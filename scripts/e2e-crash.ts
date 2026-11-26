// ==================== Playwright Electron E2E：进程强杀（SIGKILL）后恢复（R4.1 PERSIST-CRASH-01 / RECOVERY-KILL） ====================
// 覆盖：
// - E2E-CRASH-01：运行中（mock 已收到请求的 durable checkpoint）直接强杀主进程（非优雅 close），
//   复用同一 userData 重启 → 该 run 出现在 runs:recoverable（DB 状态非终态）、session 在 sessionsList、
//   user 消息可经 sessionsLoad 加载
// - E2E-CRASH-02（可选诊断）：runsAbandon 放弃路径——API 契约 + 放弃后 recoverable 列表的实测行为
// 强杀方式：POSIX process.kill(pid, 'SIGKILL')；Windows taskkill /F /T /PID（进程树强制终止，等价 SIGKILL）
// 运行：npx electron-vite build && npx esbuild scripts/e2e-crash.ts --bundle --format=esm --platform=node --outfile=out/e2e-crash.mjs --external:@playwright/test && node out/e2e-crash.mjs
// 注意：需要桌面显示环境；CI 在 Windows Runner 或 xvfb 下运行。禁止修改 src/ 生产代码——行为差异只记录不修复。

import * as path from 'node:path'
import * as url from 'node:url'
import * as os from 'node:os'
import * as fs from 'node:fs'
import * as http from 'node:http'
import { execSync } from 'node:child_process'
import { promises as fsp } from 'node:fs'
import { _electron as electron, type ElectronApplication, type Page } from '@playwright/test'

const __dirname = path.dirname(url.fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')

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
function info(name: string, detail = ''): void {
  console.log(`  INFO  ${name}${detail ? ` — ${detail}` : ''}`)
}

/** 本地确定性 mock model（同 e2e-electron.ts）：记录请求体与调用次数 */
interface MockModel {
  server: http.Server
  port: number
  calls: Array<{ body: { messages: Array<{ role: string; content: string }> } }>
}
async function startMockModel(): Promise<MockModel> {
  const calls: MockModel['calls'] = []
  const server = http.createServer((req, res) => {
    let body = ''
    req.on('data', (d) => (body += d))
    req.on('end', () => {
      if (req.url?.includes('/chat/completions') && req.method === 'POST') {
        try {
          calls.push({ body: JSON.parse(body) })
        } catch {
          /* 忽略非法请求体 */
        }
        res.writeHead(200, { 'Content-Type': 'text/event-stream' })
        // 慢速流式输出（500ms/块，全程约 2.5s）：制造足够宽的"运行中"窗口，确保在 mid-stream 强杀时 run 仍非终态
        const chunks = ['完成', '工具', '调用', '总结', '。']
        let i = 0
        const timer = setInterval(() => {
          if (i >= chunks.length) {
            clearInterval(timer)
            res.write(`data: ${JSON.stringify({ id: 'm', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } })}\n\n`)
            res.write('data: [DONE]\n\n')
            res.end()
            return
          }
          res.write(`data: ${JSON.stringify({ id: 'm', choices: [{ index: 0, delta: { content: chunks[i], role: 'assistant' }, finish_reason: null }], usage: null })}\n\n`)
          i++
        }, 500)
      } else {
        res.writeHead(404).end()
      }
    })
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const port = (server.address() as { port: number }).port
  return { server, port, calls }
}

async function launchApp(width: number, height: number, extraEnv: Record<string, string> = {}, userDataDir?: string): Promise<{ app: ElectronApplication; page: Page }> {
  const ud = userDataDir ?? (await fsp.mkdtemp(path.join(os.tmpdir(), 'dw-crash-ud-')))
  const app = await electron.launch({
    args: [path.join(ROOT, 'out', 'main', 'index.js')],
    env: { ...process.env, NODE_ENV: 'test', DW_TEST_USERDATA: ud, ...extraEnv }
  })
  const page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  await page.waitForSelector('.composer', { timeout: 15000 })
  await app.evaluate(({ BrowserWindow }, size: { w: number; h: number }) => {
    const win = BrowserWindow.getAllWindows()[0]
    if (win) win.setSize(size.w, size.h)
  }, { w: width, h: height })
  await page.waitForTimeout(400)
  return { app, page }
}

async function closeApp(app: ElectronApplication): Promise<void> {
  const guard = setTimeout(() => {
    try {
      if (process.platform === 'win32') execSync(`taskkill /F /T /PID ${app.process().pid}`, { stdio: 'ignore' })
      else process.kill(app.process().pid, 'SIGKILL')
    } catch {
      /* 进程已退出 */
    }
  }, 25000)
  try {
    await app.close()
  } finally {
    clearTimeout(guard)
  }
}

async function setSettingsToMock(page: Page, port: number): Promise<void> {
  await page.evaluate(async (p: number) => {
    const ds = (window as any).ds
    await ds.setSettings({ ...(await ds.getSettings()), baseUrl: `http://127.0.0.1:${p}`, apiKey: 'e2e-key', model: 'deepseek-v4-flash' })
  }, port)
  await page.waitForTimeout(300)
}

interface RunMeta { runId: string; sessionId: string; status: string; phase: string }

async function listRecoverable(page: Page): Promise<RunMeta[]> {
  return page.evaluate(async () => (window as any).ds.runsRecoverable()) as Promise<RunMeta[]>
}

/**
 * 强杀 Electron 主进程（SIGKILL 语义），不做优雅 close。
 * - POSIX：process.kill(pid, 'SIGKILL')
 * - win32：taskkill /F /T /PID（强制终止进程树，Windows 上 SIGKILL 等价物）
 * 返回 { pid, method, dead }；等待进程真正退出（exit 事件或 ESRCH 轮询，10s 超时）。
 */
async function killHard(app: ElectronApplication): Promise<{ pid: number; method: string; dead: boolean }> {
  const proc = app.process()
  const pid = proc.pid
  let method: string
  if (process.platform === 'win32') {
    execSync(`taskkill /F /T /PID ${pid}`, { stdio: 'ignore' })
    method = `taskkill /F /T /PID ${pid}`
  } else {
    process.kill(pid, 'SIGKILL')
    method = `process.kill(${pid}, 'SIGKILL')`
  }
  const exited = new Promise<boolean>((resolve) => proc.once('exit', () => resolve(true)))
  const deadline = Date.now() + 10000
  let dead = false
  while (Date.now() < deadline) {
    if (await Promise.race([exited, new Promise<boolean>((r) => setTimeout(() => r(false), 300))])) {
      dead = true
      break
    }
    try {
      process.kill(pid, 0) // 探测存活；抛 ESRCH = 已死
    } catch {
      dead = true
      break
    }
  }
  return { pid, method, dead }
}

interface CrashRunInfo { runId: string; sessionId: string; status: string }

async function main(): Promise<void> {
  // 复用 e2e-screenshots/ 下 fixture 目录做 userData（已被 .gitignore 忽略），测试后清理
  const crashUd = path.join(ROOT, 'e2e-screenshots', 'fixture', `crash-ud-${Date.now()}`)
  await fsp.mkdir(crashUd, { recursive: true })
  const mock = await startMockModel()

  try {
    // ---------- 阶段 1：启动 → mock 设置 → 发送消息 → 等 durable checkpoint（mock 收到请求） ----------
    console.log('\n[E2E-CRASH-01] 运行中强杀主进程 → 复用同一 userData 重启 → run 可恢复')
    const { app: app1, page: page1 } = await launchApp(1280, 900, {}, crashUd)
    let preRun: CrashRunInfo | null = null
    let crashInfo: { pid: number; method: string } | null = null
    try {
      await setSettingsToMock(page1, mock.port)
      const preKillEmpty = await listRecoverable(page1)
      check('强杀前（全新 userData）recoverable 列表为空', preKillEmpty.length === 0, JSON.stringify(preKillEmpty))

      await page1.locator('textarea').fill('这是一条在进程强杀前发送、必须可恢复的消息 CRASH-01')
      await page1.locator('.btn.primary', { hasText: '发送' }).click()

      // durable checkpoint：mock 收到模型请求 ⇒ run 已建行（status running）、user 消息已写 session_messages
      const deadline = Date.now() + 15000
      while (mock.calls.length < 1 && Date.now() < deadline) {
        await page1.waitForTimeout(200)
      }
      check('mock model 收到请求（durable checkpoint 达成）', mock.calls.length >= 1, `calls=${mock.calls.length}`)
      if (mock.calls.length < 1) throw new Error('mock 未收到请求，无法进入强杀阶段')

      const preRuns = await listRecoverable(page1)
      check('强杀前 run 已在 recoverable 列表（status running）', preRuns.length === 1 && preRuns[0]?.status === 'running', JSON.stringify(preRuns))
      preRun = preRuns[0] ? { runId: preRuns[0].runId, sessionId: preRuns[0].sessionId, status: preRuns[0].status } : null

      // mid-stream 强杀：流式全程约 2.5s，此处约 0.6s（首块已输出、run 仍 running），随后强杀
      await page1.waitForTimeout(600)
      crashInfo = await killHard(app1)
      check('主进程已强杀且确认死亡（非优雅 close）', !!crashInfo.dead, `${crashInfo.method} dead=${crashInfo.dead}`)
      // 强杀后短暂等待 OS 回收（文件锁/WAL 让渡），再启动新实例
      await new Promise<void>((r) => setTimeout(r, 1200))
    } catch (e) {
      check(`强杀执行失败：${(e as Error).message}`, false, '')
      // 强杀失败时仍尝试关闭 app1，避免残留进程
      await closeApp(app1).catch(() => undefined)
      throw e
    } finally {
      // 注意：此处不调用 app1.close()——强杀后进程已死，避免任何优雅关闭语义
    }

    info('强杀细节', `${crashInfo?.method ?? 'n/a'}`)

    // ---------- 阶段 2：复用同一 userData 重启 → 断言恢复 ----------
    const { app: app2, page: page2 } = await launchApp(1280, 900, {}, crashUd)
    try {
      await setSettingsToMock(page2, mock.port)

      // 短暂轮询（≤3s）以吸收 app2 启动/DB 打开时序差异；恢复语义本身是 DB 直读
      let rec: RunMeta[] = []
      const pollDeadline = Date.now() + 3000
      while (Date.now() < pollDeadline) {
        rec = await listRecoverable(page2)
        if (rec.length > 0) break
        await page2.waitForTimeout(250)
      }
      check('重启后 runsRecoverable() 非空（PERSIST-CRASH-01）', Array.isArray(rec) && rec.length >= 1, JSON.stringify(rec))
      const recMatch = rec.find((r) => r.runId === preRun?.runId)
      check('重启后原 runId 在 recoverable 列表（未被丢弃/未误标终态）', !!recMatch, `rec=${JSON.stringify(rec)} pre=${JSON.stringify(preRun)}`)
      if (recMatch) {
        const nonTerminal = ['running', 'queued', 'recoverable', 'cancelling']
        check('恢复 run 状态为非终态（running/recoverable/queued/cancelling）', nonTerminal.includes(recMatch.status), `status=${recMatch.status} phase=${recMatch.phase}`)
      }

      const sessions = await page2.evaluate(async () => (window as any).ds.sessionsList()) as Array<{ id: string }>
      const sid = preRun?.sessionId
      check('重启后 session 在 sessionsList() 中存在', !!sid && Array.isArray(sessions) && sessions.some((s) => s.id === sid), `sid=${sid} sessions=${JSON.stringify(sessions)}`)

      const msgs = sid ? (await page2.evaluate(async (id: string) => (window as any).ds.sessionsLoad(id), sid)) as Array<{ role: string; content: string }> : []
      const userText = msgs.find((m) => m.role === 'user')?.content ?? ''
      check('user 消息经 sessionsLoad() 逐字可加载', userText.includes('这是一条在进程强杀前发送、必须可恢复的消息 CRASH-01'), userText.slice(0, 200))

      const runDetail = preRun ? await page2.evaluate(async (id: string) => (window as any).ds.runsList(id), preRun.sessionId) : null
      check('runsList(sessionId) 仍列出该非终态 run（DB 未被错误 finalize）', Array.isArray(runDetail) && runDetail.some((r) => (r as { runId: string }).runId === preRun?.runId), JSON.stringify(runDetail))

      // ---------- R4.2 A1 补充：kill 窗口事务原子性（PERSIST-ATOMIC-KILL-01） ----------
      // 强杀发生在 acceptChatStart 单事务提交后的 mid-stream——run 行、user turn、user 消息必须
      // 同时存在（要么全部提交、要么全部回滚）。preload 不暴露 runsGet（turns），以可观测 API
      // 交叉一致证明原子性：run 存在 ⇔ user 消息存在（同生共死，无孤儿 run/孤儿消息）。
      check('PERSIST-ATOMIC-KILL-01 run 与 user 消息原子一致（单事务：同生共死，无孤儿）', userText.length > 0 === !!recMatch, `userMsg=${userText.length > 0} run=${!!recMatch}`)

      // ---------- E2E-CRASH-02（可选诊断）：放弃路径 ----------
      console.log('\n[E2E-CRASH-02] runsAbandon 放弃路径（诊断，不判 FAIL）')
      if (preRun) {
        const abandon = await page2.evaluate(async (id: string) => (window as any).ds.runsAbandon(id), preRun.runId) as { ok: boolean }
        check('runsAbandon() 返回 ok（API 契约）', abandon?.ok === true, JSON.stringify(abandon))
        const after = await listRecoverable(page2)
        info('放弃后 recoverable 列表实测', `${JSON.stringify(after)}（若 run 仍在列：abandon 依赖 kernel 内存态，重启后为空 → DB 无变化，属观察到的行为）`)
      }
    } finally {
      await closeApp(app2)
    }
  } finally {
    await new Promise<void>((r) => mock.server.close(() => r()))
    await fsp.rm(crashUd, { recursive: true, force: true }).catch(() => undefined)
  }

  console.log(`\n===== E2E-CRASH 结果：${passed} PASS / ${failed} FAIL =====`)
  process.exit(failed > 0 ? 1 : 0)
}

main().catch((e) => {
  console.error('E2E-CRASH 执行异常（可能是无显示环境或强杀失败）：', (e as Error).message)
  console.error('E2E 需桌面显示环境；CI 请在 Windows Runner 或 xvfb 下运行。')
  process.exit(2)
})
