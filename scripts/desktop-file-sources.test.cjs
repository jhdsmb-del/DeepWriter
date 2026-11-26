const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises'), os = require('node:os'), path = require('node:path'), http = require('node:http')
const { _electron, expect } = require('@playwright/test')
const { buildSync } = require('esbuild')
const root = path.resolve(__dirname, '..')
function load(entry) { const module = { exports: {} }; const built = buildSync({ entryPoints: [path.join(root, entry)], bundle: true, platform: 'node', format: 'cjs', write: false }); new Function('require', 'module', 'exports', built.outputFiles[0].text)(require, module, module.exports); return module.exports }

test('来源异步查询不跨会话/消息版本；分页以run/tool/source身份去重而非文件名', async () => {
  globalThis.window = { ds: {} }
  const { useStore } = load('src/renderer/src/store.ts')
  const message = (id, count = 2) => ({ id, role: 'assistant', content: '回复', reasoning: '', status: 'done', rounds: 0, toolEvents: [], fileEvidence: { status: 'idle', revision: count, nextOffset: 0, entries: [] } })
  let finish
  window.ds.sessionsFileEvidence = () => new Promise(resolve => { finish = resolve })
  useStore.setState({ currentSessionId: 'a', messages: [message('a-message')] })
  const pending = useStore.getState().loadMessageSources('a-message')
  useStore.setState({ currentSessionId: 'b', messages: [message('b-message')] })
  finish({ entries: [{ runId: 'a', toolCallId: 'tool', sourceIndex: 0, excerpt: 'A不可串到B' }], nextOffset: null }); await pending
  assert.deepEqual(useStore.getState().messages[0].fileEvidence.entries, [])
  useStore.setState({ currentSessionId: 'a', messages: [message('a-message')] })
  const old = useStore.getState().loadMessageSources('a-message')
  useStore.setState({ messages: [message('a-message', 3)] })
  finish({ entries: [{ runId: 'a', toolCallId: 'old', sourceIndex: 0 }], nextOffset: null }); await old
  assert.deepEqual(useStore.getState().messages[0].fileEvidence.entries, [])
  const entries = [0, 1].map(sourceIndex => ({ runId: 'a', toolCallId: 'read-batch', sourceIndex, displayName: '说明.md' }))
  window.ds.sessionsFileEvidence = async () => ({ entries, nextOffset: 2 })
  await useStore.getState().loadMessageSources('a-message'); await useStore.getState().loadMessageSources('a-message')
  assert.equal(useStore.getState().messages[0].fileEvidence.entries.length, 2)
})

test('真实 Electron 同名文件证据可读/键盘返回；重开看原摘录而非当前文件，无来源回复不加入口', { timeout: 60000 }, async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'dw-file-sources-')), workspace = path.join(home, 'workspace')
  let app, page
  const requests = []
  const server = http.createServer((req, res) => { let raw = ''; req.on('data', part => { raw += part }); req.on('end', () => {
    const body = JSON.parse(raw)
    if (!body.stream && body.tools?.[0]?.function?.name === 'deepwriter_tool_probe') {
      const nonce = body.tools[0].function.parameters.properties.nonce.enum[0]
      res.writeHead(200, { 'content-type': 'application/json' })
      return res.end(JSON.stringify({ choices: [{ finish_reason: 'tool_calls', message: { role: 'assistant', tool_calls: [{ id: 'probe', type: 'function', function: { name: 'deepwriter_tool_probe', arguments: JSON.stringify({ nonce }) } }] } }] }))
    }
    requests.push(body)
    const tool = body.messages.find(item => item.role === 'tool' && item.tool_call_id === 'read-two')
    const plain = body.messages.some(item => item.role === 'user' && item.content.includes('普通消息'))
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    if (!tool && !plain) {
      const call = { index: 0, id: 'read-two', type: 'function', function: { name: 'read_files', arguments: JSON.stringify({ files: [{ path: '甲项目/说明.md', start_line: 2, line_count: 1 }, { path: '乙项目/说明.md', start_line: 2, line_count: 1 }] }) } }
      res.write('data: ' + JSON.stringify({ choices: [{ delta: { tool_calls: [call] }, finish_reason: null }] }) + '\n\n')
      return res.end('data: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 30, completion_tokens: 10 } }) + '\n\ndata: [DONE]\n\n')
    }
    const content = plain ? '这条普通回复没有调用文件工具。' : '两份说明各有侧重：甲项目先完成入门教材，乙项目先开放借阅。\n\n建议按各自计划推进，不要混用交付日期。'
    res.end('data: ' + JSON.stringify({ choices: [{ delta: { content }, finish_reason: 'stop' }], usage: { prompt_tokens: 60, completion_tokens: 30 } }) + '\n\ndata: [DONE]\n\n')
  }) })
  const launch = async () => {
    app = await _electron.launch({ args: [path.join(root, process.env.DW_UI_BUILD_DIR || 'out', 'main/index.js'), '--user-data-dir=' + home], env: { ...process.env, NODE_ENV: 'test', DW_TEST_MODE: '1', DW_TEST_USERDATA: home } })
    page = await app.firstWindow(); page.setDefaultTimeout(15000); await page.locator('.composer textarea').waitFor()
  }
  const send = async text => { await page.getByRole('textbox', { name: '任务内容' }).fill(text); await page.getByRole('button', { name: '发送', exact: true }).click() }
  const sourceDetails = () => page.locator('.file-sources').first()
  const open = async () => { await sourceDetails().locator('summary').focus(); await page.keyboard.press('Enter'); await expect(sourceDetails().locator('.file-source')).toHaveCount(2) }
  try {
    for (const name of ['甲项目', '乙项目']) await fs.mkdir(path.join(workspace, name), { recursive: true })
    await fs.writeFile(path.join(workspace, '甲项目', '说明.md'), '# 甲项目\n甲项目：九月交付入门教材。\n这是未读取的第三行。')
    await fs.writeFile(path.join(workspace, '乙项目', '说明.md'), '# 乙项目\n乙项目：十月开放图书借阅。\n这是未读取的第三行。')
    await fs.writeFile(path.join(home, 'settings.json'), JSON.stringify({ workDir: workspace, docDir: workspace, planMode: false, toolsEnabled: true, webAccessEnabled: false }))
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); await launch()
    await page.evaluate(async baseUrl => {
      const ds = window.ds, saved = await ds.providerCreateSetup({ displayName: '本地资料模型', baseUrl, apiKey: 'synthetic-file-sources', protocol: 'openai-chat', modelIds: ['local-sources'] })
      if (!saved.ok) throw new Error(saved.error.message)
      const snapshot = (await ds.providerSnapshot()).data, profile = snapshot.profiles.find(item => item.providerId === saved.data.id)
      const probe = await ds.modelProbeTools(profile.modelId, saved.data.defaultCredentialRefId, true)
      if (!probe.ok || probe.data.outcome !== 'supported') throw new Error('工具能力测试失败')
      await ds.profileSetBindings({ ...snapshot.bindings, defaultProfileId: profile.id, draftProfileId: profile.id })
      window.dispatchEvent(new Event('deepwriter:provider-registry-changed'))
    }, `http://127.0.0.1:${server.address().port}/v1`)
    await send('比较两个项目的说明第二行。')
    await expect(page.locator('.msg.assistant').last()).toContainText('不要混用交付日期')
    await open(); await expect(sourceDetails().locator('summary')).toContainText('2 处')
    await expect(sourceDetails()).toContainText('工作目录 / 甲项目 / 说明.md'); await expect(sourceDetails()).toContainText('工作目录 / 乙项目 / 说明.md')
    await expect(sourceDetails().locator('.file-source').first()).toContainText('第 2 行')
    await expect(sourceDetails()).toContainText('九月交付入门教材'); await expect(sourceDetails()).toContainText('十月开放图书借阅')
    assert.ok(!(await sourceDetails().innerText()).includes('第三行')); assert.ok(!(await sourceDetails().innerText()).includes('start_line'))
    const task = (await page.evaluate(() => window.ds.sessionsList()))[0]
    const messages = await page.evaluate(id => window.ds.sessionsLoad(id), task.id)
    const assistant = messages.find(item => item.role === 'assistant')
    assert.equal(assistant.fileEvidenceCount, 2)
    assert.deepEqual(await page.evaluate(({ sid, mid }) => window.ds.sessionsFileEvidence(sid, mid), { sid: 'another-session', mid: assistant.id }), { entries: [], nextOffset: null })
    assert.ok(requests.at(-1).messages.some(item => item.role === 'tool' && item.content.includes('九月交付入门教材')))
    await sourceDetails().locator('summary').focus(); await page.keyboard.press('Escape')
    await expect(sourceDetails()).not.toHaveAttribute('open', '')
    await expect(sourceDetails().locator('summary')).toBeFocused(); await open()
    if (process.env.DW_SOURCES_SCREENSHOT) await page.screenshot({ path: process.env.DW_SOURCES_SCREENSHOT, animations: 'disabled', scale: 'css' })
    if (process.env.DW_SOURCES_CARD_SCREENSHOT) await page.locator('.msg.assistant').last().screenshot({ path: process.env.DW_SOURCES_CARD_SCREENSHOT, animations: 'disabled', scale: 'css' })
    await app.close(); app = null
    await fs.writeFile(path.join(workspace, '甲项目', '说明.md'), '作者后来已修改此文件；不能冒充历史。')
    await fs.rm(path.join(workspace, '乙项目', '说明.md'))
    await launch(); await page.locator('.session-item').filter({ hasText: '比较两个项目' }).click(); await open()
    await expect(sourceDetails()).toContainText('九月交付入门教材'); await expect(sourceDetails()).toContainText('十月开放图书借阅')
    assert.ok(!(await sourceDetails().innerText()).includes('作者后来'))
    assert.equal(requests.length, 2, 'Reopening sources must not call a provider or reread current files')
    await page.getByRole('button', { name: '新建会话', exact: true }).click()
    await send('普通消息，不查文件。'); await expect(page.locator('.msg.assistant').last()).toContainText('没有调用文件工具')
    await expect(page.locator('.file-sources')).toHaveCount(0)
  } finally {
    if (app) await app.close().catch(() => {})
    await new Promise(resolve => server.close(resolve))
    if (path.dirname(home) === os.tmpdir() && path.basename(home).startsWith('dw-file-sources-')) await fs.rm(home, { recursive: true, force: true })
  }
})
