const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const http = require('node:http')
const { _electron, expect } = require('@playwright/test')

test('重开后撤销单次改稿，作者后续修改冲突不覆盖，撤销状态持久保留', { timeout: 80000 }, async () => {
  const root = path.resolve(__dirname, '..')
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'dw-edit-undo-ui-'))
  const original = '小曲过桥。\r\n听见渡船靠岸。\r\n小曲回头。'
  const file = path.join(home, '河岸.md'), other = path.join(home, '归途.md')
  await fs.writeFile(file, original)
  await fs.writeFile(other, '小曲关上书店的门。')
  let received = 0
  const server = http.createServer((req, res) => {
    if (!req.url.includes('/chat/completions')) return res.writeHead(404).end()
    let body = ''; req.on('data', part => { body += part })
    req.on('end', () => {
      received++
      const messages = JSON.parse(body).messages
      const finished = messages.some(message => message.role === 'tool')
      const delta = finished ? { content: '两份稿件的人物名字已统一。' } : { tool_calls: ['河岸.md', '归途.md'].map((file, index) => ({ index, id: 'undo-edit-' + index, type: 'function', function: { name: 'edit_file', arguments: JSON.stringify({ path: file, old_text: '小曲', new_text: '小禾', replace_all: true }) } })) }
      res.writeHead(200, { 'Content-Type': 'text/event-stream' })
      for (const [content, finish] of [[delta, null], [{}, finished ? 'stop' : 'tool_calls']]) res.write('data: ' + JSON.stringify({ choices: [{ index: 0, delta: content, finish_reason: finish }], ...(finish ? { usage: { prompt_tokens: 30, completion_tokens: 5, total_tokens: 35 } } : {}) }) + '\n\n')
      res.end('data: [DONE]\n\n')
    })
  })
  let app, page
  const openReceipts = async () => {
    const process = page.locator('details.message-process').last()
    await process.locator('summary').click()
    const edit = process.locator('.tool-card').filter({ hasText: '河岸.md' })
    const conflict = process.locator('.tool-card').filter({ hasText: '归途.md' })
    await edit.locator('.tool-card-header').click()
    await conflict.locator('.tool-card-header').click()
    await edit.getByLabel('修改前后').waitFor()
    assert.equal(await process.getByRole('button', { name: '回滚该文件', exact: true }).count(), 0)
    return { edit, conflict }
  }
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
    const base = 'http://127.0.0.1:' + server.address().port
    await fs.writeFile(path.join(home, 'settings.json'), JSON.stringify({ workDir: home, docDir: home, baseUrl: base, model: 'deepseek-v4-flash', toolsEnabled: true, planMode: false }))
    const launch = () => _electron.launch({ args: [process.env.DW_UI_BUILD_DIR ? path.join(root, process.env.DW_UI_BUILD_DIR, 'main/index.js') : root, '--user-data-dir=' + home], env: { ...process.env, NODE_ENV: 'test', DW_TEST_MODE: '1', DW_TEST_USERDATA: home, DW_TEST_PRICING_ORIGIN: base } })
    app = await launch(); page = await app.firstWindow(); page.setDefaultTimeout(15000)
    await page.locator('.composer textarea').waitFor()
    await page.evaluate(async () => { const ds = window.ds; await ds.setSettings({ ...(await ds.getSettings()), apiKey: 'synthetic-local-undo-key' }) })
    await page.reload()
    await page.locator('.composer textarea').fill('将河岸.md 和归途.md 中的小曲改为小禾。')
    await page.locator('.composer textarea').press('Enter')
    await page.getByText('两份稿件的人物名字已统一。', { exact: true }).waitFor()
    assert.equal(await fs.readFile(file, 'utf8'), original.replaceAll('小曲', '小禾'))
    assert.equal(await fs.readFile(other, 'utf8'), '小禾关上书店的门。')
    await page.locator('.composer textarea').fill('下一轮继续改稿')
    await page.waitForTimeout(500)
    await app.close(); app = null
    // The author edits one file outside DeepWriter while the application is closed.
    const authored = '小禾关上书店的门。\n作者手动补写：雨还没有停。'
    await fs.writeFile(other, authored)
    app = await launch(); page = await app.firstWindow(); page.setDefaultTimeout(15000)
    await page.getByText('两份稿件的人物名字已统一。', { exact: true }).waitFor()
    const { edit, conflict } = await openReceipts()
    const undo = edit.getByRole('button', { name: '撤销这次改稿', exact: true })
    await expect(undo).toBeEnabled()
    if (process.env.DW_UNDO_EXAMPLE_SCREENSHOT) await edit.screenshot({ path: process.env.DW_UNDO_EXAMPLE_SCREENSHOT, animations: 'disabled', scale: 'css' })
    await undo.focus(); await undo.press('Enter')
    await expect(edit.getByRole('status')).toHaveText('已撤销这次改稿')
    assert.equal(await fs.readFile(file, 'utf8'), original)
    await expect(edit.locator('.tool-card-header')).toContainText('已撤销')
    assert.equal(await edit.getByRole('button', { name: '撤销这次改稿', exact: true }).count(), 0)
    await conflict.getByRole('button', { name: '撤销这次改稿', exact: true }).click()
    await expect(conflict.getByRole('alert')).toContainText(/已变化|手动|改动|修改/)
    assert.equal(await fs.readFile(other, 'utf8'), authored)
    if (process.env.DW_UNDO_SCREENSHOT) await page.screenshot({ path: process.env.DW_UNDO_SCREENSHOT, animations: 'disabled', scale: 'css' })
    await page.reload()
    await page.getByText('两份稿件的人物名字已统一。', { exact: true }).waitFor()
    const reloaded = await openReceipts()
    await expect(reloaded.edit.getByRole('status')).toHaveText('已撤销这次改稿')
    assert.equal(await reloaded.edit.getByRole('button', { name: '撤销这次改稿', exact: true }).count(), 0)
    assert.equal(await fs.readFile(file, 'utf8'), original)
    assert.equal(received, 2, 'Undo must not call the model or replay the original edit')
  } catch (error) {
    if (page) console.error('撤销界面：', (await page.locator('body').innerText().catch(() => '')).slice(-1800))
    throw error
  } finally {
    if (app) await app.close()
    server.closeAllConnections(); server.close()
    if (path.dirname(home) === os.tmpdir() && path.basename(home).startsWith('dw-edit-undo-ui-')) await fs.rm(home, { recursive: true, force: true })
  }
})
