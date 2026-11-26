const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const http = require('node:http')
const { _electron, expect } = require('@playwright/test')
const { buildSync } = require('esbuild')
const root = path.resolve(__dirname, '..')
const shutdown = { exports: {} }
new Function('require', 'module', 'exports', buildSync({ entryPoints: [path.join(root, 'scripts/electron-shutdown.ts')], platform: 'node', bundle: true, format: 'cjs', write: false }).outputFiles[0].text)(require, shutdown, shutdown.exports)
async function main() {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'dw-plan-desktop-'))
  const shots = path.join(root, 'out/readonly-plan-evidence'); await fs.mkdir(shots, { recursive: true })
  const file = path.join(home, 'source.md'), other = path.join(home, 'other')
  await fs.mkdir(other); await fs.writeFile(file, '海鸥绕过旧钟。')
  const custom = process.env.DW_PLAN_CUSTOM_PROVIDER === '1'
  const calls = []
  const server = http.createServer((req, res) => {
    let raw = ''; req.on('data', chunk => { raw += chunk }); req.on('end', () => {
      const body = JSON.parse(raw)
      if (body.stream === false && body.tools?.[0]?.function?.name === 'deepwriter_tool_probe') {
        const nonce = body.tools[0].function.parameters.properties.nonce.enum[0]
        res.writeHead(200, { 'content-type': 'application/json' })
        return res.end(JSON.stringify({ choices: [{ finish_reason: 'tool_calls', message: { role: 'assistant', tool_calls: [{ id: 'verified-local-probe', type: 'function', function: { name: 'deepwriter_tool_probe', arguments: JSON.stringify({ nonce }) } }] } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }))
      }
      calls.push(body)
      const planning = body.messages.some(message => message.role === 'system' && message.content.includes('当前是只读查稿与方案阶段'))
      const tools = body.messages.filter(message => message.role === 'tool')
      let delta, reason
      if (!tools.length) {
        const requested = planning ? [
          { name: 'read_file', args: { path: file } },
          { name: 'write_file', args: { path: file, content: '禁止在只读阶段写入' } },
          { name: 'run_command', args: { command: 'echo forbidden' } },
          { name: 'dw_fake_delete', args: {} }
        ] : [{ name: 'write_file', args: { path: file, content: '海鸥绕过晨钟。' } }]
        delta = { tool_calls: requested.map((tool, index) => ({ index, id: tool.name + calls.length, type: 'function', function: { name: tool.name, arguments: JSON.stringify(tool.args) } })) }; reason = 'tool_calls'
      } else {
        if (planning) assert.ok(tools.some(tool => tool.content.includes('海鸥绕过旧钟')), 'actual manuscript must enter the review')
        delta = { content: planning ? '## 执行方案\n把 source.md 的旧钟改为晨钟，其余内容保留。' : '已按批准方案把旧钟改为晨钟。' }; reason = 'stop'
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.end(`data: ${JSON.stringify({ choices: [{ delta, finish_reason: reason }], usage: { prompt_tokens: 20, completion_tokens: 20, total_tokens: 40 } })}\n\ndata: [DONE]\n\n`)
    })
  })
  let app, page
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
    const base = 'http://127.0.0.1:' + server.address().port
    await fs.writeFile(path.join(home, 'settings.json'), JSON.stringify({ workDir: home, docDir: home, baseUrl: base, model: 'deepseek-v4-flash', toolsEnabled: true, webAccessEnabled: false, planMode: false }))
    app = await _electron.launch({ args: [path.join(root, process.env.DW_UI_BUILD_DIR || 'out', 'main/index.js'), '--user-data-dir=' + home], env: { ...process.env, NODE_ENV: 'test', DW_TEST_MODE: '1', DW_TEST_USERDATA: home, DW_TEST_PRICING_ORIGIN: custom ? '' : base } })
    page = await app.firstWindow(); page.setDefaultTimeout(12000)
    page.on('pageerror', error => console.error('PAGE_ERROR', error.stack))
    page.on('console', message => { if (message.type() === 'error') console.error('CONSOLE_ERROR', message.text()) })
    await page.reload()
    await page.locator('.composer textarea').waitFor()
    if (custom) {
    await page.evaluate(async base => {
      const ds = window.ds
      const setup = await ds.providerCreateSetup({ displayName: '只读方案本机模型', baseUrl: base + '/v1', apiKey: '', protocol: 'openai-chat', modelIds: ['bootstrap-fixture'] })
      if (!setup.ok) throw new Error(setup.error.message)
      const model = await ds.modelAddManual({ providerId: setup.data.id, remoteModelId: 'plan-local-fixture', displayName: '本机方案模型', contextWindow: 32768, maxOutputTokens: 8192 })
      if (!model.ok) throw new Error(model.error.message)
      const proof = await ds.modelProbeTools(model.data.id, null, true)
      if (!proof.ok || proof.data.outcome !== 'supported') throw new Error('本机工具协议未通过真实探测')
      const snapshot = (await ds.providerSnapshot()).data
      const profile = snapshot.profiles.find(item => item.modelId === model.data.id)
      const binding = await ds.profileSetBindings({ defaultProfileId: profile.id, planningProfileId: profile.id, draftProfileId: profile.id, reviewProfileId: profile.id, polishProfileId: profile.id })
      if (!binding.ok) throw new Error(binding.error.message)
      await ds.setSettingField('thinkingEnabled', false)
    }, base)
    } else await page.evaluate(async () => { await window.ds.setSettings({ ...(await window.ds.getSettings()), apiKey: 'synthetic-plan-local-key' }) })
    await page.reload()
    await page.getByTestId('composer-tools-trigger').click()
    const toggle = page.getByRole('checkbox', { name: '只读审阅', exact: true })
    await page.locator('label.dw-switch').filter({ hasText: '只读审阅' }).click(); await expect(toggle).toBeChecked(); await page.keyboard.press('Escape')
    await page.locator('.composer textarea').fill('只读查看 source.md，提出钟声修改方案，先不要修改。')
    await page.getByRole('button', { name: '只读审阅', exact: true }).click()
    await page.getByRole('button', { name: '批准执行', exact: true }).waitFor()
    assert.equal(calls.length, 2)
    assert.deepEqual(calls[0].tools.map(tool => tool.function.name).sort(), ['read_file', 'list_files', 'search_files', 'find_files', 'read_files'].sort())
    assert.ok(calls[1].messages.filter(message => message.role === 'tool').slice(1).every(message => message.content.includes('plan_read_only')))
    assert.equal(await fs.readFile(file, 'utf8'), '海鸥绕过旧钟。')
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(window => !window.webContents.getURL().includes('window='))?.setSize(1280, 900))
    await page.screenshot({ path: path.join(shots, 'plan-review.png'), animations: 'disabled' })
    const restoreSession = async () => {
      await page.reload(); await page.locator('.composer textarea').waitFor()
      const cancel = page.getByRole('button', { name: '取消', exact: true })
      if (await cancel.isVisible()) await cancel.click()
      const expand = page.getByRole('button', { name: '展开会话栏', exact: true })
      if (await expand.isVisible()) await expand.click()
      await page.locator('button.session-item-main').first().click()
    }
    await restoreSession(); await page.getByRole('button', { name: '批准执行', exact: true }).waitFor()
    const count = calls.length
    const setDirectory = async directory => {
      await app.evaluate(({ dialog }, path) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] }) }, directory)
      await page.getByTestId('composer-tools-trigger').click()
      await page.getByRole('button', { name: /^工作目录：/ }).click()
      await expect(page.getByRole('button', { name: /^工作目录：/ })).toHaveAttribute('aria-label', '工作目录：' + directory)
      await page.keyboard.press('Escape')
    }
    await setDirectory(other)
    await page.getByRole('button', { name: '批准执行', exact: true }).click()
    await expect(page.locator('.toast')).toContainText('目录已变化'); assert.equal(calls.length, count)
    await setDirectory(home)
    await fs.writeFile(path.join(home, 'DEEPWRITER.md'), '保持第三人称叙述。')
    await page.getByRole('button', { name: '批准执行', exact: true }).click()
    await expect(page.locator('.toast')).toContainText('项目约定已变化'); assert.equal(calls.length, count)
    await fs.unlink(path.join(home, 'DEEPWRITER.md'))
    await page.getByRole('button', { name: '批准执行', exact: true }).click()
    await page.getByText('已按批准方案把旧钟改为晨钟。', { exact: true }).waitFor()
    assert.equal(await fs.readFile(file, 'utf8'), '海鸥绕过晨钟。'); assert.equal(calls.length, count + 2)
    await restoreSession(); await page.locator('.plan-tag.approved').waitFor()
    await fs.writeFile(file, '海鸥绕过旧钟。')
    await page.locator('.composer textarea').fill('再只读检查一次并提出方案。')
    await page.getByRole('button', { name: '只读审阅', exact: true }).click()
    await page.getByRole('button', { name: '拒绝', exact: true }).waitFor()
    const session = (await page.evaluate(() => window.ds.sessionsList()))[0].id
    const messages = await page.evaluate(id => window.ds.sessionsLoad(id), session)
    const saved = messages.findLast(message => message.plan === 'pending').planApproval
    await page.getByRole('button', { name: '拒绝', exact: true }).click()
    await page.locator('.plan-tag.rejected').waitFor(); await restoreSession(); await page.locator('.plan-tag.rejected').waitFor()
    const afterReject = calls.length
    const rejection = await page.evaluate(async ({ session, saved }) => {
      try { await window.ds.chatStart({ id: crypto.randomUUID(), sessionId: session, phase: 'execute', mode: 'agent', planApproval: saved }); return '' }
      catch (error) { return error.message }
    }, { session, saved })
    assert.match(rejection, /已拒绝/); assert.equal(calls.length, afterReject)
    assert.equal(await fs.readFile(file, 'utf8'), '海鸥绕过旧钟。')
    assert.equal(calls.length, 6)
    console.log('PASS desktop actual composer read-only → persisted plan/reload → drift denied → approve/normal write → reject durable/forgery denied; 6 local workflow requests (plus 1 harmless capability probe only in custom-provider mode)')
  } catch (error) {
    if (page) { console.error('LOCAL_CALLS', calls.length); console.error('RUN_DIAGNOSTICS', JSON.stringify(await page.evaluate(async () => Promise.all((await window.ds.runsListRecent(5)).map(async row => { const run = await window.ds.runsGet(row.runId); return { runId: run.runId, status: run.status, errorCode: run.errorCode, errorMessage: run.errorMessage, tools: run.config.toolPolicy, contract: run.config.completionContract } }))).catch(() => []))); console.error((await page.locator('body').innerText()).slice(-3500)); await page.screenshot({ path: path.join(shots, 'failure.png'), animations: 'disabled' }).catch(() => undefined) }
    throw error
  } finally {
    try { if (app) await shutdown.exports.closeElectronGracefully(app, { profile: home, diagnosticsDir: shots }) } finally {
      server.closeAllConnections(); await new Promise(resolve => server.close(resolve))
      assert.equal(path.dirname(home), os.tmpdir()); assert.ok(path.basename(home).startsWith('dw-plan-desktop-'))
      await fs.rm(home, { recursive: true, force: true })
    }
  }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
