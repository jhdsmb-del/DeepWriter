import { _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { mkdtemp, rm, stat } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
let passed = 0
function check(name: string, condition: boolean, detail = ''): void {
  if (!condition) throw new Error(`${name}${detail ? ` — ${detail}` : ''}`)
  passed += 1
  console.log(`  PASS  ${name}`)
}

async function closeApp(app: ElectronApplication): Promise<void> {
  const main = app.windows().find((page) => !page.url().includes('window=float'))
  await main?.evaluate(async () => (window as any).ds?.testShutdown?.()).catch(() => undefined)
  await app.close().catch(() => undefined)
}

async function waitForRunEnd(page: Page): Promise<void> {
  await page.locator('.composer .btn.stop').waitFor({ state: 'visible', timeout: 15_000 })
  await page.locator('.composer .btn.stop').waitFor({ state: 'hidden', timeout: 30_000 })
}

async function main(): Promise<void> {
  console.log('\n[R43 Electron smoke] task center + idle float + truthful billing')
  const userData = await mkdtemp(path.join(tmpdir(), 'deepwriter-r43-e2e-'))
  const screenshotPath = path.join(ROOT, 'e2e-screenshots', 'ui-billing-1.1.1.png')
  let requestCount = 0
  const server = createServer((request, response) => {
    requestCount += 1
    response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
    response.write(`data: ${JSON.stringify({ id: 'r43-e2e-request', choices: [{ delta: { content: '一段经过真实工作流生成的短文。' }, finish_reason: null }] })}\n\n`)
    const timer = setTimeout(() => {
      response.write(`data: ${JSON.stringify({ id: 'r43-e2e-request', choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 9, completion_tokens: 2, total_tokens: 11 } })}\n\n`)
      response.end('data: [DONE]\n\n')
    }, requestCount === 1 ? 350 : 10_000)
    request.once('close', () => clearTimeout(timer))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  let app: ElectronApplication | null = null
  try {
    const address = server.address()
    check('mock provider bound locally', Boolean(address && typeof address === 'object'))
    app = await electron.launch({
      args: [path.join(ROOT, 'out', 'main', 'index.js')],
      env: { ...process.env, NODE_ENV: 'test', DW_TEST_USERDATA: userData }
    })
    const page = await app.firstWindow()
    await page.waitForSelector('.composer', { timeout: 15_000 })
    const nav = page.locator('.dw-global-nav')
    check('global navigation exposes all five primary destinations', await nav.locator('button').count() === 5)
    check('Agent is the accessible current page', await nav.getByRole('button', { name: 'Agent' }).getAttribute('aria-current') === 'page')
    check('Agent page exposes task center and compact workflow entrances', await nav.getByRole('button', { name: '任务中心' }).isVisible() && await page.getByRole('button', { name: /^工作流/ }).isVisible())
    await nav.getByRole('button', { name: '任务中心' }).click()
    const idleFloatButtons = page.getByRole('button', { name: '打开悬浮进度窗' })
    check('idle floating window action stays disabled', await idleFloatButtons.count() >= 1 && await idleFloatButtons.evaluateAll((buttons) => buttons.every((button) => (button as HTMLButtonElement).disabled)))
    await nav.getByRole('button', { name: 'Agent' }).click()

    const port = (address as { port: number }).port
    await page.evaluate(async (mockPort) => {
      const ds = (window as any).ds
      const current = await ds.getSettings()
      await ds.setSettings({ ...current, apiKey: 'local-e2e-only', baseUrl: `http://127.0.0.1:${mockPort}`, model: 'deepseek-v4-flash', thinkingEnabled: false, toolsEnabled: false, planMode: false })
    }, port)
    await page.reload()
    await page.waitForSelector('.composer')
    await page.locator('.composer textarea').fill('写一句克制的开场。')
    const floatPromise = app.waitForEvent('window')
    await page.locator('.composer .btn.primary').click()
    const float = await floatPromise
    const autoFloatDeadline = Date.now() + 10_000
    let autoFloatVisible = false
    while (!autoFloatVisible && Date.now() < autoFloatDeadline) {
      autoFloatVisible = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().some((win) => win.webContents.getURL().includes('window=float') && win.isVisible()))
      if (!autoFloatVisible) await page.waitForTimeout(100)
    }
    check('first run start automatically surfaces float when user has not hidden it', autoFloatVisible)
    await page.locator('.dw-activity-rail').getByText(/正在|准备|理解|思考|写作/).first().waitFor({ timeout: 15_000 })
    check('Activity Rail consumes the live workflow', await page.locator('.dw-activity-rail .dw-task-run').count() >= 1)
    await waitForRunEnd(page)
    await float.waitForSelector('.dw-float-root.status-completed', { timeout: 15_000 })
    check('visible float keeps completed state instead of timer hiding', await float.locator('.dw-float-root.status-completed').count() === 1)

    await nav.getByRole('button', { name: '任务中心' }).click()
    await page.locator('.dw-agent-task-center.is-full').waitFor()
    await page.locator('.dw-task-recent').first().waitFor({ timeout: 15_000 })
    check('recent completed comes from a durable completed run', await page.locator('.dw-task-recent').first().innerText().then((text) => text.includes('已完成')))
    await page.locator('.dw-task-recent').first().getByRole('button', { name: '账单' }).click()
    const billing = page.locator('[data-testid="run-billing-panel"]')
    await billing.waitFor({ timeout: 15_000 })
    const billingText = await billing.innerText()
    check('账单首屏先展示总额与费用去向', billingText.includes('本次任务总费用') && billingText.includes('费用花到哪了') && billingText.includes('生成与任务编排') && billingText.includes('工具执行'), billingText.slice(0, 900))
    check('输入/生成/缓存/推理一眼可见且未知不伪造', billingText.includes('输入\n9') && billingText.includes('生成文本\n2') && billingText.includes('缓存命中\n未知') && billingText.includes('缓存未命中\n未知') && billingText.includes('模型推理\n未知') && /费用未知/u.test(billingText) && !billingText.includes('¥0.0000'), billingText.slice(0, 1100))
    await billing.locator('.ri-audit-details > summary').click()
    const auditText = await billing.innerText()
    check('Provider、首字延迟和成功结果保留在审计明细', auditText.includes('127.0.0.1') && auditText.includes('deepseek-v4-flash') && auditText.includes('首字延迟') && auditText.includes('成功'))
    await page.screenshot({ path: screenshotPath, fullPage: true })
    check('task center and billing screenshot can be captured', (await stat(screenshotPath)).size > 10_000)

    await page.getByRole('button', { name: '关闭任务详情' }).click()
    await page.reload()
    await page.waitForSelector('.dw-global-nav')
    await page.locator('.dw-global-nav').getByRole('button', { name: '任务中心' }).click()
    await page.locator('.dw-task-recent').first().waitFor({ timeout: 15_000 })
    check('recent completed survives renderer reload', await page.locator('.dw-task-recent').count() >= 1)
    await page.locator('.dw-task-recent').first().getByRole('button', { name: '账单' }).click()
    await page.locator('[data-testid="run-billing-panel"]').waitFor({ timeout: 15_000 })
    check('billing survives reload with the same unknown semantics', (await page.locator('[data-testid="run-billing-panel"]').innerText()).includes('模型推理\n未知'))

    await page.getByRole('button', { name: '关闭任务详情' }).click()
    await page.locator('.dw-global-nav').getByRole('button', { name: 'Agent' }).click()
    await page.locator('.composer textarea').fill('开始一个可被用户停止的测试任务。')
    await page.locator('.composer .btn.primary').click()
    await page.locator('.dw-activity-rail .dw-task-run').waitFor({ timeout: 15_000 })
    const activeRunId = await page.evaluate(async () => (await (window as any).ds.runsListRecent(1))[0]?.runId as string)
    check('second workflow exposes a durable run id before cancellation', Boolean(activeRunId))
    await page.getByRole('button', { name: '关闭工作流侧栏' }).click()
    check('workflow rail can close without losing its entry', await page.getByRole('button', { name: /^工作流/ }).isVisible())
    await page.getByRole('button', { name: /^工作流/ }).click()
    await page.locator('.dw-activity-rail .dw-task-run .dw-text-btn.danger').click()
    await page.waitForFunction(async (runId) => (await (window as any).ds.runsGet(runId))?.status === 'cancelled', activeRunId, { timeout: 15_000 })
    check('stop button reaches the kernel and persists cancelled state', await page.evaluate(async (runId) => (await (window as any).ds.runsGet(runId))?.status === 'cancelled', activeRunId))

    await page.locator('.dw-global-nav').getByRole('button', { name: '任务中心' }).click()
    const cancelledRow = page.locator('.dw-task-recent').filter({ hasText: '已停止' }).first()
    await cancelledRow.waitFor({ timeout: 15_000 })
    await cancelledRow.getByRole('button', { name: '删除' }).click()
    await page.getByRole('button', { name: '删除工作流' }).click()
    await page.waitForFunction(async (runId) => (await (window as any).ds.runsGet(runId)) === null, activeRunId, { timeout: 15_000 })
    check('terminal workflow delete removes the durable record', await page.evaluate(async (runId) => (await (window as any).ds.runsGet(runId)) === null, activeRunId))
  } finally {
    if (app) await closeApp(app)
    await new Promise<void>((resolve) => server.close(() => resolve()))
    await rm(userData, { recursive: true, force: true })
  }
  console.log(`\nR43 Electron smoke: ${passed}/${passed} PASS`)
}

void main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
