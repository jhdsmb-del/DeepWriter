'use strict'
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const http = require('node:http')
const { execFileSync } = require('node:child_process')
const { _electron: electron, expect } = require('@playwright/test')
const root = path.resolve(__dirname, '..')
async function main() {
  const calls = [], errors = []
  const server = http.createServer((req, res) => {
    let body = ''
    req.on('data', chunk => { body += chunk })
    req.on('end', () => {
      if (!req.url.endsWith('/chat/completions')) { res.writeHead(404).end(); return }
      const request = JSON.parse(body)
      calls.push({ path: req.url, request, authenticated: req.headers.authorization === 'Bearer synthetic-chat-key' })
      if (request.model === 'fixture-reject') { res.writeHead(401, { 'content-type': 'application/json' }).end(JSON.stringify({ error: { message: 'Synthetic authentication failure' } })); return }
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.write('data: ' + JSON.stringify({ choices: [{ delta: { role: 'assistant', content: `对话 ${calls.length}：模型调用成功，` }, finish_reason: null }] }) + '\n\n')
      setTimeout(() => {
        res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: '对话已恢复。' }, finish_reason: null }] }) + '\n\n')
        res.write('data: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 } }) + '\n\n')
        res.end('data: [DONE]\n\n')
      }, 250)
    })
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dw-custom-chat-'))
  const packagedExecutable = process.env.DW_CHAT_SMOKE_EXECUTABLE
  let app, pid
  try {
    app = await electron.launch({ ...(packagedExecutable ? { executablePath: path.resolve(packagedExecutable), args: [] } : { args: [path.join(root, 'out/main/index.js')] }), env: { ...process.env, NODE_ENV: 'test', DW_TEST_USERDATA: profileDir } })
    pid = app.process().pid
    const page = await app.firstWindow()
    page.setDefaultTimeout(10000)
    await page.waitForLoadState('domcontentloaded')
    await page.getByRole('button', { name: '设置', exact: true }).waitFor()
    const provider = await page.evaluate(async baseUrl => {
      const result = await window.ds.providerCreateSetup({ displayName: 'Chat fixture', baseUrl, apiKey: 'synthetic-chat-key', protocol: 'openai-chat', modelIds: ['deepseek-flash', 'unknown-chat-fixture', 'fixture-reject'] })
      if (!result.ok) throw new Error(result.error.message)
      return result.data
    }, `http://127.0.0.1:${server.address().port}/v1`)
    await page.evaluate(() => window.dispatchEvent(new Event('deepwriter:provider-registry-changed')))
    const snapshot = (await page.evaluate(() => window.ds.providerSnapshot())).data
    const unused = snapshot.bindings.defaultProfileId
    const bindings = await page.evaluate(profileId => window.ds.profileSetBindings({ defaultProfileId: profileId, planningProfileId: profileId, reviewProfileId: profileId, polishProfileId: profileId }), unused)
    assert.equal(bindings.ok, true)
    for (const id of packagedExecutable ? ['unknown-chat-fixture'] : ['deepseek-flash', 'unknown-chat-fixture', 'fixture-reject', 'unknown-chat-fixture']) {
      await page.getByTestId('model-reasoning-trigger').click()
      await page.getByRole('button', { name: '选择模型', exact: true }).click()
      const model = snapshot.models.find(row => row.providerId === provider.id && row.remoteModelId === id)
      await page.getByRole('option', { name: `${model.displayName} · Chat fixture`, exact: true }).click()
      await expect(page.getByTestId('model-reasoning-trigger')).toHaveAttribute('aria-label', new RegExp(`^当前模型 ${model.displayName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} · Chat fixture`))
      await page.keyboard.press('Escape')
      await page.getByTestId('model-reasoning-panel').waitFor({ state: 'detached' })
      const before = calls.length
      let observedError = ''
      await page.getByRole('textbox', { name: '任务内容', exact: true }).fill(`测试 ${id} 的正常对话`)
      if (before === 3) await page.getByRole('textbox', { name: '任务内容', exact: true }).press('Enter')
      else await page.getByRole('button', { name: '发送', exact: true }).click()
      for (let attempt = 0; attempt < 75; attempt++) {
        assert.equal(await page.getByRole('dialog', { name: '本次任务费用无法估算', exact: true }).isVisible(), false, 'Reference-price metadata must not interrupt an ordinary send')
        if (calls.length > before && (await page.locator('.composer textarea').inputValue()) === '') break
        const status = await page.locator('[role="status"], [role="alert"], .toast').allTextContents()
        observedError = status.filter(line => /失败|未知|超过|没有|不可用/.test(line)).join(' / ') || observedError
        await page.waitForTimeout(100)
      }
      const text = await page.locator('body').innerText()
      if (calls.length === before) {
        errors.push(id + ': ' + (observedError || text.slice(-2000)))
        console.log('FAIL ' + errors.at(-1))
      } else {
        assert.equal(calls.at(-1).request.model, id)
        assert.equal(calls.at(-1).authenticated, true)
        if (id === 'fixture-reject') {
          try { await page.getByText(/Provider HTTP 401/).first().waitFor() }
          catch (error) {
            console.log('ERROR DISPLAY: ' + (await page.locator('body').innerText()).slice(-2200))
            console.log('ERROR RUN: ' + JSON.stringify(await page.evaluate(async () => (await window.ds.runsListRecent(5)).map(run => ({ status: run.status, errorCode: run.errorCode, errorMessage: run.errorMessage })))))
            throw error
          }
        }
        else await page.getByText(`对话 ${before + 1}：模型调用成功，对话已恢复。`, { exact: true }).waitFor()
        await page.getByRole('button', { name: '发送', exact: true }).waitFor()
        const config = await page.evaluate(async () => (await window.ds.runsGet((await window.ds.runsListRecent(1))[0].runId)).config)
        for (const stage of ['default', 'planning', 'review', 'polish']) assert.equal(config.providerProfileSnapshots[stage], null, `Unused ${stage} must not block chat`)
        assert.equal(config.providerProfileSnapshots.draft.model.remoteModelId, id)
        if (id === 'unknown-chat-fixture') assert.equal(calls.at(-1).request.max_tokens, 2048)
        console.log('PASS ' + id + ': visible model selector → actual composer → request → ' + (id === 'fixture-reject' ? 'error recovery' : 'visible streamed reply') + ' → ready for next send')
      }
    }
    assert.equal(errors.length, 0, errors.join('\n'))
    if (packagedExecutable) {
      const evidence = path.join(root, 'out', `chat-smoke-${require('../package.json').version}`)
      fs.mkdirSync(evidence, { recursive: true })
      await page.screenshot({ path: path.join(evidence, 'packaged-chat.png'), animations: 'disabled' })
    }
    console.log('Custom chat UI smoke: PASS')
  } finally {
    if (app) {
      let timer
      const closed = await Promise.race([app.close().then(() => true, () => false), new Promise(resolve => { timer = setTimeout(() => resolve(false), 10000) })])
      clearTimeout(timer)
      if (!closed && pid) { try { execFileSync('taskkill', ['/F', '/T', '/PID', String(pid)], { windowsHide: true, stdio: 'ignore' }) } catch {} }
    }
    server.closeAllConnections()
    await new Promise(resolve => server.close(resolve))
    fs.rmSync(profileDir, { recursive: true, force: true })
  }
}
main().catch(error => { console.error(error.message); process.exitCode = 1 })
