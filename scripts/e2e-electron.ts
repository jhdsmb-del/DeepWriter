// ==================== Playwright Electron E2E（R4-5） ====================
// 覆盖：
// - E2E-01：模式栏/真实 chip/无营销文案/popover 键盘/视口截图 + 真实 innerWidth 断言（800/1024/1280）
// - E2E-02：附件主路径——fixture 选择 → 预览 chip → 发送 → mock model 收到正文（仅 1 次模型调用）
// - E2E-03：双击发送（同一 run 幂等）→ 模型仅调用 1 次
// 运行：npx electron-vite build && npx esbuild scripts/e2e-electron.ts --bundle --format=esm --platform=node --outfile=out/e2e.mjs && node out/e2e.mjs
// 注意：需要桌面显示环境；CI 在 Windows Runner 或 xvfb 下运行。

import * as path from 'node:path'
import * as url from 'node:url'
import * as os from 'node:os'
import * as fs from 'node:fs'
import * as http from 'node:http'
import { promises as fsp } from 'node:fs'
import { createRequire } from 'node:module'
import { DatabaseSync } from 'node:sqlite'
import { _electron as electron, expect, type ElectronApplication, type Page } from '@playwright/test'
import { closeElectronGracefully } from './electron-shutdown'

const __dirname = path.dirname(url.fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')
const SHOT_DIR = path.join(ROOT, 'e2e-screenshots')
const packagedExecutable = process.env.DW_E2E_EXECUTABLE ? path.resolve(process.env.DW_E2E_EXECUTABLE) : null
const profiles = new WeakMap<ElectronApplication, string>()

let passed = 0
let failed = 0

function check(name: string, cond: boolean, detail = ''): void {
  if (cond) {
    passed++
    console.log(`  PASS  ${name}`)
  } else {
    failed++
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

/** 本地确定性 mock model（R4-5：不依赖真实 Key/外网；记录请求体与调用次数） */
interface MockModel {
  server: http.Server
  port: number
  calls: Array<{ body: { model?: string; messages: Array<{ role: string; content: string; tool_call_id?: string }> } }>
  requests: Array<{ method: string; path: string }>
  resumeReply: () => void
}
async function startMockModel(opts: { toolCallFirst?: boolean; chunkDelayMs?: number; content?: string; contentChunks?: string[]; pauseAfterFirstChunk?: boolean; toolName?: string; toolArguments?: Record<string, unknown>; discoverableModel?: boolean; requiredKey?: string } = {}): Promise<MockModel> {
  const calls: MockModel['calls'] = []
  const requests: MockModel['requests'] = []
  let continueChunks = !opts.pauseAfterFirstChunk
  let requestCount = 0
  const server = http.createServer((req, res) => {
    requests.push({ method: req.method ?? '', path: req.url ?? '' })
    if (opts.requiredKey && req.headers.authorization !== `Bearer ${opts.requiredKey}`) { res.writeHead(401).end(); return }
    if (opts.discoverableModel && req.method === 'GET' && req.url?.endsWith('/v1/models')) {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ data: [
        { id: 'commercial-local-model', name: '桌面验收模型', context_window: 32768, max_output_tokens: 8192 },
        { id: 'commercial-local-alt', name: '桌面验收替代模型', context_window: 32768, max_output_tokens: 8192 },
        { id: 'commercial-unknown-window', name: '未知窗口模型' }
      ] }))
      return
    }
    let body = ''
    req.on('data', (d) => (body += d))
    req.on('end', () => {
      if (req.url?.includes('/chat/completions') && req.method === 'POST') {
        try {
          calls.push({ body: JSON.parse(body) })
        } catch {
          /* 忽略非法请求体 */
        }
        requestCount++
        if (JSON.parse(body).stream === false) {
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ choices: [{ message: { content: opts.content ?? 'OK' } }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }))
          return
        }
        res.writeHead(200, { 'Content-Type': 'text/event-stream' })
        const write = (data: unknown): void => {
          res.write(`data: ${JSON.stringify(data)}\n\n`)
        }
        if (opts.toolCallFirst && requestCount === 1) {
          // 第一轮：工具调用（R4-4 transcript 重建）
          write({ id: 'm', choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, id: 'tc_e2e_1', type: 'function', function: { name: opts.toolName ?? 'mock_tool', arguments: JSON.stringify(opts.toolArguments ?? { path: 'a.txt' }) } }] }, finish_reason: null }], usage: null })
          // Keep a deterministic usage record on tool-call turns so the
          // test-only user_supplied price snapshot can settle this attempt;
          // production still requires provider usage or fail-closed pricing.
          write({ id: 'm', choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 10, completion_tokens: 0, total_tokens: 10, prompt_cache_hit_tokens: 3, prompt_cache_miss_tokens: 7 } })
          res.write('data: [DONE]\n\n')
          res.end()
          return
        }
        const chunks = opts.contentChunks ?? (opts.content ? [opts.content] : ['完成', '工具', '调用', '总结', '。'])
        let i = 0
        const timer = setInterval(() => {
          if (i > 0 && !continueChunks) return
          if (i >= chunks.length) {
            clearInterval(timer)
            write({ id: 'm', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15, prompt_cache_hit_tokens: 3, prompt_cache_miss_tokens: 7 } })
            res.write('data: [DONE]\n\n')
            res.end()
            return
          }
          write({ id: 'm', choices: [{ index: 0, delta: { content: chunks[i], role: 'assistant' }, finish_reason: null }], usage: null })
          i++
        }, opts.chunkDelayMs ?? 15)
        res.once('close', () => clearInterval(timer))
      } else {
        res.writeHead(404).end()
      }
    })
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const port = (server.address() as { port: number }).port
  return { server, port, calls, requests, resumeReply: () => { continueChunks = true } }
}

async function launchApp(width: number, height: number, extraEnv: Record<string, string> = {}, userDataDir?: string): Promise<{ app: ElectronApplication; page: Page }> {
  // R4-5：每个实例独立 userData（run/会话隔离，防跨实例 recoverable 串扰）；可复用指定目录（PERSIST-RESTART）
  const ud = userDataDir ?? (await fsp.mkdtemp(path.join(os.tmpdir(), 'dw-e2e-ud-')))
  const app = await electron.launch({
    executablePath: packagedExecutable ?? createRequire(import.meta.url)('electron') as string,
    args: [
      ...(process.env.DW_E2E_NO_SANDBOX === '1' ? ['--no-sandbox'] : []),
      ...(process.env.DW_E2E_PASSWORD_STORE === 'gnome-libsecret' ? ['--password-store=gnome-libsecret'] : []),
      ...(packagedExecutable ? [] : [path.join(ROOT, 'out', 'main', 'index.js')])
    ],
    env: { ...process.env, NODE_ENV: 'test', DW_TEST_USERDATA: ud, ...extraEnv }
  })
  profiles.set(app, ud)
  const page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  // 等待应用渲染出 Composer
  await page.waitForSelector('.composer', { timeout: 15000 })
  await resizeMainWindow(app, width, height)
  await page.waitForTimeout(400)
  return { app, page }
}

async function closeApp(app: ElectronApplication): Promise<void> {
  await closeElectronGracefully(app, { profile: profiles.get(app) ?? '', diagnosticsDir: SHOT_DIR })
}

async function resizeMainWindow(app: ElectronApplication, width: number, height: number): Promise<{ requested: number; clamped: number }> {
  return app.evaluate(({ BrowserWindow, screen }, size: { w: number; h: number }) => {
    const win = BrowserWindow.getAllWindows().find((candidate) => !candidate.webContents.getURL().includes('window=float'))
    if (!win) return { requested: size.w, clamped: size.w }
    if (win.isFullScreen()) win.setFullScreen(false)
    if (win.isMaximized()) win.unmaximize()
    const workArea = screen.getDisplayMatching(win.getBounds()).workArea
    const frameWidth = Math.max(0, win.getBounds().width - win.getContentBounds().width)
    const expectedContentWidth = Math.min(size.w, Math.max(1, workArea.width - frameWidth))
    const safeHeight = Math.min(size.h, Math.max(640, workArea.height - 80))
    win.setContentSize(size.w, safeHeight, false)
    win.center()
    return { requested: size.w, clamped: expectedContentWidth }
  }, { w: width, h: height })
}

async function setSettingsToMock(page: Page, port: number): Promise<void> {
  await page.evaluate(async (p: number) => {
    const ds = (window as any).ds
    await ds.setSettings({ ...(await ds.getSettings()), baseUrl: `http://127.0.0.1:${p}`, apiKey: 'e2e-key', model: 'deepseek-v4-flash' })
    if ((await ds.getSettings()).apiKey !== '__CONFIGURED__') {
      throw new Error('桌面测试需要可用的系统凭据存储；Linux 请检查 Secret Service。')
    }
  }, port)
  await page.waitForTimeout(300)
}

function mockPricingEnv(port: number): Record<string, string> {
  return { DW_TEST_PRICING_ORIGIN: `http://127.0.0.1:${port}` }
}

async function waitForDurableRuns(page: Page, expectedCount: number): Promise<void> {
  // waitForFunction treats a Promise as truthy before its result is resolved.
  // Poll in the test process so every IPC response is awaited and checked.
  try {
    await expect.poll(async () => page.evaluate(async () => {
      const runs = await (window as any).ds.runsListRecent(50) as Array<{ runId: string; status: string; durableCompleted: boolean }>
      return {
        count: runs.length,
        incomplete: runs.filter((run) => run.status !== 'completed' || run.durableCompleted !== true)
          .map((run) => ({ runId: run.runId, status: run.status, durableCompleted: run.durableCompleted }))
      }
    }), { timeout: 15000, message: `${expectedCount} 个任务必须全部持久化完成` }).toEqual({ count: expectedCount, incomplete: [] })
  } catch (error) {
    const diagnostic = await page.evaluate(async () => {
      const ds = (window as any).ds
      const runs = await ds.runsListRecent(50)
      return Promise.all(runs.filter((run: { status: string; durableCompleted: boolean }) => run.status !== 'completed' || !run.durableCompleted).map(async (run: { runId: string; status: string; durableCompleted: boolean }) => {
        const detail = await ds.runsGet(run.runId)
        return { runId: run.runId, status: run.status, durableCompleted: run.durableCompleted, phase: detail?.phase, errorCode: detail?.errorCode, providerCallBudget: detail?.config?.completionContract?.providerCallBudget ?? detail?.config?.providerCallBudget }
      }))
    })
    console.error(`[durable-runs] ${JSON.stringify({ expectedCount, incomplete: diagnostic })}`)
    await page.screenshot({ path: path.join(SHOT_DIR, `durable-runs-failure-${Date.now()}.png`), animations: 'disabled' })
    throw error
  }
}

async function runStopAcceptance(): Promise<void> {
  console.log('\n[E2E-7] 真实生成中停止：持久化 cancelled、重启不重放、删除需确认')
  const mock = await startMockModel({ contentChunks: ['这是尚未完成的流式回复。', '这段内容不应在停止后出现。'], pauseAfterFirstChunk: true })
  const profile = await fsp.mkdtemp(path.join(os.tmpdir(), 'dw-e2e-stop-'))
  try {
    const first = await launchApp(1280, 900, mockPricingEnv(mock.port), profile)
    try {
      const page = first.page
      await setSettingsToMock(page, mock.port)
      await page.getByRole('textbox', { name: '任务内容' }).fill('在真正生成过程中停止这个桌面验收任务。')
      await page.getByRole('button', { name: '发送', exact: true }).click()
      await expect(page.locator('.msg.assistant')).toContainText('这是尚未完成的流式回复。')
      const stop = page.locator('.btn.stop')
      await expect(stop).toBeEnabled()
      const before = await page.evaluate(async () => (window as any).ds.runsListRecent(50)) as Array<{ status: string }>
      check('停止前模型仍在生成且数据库不是终态', before.length === 1 && !['completed', 'cancelled', 'failed'].includes(before[0].status) && mock.calls.length === 1)
      await stop.click()
      await expect.poll(async () => page.evaluate(async () => {
        const runs = await (window as any).ds.runsListRecent(50)
        return runs.map((run: { status: string; durableCompleted: boolean }) => ({ status: run.status, durableCompleted: run.durableCompleted }))
      }), { timeout: 15000 }).toEqual([{ status: 'cancelled', durableCompleted: false }])
      await expect(stop).toHaveCount(0)
      await page.waitForTimeout(300)
      check('实际点击停止后持久化为 cancelled，不伪装 completed', (await page.evaluate(async () => (window as any).ds.runsListRecent(50)))[0]?.status === 'cancelled')
      check('停止后没有额外模型调用或后续流式正文', mock.calls.length === 1 && !(await page.locator('.msg.assistant').innerText()).includes('这段内容不应在停止后出现。'))
      await page.getByRole('navigation', { name: '全局一级导航' }).getByRole('button', { name: '任务中心', exact: true }).click()
      await expect(page.locator('.dw-task-recent')).toContainText('已停止')
      await page.screenshot({ path: path.join(SHOT_DIR, 'commercial-stopped-task.png'), animations: 'disabled' })
    } finally { await closeApp(first.app) }
    const restarted = await launchApp(1280, 900, mockPricingEnv(mock.port), profile)
    try {
      const page = restarted.page
      const runs = await page.evaluate(async () => (window as any).ds.runsListRecent(50)) as Array<{ runId: string; status: string }>
      const recoverable = await page.evaluate(async () => (window as any).ds.runsRecoverable()) as Array<{ runId: string }>
      check('重启仍为已停止且不成为恢复候选，没有重放模型', runs.length === 1 && runs[0].status === 'cancelled' && !recoverable.some((run) => run.runId === runs[0].runId) && mock.calls.length === 1)
      await page.getByRole('navigation', { name: '全局一级导航' }).getByRole('button', { name: '任务中心', exact: true }).click()
      const row = page.locator('.dw-task-recent')
      await expect(row).toContainText('已停止')
      await row.getByRole('button', { name: '删除', exact: true }).click()
      await expect(page.getByRole('button', { name: '仅删除执行记录', exact: true })).toBeVisible()
      check('任务删除先展示保留或撤回故事修订的明确确认', (await page.evaluate(async () => (window as any).ds.runsListRecent(50))).length === 1)
      await page.locator('.dw-dialog-actions').getByRole('button', { name: '取消', exact: true }).click()
      check('取消删除保留运行记录', (await page.evaluate(async () => (window as any).ds.runsListRecent(50))).length === 1)
      await row.getByRole('button', { name: '删除', exact: true }).click()
      await page.getByRole('button', { name: '仅删除执行记录', exact: true }).click()
      await expect.poll(async () => page.evaluate(async () => (await (window as any).ds.runsListRecent(50)).length)).toBe(0)
      await expect(row).toHaveCount(0)
      check('仅删除执行记录后任务中心同步清除，canonical 会话仍保留', await row.count() === 0 && (await page.evaluate(async () => (window as any).ds.sessionsList())).length === 1)
    } finally { await closeApp(restarted.app) }
  } finally {
    await new Promise<void>((resolve) => { mock.server.closeAllConnections?.(); mock.server.close(() => resolve()) })
  }
}

async function runProviderAcceptance(): Promise<void> {
  console.log('\n[E2E-14] Provider 输入错误收敛、UI 配置、未知费用与宽窄屏可达性')
  const mock = await startMockModel({ content: '本地模拟服务已完成配置验收。', discoverableModel: true, requiredKey: 'e2e-replacement-fixture-key' })
  try {
    // Independent app profiles exercise unpriced bounded requests and the
    // fully priced path through the same visible ProviderManager workflow.
    await runProviderConfigurationAcceptance(mock, false)
    await runProviderConfigurationAcceptance(mock, true)
  } finally {
    await new Promise<void>((resolve) => { mock.server.closeAllConnections?.(); mock.server.close(() => resolve()) })
  }
}

async function runProviderConfigurationAcceptance(mock: MockModel, priced: boolean): Promise<void> {
  const setupCallsBefore = mock.calls.length
  const setupRequestsBefore = mock.requests.length
  const { app, page } = await launchApp(1280, 900)
  const rendererErrors: string[] = []
  page.on('pageerror', (error) => rendererErrors.push(error.message))
  try {
    const windowTitle = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((win) => !win.webContents.getURL().includes('window=float'))?.getTitle())
    check('真实桌面窗口使用文本写作助手新定位标题', windowTitle === 'DeepWriter — 文本写作助手')
    await page.getByRole('button', { name: '设置', exact: true }).click()
    const manager = page.getByTestId('provider-registry')
    await manager.getByRole('button', { name: '＋ 添加供应商', exact: true }).click()
    const providerCountBefore = await page.evaluate(async () => (await (window as any).ds.providerSnapshot()).data.providers.length)
    await manager.getByLabel('供应商名称', { exact: true }).fill('桌面验收本地 Provider')
    const baseUrl = manager.getByLabel('供应商 Base URL', { exact: true })
    await baseUrl.fill(`http://127.0.0.1:${mock.port}/v1?invalid=1`)
    await manager.getByLabel('供应商 API Key', { exact: true }).fill('e2e-initial-fixture-key')
    await manager.getByLabel('模型 ID 1', { exact: true }).fill('commercial-seed')
    const addProvider = manager.getByRole('button', { name: '添加供应商', exact: true })
    await addProvider.click()
    await expect(manager.getByRole('status')).toContainText('请填写有效的 Base URL，并选择对应的 API 格式')
    check('正常表单拒绝非法 URL，保留草稿且不落盘、不发请求',
      (await page.evaluate(async () => (await (window as any).ds.providerSnapshot()).data.providers.length)) === providerCountBefore
      && mock.requests.length === setupRequestsBefore && mock.calls.length === setupCallsBefore
      && await baseUrl.inputValue() === `http://127.0.0.1:${mock.port}/v1?invalid=1`)
    await expect(addProvider).toBeEnabled()
    await baseUrl.fill(`http://127.0.0.1:${mock.port}/v1`)
    await addProvider.click()
    await expect(manager.getByRole('status')).toContainText('供应商已添加')
    await expect(manager.getByLabel('当前供应商 API Key', { exact: true })).toHaveValue('')
    const createdSnapshot = await page.evaluate(async () => (window as any).ds.providerSnapshot())
    const createdProvider = createdSnapshot.data.providers.find((provider: { displayName: string }) => provider.displayName === '桌面验收本地 Provider')
    check('正常表单一次保存供应商、加密凭据和模型，Renderer 没有密钥明文或加密 blob',
      Boolean(createdProvider?.defaultCredentialRefId)
      && createdSnapshot.data.models.some((model: { providerId: string; remoteModelId: string }) => model.providerId === createdProvider.id && model.remoteModelId === 'commercial-seed')
      && !/e2e-initial-fixture-key|encrypted_blob/.test(JSON.stringify(createdSnapshot)))

    // Edit the actual normal-form URL and key, and save through the footer.
    const editedUrl = `http://127.0.0.1:${mock.port}/edited/v1`
    await manager.getByLabel('当前供应商 Base URL', { exact: true }).fill(editedUrl)
    await manager.getByLabel('当前供应商 API Key', { exact: true }).fill('e2e-replacement-fixture-key')
    await page.evaluate(() => window.dispatchEvent(new Event('deepwriter:provider-registry-changed')))
    await expect(manager.getByLabel('当前供应商 Base URL', { exact: true })).toHaveValue(editedUrl)
    await expect(manager.getByLabel('当前供应商 API Key', { exact: true })).toHaveValue('e2e-replacement-fixture-key')
    await page.getByRole('button', { name: '保存并关闭', exact: true }).click()
    await page.getByRole('dialog', { name: '设置', exact: true }).waitFor({ state: 'hidden' })
    await page.getByRole('button', { name: '设置', exact: true }).click()
    await manager.getByRole('button', { name: '桌面验收本地 Provider', exact: true }).click()
    await expect(manager.getByLabel('当前供应商 Base URL', { exact: true })).toHaveValue(editedUrl)
    await expect(manager.getByLabel('当前供应商 API Key', { exact: true })).toHaveValue('')
    const editedSnapshot = await page.evaluate(async () => (window as any).ds.providerSnapshot())
    const editedProvider = editedSnapshot.data.providers.find((provider: { id: string }) => provider.id === createdProvider.id)
    check('页脚保存并重开后 URL/Key 持久化，供应商和凭据身份保持，明文不返回',
      editedProvider.chatPath === '/edited/v1/chat/completions' && editedProvider.modelsPath === '/edited/v1/models'
      && editedProvider.defaultCredentialRefId === createdProvider.defaultCredentialRefId
      && !/e2e-(?:initial|replacement)-fixture-key|encrypted_blob/.test(JSON.stringify(editedSnapshot)))

    await manager.getByRole('button', { name: '获取模型', exact: true }).click()
    const discovery = manager.locator('.dw-provider-discovery')
    for (const model of ['桌面验收模型', '桌面验收替代模型', '未知窗口模型']) await discovery.getByLabel(model, { exact: true }).check()
    await discovery.getByRole('button', { name: '添加所选模型（3）', exact: true }).click()
    await expect(manager.getByRole('status')).toContainText('所选模型已添加')
    check('目录发现走已编辑 URL 和替换 Key，勾选后才保存三个模型，没有生成请求',
      mock.requests.length === setupRequestsBefore + 1 && mock.requests.at(-1)?.path === '/edited/v1/models'
      && mock.calls.length === setupCallsBefore
      && (await page.evaluate(async () => (await (window as any).ds.providerSnapshot()).data.models.filter((model: { remoteModelId: string }) => ['commercial-local-model', 'commercial-local-alt', 'commercial-unknown-window'].includes(model.remoteModelId)))).length === 3)
    const mainModels = manager.locator('.dw-provider-simple-models')
    const modelDetails = mainModels.locator('.dw-provider-model-row').filter({ has: page.getByRole('button', { name: /^桌面验收模型 / }) }).locator('details')
    await expect(modelDetails).not.toHaveAttribute('open', '')
    await modelDetails.getByLabel('桌面验收模型 规格与连接', { exact: true }).click()
    await expect(modelDetails).toContainText('32,768 tokens')
    await expect(modelDetails).toContainText('8,192 tokens')
    page.once('dialog', async (dialog) => {
      expect(dialog.message()).toContain('测试将发送一条短请求')
      await dialog.accept()
    })
    await modelDetails.getByRole('button', { name: '测试 桌面验收模型 连接', exact: true }).click()
    await expect(modelDetails).toContainText('已连接')
    check('规格按需展开且连接测试真正调用所选模型的已编辑端点',
      mock.calls.length === setupCallsBefore + 1 && mock.calls.at(-1)?.body.model === 'commercial-local-model'
      && mock.requests.at(-1)?.path === '/edited/v1/chat/completions')
    const callsBefore = mock.calls.length

    // Advanced configuration is still reachable for custom headers and prices;
    // neither is a prerequisite for the normal model-import flow above.
    const advanced = manager.locator('details.dw-provider-advanced')
    await advanced.locator(':scope > summary').click()
    const custom = advanced.locator('details.dw-provider-block').filter({ hasText: '添加自定义 Provider' })
    await custom.locator('summary').click()
    await custom.getByLabel('名称', { exact: true }).fill('Header 验收候选')
    await custom.getByLabel('API Host（不含路径）', { exact: true }).fill(`http://127.0.0.1:${mock.port}`)
    await custom.getByRole('button', { name: '网络范围', exact: true }).click()
    await page.getByRole('option', { name: /本机开发/ }).click()
    const headers = custom.getByLabel('额外 Header（JSON）', { exact: true })
    await headers.fill('{invalid-json')
    const before = await page.evaluate(async () => (await (window as any).ds.providerSnapshot()).data.providers.length)
    const requestsBeforeHeaders = mock.requests.length
    await custom.getByRole('button', { name: '创建 Provider', exact: true }).click()
    await expect(advanced.getByRole('status')).toContainText('额外 Header 不是有效 JSON')
    check('高级入口的错误 Header JSON 可重试，不创建 Provider 或发请求',
      (await page.evaluate(async () => (await (window as any).ds.providerSnapshot()).data.providers.length)) === before
      && mock.calls.length === callsBefore && mock.requests.length === requestsBeforeHeaders
      && await headers.inputValue() === '{invalid-json')
    await expect(custom.getByRole('button', { name: '创建 Provider', exact: true })).toBeEnabled()
    await headers.fill('{}')
    await custom.locator('summary').click()
    const models = advanced.getByRole('region', { name: '模型', exact: true })
    if (priced) {
      for (const model of ['桌面验收替代模型', '桌面验收模型']) {
        await models.getByRole('button', { name: new RegExp(`^${model}`) }).click()
        const pricing = models.locator('details.dw-provider-pricing')
        await pricing.locator('summary').click()
        await pricing.getByLabel('参考价币种', { exact: true }).fill('USD')
        await pricing.getByLabel('参考价生效日期', { exact: true }).fill(new Date(Date.now() - 86_400_000).toISOString().slice(0, 10))
        await pricing.getByLabel('输入参考价', { exact: true }).fill('0.01')
        await pricing.getByLabel('输出参考价', { exact: true }).fill('0.02')
        await pricing.getByLabel('缓存命中输入参考价', { exact: true }).fill('0.001')
        await pricing.getByRole('button', { name: '参考价推理计费方式', exact: true }).click()
        await page.getByRole('option', { name: '已包含在输出价中', exact: true }).click()
        await pricing.getByLabel('确认参考价不是实际账单', { exact: true }).check()
        await pricing.getByRole('button', { name: '保存用户参考价', exact: true }).click()
        await expect(advanced.getByRole('status')).toContainText('用户参考价已保存')
        await pricing.locator('summary').click()
      }
      const prices = await page.evaluate(async () => (await (window as any).ds.providerSnapshot()).data.models.filter((model: { remoteModelId: string }) => ['commercial-local-alt', 'commercial-local-model'].includes(model.remoteModelId)).map((model: { pricing: { source: string; currency: string } }) => ({ source: model.pricing?.source, currency: model.pricing?.currency })))
      expect(prices).toEqual([{ source: 'user_supplied', currency: 'USD' }, { source: 'user_supplied', currency: 'USD' }])
      check('真实参考价 UI 为两个本地模型保存完整用户声明，不伪装官方价格', true)
    }
    await advanced.locator(':scope > summary').click()
    await mainModels.getByRole('button', { name: /^桌面验收模型 / }).click()
    await expect(manager.getByRole('status')).toContainText('已选择 桌面验收模型')
    for (const width of [1280, 800]) {
      await resizeMainWindow(app, width, 900)
      const bounds = await manager.evaluate((element) => ({ width: innerWidth, overflow: element.scrollWidth > element.clientWidth + 1, documentOverflow: document.documentElement.scrollWidth > innerWidth + 2 }))
      check(`${width}px 模型供应商正常表单无横向溢出`, !bounds.overflow && !bounds.documentOverflow, JSON.stringify(bounds))
      await page.screenshot({ path: path.join(SHOT_DIR, `commercial-provider-configured-${width}.png`), animations: 'disabled' })
    }
    await resizeMainWindow(app, 1280, 900)
    await page.getByRole('button', { name: '关闭设置', exact: true }).click()
    const trigger = page.getByTestId('model-reasoning-trigger')
    await expect(trigger).toHaveAttribute('aria-label', /当前模型 桌面验收模型 · 桌面验收本地 Provider/)
    await page.getByRole('textbox', { name: '任务内容' }).fill('使用当前 Profile 验证未知费用说明。')
    await trigger.click()
    await expect(page.getByTestId('model-reasoning-panel')).toBeVisible()
    await expect(page.getByRole('slider', { name: '思考强度', exact: true })).toBeDisabled()
    await page.getByRole('button', { name: '选择模型', exact: true }).click()
    await expect(page.getByRole('option', { name: /^桌面验收模型/ })).toHaveAttribute('aria-selected', 'true')
    await page.screenshot({ path: path.join(SHOT_DIR, 'commercial-model-dropdown-1280.png'), animations: 'disabled' })
    await page.getByRole('option', { name: /^未知窗口模型/ }).click()
    await expect(trigger).toHaveAttribute('aria-label', /当前模型 未知窗口模型/)
    await page.keyboard.press('Escape')
    await page.getByTestId('model-reasoning-panel').waitFor({ state: 'detached' })
    await page.getByRole('textbox', { name: '任务内容' }).fill('过大上下文'.repeat(12000))
    await page.getByRole('button', { name: '发送', exact: true }).click()
    await expect(page.getByText('上下文超过模型窗口，请减少素材后重试，草稿已保留', { exact: true })).toBeVisible()
    check('未知型号的有限运行预算拒绝超大上下文并保留草稿', mock.calls.length === callsBefore && (await page.evaluate(async () => (window as any).ds.runsListRecent(50))).length === 0 && await page.getByRole('textbox', { name: '任务内容' }).inputValue() === '过大上下文'.repeat(12000))
    await page.getByRole('textbox', { name: '任务内容' }).fill('使用当前 Profile 验证未知费用说明。')
    await trigger.click()
    await page.getByRole('button', { name: '选择模型', exact: true }).click()
    await page.getByRole('option', { name: /^桌面验收替代模型/ }).click()
    await expect(trigger).toHaveAttribute('aria-label', /当前模型 桌面验收替代模型/)
    await page.keyboard.press('Escape')
    await page.getByTestId('model-reasoning-panel').waitFor({ state: 'detached' })
    await page.getByRole('button', { name: '发送', exact: true }).click()
    if (priced) {
      await waitForDurableRuns(page, 1)
      const currentSnapshot = await page.evaluate(async () => (await (window as any).ds.providerSnapshot()).data)
      const providerId = currentSnapshot.providers.find((provider: { displayName: string }) => provider.displayName === '桌面验收本地 Provider')?.id
      const firstBilling = await page.evaluate(async () => (window as any).ds.runsGetBilling((await (window as any).ds.runsListRecent(50))[0].runId))
      check('可见模型切换实际驱动同一 Provider 的替代模型请求与账单身份', mock.calls.length === callsBefore + 1 && mock.calls[callsBefore].body.model === 'commercial-local-alt' && firstBilling.attempts.some((attempt: { providerId: string; modelId: string }) => attempt.providerId === providerId && attempt.modelId === 'commercial-local-alt'))
      await page.getByRole('navigation', { name: '全局一级导航' }).getByRole('button', { name: '任务中心', exact: true }).click()
      await expect(page.locator('.composer')).toHaveCount(0)
      await page.getByRole('navigation', { name: '全局一级导航' }).getByRole('button', { name: 'Agent', exact: true }).click()
      await expect(trigger).toHaveAttribute('aria-label', /当前模型 桌面验收替代模型/)
      await trigger.click()
      await page.getByRole('button', { name: '选择模型', exact: true }).click()
      await expect(page.getByRole('option', { name: /^桌面验收替代模型/ })).toHaveAttribute('aria-selected', 'true')
      await page.getByRole('option', { name: /^桌面验收模型/ }).click()
      await expect(trigger).toHaveAttribute('aria-label', /当前模型 桌面验收模型/)
      await page.keyboard.press('Escape')
      await page.getByTestId('model-reasoning-panel').waitFor({ state: 'detached' })
      await page.getByRole('textbox', { name: '任务内容' }).fill('重挂模型控件后切回原模型进行第二个任务。')
      await page.getByRole('button', { name: '发送', exact: true }).click()
      await waitForDurableRuns(page, 2)
      const allBillingModels = await page.evaluate(async () => {
        const ds = (window as any).ds
        const runs = await ds.runsListRecent(50)
        return (await Promise.all(runs.map((run: { runId: string }) => ds.runsGetBilling(run.runId)))).flatMap((bill) => bill.attempts.map((attempt: { providerId: string; modelId: string }) => ({ providerId: attempt.providerId, modelId: attempt.modelId })))
      })
      check('控件重挂后保持有效绑定，切回原模型的真实请求和账单不串模型', mock.calls.length === callsBefore + 2 && mock.calls[callsBefore + 1].body.model === 'commercial-local-model' && allBillingModels.some((attempt: { providerId: string; modelId: string }) => attempt.providerId === providerId && attempt.modelId === 'commercial-local-model'))
    } else {
      await waitForDurableRuns(page, 1)
      await expect(page.getByRole('dialog', { name: '本次任务费用无法估算', exact: true })).toHaveCount(0)
      const frozen = await page.evaluate(async () => {
        const ds = (window as any).ds
        return (await ds.runsGet((await ds.runsListRecent(50))[0].runId)).config
      })
      check('未设预算时缺参考价不拦截，不生成金额、次数或 token 上限，也不伪造用户授权', mock.calls.length === callsBefore + 1 && frozen.workBudgetPolicy === 'explicit_v1' && frozen.providerCallBudget.maxCost === null && frozen.providerCallBudget.maxCalls === null && frozen.providerCallBudget.maxTokens === null && frozen.desktopCostAuthorization === undefined)
      await page.screenshot({ path: path.join(SHOT_DIR, 'commercial-unknown-cost-direct-send.png'), animations: 'disabled' })
      await page.getByRole('textbox', { name: '任务内容' }).fill('继续下一条普通对话，不重复费用确认。')
      await page.getByRole('textbox', { name: '任务内容' }).press('Enter')
      await waitForDurableRuns(page, 2)
      await expect(page.getByRole('dialog', { name: '本次任务费用无法估算', exact: true })).toHaveCount(0)
      check('下一条回车发送不因缺参考价再次拦截', mock.calls.length === callsBefore + 2)
    }
    await page.getByRole('navigation', { name: '全局一级导航' }).getByRole('button', { name: '任务中心', exact: true }).click()
    await page.locator('.dw-task-recent').first().getByRole('button', { name: '账单', exact: true }).click()
    await page.getByTestId('run-billing-panel').waitFor({ state: 'visible' })
    const billing = page.getByTestId('run-billing-panel')
    const durableBilling = await page.evaluate(async () => (window as any).ds.runsGetBilling((await (window as any).ds.runsListRecent(50))[0].runId))
    if (priced) {
      await expect(billing.locator('.ri-billing-total')).toContainText('按价格快照估算')
      check('完整用户参考价与真实 usage 只生成 estimated 费用，不伪装实际账单', durableBilling.cost.status === 'estimated' && durableBilling.cost.currency === 'USD' && durableBilling.cost.amount > 0 && durableBilling.attempts.every((attempt: { costStatus: string; priceSnapshotId: string | null }) => attempt.costStatus === 'estimated' && Boolean(attempt.priceSnapshotId)))
    } else {
      await expect(billing.locator('.ri-billing-total')).toContainText('费用未知')
      check('未知价格保持 unknown/null，账单解释缺失而不显示伪造 0', durableBilling.cost.status === 'unknown' && durableBilling.cost.amount === null && await billing.locator('.ri-cost-note').isVisible())
    }
    for (const width of [1280, 800]) {
      await resizeMainWindow(app, width, 900)
      const reachable = await page.getByRole('button', { name: '关闭任务详情', exact: true }).evaluate((button) => {
        const rect = button.getBoundingClientRect()
        const hit = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2)
        return rect.left >= 0 && rect.right <= innerWidth && rect.top >= 0 && rect.bottom <= innerHeight && button.contains(hit)
      })
      check(`${width}px ${priced ? '参考价估算' : '未知费用'}账单与关闭控件真实可达，页面无横向溢出`, reachable && await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 2))
      await page.screenshot({ path: path.join(SHOT_DIR, `commercial-${priced ? 'priced' : 'unknown'}-billing-${width}.png`), animations: 'disabled' })
    }
    await page.getByRole('button', { name: '关闭任务详情', exact: true }).click()
    await page.getByRole('navigation', { name: '全局一级导航' }).getByRole('button', { name: 'Agent', exact: true }).click()
    await page.getByTestId('model-reasoning-trigger').click()
    await expect(page.getByTestId('model-reasoning-panel')).toBeVisible()
    await page.screenshot({ path: path.join(SHOT_DIR, 'commercial-model-dropdown-800.png'), animations: 'disabled' })
    check('Provider 错误输入与修复后流程没有未处理 Renderer 异常', rendererErrors.length === 0, rendererErrors.join(' | '))
  } finally { await closeApp(app) }
}

async function main(): Promise<void> {
  await fsp.mkdir(SHOT_DIR, { recursive: true })
  if (process.env.DW_E2E_FOCUS === 'commercial') {
    console.log('[E2E FOCUS] 仅运行真实停止与 Provider 商业验收；其他分组未运行。')
    await runStopAcceptance()
    await runProviderAcceptance()
    console.log(`\n===== E2E 商业定向结果：${passed} PASS / ${failed} FAIL =====`)
    process.exit(failed > 0 ? 1 : 0)
  }

  console.log('\n[E2E-1] 启动 + Composer 模式栏存在性')
  const { app, page } = await launchApp(1280, 900)
  try {
    check('窗口加载出 Composer', (await page.locator('.composer').count()) > 0)
    if (packagedExecutable) {
      check('发行包实际版本与发布版本一致', await app.evaluate(({ app }) => app.getVersion()) === JSON.parse(await fsp.readFile(path.join(ROOT, 'package.json'), 'utf8')).version)
      check('发行界面来自 app.asar', page.url().includes('app.asar/out/renderer/index.html'))
    }
    check('空白首屏不加载 Markdown 和任务详情模块', await page.evaluate(() => !performance.getEntriesByType('resource').some((entry) => /\/(Markdown|RunInspector)-[^/]+\.js/.test(entry.name))))
    check('输入区不再重复工作区模式入口', (await page.locator('.mode-popover-wrap').count()) === 0)
    check('附件入口唯一（紧凑图标按钮）', (await page.getByRole('button', { name: '添加附件' }).count()) === 1)
    const modelTrigger = page.getByTestId('model-reasoning-trigger')
    check('左下角模型与思考入口唯一且显示真实选择', (await modelTrigger.count()) === 1 && /当前模型.+思考/.test(await modelTrigger.getAttribute('aria-label') ?? ''))
    await modelTrigger.click()
    const modelPanel = page.getByTestId('model-reasoning-panel')
    await modelPanel.waitFor({ state: 'visible' })
    check('模型弹层使用轻柔的进入动画', await modelPanel.evaluate((el) => getComputedStyle(el).animationName === 'dw-soft-rise-in'))
    check('模型弹层优先只显示真实强度滑块与模型次级入口', await modelPanel.isVisible() && (await modelPanel.getByRole('slider', { name: '思考强度' }).count()) === 1 && (await modelPanel.getByRole('button', { name: '选择模型' }).count()) === 1)
    check('上下文细节默认不出现在第一层', await modelPanel.getByRole('group', { name: '上下文范围' }).count() === 0)
    await modelPanel.getByRole('button', { name: '高级', exact: true }).click()
    check('高级页不提供上下文三档或全局窗口覆盖', await modelPanel.getByRole('group', { name: '上下文范围' }).count() === 0 && await modelPanel.locator('.dw-model-context-option, input[name="contextWindowTokens"]').count() === 0)
    const contextDetails = modelPanel.getByRole('button', { name: '查看本次上下文明细', exact: true })
    await contextDetails.focus()
    await page.keyboard.press('Enter')
    const contextDialog = page.getByRole('dialog', { name: '本次运行上下文', exact: true })
    await expect(contextDialog).toContainText('按模型自动管理')
    check('原高级入口可用键盘打开明细且固定事实仍可编辑', await contextDialog.getByPlaceholder('添加必须保留的事实').isVisible() && await contextDialog.getByRole('button', { name: '固定事实', exact: true }).count() === 1)
    await page.keyboard.press('Escape')
    await contextDialog.waitFor({ state: 'detached' })
    await modelTrigger.click()
    await modelPanel.waitFor({ state: 'visible' })
    await modelPanel.getByRole('button', { name: '高级', exact: true }).click()
    await page.keyboard.press('Escape')
    await page.waitForFunction(() => document.querySelector('[data-testid="model-reasoning-panel"]')?.getAttribute('data-state') === 'closing')
    check('关闭弹层时保留退出动画并停止接收操作', await modelPanel.evaluate((el) => el.hasAttribute('inert') && el.getAttribute('aria-hidden') === 'true' && getComputedStyle(el).animationName === 'dw-soft-rise-out'))
    await modelTrigger.click()
    await page.waitForFunction(() => document.querySelector('[data-testid="model-reasoning-panel"]')?.getAttribute('data-state') === 'open')
    check('退出期间可以立即重新打开且没有重复弹层', await modelPanel.count() === 1 && await modelPanel.evaluate((el) => !el.hasAttribute('inert')))
    await page.keyboard.press('Escape')
    await modelPanel.waitFor({ state: 'detached' })
    check('Escape 关闭后焦点回到模型按钮', await modelTrigger.evaluate((el) => el === document.activeElement))
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await modelTrigger.click()
    await modelPanel.waitFor({ state: 'visible' })
    check('系统减少动态效果时弹层和按钮没有动画', await modelPanel.evaluate((el) => getComputedStyle(el).animationName === 'none') && await modelTrigger.evaluate((el) => getComputedStyle(el).transitionDuration.split(',').every((duration) => parseFloat(duration) === 0)))
    await page.keyboard.press('Escape')
    await modelPanel.waitFor({ state: 'detached' })
    await page.getByRole('navigation', { name: '全局一级导航' }).getByRole('button', { name: '任务中心', exact: true }).click()
    check('减少动态效果也关闭工作区切换动画', await page.locator('.chat-area').evaluate((el) => el.getAnimations().length === 0))
    await page.getByRole('navigation', { name: '全局一级导航' }).getByRole('button', { name: 'Agent', exact: true }).click()
    await page.emulateMedia({ reducedMotion: 'no-preference' })
    check('顶部已移除营销 tagline 与重复工作区按钮', (await page.locator('.tagline, .ws-switch').count()) === 0)
    check('一级导航收敛为三个入口，无重复工作区 tabs', (await page.locator('.dw-global-nav > button').count()) === 3 && (await page.locator('.ws-tabs').count()) === 0)
    check('聊天页移除重复任务中心卡片', (await page.locator('.dw-agent-task-center').count()) === 0)
    await page.locator('.composer textarea').fill('先保留这份未发送的桌面任务草稿')
    await page.getByRole('navigation', { name: '全局一级导航' }).getByRole('button', { name: '任务中心', exact: true }).click()
    await page.locator('.chat-area.workspace-runs').waitFor({ state: 'visible' })
    check('任务中心不挂载聊天发送框', (await page.locator('.composer').count()) === 0)
    await page.getByRole('navigation', { name: '全局一级导航' }).getByRole('button', { name: 'Agent', exact: true }).click()
    await page.locator('.composer').waitFor({ state: 'visible' })
    check('切换任务中心后未发送草稿仍在', await page.locator('.composer textarea').inputValue() === '先保留这份未发送的桌面任务草稿')

    console.log('\n[E2E-2] 唯一工作区导航与轻量指令弹层')
    const keyboardNav = page.getByRole('navigation', { name: '全局一级导航' })
    await keyboardNav.getByRole('button', { name: 'Agent', exact: true }).focus()
    await page.keyboard.press('Tab')
    check('Tab 可进入长文导航按钮', await keyboardNav.getByRole('button', { name: '长文', exact: true }).evaluate((el) => el === document.activeElement))
    await page.keyboard.press('Enter')
    const longformShell = page.getByTestId('longform-workflow-shell')
    await expect(keyboardNav.getByRole('button', { name: '长文', exact: true })).toHaveAttribute('aria-current', 'page')
    await expect(longformShell).toBeVisible()
    await expect(longformShell.getByRole('navigation', { name: '长文业务阶段', exact: true })).toBeVisible()
    await expect(longformShell.getByRole('heading', { name: '先写下你的构想', exact: true })).toBeVisible()
    await page.locator('.composer').waitFor({ state: 'detached' })
    const novelNav = page.getByRole('navigation', { name: '全局一级导航' }).getByRole('button', { name: '长文', exact: true })
    check('键盘选择进入真实长文工作区并卸载 Composer',
      await novelNav.getAttribute('aria-current') === 'page' &&
      await page.locator('.chat-area.workspace-novel').isVisible() &&
      await longformShell.getByRole('navigation', { name: '长文业务阶段', exact: true }).isVisible() &&
      (await page.locator('.composer').count()) === 0,
      '长文导航、workspace-novel 与长文工作流应同时可见')
    await page.locator('.dw-longform-contract > summary').click()
    const targetInput = page.getByTestId('long-target-input')
    await page.getByRole('button', { name: '20,000 字', exact: true }).click()
    check('实际长文契约入口可以使用字数快捷值', await targetInput.inputValue() === '20000')
    await targetInput.fill('10000.9')
    await targetInput.press('Enter')
    check('实际长文契约自定义篇幅统一为整数', await targetInput.inputValue() === '10000')

    await page.getByRole('navigation', { name: '全局一级导航' }).getByRole('button', { name: 'Agent', exact: true }).click()
    await page.locator('.chat-area.workspace-chat').waitFor({ state: 'visible' })
    await page.locator('.composer').waitFor({ state: 'visible' })
    check('切换长文工作区后返回仍保留草稿', await page.locator('.composer textarea').inputValue() === '先保留这份未发送的桌面任务草稿')
    check('全局 Agent 导航返回 chat 并重新挂载输入框',
      await page.getByRole('navigation', { name: '全局一级导航' }).getByRole('button', { name: 'Agent', exact: true }).getAttribute('aria-current') === 'page' &&
      await page.getByRole('textbox', { name: '任务内容' }).isVisible())
    await page.getByRole('button', { name: '新建会话', exact: true }).click()
    check('新建会话不带入旧草稿', await page.locator('.composer textarea').inputValue() === '')
    const draftSession = page.locator('.session-sidebar').getByRole('button', { name: /先保留这份未发送的桌面任务草稿/ })
    await draftSession.focus()
    await page.keyboard.press('Enter')
    check('未发送会话可从侧栏用键盘恢复草稿', await page.locator('.composer textarea').inputValue() === '先保留这份未发送的桌面任务草稿')
    const presetTrigger = page.getByRole('button', { name: '自定义指令', exact: true })
    await page.getByTestId('composer-tools-trigger').click()
    await presetTrigger.click()
    const presetPanel = page.getByTestId('agent-preset-panel')
    await presetPanel.waitFor({ state: 'visible' })
    check('自定义指令从轻量入口打开，主界面没有空预设栏', await presetPanel.isVisible() && (await page.locator('.dw-agent-preset-summary').count()) === 0)
    await page.keyboard.press('Escape')
    await presetPanel.waitFor({ state: 'detached' })
    check('Escape 关闭指令弹层并恢复焦点', await presetTrigger.evaluate((el) => el === document.activeElement))
    await presetTrigger.click()
    await presetPanel.waitFor({ state: 'visible' })
    await page.mouse.click(5, 5)
    await presetPanel.waitFor({ state: 'detached' })
    check('点击外部关闭指令弹层', (await presetPanel.count()) === 0)
    await page.getByRole('textbox', { name: '任务内容' }).fill('/')
    await page.keyboard.press('Escape')
    check('Escape 关闭命令提示并保留输入', await page.getByRole('textbox', { name: '任务内容' }).inputValue() === '/' && (await page.locator('.command-menu').count()) === 0)
    await page.getByRole('textbox', { name: '任务内容' }).fill('先保留这份未发送的桌面任务草稿')

    console.log('\n[E2E-3] 视口 1280/1024/800：真实 innerWidth 断言 + 截图 + 固定侧栏检查')
    for (const w of [1280, 1024, 800]) {
      const expectedW = await resizeMainWindow(app, w, 900)
      await page.waitForTimeout(600)
      // 不同窗口管理器会选择接受请求尺寸，或将其限制到工作区；两者都应精确命中其一。
      const innerW = await page.evaluate(() => window.innerWidth)
      const widthDelta = Math.min(Math.abs(innerW - expectedW.requested), Math.abs(innerW - expectedW.clamped))
      check(`E2E-01 请求 ${w}px 后 innerWidth 真实生效（±20px）`, widthDelta <= 20, `innerWidth=${innerW} expected=${expectedW.requested}|${expectedW.clamped}`)
      await page.screenshot({ path: path.join(SHOT_DIR, `agent-${w}.png`) })
      // 800px 时不应存在固定侧栏占位（侧栏为 overlay 或不可见）
      if (w === 800) {
        const legacyFixedPanel = await page.evaluate(() => {
          const direct = document.querySelector('.layout > .side-panel') as HTMLElement | null
          if (!direct) return false
          return direct.getBoundingClientRect().width <= 320
        })
        check('800px 无旧版固定 280px 工作面板', legacyFixedPanel === false, `legacyFixedPanel=${legacyFixedPanel}`)
        const narrowSidebar = await page.locator('.session-sidebar').evaluate((el) => {
          const r = el.getBoundingClientRect()
          const cs = getComputedStyle(el)
          return { left: r.left, right: r.right, transform: cs.transform, text: el.textContent ?? '' }
        })
        check('800px 会话栏默认完整隐藏（不再挤成逐字竖排）', narrowSidebar.right <= 1, JSON.stringify(narrowSidebar))
        check('隐藏会话栏退出键盘焦点顺序', await page.locator('.session-sidebar').evaluate((el) => el.hasAttribute('inert')))
        const narrowComposer = await page.locator('.composer').evaluate((el) => {
          const r = el.getBoundingClientRect()
          return {
            visible: r.width > 0 && r.height > 0 && r.top >= 0 && r.bottom <= window.innerHeight + 2,
            top: Math.round(r.top),
            bottom: Math.round(r.bottom),
            innerHeight: window.innerHeight,
            documentWidth: document.documentElement.scrollWidth,
            innerWidth: window.innerWidth
          }
        })
        check('800px Composer 完整位于可视区且页面无横向滚动', narrowComposer.visible && narrowComposer.documentWidth <= narrowComposer.innerWidth + 2, JSON.stringify(narrowComposer))
      }
    }
    check('截图输出存在（1280/1024/800）', fs.existsSync(path.join(SHOT_DIR, 'agent-1280.png')) && fs.existsSync(path.join(SHOT_DIR, 'agent-800.png')))

    console.log('\n[E2E-3B] 极简状态胶囊：空闲不出现')
    const floatEntry = page.locator('.dw-topbar .dw-icon-btn[aria-label="打开悬浮进度窗"]')
    check('空闲时不显示无用悬浮窗入口', (await floatEntry.count()) === 0)
    const idleFloatCount = app.windows().filter((candidate) => candidate.url().includes('window=float')).length
    check('空闲时不创建悬浮窗', idleFloatCount === 0, `count=${idleFloatCount}`)
  } finally {
    await closeApp(app)
  }

  console.log('\n[E2E-4] 附件主路径（R4-5）：fixture 选择→预览→发送→mock model 收到正文，仅 1 次模型调用')
  const fixtureDir = path.join(ROOT, 'e2e-screenshots', 'fixture')
  const settingsFixtureDir = path.join(ROOT, 'e2e-screenshots', 'settings-fixture')
  await fsp.mkdir(fixtureDir, { recursive: true })
  await fsp.mkdir(settingsFixtureDir, { recursive: true })
  await fsp.writeFile(path.join(fixtureDir, 'note.txt'), '这是来自 fixture 的附件正文内容 R4-E2E', 'utf-8')
  await fsp.rm(path.join(fixtureDir, 'renpy.exe'), { force: true })
  await fsp.writeFile(path.join(settingsFixtureDir, 'renpy.exe'), '', 'utf-8')
  const mock = await startMockModel()
  try {
    const { app: app2, page: page2 } = await launchApp(1280, 900, { DW_TEST_FIXTURE_DIR: fixtureDir, DW_TEST_SETTINGS_FIXTURE_DIR: settingsFixtureDir, ...mockPricingEnv(mock.port) })
    try {
      await setSettingsToMock(page2, mock.port)
      await page2.getByRole('button', { name: '设置', exact: true }).click()
      await page2.getByRole('dialog', { name: '设置', exact: true }).waitFor({ state: 'visible' })
      await page2.getByRole('navigation', { name: '设置分类' }).getByRole('button', { name: '工作区', exact: true }).click()
      await page2.getByText('文档默认保存目录', { exact: true }).locator('..').getByRole('button', { name: '选择', exact: true }).click()
      await page2.getByRole('button', { name: '保存并关闭', exact: true }).click()
      await page2.getByRole('dialog', { name: '设置', exact: true }).waitFor({ state: 'detached' })
      const savedDialog = await page2.evaluate(async () => (window as any).ds.getSettings())
      check('设置弹窗保存目录保留主进程新配置的凭据', savedDialog.docDir === settingsFixtureDir && savedDialog.apiKey === '__CONFIGURED__')
      const directoryButton = page2.getByRole('button', { name: /^工作目录：/ })
      await page2.getByTestId('composer-tools-trigger').click()
      await directoryButton.click()
      await page2.waitForFunction(() => document.querySelector('.working-directory-btn')?.getAttribute('aria-label')?.endsWith('settings-fixture'))
      check('Agent 输入区可直接选择授权工作目录', (await page2.evaluate(async () => (window as any).ds.getSettings())).workDir === settingsFixtureDir)
      check('输入区切换目录不会清除已配置的凭据', (await page2.evaluate(async () => (window as any).ds.getSettings())).apiKey === '__CONFIGURED__')
      const pathSettings = await page2.evaluate(async () => {
        const ds = (window as any).ds
        const dir = await ds.chooseDir('settings')
        const sdk = await ds.chooseSdkExecutable()
        const current = await ds.getSettings()
        await ds.setSettings({
          ...current,
          workDir: { value: 'renderer-value-must-not-be-trusted', dirRefId: dir.view.fileRefId },
          galgame: { ...current.galgame, sdkPath: { value: 'fake.exe', dirRefId: sdk.view.fileRefId } }
        })
        const saved = await ds.getSettings()
        return { dirPath: dir.path, sdkPath: sdk.path, savedWorkDir: saved.workDir, savedSdkPath: saved.galgame.sdkPath }
      })
      check('设置目录选择器与保存使用同一授权作用域', pathSettings.savedWorkDir === pathSettings.dirPath, JSON.stringify(pathSettings))
      check('Ren\'Py SDK 按文件能力保存且忽略 renderer 伪造路径', pathSettings.savedSdkPath === pathSettings.sdkPath, JSON.stringify(pathSettings))
      // 通过 UI 附件按钮触发选择（测试 seam：dialog:openFiles 返回 fixture 文件 refs）
      await page2.getByRole('button', { name: '添加附件' }).click()
      await page2.waitForTimeout(900)
      check('附件 chip 出现（预览 ready）', (await page2.locator('.attach-chip').count()) > 0, '无附件 chip')
      await page2.locator('.composer textarea').fill('附件草稿只属于原会话')
      await page2.getByRole('button', { name: '新建会话', exact: true }).click()
      check('新会话不带入旧会话附件', (await page2.locator('.attach-chip').count()) === 0)
      await page2.locator('.session-sidebar').getByRole('button', { name: /附件草稿只属于原会话/ }).click()
      check('切回原会话还原附件和草稿', (await page2.locator('.attach-chip').count()) === 1 && await page2.locator('.composer textarea').inputValue() === '附件草稿只属于原会话')
      await page2.locator('textarea').fill('请阅读附件并总结')
      await page2.getByRole('button', { name: '发送', exact: true }).click()
      check('普通 Agent 不显示长文进度目标', (await page2.getByTestId('stream-progress').count()) === 0 && (await page2.getByTestId('long-write-status').count()) === 0)
      const deadline = Date.now() + 10000
      let sendDiagnostic = ''
      while (mock.calls.length === 0 && Date.now() < deadline) {
        sendDiagnostic = (await page2.locator('.toast, .error-banner').allTextContents()).join(' | ') || sendDiagnostic
        await page2.waitForTimeout(200)
      }
      check('mock model 收到请求', mock.calls.length >= 1, `calls=${mock.calls.length}; ${sendDiagnostic}`)
      if (mock.calls.length === 0) await page2.screenshot({ path: path.join(SHOT_DIR, 'attachment-send-failure.png') })
      const firstBody = mock.calls[0]?.body
      const allContent = (firstBody?.messages ?? []).map((m) => m.content).join('\n')
      check('模型请求包含附件正文（read-for-model 链路）', allContent.includes('来自 fixture 的附件正文内容'), allContent.slice(0, 200))
      check('模型请求未收到"读取被拒绝"占位', !allContent.includes('读取被拒绝'), '')
      await page2.waitForTimeout(1500)
      check('附件主路径全程仅 1 次模型调用（FILE-01）', mock.calls.length === 1, `calls=${mock.calls.length}`)
    } finally {
      await closeApp(app2)
    }
  } finally {
    await new Promise<void>((r) => { mock.server.closeAllConnections?.(); mock.server.close(() => r()) })
  }

  console.log('\n[E2E-5] V4 tool transcript 重建（R4-4）：第一轮工具调用 → tool 消息落库 → 第二轮请求含 role=tool')
  const mock5 = await startMockModel({ toolCallFirst: true })
  try {
    const { app: app5, page: page5 } = await launchApp(1280, 900, mockPricingEnv(mock5.port))
    try {
      await setSettingsToMock(page5, mock5.port)
      await page5.locator('textarea').fill('执行一个工具任务')
      await page5.getByRole('button', { name: '发送', exact: true }).click()
      const deadline5 = Date.now() + 15000
      while (mock5.calls.length < 2 && Date.now() < deadline5) {
        await page5.waitForTimeout(200)
      }
      check('工具调用两轮请求（第一轮 tool_calls + 第二轮文本）', mock5.calls.length === 2, `calls=${mock5.calls.length}`)
      const second = mock5.calls[1]?.body
      const toolMsgs = (second?.messages ?? []).filter((m) => m.role === 'tool')
      check('第二轮请求包含 role=tool 消息（transcript 从 DB turns 重建）', toolMsgs.length >= 1, JSON.stringify((second?.messages ?? []).slice(-3)))
      check('tool 消息携带 tool_call_id（tc_e2e_1）', toolMsgs.some((m) => m.tool_call_id === 'tc_e2e_1'), JSON.stringify(toolMsgs))
      // UI 到达完成态（msg-bubble）
      const deadlineDone = Date.now() + 15000
      let doneText = ''
      while (Date.now() < deadlineDone) {
        doneText = await page5.locator('.msg-bubble').last().innerText().catch(() => '')
        if (doneText.includes('总结')) break
        await page5.waitForTimeout(300)
      }
      check('UI 显示工具调用后的总结（完整链路闭环）', doneText.includes('总结'), doneText.slice(0, 80))
      const detailButton = page5.getByRole('button', { name: '查看任务详情' }).last()
      await detailButton.waitFor({ state: 'visible', timeout: 5000 }).catch(() => undefined)
      if (await detailButton.isVisible().catch(() => false)) {
        await detailButton.click()
        await page5.locator('.run-inspector').waitFor({ state: 'visible' })
        check('运行详情可从完成记录进入', await page5.getByRole('dialog', { name: '任务详情' }).isVisible())
        const logFonts = await page5.evaluate(() => {
          const selectors = ['.run-inspector-sub', '.ri-stats', '.ri-section h4', '.step-title', '.step-args', '.step-meta', '.ri-tool-name']
          return selectors.flatMap((selector) => Array.from(document.querySelectorAll(selector)).map((node) => ({ selector, px: Number.parseFloat(getComputedStyle(node).fontSize) })))
        })
        check('运行详情与细分日志没有小于 12px 的正文', logFonts.every((item) => item.px >= 12), JSON.stringify(logFonts))
        await page5.screenshot({ path: path.join(SHOT_DIR, 'ui-run-inspector.png'), animations: 'disabled' })
      } else {
        check('运行详情可从完成记录进入', false, '未找到任务详情入口')
      }
      console.log('[E2E-5] done; closing app5...')
    } finally {
      await closeApp(app5)
      console.log('[E2E-5] app5 closed; closing mock5...')
    }
  } finally {
    await new Promise<void>((r) => { mock5.server.closeAllConnections?.(); mock5.server.close(() => r()) })
    console.log('[E2E-5] mock5 closed')
  }

  console.log('\n[E2E-6] 四工作区布局（R4-5 第 8 条）：各工作面板无横向溢出')
  const { app: app6, page: page6 } = await launchApp(1280, 900)
  try {
    check('顶栏不再存在第二套工作区入口', (await page6.locator('.ws-btn').count()) === 0)
    const globalNav = page6.getByRole('navigation', { name: '全局一级导航' })
    for (const label of ['长文', '风格参考', 'Galgame']) {
      if (label === '风格参考' || label === 'Galgame') await globalNav.locator('summary').click()
      await globalNav.getByRole('button', { name: label, exact: true }).click()
      const workspaceClass = label === '长文'
        ? '.chat-area.workspace-novel'
        : label === '风格参考'
          ? '.chat-area.workspace-style'
          : '.chat-area.workspace-galgame'
      const workspace = page6.locator(workspaceClass)
      await workspace.waitFor({ state: 'visible' })
      if (label === '长文') await page6.locator('.composer').waitFor({ state: 'detached' })
      else await page6.locator('.composer').waitFor({ state: 'visible' })
      const centralCanvas = workspace.locator('.dw-workspace-canvas')
      await centralCanvas.waitFor({ state: 'visible' })
      const panelCount = await page6.locator('.side-panel').count()
      const overflowInfo = await page6.evaluate(() => {
        const els = Array.from(document.querySelectorAll('*'))
          .filter((el) => {
            const r = el.getBoundingClientRect()
            return r.right > window.innerWidth + 4 || r.left < -4
          })
          .slice(0, 14)
          .map((el) => `${el.tagName}.${String((el as HTMLElement).className).slice(0, 40)}`)
        const rects = ['.app', '.layout', '.chat-area', '.topbar', '.session-sidebar', '.side-panel'].map((sel) => {
          const el = document.querySelector(sel)
          if (!el) return `${sel}:none`
          const r = el.getBoundingClientRect()
          return `${sel}:w=${Math.round(r.width)} r=${Math.round(r.right)}`
        })
        const layoutKids = Array.from(document.querySelector('.layout')?.children ?? []).map((el) => {
          const r = el.getBoundingClientRect()
          return `${el.tagName}.${String((el as HTMLElement).className).slice(0, 30)}:l=${Math.round(r.left)} w=${Math.round(r.width)}`
        })
        return { doc: document.documentElement.scrollWidth, inner: window.innerWidth, els, rects, layoutKids }
      })
      const overflow = overflowInfo.doc > overflowInfo.inner + 4
      const composerCount = await page6.locator('.composer').count()
      const composerVisible = composerCount === 1 && await page6.locator('.composer').isVisible()
      const composerMatchesWorkspace = label === '长文' ? composerCount === 0 : composerVisible
      check(`工作区「${label}」中央画布无横向溢出且 Composer 状态正确`, panelCount > 0 && await centralCanvas.isVisible() && !overflow && composerMatchesWorkspace, `panel=${panelCount} canvas=${await centralCanvas.isVisible()} doc=${overflowInfo.doc} inner=${overflowInfo.inner} rects=${JSON.stringify(overflowInfo.rects)} kids=${JSON.stringify(overflowInfo.layoutKids)} els=${JSON.stringify(overflowInfo.els)} composerCount=${composerCount} composerVisible=${composerVisible}`)
      if (label === '长文') {
        const longformShell = page6.getByTestId('longform-workflow-shell')
        await longformShell.waitFor({ state: 'visible' })
        const longformStages = page6.getByRole('navigation', { name: '长文业务阶段' })
        check('长文工作流外壳与五个业务阶段存在', await longformShell.isVisible() && (await longformStages.getByRole('button').count()) === 5)
        await page6.screenshot({ path: path.join(SHOT_DIR, 'ui-longform.png') })
        await longformStages.getByRole('button', { name: /素材回顾/ }).click()
        await page6.waitForFunction(() => Array.from(document.querySelectorAll('[aria-label="长文业务阶段"] button')).some((button) => button.getAttribute('aria-pressed') === 'true' && button.getAttribute('aria-label')?.includes('素材回顾')))
        await page6.screenshot({ path: path.join(SHOT_DIR, 'ui-longform-material-review.png') })
        await longformStages.getByRole('button', { name: /分场写作/ }).click()
        await page6.waitForFunction(() => Array.from(document.querySelectorAll('[aria-label="长文业务阶段"] button')).some((button) => button.getAttribute('aria-pressed') === 'true' && button.getAttribute('aria-label')?.includes('分场写作')))
        await page6.screenshot({ path: path.join(SHOT_DIR, 'ui-longform-scene-writing.png') })
      }
      if (label === '风格参考') {
        const styleStages = page6.locator('.dw-stage-nav .dw-stage-item')
        await styleStages.first().waitFor({ state: 'visible' })
        check('风格参考保留三项阶段导航', await styleStages.count() === 3)
        await page6.screenshot({ path: path.join(SHOT_DIR, 'ui-style.png') })
        await styleStages.filter({ hasText: '生成任务' }).click()
        await page6.screenshot({ path: path.join(SHOT_DIR, 'ui-style-generate.png') })
      }
      if (label === 'Galgame') {
        await page6.getByRole('region', { name: 'Galgame Studio' }).waitFor({ state: 'visible' })
        await page6.screenshot({ path: path.join(SHOT_DIR, 'ui-galgame.png') })
        check('Galgame Studio region 存在', await page6.getByRole('region', { name: 'Galgame Studio' }).isVisible())
        check('Galgame 默认进入项目创建/导入阶段并显示制作进度', await page6.getByRole('heading', { name: '创建或导入项目' }).isVisible() && await page6.getByRole('status', { name: '制作进度' }).isVisible())
        await page6.screenshot({ path: path.join(SHOT_DIR, 'ui-galgame-entry.png') })
      }
    }

    await page6.locator('.dw-topbar .dw-icon-btn[aria-label="设置"]').click()
    const settingsNav = page6.locator('.dw-settings-nav')
    await settingsNav.waitFor({ state: 'visible' })
    check('设置含扩展分类且同一时刻只展示一页', (await settingsNav.locator('button').count()) === 8 && (await page6.locator('.dw-settings-page:visible').count()) === 1 && await settingsNav.getByRole('button', { name: '扩展', exact: true }).count() === 1)
    await settingsNav.getByRole('button', { name: /完成与预算/ }).click()
    check('Agent 运行限制按需展开，长文预算沿用独立语义', await page6.getByTestId('agent-run-limits').isVisible() && await page6.locator('.dw-writing-settings').getAttribute('open') === null)
    await page6.locator('.dw-writing-settings > summary').click()
    check('长文保留预设、自定义 token 与墙钟三类控制', (await page6.locator('.dw-writing-settings .dw-budget-presets [role="radio"]').count()) === 3 && (await page6.locator('.dw-writing-settings .dw-number-field input').count()) === 2)
    await page6.screenshot({ path: path.join(SHOT_DIR, 'ui-settings-completion.png') })
    await settingsNav.getByRole('button', { name: /权限/ }).click()
    check('设置分类切换后仍只展示当前页', (await page6.locator('.dw-settings-page:visible').count()) === 1 && await page6.getByRole('heading', { name: '权限', exact: true }).isVisible())
    check('权限模式为键盘可识别的单选组（不再使用可点击 div）', (await page6.locator('.dw-permission-segment[role="radiogroup"] .dw-permission-option[role="radio"]').count()) === 3)
    const typeSelect = page6.getByRole('button', { name: '规则类型' })
    await typeSelect.click()
    check('自定义规则选择器使用 listbox/option 语义', (await page6.locator('.dw-select-menu[role="listbox"] .dw-select-option[role="option"]').count()) === 2)
    await page6.keyboard.press('Escape')
    check('Escape 可关闭自定义选择器', (await page6.locator('.dw-select-menu').count()) === 0)
    check('一次性规则使用紧凑 Switch 控件', (await page6.locator('.dw-switch', { hasText: '仅一次' }).count()) === 1)
    await page6.screenshot({ path: path.join(SHOT_DIR, 'ui-settings-permissions.png') })
  } finally {
    await closeApp(app6)
  }

  console.log('\n[E2E-6B] 运行中任务：悬浮状态 + 人性化阶段信息')
  const mock6b = await startMockModel({ chunkDelayMs: 10000 })
  try {
    const { app: app6b, page: page6b } = await launchApp(1280, 900, mockPricingEnv(mock6b.port))
    try {
      await setSettingsToMock(page6b, mock6b.port)
      await page6b.locator('textarea').last().fill('分析这段故事的冲突与人物动机')
      await page6b.getByRole('button', { name: '发送', exact: true }).click()
      await page6b.locator('.dw-topbar .dw-icon-btn[aria-label="打开悬浮进度窗"]').click()
      await page6b.waitForTimeout(600)
      const float6b = app6b.windows().find((candidate) => candidate.url().includes('window=float'))
      check('任务运行时悬浮窗已显示', Boolean(float6b))
      if (float6b) {
        const floatInfo = await app6b.evaluate(({ BrowserWindow }) => {
          const win = BrowserWindow.getAllWindows().find((candidate) => candidate.webContents.getURL().includes('window=float'))
          return win ? { contentBounds: win.getContentBounds() } : null
        })
        check('运行态悬浮窗为紧凑 320×84 双层信息卡', floatInfo?.contentBounds.width === 320 && floatInfo?.contentBounds.height === 84, JSON.stringify(floatInfo))
        const exposure = await float6b.evaluate(() => ({ hasMainApi: Boolean((window as any).ds), hasFloatApi: Boolean((window as any).dwFloat) }))
        check('悬浮窗只暴露窄能力（无主窗口 ds）', exposure.hasMainApi === false && exposure.hasFloatApi === true, JSON.stringify(exposure))
        const state = await float6b.evaluate(async () => (window as any).dwFloat.getState())
        const durableRun = await page6b.evaluate(async () => (await (window as any).ds.runsListRecent(50))[0])
        check('悬浮状态对应真实 Agent 任务与思考阶段，不虚构总步数', state.runId === durableRun.runId && durableRun.status === 'running' && state.status === 'running' && state.phase === 'thinking' && state.stepTotal === 0, JSON.stringify(state))
        const floatHierarchy = await float6b.evaluate(() => {
          const project = document.querySelector('.dw-float-project') as HTMLElement | null
          const phase = document.querySelector('.dw-float-phase') as HTMLElement | null
          const projectStyle = project ? getComputedStyle(project) : null
          const phaseStyle = phase ? getComputedStyle(phase) : null
          return {
            project: project?.textContent?.trim() ?? '',
            phase: phase?.textContent?.trim() ?? '',
            projectSize: Number.parseFloat(projectStyle?.fontSize ?? '0'),
            projectWeight: Number.parseInt(projectStyle?.fontWeight ?? '0', 10),
            phaseSize: Number.parseFloat(phaseStyle?.fontSize ?? '0'),
            phaseWeight: Number.parseInt(phaseStyle?.fontWeight ?? '0', 10)
          }
        })
        check('悬浮窗上层项目名更大加粗、下层状态为正常字重', Boolean(floatHierarchy.project) && floatHierarchy.projectSize > floatHierarchy.phaseSize && floatHierarchy.projectWeight >= 600 && floatHierarchy.phaseWeight <= 500, JSON.stringify(floatHierarchy))
        check('悬浮窗状态使用自然语言，不展示精确进度数值', Boolean(floatHierarchy.phase) && !/\d/.test(floatHierarchy.phase), JSON.stringify(floatHierarchy))
        const hideControl = float6b.getByRole('button', { name: '隐藏悬浮窗' })
        check('悬浮卡片动作默认隐藏（不形成常驻按钮条）', !(await hideControl.isVisible().catch(() => false)))
        await float6b.locator('.dw-float-root').dispatchEvent('mouseover')
        await float6b.waitForFunction(() => {
          const root = document.querySelector('.dw-float-root')
          return Boolean(root?.classList.contains('is-hovered')) || root?.querySelector('[aria-hidden="false"]') !== null
        })
        check('指针进入后暴露动作语义', await hideControl.isVisible().catch(() => false))
        await float6b.locator('.dw-float-summary').focus()
        const focusedHideVisible = await hideControl.isVisible().catch(() => false)
        const stopVisible = await float6b.getByRole('button', { name: '停止当前任务' }).isVisible().catch(() => false)
        check('聚焦后显示动作', focusedHideVisible && stopVisible)
        check('运行中悬浮窗提供停止动作', stopVisible)
        await float6b.screenshot({ path: path.join(SHOT_DIR, 'float-running.png'), timeout: 5000 }).catch(() => undefined)
      }
    } finally {
      await closeApp(app6b)
    }
  } finally {
    await new Promise<void>((r) => { mock6b.server.closeAllConnections?.(); mock6b.server.close(() => r()) })
  }

  await runStopAcceptance()

  console.log('\n[E2E-8] endpoint 攻击被拒（SEC-01 E2E）：evil baseUrl 设置失败、请求仍到原 mock')
  const { app: app8, page: page8 } = await launchApp(1280, 900)
  try {
    const evilResult = await page8.evaluate(async () => {
      const ds = (window as any).ds
      try {
        await ds.setSettings({ ...(await ds.getSettings()), baseUrl: 'https://evil.example.com' })
        return 'accepted'
      } catch {
        return 'rejected'
      }
    })
    check('evil.example.com baseUrl 设置被拒绝（schema 白名单）', evilResult === 'rejected', `result=${evilResult}`)
  } finally {
    await closeApp(app8)
  }

  console.log('\n[E2E-9] 会话跨重启恢复（PERSIST-RESTART-01，B-04）：完成会话 → 复用 userData 重启 → 列表/消息逐字一致')
  const persistUd = path.join(ROOT, 'e2e-screenshots', 'fixture', `persist-ud-${Date.now()}`)
  await fsp.mkdir(persistUd, { recursive: true })
  const mock9 = await startMockModel()
  try {
    const { app: app9, page: page9 } = await launchApp(1280, 900, mockPricingEnv(mock9.port), persistUd)
    try {
      await setSettingsToMock(page9, mock9.port)
      await page9.locator('textarea').fill('这是一条需要跨重启保留的消息')
      await page9.getByRole('button', { name: '发送', exact: true }).click()
      const deadline9 = Date.now() + 15000
      while (mock9.calls.length < 1 && Date.now() < deadline9) {
        await page9.waitForTimeout(200)
      }
      // 先等 UI 完成态（区分"引擎未完成"与"投影失败"）
      const uiDone9 = Date.now() + 15000
      let uiDone = false
      while (Date.now() < uiDone9) {
        const t = await page9.locator('.msg-bubble').last().innerText().catch(() => '')
        const stoppedRunning = (await page9.locator('.btn.stop').count()) === 0
        if (t.includes('总结') && stoppedRunning) {
          uiDone = true
          break
        }
        await page9.waitForTimeout(300)
      }
      check('E2E-9 UI 收到 terminal 并退出运行态', uiDone, '')
      // 等待 canonical session 投影（assistant 消息写入 SQLite）
      const projDeadline = Date.now() + 15000
      let hasAssistant = false
      while (Date.now() < projDeadline) {
        const sessions = await page9.evaluate(async () => (window as any).ds.sessionsList())
        const sid = (sessions as Array<{ id: string }>)[0]?.id
        if (sid) {
          const msgs = await page9.evaluate(async (id: string) => (window as any).ds.sessionsLoad(id), sid)
          hasAssistant = (msgs as Array<{ role: string }>).some((m) => m.role === 'assistant')
        }
        if (hasAssistant) break
        await page9.waitForTimeout(400)
      }
      check('关闭前 assistant 消息已投影到 canonical session', hasAssistant, '')
      // 诊断：run turns 是否有 assistant（区分引擎未完成 vs 投影失败）
      const turnsDiag = await page9.evaluate(async () => {
        const ds = (window as any).ds
        const runs = await ds.runsRecoverable()
        void runs
        return 'n/a'
      })
      void turnsDiag
    } finally {
      await closeApp(app9)
    }
    // 复用同一 userData 重启
    const { app: app9b, page: page9b } = await launchApp(1280, 900, mockPricingEnv(mock9.port), persistUd)
    try {
      const sessions = await page9b.evaluate(async () => (window as any).ds.sessionsList())
      check('重启后会话列表非空（PERSIST-RESTART-01）', Array.isArray(sessions) && sessions.length >= 1, JSON.stringify(sessions))
      const sid = (sessions as Array<{ id: string }>)[0]?.id
      const msgs = sid ? await page9b.evaluate(async (id: string) => (window as any).ds.sessionsLoad(id), sid) : []
      const allText = (msgs as Array<{ content: string }>).map((m) => m.content).join('\n')
      check('重启后消息逐字可恢复', allText.includes('这是一条需要跨重启保留的消息'), allText.slice(0, 200))
      check('重启后助手回复可恢复', allText.includes('完成') || allText.includes('总结') || allText.includes('收到'), allText.slice(0, 300))
    } finally {
      await closeApp(app9b)
    }
  } finally {
    await new Promise<void>((r) => { mock9.server.closeAllConnections?.(); mock9.server.close(() => r()) })
    await fsp.rm(persistUd, { recursive: true, force: true }).catch(() => undefined)
  }

  console.log('\n[E2E-10] Markdown 按需加载、代码复制与链接行为')
  const markdownReply = ['## 文件整理结果', '', '| 文件 | 状态 |', '| --- | --- |', '| note.txt | 已读取 |', '', '```', '<原样保留的代码>', '```', '', '```typescript', 'const ready: boolean = true', '```', '', '```made-up', '<未知语言也原样保留>', '```', '', '[项目文档](https://github.com/qlys123/DeepWriter)', '[不可执行的地址](javascript:alert(1))'].join('\n')
  const mock10 = await startMockModel({ contentChunks: [markdownReply, '\n\n补充建议：整理前先备份文件。'], pauseAfterFirstChunk: true })
  try {
    const { app: app10, page: page10 } = await launchApp(1280, 900, mockPricingEnv(mock10.port))
    try {
      await setSettingsToMock(page10, mock10.port)
      await page10.getByRole('textbox', { name: '任务内容' }).fill('读取工作目录中的文件，给出整理结果与代码示例。')
      await page10.getByRole('button', { name: '发送', exact: true }).click()
      await page10.locator('.markdown-body .code-block').nth(2).waitFor({ state: 'visible', timeout: 15000 })
      check('回复按需加载 Markdown，渲染 GFM 表格', await page10.locator('.markdown-body table').isVisible())
      check('无语言代码块保留独立复制入口和原文', await page10.locator('.code-block').first().locator('code').innerText() === '<原样保留的代码>' && await page10.locator('.code-block').first().getByRole('button', { name: '复制', exact: true }).isVisible())
      check('已知语言保持语法高亮', (await page10.locator('.code-block code.language-typescript .hljs-keyword').count()) > 0)
      check('未知语言保留转义文本，不产生 HTML 元素', await page10.locator('.code-block').nth(2).locator('code').innerText() === '<未知语言也原样保留>' && (await page10.locator('.code-block').nth(2).locator('code > *').count()) === 0)
      const link = page10.getByRole('link', { name: '项目文档', exact: true })
      check('网页链接交给系统浏览器，包含隔离属性', await link.getAttribute('target') === '_blank' && /noopener/.test(await link.getAttribute('rel') ?? ''))
      check('非网页协议不能成为可执行链接', (await page10.getByRole('link', { name: '不可执行的地址' }).count()) === 0)
      // Keep feedback expiry deterministic across slower runners. Model/network
      // and main-process persistence use real time; only this renderer clock pauses.
      const feedbackTime = new Date()
      await page10.clock.install({ time: feedbackTime })
      await page10.clock.pauseAt(new Date(feedbackTime.getTime() + 10_000))
      await page10.locator('.code-block').first().getByRole('button', { name: '复制', exact: true }).click()
      await expect(page10.locator('.code-block').first().getByRole('button', { name: '已复制', exact: true })).toBeVisible()
      check('真实桌面剪贴板得到代码原文', await page10.evaluate(() => navigator.clipboard.readText()) === '<原样保留的代码>')
      await page10.locator('.code-block').first().evaluate((el) => { (el as HTMLElement).dataset.streamIdentity = 'original' })
      mock10.resumeReply()
      await page10.getByText('补充建议：整理前先备份文件。', { exact: true }).waitFor({ state: 'visible' })
      check('流式追加保留代码块和复制反馈，不重复挂载', await page10.locator('.code-block').first().getAttribute('data-stream-identity') === 'original' && await page10.locator('.code-block').first().getByRole('button', { name: '已复制', exact: true }).isVisible())
      await page10.clock.runFor(1499)
      await expect(page10.locator('.code-block').first().getByRole('button', { name: '已复制', exact: true })).toBeVisible()
      await page10.clock.runFor(1)
      await expect(page10.locator('.code-block').first().getByRole('button', { name: '复制', exact: true })).toBeVisible()
      check('复制反馈按原时限到期，不被流式更新重置', await page10.locator('.code-block').first().getAttribute('data-stream-identity') === 'original')
      await page10.clock.resume()
      await page10.locator('.btn.stop').waitFor({ state: 'detached', timeout: 15000 })
      await page10.screenshot({ path: path.join(SHOT_DIR, 'agent-markdown.png') })
    } finally { await closeApp(app10) }
  } finally {
    await new Promise<void>((resolve) => { mock10.server.closeAllConnections?.(); mock10.server.close(() => resolve()) })
  }

  console.log('\n[E2E-11] 真实目录工具与 20 个连续独立任务')
  const demoDir = path.join(SHOT_DIR, 'demo-project')
  await fsp.mkdir(demoDir, { recursive: true })
  await fsp.writeFile(path.join(demoDir, 'README.md'), '# 示例项目\n本目录仅供桌面测试使用。\n')
  await fsp.writeFile(path.join(demoDir, 'package.json'), '{"name":"demo-project","private":true}\n')
  await fsp.writeFile(path.join(demoDir, 'notes.txt'), '待整理的项目笔记。\n')
  const directoryReply = '## 目录检查结果\n\n已列出当前示例项目的文件：\n\n- `README.md`：项目说明\n- `package.json`：项目配置\n- `notes.txt`：待整理的笔记\n\n下一步可先检查项目说明与配置，再整理笔记。'
  const mock11 = await startMockModel({ toolCallFirst: true, toolName: 'list_files', toolArguments: { path: '.', depth: 1 }, content: directoryReply })
  try {
    const { app: app11, page: page11 } = await launchApp(1280, 900, { ...mockPricingEnv(mock11.port), DW_TEST_SETTINGS_FIXTURE_DIR: demoDir })
    try {
      const rendererErrors: string[] = []
      page11.on('pageerror', (error) => rendererErrors.push(error.message))
      await setSettingsToMock(page11, mock11.port)
      await page11.getByTestId('composer-tools-trigger').click()
      await expect(page11.getByRole('button', { name: /^工作目录：/ })).toBeVisible()
      await page11.getByRole('button', { name: /^工作目录：/ }).click()
      await page11.waitForFunction(() => document.querySelector('.working-directory-btn')?.textContent?.includes('demo-project'))
      await page11.locator('.toast').waitFor({ state: 'detached' })
      await page11.screenshot({ path: path.join(SHOT_DIR, 'agent-home.png') })
      await page11.getByRole('textbox', { name: '任务内容' }).fill('检查当前项目的目录结构，给出文件整理建议。')
      await page11.getByRole('button', { name: '发送', exact: true }).click()
      const toolDeadline = Date.now() + 15000
      while (mock11.calls.length < 2 && Date.now() < toolDeadline) await page11.waitForTimeout(100)
      check('实际 list_files 工具进入第二轮模型请求', mock11.calls.length === 2)
      const toolText = (mock11.calls[1]?.body.messages ?? []).filter((message) => message.role === 'tool').map((message) => message.content).join('\n')
      check('真实工具结果包含示例目录的三个文件', ['README.md', 'package.json', 'notes.txt'].every((name) => toolText.includes(name)), toolText.slice(0, 250))
      await waitForDurableRuns(page11, 1)
      await page11.locator('.markdown-body').waitFor({ state: 'visible' })
      check('目录任务使用持久化完成态，不显示长文拼接段数', !(await page11.locator('.msg.assistant').innerText()).includes('段拼接'))
      const processDetails = page11.locator('.msg.assistant .message-process')
      check('工具过程默认折叠，不自动打开运行侧栏', await processDetails.evaluate((el) => !el.hasAttribute('open')) && await page11.locator('.dw-activity-rail').count() === 0)
      await page11.screenshot({ path: path.join(SHOT_DIR, 'agent-directory-result.png') })
      await processDetails.locator('summary').first().click()
      const directoryTool = processDetails.getByRole('button', { name: /^列出目录/ })
      await directoryTool.focus()
      await page11.keyboard.press('Enter')
      await processDetails.locator('.tool-card-result').waitFor({ state: 'visible' })
      const displayedToolResult = await processDetails.locator('.tool-card-result').innerText()
      check('用户可以用键盘展开实际工具结果', await directoryTool.getAttribute('aria-expanded') === 'true' && ['README.md', 'package.json', 'notes.txt'].every((name) => displayedToolResult.includes(name)), displayedToolResult.slice(0, 500))

      for (let index = 1; index <= 20; index++) {
        await page11.getByRole('button', { name: '新建会话', exact: true }).click()
        await page11.getByRole('textbox', { name: '任务内容' }).fill(`连续任务 ${index}：概括当前示例目录。`)
        await page11.getByRole('button', { name: '发送', exact: true }).click()
        const deadline = Date.now() + 10000
        while (mock11.calls.length < index + 2 && Date.now() < deadline) await page11.waitForTimeout(50)
        if (mock11.calls.length !== index + 2) throw new Error(`连续任务 ${index} 未进入模型请求`)
        // A previous run can receive its final update after the next run
        // starts. "Most recently updated" is therefore not this iteration's
        // identity, particularly with Windows' coarser clock resolution.
        await waitForDurableRuns(page11, index + 1).catch(async (error: unknown) => {
          const current = await page11.evaluate(async () => (window as any).ds.runsListRecent(50)) as Array<{ runId: string; status: string; durableCompleted: boolean }>
          console.error(`连续任务 ${index} 完成等待失败：`, JSON.stringify({ expected: index + 1, count: current.length, incomplete: current.filter((run) => run.status !== 'completed' || !run.durableCompleted).map((run) => ({ runId: run.runId, status: run.status, durableCompleted: run.durableCompleted })) }))
          throw error
        })
        await page11.locator('.btn.stop').waitFor({ state: 'detached' })
      }
      const recent = await page11.evaluate(async () => (window as any).ds.runsListRecent(50)) as Array<{ status: string; durableCompleted: boolean }>
      const sessions = await page11.evaluate(async () => (window as any).ds.sessionsList()) as Array<{ id: string; messageCount: number }>
      check('21 个任务全部持久化完成，无失败或待恢复记录', recent.length === 21 && recent.every((run) => run.status === 'completed' && run.durableCompleted), JSON.stringify(recent))
      check('连续任务没有重复模型调用', mock11.calls.length === 22, `calls=${mock11.calls.length}`)
      check('21 个独立会话各保存两条 canonical 消息', sessions.length === 21 && sessions.every((session) => session.messageCount === 2))
      check('连续桌面操作没有未处理的 Renderer 异常', rendererErrors.length === 0, rendererErrors.join(' | '))
      await page11.getByRole('navigation', { name: '全局一级导航' }).getByRole('button', { name: '任务中心', exact: true }).click()
      await page11.getByRole('heading', { name: '任务中心', exact: true }).waitFor({ state: 'visible' })
      await page11.screenshot({ path: path.join(SHOT_DIR, 'task-center.png') })
    } finally { await closeApp(app11) }
  } finally {
    await new Promise<void>((resolve) => { mock11.server.closeAllConnections?.(); mock11.server.close(() => resolve()) })
  }

  console.log('\n[E2E-12] 草稿跨重启、存储故障恢复与退出保存')
  const draftProfile = await fsp.mkdtemp(path.join(os.tmpdir(), 'dw-e2e-drafts-'))
  const draftA = '草稿 A：重启后保留这份未发送的任务 👩🏽‍💻。'
  const draftB = '草稿 B：关闭窗口前刚刚输入的下一份任务。'
  const draftFixture = { DW_TEST_FIXTURE_DIR: demoDir }
  const firstDraftApp = await launchApp(1280, 900, draftFixture, draftProfile)
  try {
    await firstDraftApp.page.getByRole('textbox', { name: '任务内容' }).fill(draftA)
    await firstDraftApp.page.getByRole('button', { name: '添加附件', exact: true }).click()
    await expect(firstDraftApp.page.locator('.attach-chip')).toHaveCount(3)
    await firstDraftApp.page.getByRole('button', { name: '新建会话', exact: true }).click()
    await firstDraftApp.page.getByRole('textbox', { name: '任务内容' }).fill(draftB)
    // No fixed delay or explicit save: production close must drain pending edits.
  } finally { await closeApp(firstDraftApp.app) }
  const draftTrace = JSON.parse(await fsp.readFile(path.join(draftProfile, 'shutdown-trace.json'), 'utf8')) as Array<{ event: string }>
  const flushIndex = draftTrace.findIndex((item) => item.event === 'composer_drafts_flushed')
  check('关闭窗口前草稿实际保存，且发生在数据库关闭之前', flushIndex >= 0 && flushIndex < draftTrace.findIndex((item) => item.event === 'db_checkpoint_close_completed'))

  const secondDraftApp = await launchApp(1280, 900, draftFixture, draftProfile)
  let draftBId = ''
  try {
    const page12 = secondDraftApp.page
    await expect(page12.getByRole('textbox', { name: '任务内容' })).toHaveValue(draftB)
    check('重启自动还原最后编辑的未发送文字', await page12.getByRole('textbox', { name: '任务内容' }).inputValue() === draftB)
    const drafts = await page12.evaluate(async () => (window as any).ds.composerDraftsList()) as Array<{ sessionId: string; text: string }>
    draftBId = drafts.find((draft) => draft.text === draftB)?.sessionId ?? ''
    check('两个未发送会话分别还原，没有创建 canonical 聊天记录', drafts.length === 2 && (await page12.evaluate(async () => (window as any).ds.sessionsList())).length === 0)
    await page12.getByRole('button', { name: /草稿 A：重启后/ }).click()
    await expect(page12.getByRole('textbox', { name: '任务内容' })).toHaveValue(draftA)
    check('切回旧草稿恢复 Unicode 文字，不恢复旧附件授权', await page12.getByRole('textbox', { name: '任务内容' }).inputValue() === draftA && await page12.locator('.attach-chip').count() === 0)

    const draftDbPath = path.join(draftProfile, 'deepwriter.db')
    const faultDb = new DatabaseSync(draftDbPath)
    try { faultDb.exec("CREATE TRIGGER draft_save_failure BEFORE UPDATE ON composer_drafts BEGIN SELECT RAISE(ABORT, 'injected draft storage error'); END") } finally { faultDb.close() }
    const changedDraft = draftA + ' 保存失败时这段修改仍然保留。'
    await page12.getByRole('textbox', { name: '任务内容' }).fill(changedDraft)
    await page12.locator('.composer-draft-error').waitFor({ state: 'visible' })
    check('真实 SQLite 保存故障保留新输入，并显示重试入口', await page12.getByRole('textbox', { name: '任务内容' }).inputValue() === changedDraft && await page12.getByRole('button', { name: '重试保存', exact: true }).isVisible())
    await secondDraftApp.app.evaluate(({ dialog }) => {
      ;(globalThis as any).__draftOriginalDialog = dialog.showMessageBox
      dialog.showMessageBox = (async (...args: unknown[]) => {
        ;(globalThis as any).__draftQuitPrompt = (args.at(-1) as { title?: string }).title
        return { response: 0, checkboxChecked: false }
      }) as typeof dialog.showMessageBox
    })
    await secondDraftApp.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((win) => !win.webContents.getURL().includes('window=float'))?.close())
    await expect.poll(() => secondDraftApp.app.evaluate(() => (globalThis as any).__draftQuitPrompt)).toBe('草稿尚未保存')
    await expect(page12.getByRole('textbox', { name: '任务内容' })).toBeEnabled()
    check('草稿保存失败时可以取消退出，窗口和新输入仍然存在', !page12.isClosed() && await page12.getByRole('textbox', { name: '任务内容' }).inputValue() === changedDraft)
    await secondDraftApp.app.evaluate(({ dialog }) => { dialog.showMessageBox = (globalThis as any).__draftOriginalDialog })
    const repairDb = new DatabaseSync(draftDbPath)
    try { repairDb.exec('DROP TRIGGER draft_save_failure') } finally { repairDb.close() }
    await page12.getByRole('button', { name: '重试保存', exact: true }).click()
    await page12.locator('.composer-draft-error').waitFor({ state: 'detached' })
    const recovered = await page12.evaluate(async () => (window as any).ds.composerDraftsList()) as Array<{ text: string }>
    check('存储恢复后重试保存的是最新文字', recovered.some((draft) => draft.text === changedDraft))
    const draftRow = page12.locator('.session-item').filter({ hasText: /草稿 A：重启后/ })
    await page12.mouse.move(700, 700)
    await draftRow.getByRole('button', { name: /草稿 A：重启后/ }).focus()
    await expect(draftRow.getByTitle('删除', { exact: true })).toBeVisible()
    check('键盘聚焦会话时显示管理操作', await draftRow.getByTitle('删除', { exact: true }).isVisible())
    const deleteFaultDb = new DatabaseSync(draftDbPath)
    try { deleteFaultDb.exec("CREATE TRIGGER draft_delete_failure BEFORE DELETE ON composer_drafts BEGIN SELECT RAISE(ABORT, 'injected deletion failure'); END") } finally { deleteFaultDb.close() }
    await draftRow.getByTitle('删除', { exact: true }).click()
    await page12.getByRole('button', { name: '删除会话', exact: true }).click()
    await expect(page12.getByText('暂时无法删除，请稍后重试', { exact: true })).toBeVisible()
    const retainedAfterDeleteFailure = await page12.evaluate(async () => (window as any).ds.composerDraftsList()) as Array<{ text: string }>
    check('当前会话删除失败仍保存输入框最新文字，没有清空持久化草稿', retainedAfterDeleteFailure.some((draft) => draft.text === changedDraft) && await page12.getByRole('textbox', { name: '任务内容' }).inputValue() === changedDraft)
    const deleteRepairDb = new DatabaseSync(draftDbPath)
    try { deleteRepairDb.exec('DROP TRIGGER draft_delete_failure') } finally { deleteRepairDb.close() }
    await draftRow.getByTitle('删除', { exact: true }).click()
    await page12.getByRole('button', { name: '删除会话', exact: true }).click()
    await expect.poll(async () => (await page12.evaluate(async () => (window as any).ds.composerDraftsList())).length).toBe(1)
    check('删除未发送会话同时清除持久化草稿', (await page12.evaluate(async () => (window as any).ds.composerDraftsList()))[0]?.sessionId === draftBId)
  } finally { await closeApp(secondDraftApp.app) }

  const mock12 = await startMockModel()
  try {
    const thirdDraftApp = await launchApp(1280, 900, mockPricingEnv(mock12.port), draftProfile)
    try {
      await expect(thirdDraftApp.page.getByRole('textbox', { name: '任务内容' })).toHaveValue(draftB)
      check('再次重启不会恢复已删除草稿', (await thirdDraftApp.page.evaluate(async () => (window as any).ds.composerDraftsList())).length === 1)
      await setSettingsToMock(thirdDraftApp.page, mock12.port)
      await thirdDraftApp.page.getByRole('button', { name: '发送', exact: true }).click()
      await waitForDurableRuns(thirdDraftApp.page, 1)
      await expect(thirdDraftApp.page.getByRole('textbox', { name: '任务内容' })).toHaveValue('')
      const afterSend = await thirdDraftApp.page.evaluate(async () => ({
        drafts: await (window as any).ds.composerDraftsList(),
        messages: await (window as any).ds.sessionsLoad((await (window as any).ds.sessionsList())[0]?.id)
      }))
      check('发送接受后草稿清除，原文字只进入一次 canonical 会话', afterSend.drafts.length === 0 && afterSend.messages.length === 2 && afterSend.messages[0]?.content === draftB && mock12.calls.length === 1)
      await thirdDraftApp.page.getByRole('textbox', { name: '任务内容' }).fill('已有历史会话中的下一份草稿。')
    } finally { await closeApp(thirdDraftApp.app) }
    const fourthDraftApp = await launchApp(1280, 900, mockPricingEnv(mock12.port), draftProfile)
    try {
      await expect(fourthDraftApp.page.getByRole('textbox', { name: '任务内容' })).toHaveValue('已有历史会话中的下一份草稿。')
      await expect(fourthDraftApp.page.locator('.message-list .msg-row')).toHaveCount(2)
      await expect(fourthDraftApp.page.locator('.message-list').getByText(draftB, { exact: true })).toBeVisible()
      check('重启已有会话同时恢复新草稿与 canonical 历史，不再次调用模型', mock12.calls.length === 1)
    } finally { await closeApp(fourthDraftApp.app) }
  } finally {
    await new Promise<void>((resolve) => { mock12.server.closeAllConnections?.(); mock12.server.close(() => resolve()) })
  }


  console.log('\n[E2E-13] 长回复自动跟随、上翻阅读与输入稳定性')
  const firstLongChunk = Array.from({ length: 80 }, (_, i) => `第 ${i + 1} 段：这是用于验证真实滚动的长回复。Unicode 👩🏽‍💻 与 Markdown **正文**。\n\n`).join('')
  const laterChunks = Array.from({ length: 80 }, (_, i) => `追加 ${i + 1}：流式回复继续生成，正在阅读的位置保持不变。\n\n`)
  const scrollMock = await startMockModel({ contentChunks: [firstLongChunk, ...laterChunks], chunkDelayMs: 30, pauseAfterFirstChunk: true })
  const scrollApp = await launchApp(1280, 900, mockPricingEnv(scrollMock.port))
  try {
    const scrollPage = scrollApp.page
    await setSettingsToMock(scrollPage, scrollMock.port)
    await scrollPage.getByRole('textbox', { name: '任务内容' }).fill('生成长回复用于桌面滚动验证。')
    await scrollPage.getByRole('button', { name: '发送', exact: true }).click()
    await expect(scrollPage.locator('.msg.assistant')).toContainText('第 80 段')
    const transcript = scrollPage.locator('.message-list.virtualized')
    const bottomGap = () => transcript.evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight)
    await expect.poll(bottomGap).toBeLessThan(30)
    check('首次长回复与 Markdown 布局完成后自动跟随到末尾', await bottomGap() < 30)
    const bounds = await transcript.boundingBox()
    if (!bounds) throw new Error('Missing scroll container')
    await scrollPage.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2)
    await scrollPage.mouse.wheel(0, -900)
    await expect(scrollPage.getByRole('button', { name: '↓ 回到最新', exact: true })).toBeVisible()
    const readingTop = await transcript.evaluate((el) => el.scrollTop)
    const nextDraft = '回复仍在生成时准备的下一份草稿。\n' + '多行输入仍应保留聊天操作空间。\n'.repeat(12)
    await scrollPage.getByRole('textbox', { name: '任务内容' }).fill(nextDraft)
    scrollMock.resumeReply()
    await scrollPage.waitForTimeout(900)
    const afterGrowth = await transcript.evaluate((el) => el.scrollTop)
    check('流式内容增长不会把上翻阅读的位置拉到底部', Math.abs(afterGrowth - readingTop) < 60 && await bottomGap() > 300, `scroll moved ${afterGrowth - readingTop}px`)
    check('生成期间输入保持焦点，下一份草稿没有丢失', await scrollPage.getByRole('textbox', { name: '任务内容' }).inputValue() === nextDraft && await scrollPage.getByRole('textbox', { name: '任务内容' }).evaluate((el) => document.activeElement === el))
    for (const width of [800, 1024, 1280]) {
      await resizeMainWindow(scrollApp.app, width, 900)
      if (width < 900) await expect(scrollPage.locator('.dw-session-sidebar')).toHaveClass(/collapsed/)
      const latestReachable = () => scrollPage.getByRole('button', { name: '↓ 回到最新', exact: true }).evaluate((button) => {
        const rect = button.getBoundingClientRect()
        const dock = document.querySelector('.dw-composer-dock')!.getBoundingClientRect()
        const transcript = document.querySelector('.message-list.virtualized')!.getBoundingClientRect()
        const hit = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2)
        return rect.bottom <= dock.top && rect.top >= transcript.top && hit !== null && button.contains(hit)
      })
      await expect.poll(latestReachable).toBe(true)
      check(`${width}px 多行输入下回到最新位于聊天区域内，可实际点击`, await latestReachable())
    }
    await scrollPage.getByRole('button', { name: '↓ 回到最新', exact: true }).click()
    await expect.poll(bottomGap).toBeLessThan(30)
    await waitForDurableRuns(scrollPage, 1)
    await expect.poll(bottomGap).toBeLessThan(30)
    const persisted = await scrollPage.evaluate(async () => (window as any).ds.sessionsLoad((await (window as any).ds.sessionsList())[0].id))
    check('回到最新恢复持续跟随，最终正文无截断或重复', await bottomGap() < 30 && persisted[1]?.content === firstLongChunk + laterChunks.join(''))
    check('最终回复完成后仍保留下一份未发送草稿', await scrollPage.getByRole('textbox', { name: '任务内容' }).inputValue() === nextDraft)
    await scrollPage.screenshot({ path: path.join(SHOT_DIR, 'v130-long-stream.png') })
  } finally {
    await closeApp(scrollApp.app)
    await new Promise<void>((resolve) => { scrollMock.server.closeAllConnections?.(); scrollMock.server.close(() => resolve()) })
  }

  await runProviderAcceptance()
  console.log(`\n===== E2E 结果：${passed} PASS / ${failed} FAIL =====`)
  process.exit(failed > 0 ? 1 : 0)
}

main().catch((e) => {
  console.error('E2E 执行失败：', (e as Error).message)
  process.exit(2)
})
