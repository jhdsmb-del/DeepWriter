const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises'), os = require('node:os'), path = require('node:path'), http = require('node:http')
const { _electron, expect } = require('@playwright/test')
const { buildSync } = require('esbuild')
const root = path.resolve(__dirname, '..')
function load(entry) { const module = { exports: {} }; const built = buildSync({ entryPoints: [path.join(root, entry)], bundle: true, platform: 'node', format: 'cjs', write: false }); new Function('require', 'module', 'exports', built.outputFiles[0].text)(require, module, module.exports); return module.exports }
const { projectComposerPerformance: project, performanceLabels: labels } = load('src/renderer/src/composerPerformance.ts')
const sample = (patch = {}) => ({ requestId: 'request1', attempt: 1, revision: 1, status: 'waiting', scope: { runId: 'run1', turnSeq: 1, round: 1, actor: 'writer' }, startedAt: 10, elapsedMs: 0, ttftMs: null, estimateMethod: 'visible_cjk_1_other_quarter_v1', estimatedOutputTokens: 0, windowMs: 0, windowOutputTokens: 0, estimatedTokensPerSecond: null, actualTokensPerSecond: null, inputTokens: null, outputTokens: null, cache: { status: 'unknown', inputTokens: null, hitTokens: null, missTokens: null, writeTokens: null, hitRate: null }, ...patch })

test('速度与缓存区分未知、真实零、估算；旧请求/轮次/任务和重复修订不能串入', () => {
  assert.equal(labels(sample()).speed, '输出 — tok/s'); assert.equal(labels(sample()).cache, '缓存命中 未知')
  assert.equal(labels(sample({ status: 'streaming', estimatedTokensPerSecond: 12.35 })).speed, '输出 ≈12.3 tok/s')
  const actual = sample({ status: 'completed', actualTokensPerSecond: 0, cache: { status: 'reported', hitRate: 0, hitTokens: 0 } })
  assert.equal(labels(actual).speed, '输出 0.0 tok/s'); assert.equal(labels(actual).cache, '缓存命中 0%')
  assert.equal(labels({ ...actual, cache: { status: 'reported', hitRate: .375 } }).cache, '缓存命中 38%')
  let state = project(null, sample(), 'run1')
  assert.equal(project(state, sample(), 'run1'), state)
  assert.equal(project(state, sample({ revision: 9, scope: { runId: 'other', turnSeq: 1, round: 1, actor: 'writer' } }), 'run1'), state)
  state = project(state, sample({ revision: 2, attempt: 2 }), 'run1')
  assert.equal(state.snapshot.status, 'waiting')
  state = project(state, sample({ requestId: 'request2', startedAt: 10, scope: { runId: 'run1', turnSeq: 1, round: 2, actor: 'editor' } }), 'run1')
  assert.equal(project(state, sample({ revision: 99, status: 'completed' }), 'run1'), state)
  assert.equal(project(state, sample({ requestId: 'oldround', startedAt: 50 }), 'run1'), state)
  assert.equal(labels(state.snapshot).cache, '缓存命中 未知')
})

test('真实 Electron 流式速度、缓存用量、工具轮次与会话切换；只读上下文明细仍可打开', { timeout: 60000 }, async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'dw-performance-ui-')), workspace = path.join(home, 'workspace')
  const requests = []
  let call = 0, app
  const pause = ms => new Promise(resolve => setTimeout(resolve, ms))
  const server = http.createServer((req, res) => { let raw = ''; req.on('data', chunk => { raw += chunk }); req.on('end', async () => {
    try {
      const body = JSON.parse(raw)
      if (!body.stream && body.tools?.[0]?.function?.name === 'deepwriter_tool_probe') {
        const nonce = body.tools[0].function.parameters.properties.nonce.enum[0]
        res.writeHead(200, { 'content-type': 'application/json' })
        return res.end(JSON.stringify({ choices: [{ finish_reason: 'tool_calls', message: { role: 'assistant', tool_calls: [{ id: 'local-probe', type: 'function', function: { name: 'deepwriter_tool_probe', arguments: JSON.stringify({ nonce }) } }] } }] }))
      }
      const n = ++call; requests.push(body)
      res.writeHead(200, { 'content-type': 'text/event-stream' }); res.flushHeaders()
      const delta = payload => res.write('data: ' + JSON.stringify({ choices: [{ delta: payload, finish_reason: null }] }) + '\n\n')
      await pause(850)
      if (n === 2) {
        delta({ tool_calls: [{ index: 0, id: 'read-demo', type: 'function', function: { name: 'read_file', arguments: JSON.stringify({ path: '素材.txt' }) } }] })
        await pause(500)
        return res.end('data: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 200, completion_tokens: 20, prompt_tokens_details: { cached_tokens: 100 } } }) + '\n\ndata: [DONE]\n\n')
      }
      const text = n === 1 ? '清晨的窗边，杯口升起一点白雾。\n\n她把信纸折好，放进蓝色的信封里。' : n === 3 ? '素材里写着：雨停以后，去河边走一走。\n\n我们把这一句留作故事的开头。' : '这次接口没有报告缓存，保留未知。'
      for (const part of text.match(/.{1,10}|\n/g)) { delta({ content: part }); await pause(120) }
      const usage = { prompt_tokens: 200, completion_tokens: 80, ...(n === 1 ? { prompt_tokens_details: { cached_tokens: 80 } } : n === 3 ? { prompt_tokens_details: { cached_tokens: 0 } } : {}) }
      res.end('data: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage }) + '\n\ndata: [DONE]\n\n')
    } catch { res.destroy() }
  }) })
  try {
    await fs.mkdir(workspace); await fs.writeFile(path.join(workspace, '素材.txt'), '雨停以后，去河边走一走。')
    await fs.writeFile(path.join(home, 'settings.json'), JSON.stringify({ workDir: workspace, docDir: workspace, toolsEnabled: true, planMode: false, webAccessEnabled: false }))
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
    app = await _electron.launch({ args: [process.env.DW_UI_BUILD_DIR ? path.join(root, process.env.DW_UI_BUILD_DIR, 'main/index.js') : root, '--user-data-dir=' + home], env: { ...process.env, NODE_ENV: 'test', DW_TEST_MODE: '1', DW_TEST_USERDATA: home } })
    const page = await app.firstWindow(); page.setDefaultTimeout(15000)
    await page.locator('.composer textarea').waitFor()
    await page.evaluate(async baseUrl => {
      const ds = window.ds, saved = await ds.providerCreateSetup({ displayName: '本地演示模型', baseUrl, apiKey: 'synthetic-performance-only', protocol: 'openai-chat', modelIds: ['local-performance'] })
      if (!saved.ok) throw new Error(saved.error.message)
      const snapshot = (await ds.providerSnapshot()).data, profile = snapshot.profiles.find(item => item.providerId === saved.data.id)
      const probe = await ds.modelProbeTools(profile.modelId, saved.data.defaultCredentialRefId, true)
      if (!probe.ok || probe.data.outcome !== 'supported') throw new Error('工具能力探测失败')
      await ds.profileSetBindings({ ...snapshot.bindings, defaultProfileId: profile.id, draftProfileId: profile.id })
      window.dispatchEvent(new Event('deepwriter:provider-registry-changed'))
    }, `http://127.0.0.1:${server.address().port}/v1`)
    const footer = page.getByTestId('composer-performance')
    const send = async text => { await page.getByRole('textbox', { name: '任务内容' }).fill(text); await page.getByRole('button', { name: '发送', exact: true }).click() }
    await send('写一小段清晨读信的场景。')
    await expect(footer).toContainText('输出 — tok/s'); await expect(footer).toContainText('缓存命中 未知')
    await expect(footer).toContainText('≈')
    await expect(footer).toContainText('缓存命中 40%')
    await expect(page.getByRole('button', { name: '发送', exact: true })).toBeVisible()
    assert.ok(!((await footer.innerText()).includes('≈')))
    if (process.env.DW_PERFORMANCE_SCREENSHOT) await page.screenshot({ path: process.env.DW_PERFORMANCE_SCREENSHOT, animations: 'disabled', scale: 'css' })
    await send('读取素材.txt，把它的一句话作为故事开头。')
    await expect(footer).toContainText('输出 — tok/s'); await expect(footer).toContainText('缓存命中 未知')
    await expect.poll(() => requests.length).toBe(3)
    await expect(footer).toContainText('输出 — tok/s'); await expect(footer).toContainText('缓存命中 未知')
    await expect(footer).toContainText('缓存命中 0%')
    await expect(page.locator('.msg.assistant').last()).toContainText('去河边走一走')
    assert.ok(requests[2].messages.some(message => message.role === 'tool' && String(message.content).includes('雨停以后')))
    await expect(page.getByRole('button', { name: '发送', exact: true })).toBeVisible()
    await page.getByRole('button', { name: '新建会话', exact: true }).click()
    await expect(footer).toHaveCount(0)
    await send('请回一条没有缓存报告的说明。')
    await expect(footer).toContainText('缓存命中 未知')
    await expect(page.locator('.msg.assistant').last()).toContainText('保留未知')
    await expect(page.getByRole('button', { name: '发送', exact: true })).toBeVisible()
    await expect(footer).toContainText('缓存命中 未知')
    await page.getByTestId('model-reasoning-trigger').click()
    await page.getByRole('button', { name: '高级', exact: true }).click()
    await expect(page.getByRole('group', { name: '上下文范围' })).toHaveCount(0)
    await page.getByRole('button', { name: '查看本次上下文明细', exact: true }).click()
    await expect(page.getByRole('dialog', { name: '本次运行上下文' })).toContainText('按模型自动管理')
    await expect(page.getByPlaceholder('添加必须保留的事实')).toBeVisible()
  } finally {
    if (app) await app.close().catch(() => {})
    await new Promise(resolve => server.close(resolve))
    if (path.dirname(home) === os.tmpdir() && path.basename(home).startsWith('dw-performance-ui-')) await fs.rm(home, { recursive: true, force: true })
  }
})

