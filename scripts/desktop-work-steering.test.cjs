const { test } = require('node:test'), assert = require('node:assert/strict')
const fs = require('node:fs/promises'), os = require('node:os'), path = require('node:path'), http = require('node:http')
const { _electron, expect } = require('@playwright/test')
const root = path.resolve(__dirname, '..')
test('Composer sends real steering while the Agent streams, preserves stop-before-consume receipts after restart and restores the text', { timeout: 70000 }, async () => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'dw-desktop-steering-')), home = await fs.realpath(temporary)
  const requests = [], file = path.join(home, '河岸.md')
  const screenshots = path.join(root, 'tmp', 'steering-evidence')
  let app, page, release, held
  const send = (res, delta, finish = 'stop') => {
    res.write('data: ' + JSON.stringify({ choices: [{ delta, finish_reason: null }] }) + '\n\n')
    res.end('data: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: finish }], usage: { prompt_tokens: 30, completion_tokens: 5, total_tokens: 35 } }) + '\n\ndata: [DONE]\n\n')
  }
  const server = http.createServer((req, res) => {
    let body = ''; req.on('data', chunk => { body += chunk })
    req.on('end', () => {
      const request = JSON.parse(body); requests.push(request)
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      if (requests.length === 1) return send(res, { tool_calls: [{ index: 0, id: 'once-edit', type: 'function', function: { name: 'edit_file', arguments: JSON.stringify({ path: '河岸.md', old_text: '小曲', new_text: '小禾' }) } }] }, 'tool_calls')
      if (requests.length === 2 || requests.length === 4) {
        held = res
        res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: requests.length === 2 ? '正在检查修改。' : '正在处理第二项任务。' }, finish_reason: null }] }) + '\n\n')
        release = () => send(res, {}, 'stop'); return
      }
      send(res, { content: '已按补充保持第一人称，不再改文件。' })
    })
  })
  const launch = async () => {
    app = await _electron.launch({ args: [path.join(root, process.env.DW_UI_BUILD_DIR || 'out', 'main/index.js'), '--user-data-dir=' + home], env: { ...process.env, NODE_ENV: 'test', DW_TEST_MODE: '1', DW_TEST_USERDATA: home, DW_TEST_PRICING_ORIGIN: `http://127.0.0.1:${server.address().port}` } })
    page = await app.firstWindow(); page.setDefaultTimeout(12000)
    await page.getByRole('textbox', { name: '任务内容' }).waitFor()
  }
  try {
    await fs.mkdir(screenshots, { recursive: true })
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
    const origin = `http://127.0.0.1:${server.address().port}`
    await fs.writeFile(file, '\ufeff小曲过桥。\r\n尾声 — ①。')
    await fs.writeFile(path.join(home, 'settings.json'), JSON.stringify({ workDir: home, docDir: home, baseUrl: origin, model: 'deepseek-v4-flash', toolsEnabled: true, webAccessEnabled: false }))
    await launch()
    await page.evaluate(async () => { await window.ds.setSettings({ ...(await window.ds.getSettings()), apiKey: 'synthetic-local-steering-key' }) })
    await page.reload()
    const input = () => page.getByRole('textbox', { name: '任务内容' })
    await input().fill('把河岸.md 中的小曲改为小禾，然后说明改动。'); await input().press('Enter')
    await expect.poll(() => requests.length).toBe(2)
    await expect(page.getByRole('button', { name: '补充指令', exact: true })).toBeVisible()
    await input().fill('补充：保持第一人称，不要再改文件。')
    await page.getByRole('button', { name: '补充指令', exact: true }).click()
    await expect(input()).toHaveValue('')
    const receipts = () => page.getByTestId('work-steering-receipts')
    await expect(receipts().locator('summary')).toHaveText('补充指令 · 1 条待处理')
    await receipts().locator('summary').click()
    await expect(receipts()).toContainText('补充：保持第一人称，不要再改文件。')
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(win => win.isVisible())?.setContentSize(860, 720))
    await page.screenshot({ path: path.join(screenshots, 'steering-composer-pending.png'), animations: 'disabled', scale: 'css' })
    release(); held = null
    await page.getByText('已按补充保持第一人称，不再改文件。', { exact: false }).last().waitFor()
    await expect(receipts().locator('summary')).toHaveText('补充指令 · 0 条待处理')
    assert.equal(requests.length, 3)
    const message = requests[2].messages.filter(m => m.role === 'user' && m.content === '补充：保持第一人称，不要再改文件。')
    assert.equal(message.length, 1)
    assert.equal(await fs.readFile(file, 'utf8'), '\ufeff小禾过桥。\r\n尾声 — ①。')
    await input().fill('第二项任务，请稍候再回答。'); await input().press('Enter')
    await expect.poll(() => requests.length).toBe(4)
    await expect(page.getByRole('button', { name: '补充指令', exact: true })).toBeVisible()
    await input().fill('停止前保存的补充，之后仍要看得到。'); await input().press('Enter')
    await expect(receipts().locator('summary')).toHaveText('补充指令 · 1 条待处理')
    await page.getByRole('button', { name: '停止', exact: true }).click()
    held.destroy(); held = null
    await expect(page.getByRole('button', { name: '停止', exact: true })).toHaveCount(0)
    const recent = (await page.evaluate(() => window.ds.runsListRecent(1)))[0]
    const beforeClose = await page.evaluate(({ runId, sessionId }) => window.ds.runsSteering(runId, sessionId), recent)
    assert.equal(beforeClose.messages[0].status, 'pending')
    await app.close(); app = null
    await launch()
    await page.locator('.session-item-main').filter({ hasText: '把河岸.md' }).click()
    await expect(receipts().locator('summary')).toHaveText('补充指令 · 1 条待处理')
    await receipts().locator('summary').click()
    await expect(receipts()).toContainText('运行已暂停或结束；补充仍已保存')
    await receipts().getByRole('button', { name: '放回输入框' }).click()
    await expect(input()).toHaveValue('停止前保存的补充，之后仍要看得到。')
    assert.equal(requests.length, 4, 'restoring queue receipts must not call a model or replay writes')
    await page.screenshot({ path: path.join(screenshots, 'steering-composer-restored.png'), animations: 'disabled', scale: 'css' })
  } catch (error) {
    if (page) console.error((await page.locator('body').innerText().catch(() => '')).slice(-1800))
    throw error
  } finally {
    held?.destroy()
    if (app) await app.close()
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve))
    await fs.rm(temporary, { recursive: true, force: true })
  }
})
