// Real Electron renderer/main/SQLite E2E with a local synthetic SSE provider. No external API.
import * as path from 'node:path'
import * as url from 'node:url'
import * as os from 'node:os'
import * as fs from 'node:fs'
import * as http from 'node:http'
import { DatabaseSync } from 'node:sqlite'
import { _electron as electron, type ElectronApplication, type Page } from '@playwright/test'

const ROOT = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '..')
const exeArg = process.argv.find((arg) => arg.startsWith('--exe='))?.slice('--exe='.length)
const executablePath = exeArg ? path.resolve(ROOT, exeArg) : null
let passed = 0
let failed = 0

function check(name: string, ok: boolean, detail = ''): void {
  if (ok) { passed++; console.log(`  PASS  ${name}${detail ? ` — ${detail}` : ''}`) }
  else { failed++; console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`) }
}

function exact(text: string, count: number): string {
  return Array.from(text.repeat(Math.ceil(count / Array.from(text).length))).slice(0, count).join('')
}

function validSegment(round: number): string {
  const prefix = `灯塔旁的守夜人沿着海雾巡查，旧铜门在风里发出低响。第${round}夜，`
  const body = Array.from({ length: 1000 }, (_, i) => String.fromCodePoint(0x4e00 + ((round * 2400 + i) % 18_000))).join('')
  const segment = Array.from(prefix + body).slice(0, 1000)
  segment[segment.length - 1] = '。'
  return segment.join('')
}

const BAD_1000 = exact('人生的意义在于不断追求成功。这告诉我们，每个人都应该超越眼前的小事，为社会创造更大的价值。', 1000)
type Request = { messages: Array<{ role: string; content: string }> }

async function startMock(): Promise<{ server: http.Server; port: number; requests: Request[] }> {
  const requests: Request[] = []
  let constrainedRound = 0
  const server = http.createServer((req, res) => {
    if (req.method !== 'POST' || !req.url?.includes('/chat/completions')) { res.writeHead(404).end(); return }
    let raw = ''
    req.on('data', (chunk) => { raw += String(chunk) })
    req.on('end', () => {
      const request = JSON.parse(raw) as Request
      requests.push(request)
      const constraint = request.messages.some((message) => message.role === 'system' && message.content.includes('本次写作边界'))
      const userText = [...request.messages].reverse().find((message) => message.role === 'user')?.content ?? ''
      let content: string
      if (constraint) {
        constrainedRound += 1
        content = constrainedRound === 1 ? BAD_1000 : validSegment(constrainedRound - 1)
      } else if (userText.includes('普通 Agent')) {
        content = '普通 Agent 正常回答，没有套用长文写作门禁。'
      } else {
        content = exact(BAD_1000, 4000)
      }
      const chars = Array.from(content)
      const chunks = Array.from({ length: Math.ceil(chars.length / 200) }, (_, index) => chars.slice(index * 200, (index + 1) * 200).join(''))
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' })
      let index = 0
      const timer = setInterval(() => {
        if (res.destroyed) { clearInterval(timer); return }
        if (index < chunks.length) {
          res.write(`data: ${JSON.stringify({ id: `r39-${requests.length}`, choices: [{ index: 0, delta: { role: 'assistant', content: chunks[index++] }, finish_reason: null }], usage: null })}\n\n`)
          return
        }
        clearInterval(timer)
        res.write(`data: ${JSON.stringify({ id: `r39-${requests.length}`, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 20, completion_tokens: chars.length, total_tokens: chars.length + 20, prompt_cache_hit_tokens: 0, prompt_cache_miss_tokens: 20 } })}\n\n`)
        res.end('data: [DONE]\n\n')
      }, 25)
      res.on('close', () => clearInterval(timer))
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  return { server, port: (server.address() as { port: number }).port, requests }
}

async function configure(page: Page, port: number): Promise<void> {
  await page.evaluate(async (mockPort) => {
    const ds = (window as any).ds
    const current = await ds.getSettings()
    await ds.setSettings({
      ...current, apiKey: 'r39-local-synthetic', baseUrl: `http://127.0.0.1:${mockPort}`, model: 'deepseek-v4-flash',
      thinkingEnabled: false, toolsEnabled: false, planMode: false, strongConstraintEnabled: true,
      strongConstraintLevel: 'balanced', strongConstraintPerspective: 'auto', strongConstraintGenre: '',
      strongConstraintMustKeep: '', strongConstraintAvoid: ''
    })
  }, port)
}

async function chooseMode(page: Page, name: '长文' | 'Agent'): Promise<void> {
  await page.locator('.mode-popover-wrap > .modebar-btn').click()
  await page.locator('.mode-item', { hasText: name }).click()
}

async function setLongwrite(page: Page): Promise<void> {
  await chooseMode(page, '长文')
  const panel = page.locator('[aria-label="深度写作控制"]')
  await panel.waitFor()
  await panel.locator('input[type="range"]').fill('4000')
}

async function sendAndStart(page: Page, text: string): Promise<void> {
  await page.locator('.composer textarea').fill(text)
  await page.locator('.composer .btn.primary').click()
  await page.locator('.composer .btn.stop').waitFor({ state: 'visible', timeout: 15000 })
}

async function waitTerminal(page: Page): Promise<void> {
  await page.locator('.composer .btn.stop').waitFor({ state: 'hidden', timeout: 60000 })
  await page.waitForTimeout(250)
}

async function waitRequests(requests: Request[], n: number, page: Page): Promise<void> {
  const deadline = Date.now() + 30_000
  while (requests.length < n && Date.now() < deadline) await page.waitForTimeout(50)
}

async function quit(app: ElectronApplication): Promise<number> {
  const child = app.process()
  const exited = new Promise<number>((resolve) => child.once('exit', (code) => resolve(code ?? 0)))
  await app.evaluate(({ app: electronApp }) => electronApp.quit()).catch(() => undefined)
  return Promise.race([exited, new Promise<number>((resolve) => setTimeout(() => resolve(255), 15_000))])
}

type DbRun = { run_id: string; status: string; config_json: string; client_request_id: string }
function inspectDb(userData: string): { runs: DbRun[]; turns: Record<string, string>; attempts: number; evidenceStatus: string } {
  const db = new DatabaseSync(path.join(userData, 'deepwriter.db'))
  try {
    const runs = db.prepare('SELECT run_id,status,config_json,client_request_id FROM runs ORDER BY started_at').all() as DbRun[]
    const turns: Record<string, string> = {}
    for (const run of runs) {
      turns[run.run_id] = (db.prepare("SELECT content FROM turns WHERE run_id=? AND role='assistant' ORDER BY turn_seq").all(run.run_id) as Array<{ content: string }>).map((row) => row.content).join('')
    }
    const first = runs[0]
    const attempts = first ? (db.prepare('SELECT COUNT(*) AS n FROM completion_attempts WHERE run_id=? AND attempt<0').get(first.run_id) as { n: number }).n : 0
    const evidence = first ? db.prepare("SELECT json FROM run_evidence WHERE run_id=? AND kind='strong_constraint_latest'").get(first.run_id) as { json: string } | undefined : undefined
    return { runs, turns, attempts, evidenceStatus: evidence ? (JSON.parse(evidence.json) as { status?: string }).status ?? '' : '' }
  } finally { db.close() }
}

async function main(): Promise<void> {
  const userData = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'dw-r39-ui-'))
  const mock = await startMock()
  let app: ElectronApplication | null = null
  let firstUi = ''
  let disabledUi = ''
  let agentUi = ''
  let runningDetail = ''
  let terminalDetail = ''
  try {
    app = await electron.launch(executablePath ? {
      executablePath,
      args: [`--user-data-dir=${userData}`],
      env: { ...process.env, NODE_ENV: 'test', DW_TEST_USERDATA: userData }
    } : {
      args: [path.join(ROOT, 'out', 'main', 'index.js')],
      env: { ...process.env, NODE_ENV: 'test', DW_TEST_USERDATA: userData }
    })
    const page = await app.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    await page.waitForSelector('.composer', { timeout: 15000 })
    await configure(page, mock.port)
    // configure 通过主进程保存后重载，使 renderer store 与持久设置同源；避免测试脚本
    // 直接改 IPC 后再由旧 store 整包覆盖，真实用户路径不会有该竞态。
    await page.reload()
    await page.waitForSelector('.composer', { timeout: 15000 })
    await setLongwrite(page)

    const card = page.locator('[data-testid="strong-constraint-card"]')
    check('R39-UI-E2E 新用户长文默认显示强约束开启', await card.locator('input[type="checkbox"]').isChecked())
    await card.locator('button', { hasText: '查看当前约束' }).click()
    check('R39-UI-E2E 当前约束可见并可编辑', await card.getByText(/必须原文保留/).isVisible() && await card.getByText('不要出现').isVisible())

    await sendAndStart(page, '写一个发生在海边灯塔的守夜人悬疑故事，4000字，保持克制，不要说教。')
    await page.locator('[data-testid="stream-progress"]').waitFor({ state: 'visible' })
    await waitRequests(mock.requests, 2, page)
    // 流式进度每个 chunk 都会重渲染；在真实可见按钮上原生触发，避免 Playwright
    // 等待“稳定”期间节点被下一 chunk 替换造成测试假红。
    await page.waitForSelector('[data-testid="stream-detail-button"]', { state: 'visible' })
    await page.evaluate(() => (document.querySelector('[data-testid="stream-detail-button"]') as HTMLButtonElement | null)?.click())
    const dialog = page.locator('.run-inspector[role="dialog"]')
    await dialog.waitFor({ state: 'visible' })
    await page.locator('[data-testid="strong-constraint-progress"]').waitFor({ state: 'visible', timeout: 10000 })
    runningDetail = await dialog.innerText()
    await page.locator('[aria-label="关闭任务详情"]').click()
    await waitTerminal(page)
    firstUi = await page.locator('.msg.assistant .msg-bubble').last().innerText()
    await page.locator('.msg.assistant .ghost-btn', { hasText: '查看任务详情' }).last().click()
    await dialog.waitFor({ state: 'visible' })
    terminalDetail = await dialog.innerText()
    await page.locator('[aria-label="关闭任务详情"]').click()

    // 双向：已有正文时 SidePanel 收起，走真实“设置 → 完成与预算”关闭。
    await page.locator('[aria-label="设置"]').click()
    const settingsDialog = page.locator('.dw-settings-modal[role="dialog"]')
    await settingsDialog.waitFor({ state: 'visible' })
    await settingsDialog.locator('.dw-settings-nav button', { hasText: '完成与预算' }).click()
    await settingsDialog.locator('.dw-writing-settings > summary').click()
    await settingsDialog.locator('[data-testid="strong-constraint-settings"] input[type="checkbox"]').uncheck({ force: true })
    await settingsDialog.locator('button', { hasText: '保存并关闭' }).click()
    await settingsDialog.waitFor({ state: 'hidden' })
    await sendAndStart(page, '关闭强约束后写四千字测试文本。')
    await waitTerminal(page)
    disabledUi = await page.locator('.msg.assistant .msg-bubble').last().innerText()

    await chooseMode(page, 'Agent')
    await sendAndStart(page, '普通 Agent 请简短回答。')
    await waitTerminal(page)
    agentUi = await page.locator('.msg.assistant .msg-bubble').last().innerText()
    const exit = await quit(app)
    check('R39-UI-E2E app.quit 自然退出', exit === 0, `exit=${exit}`)
  } finally {
    if (app) await app.close().catch(() => undefined)
    await new Promise<void>((resolve) => mock.server.close(() => resolve()))
  }

  const db = inspectDb(userData)
  const [strongRun, disabledRun, agentRun] = db.runs
  const strongText = strongRun ? db.turns[strongRun.run_id] ?? '' : ''
  const strongConfig = strongRun ? JSON.parse(strongRun.config_json) as any : {}
  const disabledConfig = disabledRun ? JSON.parse(disabledRun.config_json) as any : {}
  const agentConfig = agentRun ? JSON.parse(agentRun.config_json) as any : {}
  const strongRequests = mock.requests.filter((request) => request.messages.some((message) => message.content.includes('本次写作边界')))
  const fixedPrompts = strongRequests.map((request) => request.messages.find((message) => message.content.includes('本次写作边界'))?.content ?? '')
  check('R39-UI-E2E 首轮跑偏后自动修复并续写四轮', strongRequests.length === 5 && db.attempts >= 1, `requests=${strongRequests.length} repairs=${db.attempts}`)
  check('R39-UI-E2E UI/durable 严格 4000 且移除说教段', Array.from(firstUi).length === 4000 && Array.from(strongText).length === 4000 && firstUi === strongText && !strongText.includes('人生的意义'))
  check('R39-UI-E2E 无手工 mustKeep 仍自动提取主题并 completed', strongText.includes('灯塔') && strongText.includes('守夜人') && strongRun?.status === 'completed' && db.evidenceStatus === 'passed' && strongConfig.strongConstraints?.mustKeep?.length === 0 && strongConfig.strongConstraints?.themeAnchors?.includes('灯塔'))
  check('R39-UI-E2E 每轮实际请求冻结约束 bytes 完全一致', fixedPrompts.length === 5 && fixedPrompts.every((text) => text === fixedPrompts[0]) && strongConfig.strongConstraints?.hash)
  check('R39-UI-E2E 运行中/结束后详情都有类别和修复事实', /正在纠正偏移|说教式收尾/.test(runningDetail) && /偏移已纠正/.test(terminalDetail))
  check('R39-UI-E2E 关闭后下一 run 不带 validator 且按设置完成', disabledRun?.status === 'completed' && disabledConfig.strongConstraints?.enabled === false && !disabledConfig.completionContract?.validators?.some((v: any) => v.id === 'strongConstraints') && Array.from(disabledUi).length === 4000)
  check('R39-UI-E2E 普通 Agent 不带写作门禁', agentRun?.status === 'completed' && agentConfig.runMode === 'agent' && agentConfig.strongConstraints?.enabled === false && agentUi.includes('普通 Agent 正常回答'))
  console.log(`\nR39 real Electron UI: ${passed} PASS / ${failed} FAIL`)
  if (failed > 0) process.exit(1)
}

main().catch((error) => { console.error(error); process.exit(2) })
