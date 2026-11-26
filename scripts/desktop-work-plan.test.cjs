// QA: live committed receipt, refresh after real tool completion, reload/cold
// detail, blocked dependency, no-list reply and native/narrow window wrapping.
const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises'), os = require('node:os'), path = require('node:path'), http = require('node:http')
const { _electron, expect } = require('@playwright/test')
const root = path.resolve(__dirname, '..')

async function verifyWorkPlan({ screenshots = process.env.DW_WORK_PLAN_SCREENSHOTS, onWindow } = {}) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'dw-desktop-work-plan-'))
  let app, page, release, requests = 0, serverError
  const first = [{ text: '读取两份资料并找出差异', status: 'done' }, { text: '整理修改建议', status: 'in_progress' }, { text: '核对全部交付项', status: 'pending' }]
  const second = [{ ...first[0] }, { ...first[1], status: 'done' }, { ...first[2], status: 'in_progress' }]
  const server = http.createServer((req, res) => { let raw = ''; req.on('data', part => { raw += part }); req.on('end', () => {
    try {
      const body = JSON.parse(raw)
      if (!body.stream && body.tools?.[0]?.function?.name === 'deepwriter_tool_probe') {
        const nonce = body.tools[0].function.parameters.properties.nonce.enum[0]
        res.writeHead(200, { 'content-type': 'application/json' })
        return res.end(JSON.stringify({ choices: [{ finish_reason: 'tool_calls', message: { role: 'assistant', tool_calls: [{ id: 'plan-probe', type: 'function', function: { name: 'deepwriter_tool_probe', arguments: JSON.stringify({ nonce }) } }] } }] }))
      }
      requests++
      const reply = (steps) => {
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        const delta = steps ? { tool_calls: [{ index: 0, id: 'work-plan-' + requests, type: 'function', function: { name: 'update_work_plan', arguments: JSON.stringify({ steps, ...(requests === 2 ? { blockedOn: '合作方提供最终确认件' } : {}) }) } }] } : { content: '这次任务的工作记录已经保存。' }
        res.end('data: ' + JSON.stringify({ choices: [{ delta, finish_reason: steps ? 'tool_calls' : 'stop' }] }) + '\n\ndata: [DONE]\n\n')
      }
      const plain = body.messages.some(message => message.role === 'user' && message.content.includes('单步问候'))
      if (plain || requests >= 3) return reply()
      assert.ok(body.tools.some(tool => tool.function.name === 'update_work_plan'))
      if (requests === 1) reply(first)
      else release = () => reply(second)
    } catch (error) { serverError = error; res.destroy(error) }
  }) })
  const launch = async () => {
    app = await _electron.launch({ args: [path.join(root, process.env.DW_UI_BUILD_DIR || 'out', 'main/index.js'), '--user-data-dir=' + home], env: { ...process.env, DEEPWRITER_API_KEY: '', NODE_ENV: 'test', DW_TEST_MODE: '1', DW_TEST_USERDATA: home } })
    page = await app.firstWindow(); page.setDefaultTimeout(12000)
    onWindow?.(app, page)
    await page.getByRole('textbox', { name: '任务内容' }).waitFor()
  }
  const openActive = async () => {
    await page.getByRole('button', { name: '任务中心', exact: true }).click()
    await page.locator('.dw-task-run-main').first().click()
  }
  const checklist = () => page.locator('.run-inspector').getByTestId('work-plan-progress')
  try {
    await fs.writeFile(path.join(home, 'settings.json'), JSON.stringify({ workDir: home, docDir: home, planMode: false, toolsEnabled: true, webAccessEnabled: false }))
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); await launch()
    await page.evaluate(async baseUrl => {
      const ds = window.ds, saved = await ds.providerCreateSetup({ displayName: '本机清单模型', baseUrl, apiKey: '', protocol: 'openai-chat', modelIds: ['local-work-plan'] })
      if (!saved.ok) throw new Error(saved.error.message)
      const snapshot = (await ds.providerSnapshot()).data, profile = snapshot.profiles.find(item => item.providerId === saved.data.id)
      const probe = await ds.modelProbeTools(profile.modelId, saved.data.defaultCredentialRefId, true)
      if (!probe.ok || probe.data.outcome !== 'supported') throw new Error('本机工具协议未通过探测')
      await ds.profileSetBindings({ ...snapshot.bindings, defaultProfileId: profile.id, draftProfileId: profile.id })
      window.dispatchEvent(new Event('deepwriter:provider-registry-changed'))
    }, `http://127.0.0.1:${server.address().port}/v1`)
    await page.getByRole('textbox', { name: '任务内容' }).fill('比较两份资料，整理修改建议并核对全部交付项。')
    await page.getByRole('button', { name: '发送', exact: true }).click()
    await expect(page.getByTestId('work-plan-progress')).toContainText('核对全部交付项')
    await expect(page.getByTestId('work-plan-progress').locator('.in_progress')).toContainText('整理修改建议')
    const initialBounds = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(window => !window.webContents.getURL().includes('window='))?.getBounds())
    assert(initialBounds.width >= 800 && initialBounds.height >= 600)
    if (screenshots) await page.screenshot({ path: path.join(screenshots, 'work-plan-live.png'), animations: 'disabled', scale: 'css' })
    const runId = await page.evaluate(async () => (await window.ds.runsListRecent())[0].runId)
    await page.reload(); await page.getByRole('textbox', { name: '任务内容' }).waitFor()
    await openActive()
    await expect(checklist().locator('.in_progress')).toContainText('整理修改建议')
    assert.equal(requests, 2, 'renderer reload must not replay tools or call the model')
    assert.equal(typeof release, 'function'); release(); release = null
    await expect(checklist().locator('.in_progress')).toContainText('核对全部交付项')
    await expect(checklist()).toContainText('等待：合作方提供最终确认件')
    await expect(checklist().locator('.done')).toHaveCount(2)
    await expect(page.locator('.run-inspector .ri-terminal-title')).toHaveText('已暂停')
    assert.ifError(serverError)
    const detail = await page.evaluate(id => window.ds.runsGet(id), runId)
    assert.deepEqual(detail.workPlan, { version: 1, steps: second, blockedOn: '合作方提供最终确认件' })
    const fit = await checklist().evaluate(element => { const rect = element.getBoundingClientRect(); return { x: rect.x, right: rect.right, width: innerWidth, overflow: element.scrollWidth > element.clientWidth } })
    assert(fit.x >= 0 && fit.right <= fit.width && !fit.overflow)
    if (screenshots) await page.screenshot({ path: path.join(screenshots, 'work-plan-detail.png'), animations: 'disabled', scale: 'css' })
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(window => !window.webContents.getURL().includes('window='))?.setSize(900, 720))
    const narrow = await checklist().evaluate(element => { const rect = element.getBoundingClientRect(); return rect.x >= 0 && rect.right <= innerWidth && element.scrollWidth <= element.clientWidth })
    assert(narrow, 'checklist must fit the narrower desktop window')
    if (screenshots) await page.screenshot({ path: path.join(screenshots, 'work-plan-narrow.png'), animations: 'disabled', scale: 'css' })
    await page.getByRole('button', { name: '关闭任务详情', exact: true }).click()
    await app.close(); app = null
    await launch()
    const cold = await page.evaluate(id => window.ds.runsGet(id), runId)
    assert.deepEqual(cold.workPlan, detail.workPlan)
    await page.getByRole('button', { name: '任务中心', exact: true }).click()
    await page.locator('.dw-task-run-main').first().click()
    await expect(checklist()).toContainText('合作方提供最终确认件')
    await page.getByRole('button', { name: '关闭任务详情', exact: true }).click()
    await page.getByRole('button', { name: '新建会话', exact: true }).click()
    await page.getByRole('button', { name: 'Agent', exact: true }).click()
    await page.getByRole('textbox', { name: '任务内容' }).fill('单步问候，不需要清单。')
    await page.getByRole('button', { name: '发送', exact: true }).click()
    await expect(page.locator('.msg.assistant').last()).toContainText('工作记录已经保存')
    await expect(page.getByTestId('work-plan-progress')).toHaveCount(0)
    const plainRun = await page.evaluate(async () => (await window.ds.runsListRecent())[0].runId)
    assert.equal((await page.evaluate(id => window.ds.runsGet(id), plainRun)).workPlan, null)
  } finally {
    if (release) release()
    if (app) await app.close().catch(() => {})
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve))
    assert.equal(path.dirname(home), os.tmpdir()); assert(path.basename(home).startsWith('dw-desktop-work-plan-'))
    await fs.rm(home, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
  }
}

module.exports = { verifyWorkPlan }
if (require.main === module) test('ordinary Agent checklist is durable, refreshes from completed tool receipts, and stays absent without a list', { timeout: 75000 }, verifyWorkPlan)
