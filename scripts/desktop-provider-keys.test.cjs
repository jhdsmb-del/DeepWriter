const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises'), os = require('node:os'), path = require('node:path'), http = require('node:http')
const { _electron, expect } = require('@playwright/test')
const { buildSync } = require('esbuild')
const root = path.resolve(__dirname, '..')
const helper = { exports: {} }
const built = buildSync({ entryPoints: [path.join(root, 'src/renderer/src/modelFailure.ts')], bundle: true, platform: 'node', format: 'cjs', write: false })
new Function('module', 'exports', built.outputFiles[0].text)(helper, helper.exports)
test('普通聊天区分鉴权、余额、网络故障，并从历史消息恢复正确的任务 id', () => {
  const { modelFailureNotice: notice, messageRunId } = helper.exports
  assert.match(notice('provider_http_401', 'HTTP 401').title, /API Key/)
  assert.match(notice(undefined, 'HTTP 403').title, /权限/)
  assert.match(notice('provider_http_402', 'HTTP 402').title, /余额/)
  assert.match(notice(undefined, 'ERR_INVALID_IP_ADDRESS').title, /网络/)
  assert.match(notice(undefined, 'fetch failed ECONNREFUSED').title, /网络/)
  assert.match(notice('credential_missing', '当前 Profile 的凭据不可用').detail, /填写并保存/)
  assert.equal(notice('completion_budget_exhausted', '需要增加预算'), null)
  assert.equal(messageRunId('m_some-run_assistant'), 'some-run')
  assert.equal(messageRunId('some-run'), 'some-run')
})

async function endpoint(label) {
  const requests = [], state = { status: 200 }
  const server = http.createServer((req, res) => {
    let raw = ''; req.on('data', x => { raw += x }); req.on('end', () => {
      const body = JSON.parse(raw || '{}'); requests.push({ path: req.url, auth: req.headers.authorization, body })
      if (state.status !== 200) { res.writeHead(state.status, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ error: { message: 'isolated synthetic failure', code: state.status === 401 ? 'invalid_api_key' : 'insufficient_balance' } })) }
      const text = `${label} 通道已回复。`, responses = req.url.endsWith('/responses')
      if (!body.stream) {
        res.writeHead(200, { 'content-type': 'application/json' })
        return res.end(JSON.stringify(responses ? { output: [{ type: 'message', content: [{ type: 'output_text', text }] }], usage: { input_tokens: 5, output_tokens: 4 } } : { choices: [{ message: { content: text } }], usage: { prompt_tokens: 5, completion_tokens: 4 } }))
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      if (responses) res.end(`event: response.output_text.delta\ndata: ${JSON.stringify({ type: 'response.output_text.delta', delta: text })}\n\nevent: response.completed\ndata: ${JSON.stringify({ type: 'response.completed', response: { id: 'local', status: 'completed', usage: { input_tokens: 5, output_tokens: 4 } } })}\n\n`)
      else res.end('data: ' + JSON.stringify({ choices: [{ delta: { content: text }, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 4, total_tokens: 9 } }) + '\n\ndata: [DONE]\n\n')
    })
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  return { server, requests, state, base: `http://127.0.0.1:${server.address().port}/tenant/v1` }
}

test('真实桌面官方/自定义配置：草稿隔离、保存再测试、Profile 凭据与聊天一致、显式清除和本机免密', { timeout: 150000 }, async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'dw-ui-provider-key-'))
  const a = await endpoint('A'), b = await endpoint('B')
  const syntheticA = 'synthetic-ui-a', syntheticB = 'synthetic-ui-b', overrideA = 'synthetic-profile-a', replacementB = 'synthetic-ui-b-new'
  let app
  try {
    await fs.writeFile(path.join(home, 'settings.json'), JSON.stringify({ workDir: home, docDir: home, toolsEnabled: false, planMode: false, webAccessEnabled: false }))
    await fs.writeFile(path.join(home, 'AGENTS.md'), '隔离合成模型测试。')
    app = await _electron.launch({ args: [process.env.DW_UI_BUILD_DIR ? path.join(root, process.env.DW_UI_BUILD_DIR, 'main/index.js') : root, '--user-data-dir=' + home], env: { ...process.env, NODE_ENV: 'test', DW_TEST_MODE: '1', DW_TEST_USERDATA: home } })
    const page = await app.firstWindow(); page.setDefaultTimeout(12000)
    page.on('dialog', dialog => dialog.accept())
    const openSettings = async () => { await page.getByRole('button', { name: '设置', exact: true }).click(); await page.getByTestId('provider-registry').waitFor() }
    const snapshot = () => page.evaluate(async () => { const value = await window.ds.providerSnapshot(); if (!value.ok) throw new Error(value.error.message); return value.data })
    const closeSaved = async () => { await page.getByRole('button', { name: '保存并关闭', exact: true }).click(); await page.getByRole('dialog', { name: '设置', exact: true }).waitFor({ state: 'detached' }) }
    const selectProvider = async name => { const nav = page.getByRole('navigation', { name: '模型供应商' }); const button = nav.getByRole('button', { name, exact: true }); if (!await button.isVisible()) await nav.getByText('常用供应商', { exact: true }).click(); await button.click() }
    const modelRow = () => page.locator('.dw-provider-model-row').first()
    const connection = async () => { const details = modelRow().locator('details'); if (await details.getAttribute('open') === null) await details.locator('summary').click(); await details.getByRole('button', { name: /^测试 .* 连接$/ }).click() }
    const chat = async text => { await page.keyboard.press('Control+n'); await page.getByRole('textbox', { name: '任务内容' }).fill(text); await page.getByRole('button', { name: '发送', exact: true }).click() }
    const abandon = async () => { await page.evaluate(async () => { for (const run of await window.ds.runsRecoverable()) await window.ds.runsAbandon(run.runId) }); await page.getByRole('button', { name: '发送', exact: true }).waitFor() }

    await openSettings()
    await selectProvider('DeepSeek')
    await page.getByLabel('当前供应商 Base URL', { exact: true }).fill(a.base)
    await page.getByLabel('当前供应商 API Key', { exact: true }).fill(syntheticA)
    await selectProvider('OpenAI')
    await page.getByLabel('当前供应商 Base URL', { exact: true }).fill(b.base)
    await page.getByLabel('当前供应商 API Key', { exact: true }).fill(syntheticB)
    await page.getByLabel('添加模型 ID', { exact: true }).fill('synthetic-b-model')
    await page.getByRole('button', { name: '工作区', exact: true }).click()
    await page.getByRole('button', { name: '模型与接口', exact: true }).click()
    await expect(page.getByLabel('当前供应商 API Key', { exact: true })).toHaveValue(syntheticB)
    await expect(page.getByLabel('添加模型 ID', { exact: true })).toHaveValue('synthetic-b-model')
    await page.locator('form.dw-provider-model-input').getByRole('button', { name: '添加模型', exact: true }).click()
    await expect(modelRow()).toContainText('synthetic-b-model')
    await selectProvider('DeepSeek')
    await expect(page.getByLabel('当前供应商 Base URL', { exact: true })).toHaveValue(a.base)
    await expect(page.getByLabel('当前供应商 API Key', { exact: true })).toHaveValue(syntheticA)
    await connection()
    await expect.poll(() => a.requests.length).toBe(1)
    assert.ok(a.requests[0].auth === `Bearer ${syntheticA}`)
    assert.equal(a.requests[0].path, '/tenant/v1/chat/completions')
    const afterA = await snapshot(), selectedA = afterA.providers.find(provider => provider.baseUrl === new URL(a.base).origin)
    assert.ok(selectedA && selectedA.kind === 'custom', 'Editing the builtin endpoint must use the returned custom provider identity')
    const explicit = await page.evaluate(async ({ id, secret }) => {
      const ds = window.ds, current = (await ds.providerSnapshot()).data
      const profile = current.profiles.find(item => item.id === (current.bindings.draftProfileId ?? current.bindings.defaultProfileId))
      const created = await ds.credentialCreate(id, '合成独立 Profile 凭据', secret)
      if (!created.ok) throw new Error(created.error.message)
      const { createdAt, updatedAt, ...input } = profile
      const saved = await ds.profileUpsert({ ...input, credentialRefId: created.data.id })
      if (!saved.ok) throw new Error(saved.error.message)
      window.dispatchEvent(new Event('deepwriter:provider-registry-changed'))
      return saved.data.id
    }, { id: selectedA.id, secret: overrideA })
    await expect(page.getByText('当前模型使用独立密钥', { exact: true })).toBeVisible()
    await connection(); await expect.poll(() => a.requests.length).toBe(2)
    assert.ok(a.requests[1].auth === `Bearer ${overrideA}`)
    await closeSaved() // Saves B's pending URL/key as well, despite A being selected.
    assert.ok(!(await page.locator('body').innerText()).includes(syntheticA))
    await chat('只回复一条用于 A 通道的连接回执。')
    await expect(page.locator('.msg.assistant').last()).toContainText('A 通道已回复。')
    assert.ok(a.requests.at(-1).auth === `Bearer ${overrideA}`); assert.equal(a.requests.at(-1).body.model, a.requests[1].body.model)
    { const bindings = (await snapshot()).bindings; assert.equal(bindings.draftProfileId ?? bindings.defaultProfileId, explicit) }

    await openSettings()
    await page.getByRole('button', { name: '改用供应商默认密钥', exact: true }).click()
    await expect(page.getByText('当前模型使用独立密钥', { exact: true })).toHaveCount(0)
    const beforeDefault = a.requests.length
    await connection(); await expect.poll(() => a.requests.length).toBeGreaterThan(beforeDefault)
    assert.ok(a.requests.at(-1).auth === `Bearer ${syntheticA}`)
    await selectProvider('OpenAI')
    await expect(page.getByLabel('当前供应商 API Key', { exact: true })).toHaveValue('')
    await expect(page.getByLabel('当前供应商 API Key', { exact: true })).toHaveAttribute('placeholder', '已保存，留空保持不变')
    await page.getByLabel('当前供应商 API Key', { exact: true }).fill(replacementB)
    await connection(); await expect.poll(() => b.requests.length).toBe(1)
    assert.ok(b.requests[0].auth === `Bearer ${replacementB}`); assert.equal(b.requests[0].path, '/tenant/v1/responses')
    await modelRow().getByRole('button', { name: /synthetic-b-model .*选择/ }).click()
    await closeSaved(); await chat('只回复一条用于 B 通道的连接回执。')
    await expect(page.locator('.msg.assistant').last()).toContainText('B 通道已回复。')
    assert.ok(b.requests.at(-1).auth === `Bearer ${replacementB}`)

    await openSettings(); await selectProvider('OpenAI')
    await page.getByRole('button', { name: '清除已保存密钥', exact: true }).click()
    await page.getByRole('button', { name: '保存配置', exact: true }).click()
    const beforeMissing = b.requests.length
    await connection(); await expect(page.locator('.dw-provider-message')).toContainText('未配置可用的 API Key')
    assert.equal(b.requests.length, beforeMissing)
    await closeSaved(); await chat('未配置密钥时保留这份草稿。')
    await expect(page.locator('.composer-submit-error')).toContainText('API Key')
    await expect(page.locator('.composer-submit-error').getByRole('button', { name: '打开模型设置' })).toBeVisible()
    assert.equal(b.requests.length, beforeMissing)

    await page.locator('.composer-submit-error').getByRole('button', { name: '打开模型设置' }).click()
    await page.getByRole('button', { name: '＋ 添加供应商', exact: true }).click()
    await page.getByLabel('供应商名称', { exact: true }).fill('合成本机服务')
    await page.getByLabel('供应商 Base URL', { exact: true }).fill(a.base + '/local')
    await page.getByLabel('模型 ID 1', { exact: true }).fill('synthetic-local')
    await page.locator('button.dw-provider-save').click()
    await expect(page.locator('.dw-provider-message')).toContainText('API Key')
    await page.getByRole('checkbox', { name: '本机服务无需 API Key' }).check()
    await page.locator('button.dw-provider-save').click()
    await expect(page.locator('.dw-provider-header')).toContainText('合成本机服务')
    await modelRow().getByRole('button', { name: /synthetic-local .*选择/ }).click()
    await closeSaved(); await chat('本机免密仅用于本机端点。')
    await expect(page.locator('.msg.assistant').last()).toContainText('A 通道已回复。')
    assert.equal(a.requests.at(-1).auth, undefined)

    for (const [status, title] of [[401, 'API Key 或模型权限未通过验证'], [402, '服务商余额不足']]) {
      a.state.status = status
      await chat(`请验证合成 HTTP ${status} 失败说明。`)
      await expect(page.locator('.msg.assistant').last().locator('.model-failure')).toContainText(title, { timeout: 25000 })
      await abandon()
    }
    a.server.closeAllConnections(); await new Promise(resolve => a.server.close(resolve))
    await chat('网络连接失败时给出可操作的说明。')
    await expect(page.locator('.msg.assistant').last().locator('.model-failure')).toContainText('网络连接失败', { timeout: 35000 })
    if (process.env.DW_KEY_SCREENSHOT) await page.locator('.msg.assistant').last().screenshot({ path: process.env.DW_KEY_SCREENSHOT, animations: 'disabled', scale: 'css' })
    await abandon()
  } finally {
    if (app) await app.close()
    for (const entry of [a, b]) { entry.server.closeAllConnections(); if (entry.server.listening) await new Promise(resolve => entry.server.close(resolve)) }
    if (path.dirname(home) === os.tmpdir() && path.basename(home).startsWith('dw-ui-provider-key-')) await fs.rm(home, { recursive: true, force: true })
  }
})
