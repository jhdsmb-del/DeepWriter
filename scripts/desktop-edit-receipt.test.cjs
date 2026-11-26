const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const http = require('node:http')
const { _electron } = require('@playwright/test')

test('桌面改稿回执：实时、跨会话、重开窗口都保留真实前后与失败状态', { timeout: 80000 }, async () => {
  const root = path.resolve(__dirname, '..')
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'dw-edit-receipt-'))
  const file = path.join(home, '河岸.md')
  await fs.writeFile(file, '小曲过桥。\r\n听见渡船靠岸。\r\n小曲回头。')
  let received = 0, sentToModel = ''
  const server = http.createServer((req, res) => {
    if (!req.url.includes('/chat/completions')) return res.writeHead(404).end()
    let body = ''; req.on('data', p => { body += p })
    req.on('end', () => {
      received++
      const messages = JSON.parse(body).messages, tool = messages.findLast(m => m.role === 'tool')
      if (tool) sentToModel = messages.filter(m => m.role === 'tool').map(m => m.content).find(content => content.includes('"count":2')) || ''
      const delta = tool ? { content: '人物名字已统一。' } : { tool_calls: [{ index: 0, id: 'edit-in-desktop', type: 'function', function: {
        name: 'edit_file', arguments: JSON.stringify({ path: '河岸.md', old_text: '小曲', new_text: '小禾', replace_all: true })
      } }, { index: 1, id: 'edit-miss-in-desktop', type: 'function', function: { name: 'edit_file', arguments: JSON.stringify({ path: '河岸.md', old_text: '不存在的人物', new_text: '不要应用' }) } }] }
      res.writeHead(200, { 'Content-Type': 'text/event-stream' })
      for (const [d, reason] of [[delta, null], [{}, tool ? 'stop' : 'tool_calls']])
        res.write('data: ' + JSON.stringify({ choices: [{ index: 0, delta: d, finish_reason: reason }], ...(reason ? { usage: { prompt_tokens: 30, completion_tokens: 5, total_tokens: 35, prompt_cache_hit_tokens: 0, prompt_cache_miss_tokens: 30 } } : {}) }) + '\n\n')
      res.end('data: [DONE]\n\n')
    })
  })
  let app, page
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
    const base = 'http://127.0.0.1:' + server.address().port
    await fs.writeFile(path.join(home, 'settings.json'), JSON.stringify({ workDir: home, docDir: home, baseUrl: base, model: 'deepseek-v4-flash', toolsEnabled: true }))
    const launch = () => _electron.launch({ args: [process.env.DW_UI_BUILD_DIR ? path.join(root, process.env.DW_UI_BUILD_DIR, 'main/index.js') : root, '--user-data-dir=' + home], env: { ...process.env, NODE_ENV: 'test', DW_TEST_MODE: '1', DW_TEST_USERDATA: home, DW_TEST_PRICING_ORIGIN: base } })
    app = await launch()
    page = await app.firstWindow(); page.setDefaultTimeout(12000)
    const input = page.locator('.composer textarea')
    await input.waitFor()
    await page.evaluate(async () => { const ds = window.ds; await ds.setSettings({ ...(await ds.getSettings()), apiKey: 'synthetic-local-receipt-key' }) })
    await page.reload(); await input.fill('将河岸.md 里的小曲全部改名为小禾。'); await input.press('Enter')
    const processCard = page.locator('details.message-process').last()
    await processCard.locator('summary').click()
    const card = processCard.locator('.tool-card').filter({ hasText: '原稿第 1、3 行' })
    await card.getByRole('button').first().click()
    const result = card.getByLabel('修改前后')
    await result.waitFor()
    assert.match(await card.getByRole('button').first().innerText(), /原稿第 1、3 行/)
    assert.equal(await result.getByLabel('修改前', { exact: true }).innerText(), '小曲')
    assert.equal(await result.getByLabel('修改后', { exact: true }).innerText(), '小禾')
    assert.ok(!(await card.innerText()).includes('old_text'), 'raw arguments should not compete with the author-facing edit')
    assert.equal(await fs.readFile(file, 'utf8'), '小禾过桥。\r\n听见渡船靠岸。\r\n小禾回头。')
    await page.getByText('人物名字已统一。', { exact: true }).last().waitFor()
    assert.equal(received, 2); assert.deepEqual(JSON.parse(sentToModel).edit, { count: 2, lines: [1, 3] })
    assert.ok(!sentToModel.includes('− 小曲'))
    await processCard.locator('.tool-card.failed').waitFor()
    assert.equal(await processCard.locator('.tool-card.failed [aria-label="修改前后"]').count(), 0)
    const sessionA = (await page.evaluate(() => window.ds.sessionsList()))[0].id
    const checkRestored = async () => {
      const process = page.locator('details.message-process').last()
      await process.locator('summary').click()
      const edit = process.locator('.tool-card').filter({ hasText: '原稿第 1、3 行' })
      await edit.waitFor(); await edit.locator('button').first().click()
      assert.equal(await edit.getByLabel('修改前', { exact: true }).innerText(), '小曲')
      assert.equal(await edit.getByLabel('修改后', { exact: true }).innerText(), '小禾')
      const failure = process.locator('.tool-card.failed')
      await failure.waitFor(); assert.match(await failure.innerText(), /未修改/)
      assert.equal(await failure.getByLabel('修改前后').count(), 0)
      assert.ok(!(await process.innerText()).includes('old_text'))
      await edit.locator('button').first().click()
      assert.equal(await edit.getByLabel('修改前后').count(), 0)
      await edit.locator('button').first().click()
      return process
    }
    // Remove the original text from the present-day file: history must still
    // show the recorded edit, not reconstruct a diff against today's contents.
    await fs.writeFile(file, '外部程序已重写这份文件。')
    await input.fill('下一次继续改稿')
    await page.keyboard.press('Control+n')
    await input.fill('另一个会话的独立草稿')
    await page.locator('.session-item-main').filter({ hasText: '将河岸.md' }).click()
    await checkRestored()
    const snapshots = await page.evaluate(id => window.ds.sessionsLoad(id), sessionA)
    assert.equal(snapshots.filter(m => m.hasEditHistory).length, 1)
    assert.ok(!JSON.stringify(snapshots).includes('old_text'))
    await input.fill('重新打开后继续改稿')
    await page.waitForTimeout(500) // Debounced durable draft flush, then close the actual app.
    await app.close(); app = null
    app = await launch(); page = await app.firstWindow(); page.setDefaultTimeout(12000)
    await page.getByText('人物名字已统一。', { exact: true }).waitFor()
    await checkRestored() // Startup restores the current draft's canonical session.
    assert.equal(await fs.readFile(file, 'utf8'), '外部程序已重写这份文件。')
    assert.equal(received, 2, 'Reading history never invokes the model or replays edits')
    if (process.env.DW_EDIT_SCREENSHOT) await page.screenshot({ path: process.env.DW_EDIT_SCREENSHOT, scale: 'css' })
  } catch (e) {
    if (page) console.error('运行结果：', await page.evaluate(async () => {
      const recent = await window.ds.runsListRecent(1); if (!recent.length) return null
      const r = await window.ds.runsGet(recent[0].runId)
      return { status: r?.status, errorCode: r?.errorCode, errorMessage: r?.errorMessage }
    }).catch(String))
    if (page) console.error('页面状态：', (await page.locator('body').innerText().catch(() => '')).slice(-1600), '本地模型请求：', received)
    throw e
  } finally {
    if (app) await app.close()
    server.closeAllConnections(); server.close()
    if (path.dirname(home) === os.tmpdir() && path.basename(home).startsWith('dw-edit-receipt-')) await fs.rm(home, { recursive: true, force: true })
  }
})
