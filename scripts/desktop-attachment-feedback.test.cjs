const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises'), os = require('node:os'), path = require('node:path'), http = require('node:http')
const { _electron, expect } = require('@playwright/test')
const { buildSync } = require('esbuild')
const { zipSync, strToU8 } = require('fflate')
const root = path.resolve(__dirname, '..')
function load(entry) { const module = { exports: {} }; const built = buildSync({ entryPoints: [path.join(root, entry)], bundle: true, platform: 'node', format: 'cjs', write: false }); new Function('require', 'module', 'exports', built.outputFiles[0].text)(require, module, module.exports); return module.exports }
const { attachmentPreviewFailure: failure } = load('src/shared/attachmentPreview.ts')
const { attachmentNotice } = load('src/renderer/src/attachmentSummary.ts')

test('附件失败保留具体原因和可执行动作，不暴露机器目录；不同失败不误导为相同重试', () => {
  for (const [reason, category, retryable] of [
    ['不支持的附件类型', 'unsupported', false], ['附件超过 50MB 限制', 'limit', false],
    ['附件无效、已过期、已撤销或内容已变化', 'unavailable', false],
    ["无法读取文件: EACCES open 'C:\\Users\\private\\资料.xlsx'", 'locked', true],
    ['PDF password required', 'encrypted', false], ['ZIP 结构无效（未找到中央目录尾记录）', 'corrupt', false],
    ['PDF 未提取到文字', 'no_text', false], ['附件预览暂未完成', 'read_failed', true]
  ]) {
    const value = failure(reason)
    assert.equal(value.category, category); assert.equal(value.retryable, retryable)
    assert.ok(!value.error.includes('C:\\Users')); assert.match(value.error, /请/)
  }
  assert.match(failure('附件超过 50MB 限制').error, /50MB/)
  assert.match(failure('ZIP 结构无效（未找到中央目录尾记录）').error, /未找到中央目录尾记录/)
  const summary = attachmentNotice({ source: 'zip', truncated: true, text: 'ZIP 工程目录：3条，声明解压30字节；文本候选2条。\n--- ZIP条目 "README.md"；文本范围 [1:1, 2:1)；此条目全文 ---\n实际工程说明。\n读取覆盖：尝试1/2个文本候选；失败0条；正文仅摘录0条。' })
  assert.equal(summary.label, '3 个条目 · 已摘录 1 个文本'); assert.equal(summary.excerpt.name, 'README.md'); assert.equal(summary.excerpt.text, '实际工程说明。')
})

test('已知解析失败或仍在解析的附件不发模型，草稿与附件保留；旧无状态 wire 输入仍可用', async () => {
  globalThis.window = { ds: {} }
  const { useStore } = load('src/renderer/src/store.ts'), initial = useStore.getState()
  let requests = 0
  window.ds = { chatStart: async input => { requests++; return { runId: input.id, status: 'queued' } } }
  useStore.setState({ ...initial, settings: { planMode: false }, currentSessionId: 'one', composerText: '待发送的文字', loadContext: async () => {}, previewContext: async () => ({ previewId: 'preview', mode: 'optimized', policyRevision: 0, budget: { status: 'ready' } }) })
  const file = { fileRefId: 'zip', name: '工程.zip', size: 100 }
  for (const state of ['failed', 'parsing']) {
    useStore.setState({ pendingAttachments: [{ ...file, state }] })
    const result = await useStore.getState().send('待发送的文字', useStore.getState().pendingAttachments)
    assert.equal(result.ok, false); assert.equal(result.reason, 'attachment_not_ready'); assert.equal(requests, 0)
    assert.equal(useStore.getState().composerText, '待发送的文字'); assert.equal(useStore.getState().pendingAttachments.length, 1)
  }
  assert.equal((await useStore.getState().send('旧调用', [file])).ok, true)
  assert.equal(requests, 1)
})

test('真实桌面选择 13.5MB ZIP、修复坏包，并将摘录发送本地端点；拖入代码与长文复用同一入口', { timeout: 60000 }, async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'dw-attachment-ui-'))
  const fixtures = await fs.mkdtemp(path.join(os.tmpdir(), 'dw-attachment-outside-'))
  const workspace = path.join(home, 'workspace')
  const good = path.join(fixtures, '演示工程.zip'), broken = path.join(fixtures, '损坏工程.zip'), code = path.join(fixtures, 'example.py')
  const marker = 'ZIP_UI_SENTINEL：本项目用零值记录真实测量，缺测留空。'
  const hiddenMarker = 'LATE_ZIP_TOOL_SENTINEL_2049'
  const requests = [], probes = []
  let calls = 0
  const server = http.createServer((req, res) => { let raw = ''; req.on('data', chunk => { raw += chunk }); req.on('end', () => {
    const body = JSON.parse(raw)
    if (!body.stream && body.tools?.[0]?.function?.name === 'deepwriter_tool_probe') {
      probes.push(body)
      const nonce = body.tools[0].function.parameters.properties.nonce.enum[0]
      res.writeHead(200, { 'content-type': 'application/json' })
      return res.end(JSON.stringify({ choices: [{ finish_reason: 'tool_calls', message: { role: 'assistant', tool_calls: [{ id: 'local-probe', type: 'function', function: { name: 'deepwriter_tool_probe', arguments: JSON.stringify({ nonce }) } }] } }] }))
    }
    requests.push(body)
    const toolResult = body.messages.find(message => message.role === 'tool' && String(message.content).includes(hiddenMarker))
    const handle = JSON.stringify(body.messages).match(/attachment:[a-f0-9]{32}/)?.[0]
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    if (handle && !toolResult) {
      const tool = { index: 0, id: `zip-late-${++calls}`, type: 'function', function: { name: 'read_file', arguments: JSON.stringify({ path: handle, archive_entry: 'src/after-preview.txt', max_chars: 2000 }) } }
      res.write('data: ' + JSON.stringify({ choices: [{ delta: { tool_calls: [tool] }, finish_reason: null }] }) + '\n\n')
      return res.end('data: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 30, completion_tokens: 10, total_tokens: 40 } }) + '\n\ndata: [DONE]\n\n')
    }
    res.end('data: ' + JSON.stringify({ choices: [{ delta: { content: '本地端点已收到资料摘录。' + (toolResult ? hiddenMarker : '') }, finish_reason: 'stop' }], usage: { prompt_tokens: 30, completion_tokens: 10, total_tokens: 40 } }) + '\n\ndata: [DONE]\n\n')
  }) })
  let app
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
    const entries = { 'README.md': strToU8(marker), 'src/example.py': strToU8("print('project data')") }
    for (let i = 0; i < 10; i++) entries[`src/module-${i}.py`] = strToU8(`print(${i})`)
    entries['src/after-preview.txt'] = strToU8('本项超出自动摘录数量，验收标记：' + hiddenMarker)
    entries['assets/payload.bin'] = new Uint8Array(Math.floor(13.5 * 1024 * 1024))
    await fs.writeFile(good, zipSync(entries, { level: 0 }))
    await fs.writeFile(broken, 'this is not a valid zip archive')
    await fs.writeFile(code, '# CODE_DROP_SENTINEL\nprint("hello")\n')
    await fs.mkdir(workspace); await fs.writeFile(path.join(workspace, 'AGENTS.md'), '隔离的附件交互测试。')
    await fs.writeFile(path.join(home, 'settings.json'), JSON.stringify({ workDir: workspace, docDir: workspace, toolsEnabled: true, planMode: false, webAccessEnabled: false }))
    app = await _electron.launch({ args: [process.env.DW_UI_BUILD_DIR ? path.join(root, process.env.DW_UI_BUILD_DIR, 'main/index.js') : root, '--user-data-dir=' + home], env: { ...process.env, NODE_ENV: 'test', DW_TEST_MODE: '1', DW_TEST_USERDATA: home } })
    const page = await app.firstWindow(); page.setDefaultTimeout(15000)
    await page.locator('.composer textarea').waitFor()
    await page.evaluate(async baseUrl => {
      const ds = window.ds, saved = await ds.providerCreateSetup({ displayName: '合成附件模型', baseUrl, apiKey: 'synthetic-attachment-only', authStyle: 'bearer', protocol: 'openai-chat', modelIds: ['local-attachment'] })
      if (!saved.ok) throw new Error(saved.error.message)
      const snapshot = (await ds.providerSnapshot()).data, profile = snapshot.profiles.find(item => item.providerId === saved.data.id)
      const probe = await ds.modelProbeTools(profile.modelId, saved.data.defaultCredentialRefId, true)
      if (!probe.ok || probe.data.outcome !== 'supported') throw new Error('合成端点工具能力测试未通过')
      await ds.profileSetBindings({ ...snapshot.bindings, defaultProfileId: profile.id, draftProfileId: profile.id })
      window.dispatchEvent(new Event('deepwriter:provider-registry-changed'))
    }, `http://127.0.0.1:${server.address().port}/v1`)
    const pick = (file, canceled = false) => app.evaluate(({ dialog }, input) => { dialog.showOpenDialog = async options => { globalThis.__attachmentFilters = options.filters; return { canceled: input.canceled, filePaths: input.canceled ? [] : [input.file] } } }, { file, canceled })
    const attach = async file => { await pick(file); await page.getByRole('button', { name: '添加附件', exact: true }).click() }
    const ready = () => expect(page.locator('.attachment-item').filter({ hasText: '演示工程.zip' })).toContainText('已摘录')
    const send = async text => { await page.getByRole('textbox', { name: '任务内容' }).fill(text); await page.getByRole('button', { name: '发送', exact: true }).click(); await expect(page.locator('.msg.assistant').last()).toContainText('本地端点已收到资料摘录。') }

    await attach(good); await ready()
    await expect(page.locator('.attachment-item')).toContainText('13.5 MB')
    const filters = await app.evaluate(() => globalThis.__attachmentFilters)
    assert.ok(filters.some(item => item.extensions.includes('zip') && item.extensions.includes('xlsx') && item.extensions.includes('pptx')))
    assert.ok(filters.some(item => item.extensions.includes('py') && item.extensions.includes('ts')))
    await page.locator('.attachment-item summary').click()
    await expect(page.locator('.attachment-item')).toContainText('README.md')
    await expect(page.locator('.attach-excerpt')).toContainText(marker)
    if (process.env.DW_ATTACHMENT_SCREENSHOT_DIR) await page.locator('.composer').screenshot({ path: path.join(process.env.DW_ATTACHMENT_SCREENSHOT_DIR, 'zip-ready.png'), animations: 'disabled', scale: 'css' })
    await send('请读取工程包 src/after-preview.txt 中尚未展示的验收标记，并在回复中引用。')
    assert.ok(JSON.stringify(requests[0].messages).includes(marker))
    assert.ok(!JSON.stringify(requests[0].messages).includes(hiddenMarker), 'The first prompt must not already contain the tool-only marker')
    assert.ok(requests[0].tools.some(tool => tool.function.name === 'read_file'))
    assert.ok(requests[1].messages.some(message => message.role === 'tool' && message.content.includes(hiddenMarker)))
    await expect(page.locator('.msg.assistant').last()).toContainText(hiddenMarker)
    assert.equal(probes.length, 1)

    await page.keyboard.press('Control+n'); await attach(broken)
    await expect(page.locator('.attachment-item')).toContainText('文件结构损坏')
    assert.equal(await page.getByRole('button', { name: '重试附件：损坏工程.zip', exact: true }).count(), 0)
    await page.locator('.attachment-item summary').click()
    await expect(page.locator('.attach-details')).toContainText('请确认文件可以正常打开')
    await page.getByRole('textbox', { name: '任务内容' }).fill('坏包不应送往模型。')
    await page.getByRole('button', { name: '发送', exact: true }).click()
    await expect(page.getByRole('textbox', { name: '任务内容' })).toHaveValue('坏包不应送往模型。')
    assert.equal(requests.length, 2)
    if (process.env.DW_ATTACHMENT_SCREENSHOT_DIR) await page.locator('.composer').screenshot({ path: path.join(process.env.DW_ATTACHMENT_SCREENSHOT_DIR, 'zip-failed.png'), animations: 'disabled', scale: 'css' })
    const reselect = page.getByRole('button', { name: '重新选择附件：损坏工程.zip', exact: true })
    await pick(good, true); await reselect.click(); await expect(page.locator('.attachment-item')).toContainText('损坏工程.zip')
    await pick(good); await reselect.focus(); await page.keyboard.press('Enter'); await ready()
    await expect(page.locator('.attachment-list')).not.toContainText('损坏工程.zip')
    await send('现在重新选定正确的 ZIP，请据其中资料回答。')
    assert.ok(requests[3].messages.some(message => message.role === 'tool' && message.content.includes(hiddenMarker)))
    await expect(page.locator('.msg.assistant').last()).toContainText(hiddenMarker)

    await page.keyboard.press('Control+n')
    const cdp = await page.context().newCDPSession(page), box = await page.locator('.composer').boundingBox()
    const data = { items: [], files: [code], dragOperationsMask: 1 }, x = box.x + box.width / 2, y = box.y + 24
    for (const type of ['dragEnter', 'dragOver', 'drop']) await cdp.send('Input.dispatchDragEvent', { type, x, y, data })
    await expect(page.locator('.attachment-item')).toContainText('example.py')
    await expect(page.locator('.attach-state')).toHaveCount(0)
    await send('解释这份代码。')
    assert.ok(JSON.stringify(requests[4].messages).includes('CODE_DROP_SENTINEL'))

    await page.keyboard.press('Control+n'); await page.getByRole('button', { name: '长文', exact: true }).click()
    await pick(good); await page.getByRole('button', { name: '添加素材', exact: true }).click(); await ready()
    await page.getByRole('textbox', { name: '创作构想', exact: true }).fill('围绕这份开发工程包的素材写一篇长文。')
    await page.getByRole('button', { name: '开始梳理', exact: true }).click()
    await page.getByText('这篇稿子想用哪种写法？', { exact: true }).waitFor()
    const saved = await page.evaluate(async () => { for (const session of await window.ds.sessionsList()) { const state = await window.ds.grillGet(session.id); if (state?.attachments?.length) return state } })
    assert.equal(saved.attachments[0].name, '演示工程.zip'); assert.ok(saved.attachments[0].excerpt.includes(marker))
    assert.equal(requests.length, 5, 'The form question is local and must not add a provider call')
  } finally {
    if (app) await app.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve))
    if (path.dirname(home) === os.tmpdir() && path.basename(home).startsWith('dw-attachment-ui-')) await fs.rm(home, { recursive: true, force: true })
    if (path.dirname(fixtures) === os.tmpdir() && path.basename(fixtures).startsWith('dw-attachment-outside-')) await fs.rm(fixtures, { recursive: true, force: true })
  }
})
