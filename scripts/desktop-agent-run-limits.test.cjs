const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises'), os = require('node:os'), path = require('node:path')
const { _electron, expect } = require('@playwright/test')
const root = path.resolve(__dirname, '..')
const off = { maxCalls: null, maxTurns: null, maxTokens: null, maxWallClockMs: null, maxCost: null }

// QA: optional defaults, real selection/save/reopen, remove one/all, cancel,
// validation, unchanged old explicit values/currency and native/narrow fit.
async function verifyAgentRunLimits({ screenshots = process.env.DW_RUN_LIMITS_SCREENSHOTS, onWindow } = {}) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'dw-run-limits-ui-'))
  let app, page
  const launch = async () => {
    app = await _electron.launch({ args: [path.join(root, process.env.DW_UI_BUILD_DIR || 'out', 'main/index.js'), '--user-data-dir=' + home], env: { ...process.env, DEEPWRITER_API_KEY: '', NODE_ENV: 'test', DW_TEST_MODE: '1', DW_TEST_USERDATA: home } })
    page = await app.firstWindow(); page.setDefaultTimeout(12000)
    onWindow?.(app, page)
    await page.getByRole('textbox', { name: '任务内容' }).waitFor()
  }
  const open = async () => {
    await page.locator('.dw-topbar').getByRole('button', { name: '设置', exact: true }).click()
    await page.locator('.dw-settings-nav').getByRole('button', { name: '完成与预算', exact: true }).click()
  }
  const limits = () => page.getByTestId('agent-run-limits')
  const expand = async () => { if (await limits().locator('details').getAttribute('open') === null) await limits().locator('summary').click() }
  const save = async () => { await page.getByRole('button', { name: '保存并关闭', exact: true }).click(); await expect(page.locator('.dw-settings-modal')).toHaveCount(0) }
  const read = () => page.evaluate(() => window.ds.getSettings())
  const shot = async name => { if (screenshots) await page.screenshot({ path: path.join(screenshots, name + '.png'), animations: 'disabled', scale: 'css' }) }
  try {
    await fs.writeFile(path.join(home, 'settings.json'), JSON.stringify({ workDir: home, docDir: home }))
    await launch(); await open()
    assert.deepEqual((await read()).agentRunBudget, off)
    await expect(limits().locator('summary')).toHaveText('未设置限制')
    assert.equal(await limits().locator('details').getAttribute('open'), null)
    assert.equal(await page.locator('.dw-writing-settings').getAttribute('open'), null)
    await shot('run-limits-default')
    await expand()
    for (const label of ['模型调用次数', '任务轮数', '总 token 用量', '运行时间', '费用上限']) await expect(limits().getByRole('spinbutton', { name: label, exact: true })).toHaveValue('')
    await limits().getByRole('spinbutton', { name: '模型调用次数', exact: true }).fill('700')
    await limits().getByRole('spinbutton', { name: '任务轮数', exact: true }).fill('1200')
    await limits().getByRole('spinbutton', { name: '总 token 用量', exact: true }).fill('30000000')
    await limits().getByRole('spinbutton', { name: '运行时间', exact: true }).fill('1500')
    await limits().getByRole('spinbutton', { name: '费用上限', exact: true }).fill('2.5')
    await limits().getByRole('button', { name: '费用上限币种', exact: true }).click()
    await page.getByRole('option', { name: 'USD 美元', exact: true }).click()
    await save(); await open(); await expand()
    const chosen = { maxCalls: 700, maxTurns: 1200, maxTokens: 30000000, maxWallClockMs: 90000000, maxCost: { amount: 2.5, currency: 'USD', unknownPolicy: 'deny' } }
    assert.deepEqual((await read()).agentRunBudget, chosen)
    await expect(limits().getByRole('spinbutton', { name: '模型调用次数', exact: true })).toHaveValue('700')
    await expect(limits().getByRole('button', { name: '费用上限币种', exact: true })).toHaveText('USD 美元')
    await shot('run-limits-configured')
    await limits().getByRole('spinbutton', { name: '模型调用次数', exact: true }).fill('1.5')
    await page.getByRole('button', { name: '保存并关闭', exact: true }).click()
    await expect(page.locator('.dw-settings-modal')).toBeVisible()
    await expect(limits().getByRole('alert')).toContainText('正整数')
    assert.deepEqual((await read()).agentRunBudget, chosen)
    await limits().getByRole('spinbutton', { name: '模型调用次数', exact: true }).fill('')
    await save(); await open(); await expand()
    assert.deepEqual((await read()).agentRunBudget, { ...chosen, maxCalls: null })
    await limits().getByRole('spinbutton', { name: '任务轮数', exact: true }).fill('88')
    await page.getByRole('button', { name: '取消', exact: true }).click()
    await open(); await expand()
    await expect(limits().getByRole('spinbutton', { name: '任务轮数', exact: true })).toHaveValue('1200')
    await limits().getByRole('button', { name: '关闭全部限制', exact: true }).click()
    await expect(limits().locator('summary')).toContainText('未设置限制')
    await save(); await open()
    assert.deepEqual((await read()).agentRunBudget, off)
    await shot('run-limits-cleared')
    await page.getByRole('button', { name: '关闭设置', exact: true }).click()
    await app.close(); app = null
    const old = { maxCalls: 800, maxTurns: 2000, maxTokens: 30000001, maxWallClockMs: 90000001, maxCost: { amount: 12.75, currency: 'EUR', unknownPolicy: 'deny' } }
    await fs.writeFile(path.join(home, 'settings.json'), JSON.stringify({ workDir: home, docDir: home, agentRunBudget: old, completionTokenBudget: 876543, completionWallClockMs: 123456, themeLockMode: 'guided' }))
    await launch(); await open(); await expand()
    await expect(limits().getByRole('spinbutton', { name: '模型调用次数', exact: true })).toHaveValue('800')
    await expect(limits().getByRole('spinbutton', { name: '总 token 用量', exact: true })).toHaveValue('30000001')
    await expect(limits().getByRole('spinbutton', { name: '运行时间', exact: true })).toHaveValue(String(old.maxWallClockMs))
    await expect(limits().getByText('毫秒', { exact: true })).toBeVisible()
    await expect(limits().getByRole('button', { name: '费用上限币种', exact: true })).toHaveText('EUR')
    await shot('run-limits-existing')
    const before = await read(); await save()
    assert.deepEqual((await read()).agentRunBudget, old)
    assert.equal((await read()).completionTokenBudget, before.completionTokenBudget)
    assert.equal((await read()).completionWallClockMs, before.completionWallClockMs)
    await open(); await expand()
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(window => !window.webContents.getURL().includes('window='))?.setSize(900, 720))
    const fit = await page.locator('.dw-settings-modal').evaluate(element => { const rect = element.getBoundingClientRect(); return rect.x >= 0 && rect.right <= innerWidth && rect.y >= 0 && rect.bottom <= innerHeight && element.scrollWidth <= element.clientWidth })
    assert(fit, 'settings and actions fit the narrow desktop window')
    await shot('run-limits-narrow')
  } finally {
    if (app) await app.close().catch(() => {})
    assert.equal(path.dirname(home), os.tmpdir()); assert(path.basename(home).startsWith('dw-run-limits-ui-'))
    await fs.rm(home, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
  }
}
module.exports = { verifyAgentRunLimits }
if (require.main === module) test('Agent run limits default off, support optional saved limits, clear/cancel, and preserve older explicit settings', { timeout: 75000 }, verifyAgentRunLimits)
