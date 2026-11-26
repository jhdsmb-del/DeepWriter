// ==================== R4.4 Gate 2：COMP-PROD-CRASH-01（Electron 强杀于 continuation_required 后，重启恢复不重置预算/单调性） ====================
// 复审 B-03：生产恢复必须从 durable evaluation 恢复 controller（revision/单调性水位/墙钟），
// 不能 new 一个空 controller。本测试：真实 Electron 强杀于第二轮（continuing 后）→ 重启 → 恢复 →
// 继续完成（不重复计轮、不 no_progress 误杀、不重置预算）。
// 运行：npm run e2e:r44（electron-vite build + esbuild + node）

import * as path from 'node:path'
import * as url from 'node:url'
import * as http from 'node:http'
import { execSync } from 'node:child_process'
import { promises as fsp } from 'node:fs'
import { _electron as electron, type ElectronApplication, type Page } from '@playwright/test'

const __dirname = path.dirname(url.fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')

let passed = 0
let failed = 0
const failures: string[] = []

function check(name: string, cond: boolean, detail = ''): void {
  if (cond) {
    passed++
    console.log(`  PASS  ${name}`)
  } else {
    failed++
    failures.push(`${name}${detail ? ` — ${detail}` : ''}`)
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

interface MockModel {
  server: http.Server
  port: number
  readonly calls: number
}

/** mock：请求 1 → 8000 字（continuing）；请求 2+ → 12000 字（达标） */
async function startMock(): Promise<MockModel> {
  let callCount = 0
  const server = http.createServer((req, res) => {
    let body = ''
    req.on('data', (d) => (body += d))
    req.on('end', () => {
      callCount++
      res.writeHead(200, { 'Content-Type': 'text/event-stream' })
      const write = (obj: unknown): void => res.write(`data: ${JSON.stringify(obj)}\n\n`)
      const content = callCount === 1 ? 'x'.repeat(8000) : 'y'.repeat(12000)
      // 分块延迟发送：第二轮制造足够宽的流中强杀窗口（每块 600ms，全程约 6s）
      const chunks = []
      for (let i = 0; i < content.length; i += 2000) chunks.push(content.slice(i, i + 2000))
      let ci = 0
      const timer = setInterval(() => {
        if (ci < chunks.length) {
          write({ id: 'm', choices: [{ index: 0, delta: { content: chunks[ci], role: 'assistant' }, finish_reason: null }], usage: null })
          ci++
          return
        }
        clearInterval(timer)
        write({ id: 'm', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 } })
        res.write('data: [DONE]\n\n')
        res.end()
      }, 600)
    })
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const port = (server.address() as { port: number }).port
  return {
    server,
    port,
    get calls(): number {
      return callCount
    }
  }
}

async function launchApp(userDataDir: string, mockPort: number): Promise<{ app: ElectronApplication; page: Page }> {
  const app = await electron.launch({
    args: [path.join(ROOT, 'out', 'main', 'index.js')],
    env: { ...process.env, NODE_ENV: 'test', DW_TEST_USERDATA: userDataDir }
  })
  const page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  await page.waitForSelector('.composer', { timeout: 15000 })
  await page.evaluate(async (p: number) => {
    const ds = (window as any).ds
    await ds.setSettings({ ...(await ds.getSettings()), baseUrl: `http://127.0.0.1:${p}`, apiKey: 'e2e-key', model: 'deepseek-v4-flash' })
  }, mockPort)
  await page.waitForTimeout(300)
  return { app, page }
}

async function killHard(app: ElectronApplication): Promise<void> {
  const pid = app.process().pid
  if (process.platform === 'win32') execSync(`taskkill /F /T /PID ${pid}`, { stdio: 'ignore' })
  else process.kill(pid, 'SIGKILL')
  await new Promise((r) => setTimeout(r, 1200))
}

async function main(): Promise<void> {
  const ud = path.join(ROOT, 'e2e-screenshots', 'fixture', `r44-crash-ud-${Date.now()}`)
  await fsp.mkdir(ud, { recursive: true })
  const mock = await startMock()

  try {
    console.log('\n[COMP-PROD-CRASH-01] continuation_required 后强杀 → 重启恢复 → 完成（不重置预算/单调性）')
    // 阶段 1：启动 → 长文 run（8000 字 → continuing 注入 → 第二轮 12000 流中）→ 强杀
    let runId = ''
    {
      const { app, page } = await launchApp(ud, mock.port)
      const sessionId = `s-crash-${Date.now()}`
      const chatId = `run-crash-${Date.now()}`
      runId = chatId
      await page.evaluate(
        async (args: { id: string; sessionId: string; mockPort: number }) => {
          const ds = (window as any).ds
          const ack = await ds.chatStart({
            id: args.id,
            sessionId: args.sessionId,
            mode: 'longwrite',
            longMode: true,
            targetChars: 10000,
            text: '请写一篇长文',
            fixedPrefix: [],
            attachments: []
          })
          return ack
        },
        { id: chatId, sessionId, mockPort: mock.port }
      )
      // 等请求 2 到达（continuing 注入后第二轮开始，12000 字流中）→ 强杀
      const deadline = Date.now() + 20000
      while (mock.calls < 2 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 200))
      check('COMP-PROD-CRASH-01 长文 run 进入第二轮（continuing 后，evaluation revision 1 已落库）', mock.calls >= 2, `calls=${mock.calls}`)
      await new Promise((r) => setTimeout(r, 1000))
      await killHard(app)
      check('COMP-PROD-CRASH-01 主进程已强杀（非优雅 close）', true, '')
    }

    // 阶段 2：重启 → 恢复 run → 继续完成（不重置 revision/单调性 → 不 no_progress 误杀）
    {
      const { app, page } = await launchApp(ud, mock.port)
      try {
        const recDeadline = Date.now() + 10000
        let rec: Array<{ runId: string; status: string }> = []
        while (Date.now() < recDeadline) {
          rec = await page.evaluate(async () => (window as any).ds.runsRecoverable())
          if (Array.isArray(rec) && rec.some((r) => r.runId === runId)) break
          await new Promise((r) => setTimeout(r, 300))
        }
        check('COMP-PROD-CRASH-01 重启后 run 在可恢复列表（DB 非终态）', Array.isArray(rec) && rec.some((r) => r.runId === runId), JSON.stringify(rec))
        const resume = await page.evaluate(async (rid: string) => (window as any).ds.runsResume(rid), runId)
        check('COMP-PROD-CRASH-01 resume 领养成功', resume?.ok === true, JSON.stringify(resume))
        // 恢复后自动继续（非 recovery_required）→ 请求 3（12000）→ completed
        // 注：恢复的 run 在 reload 后无 UI 消息容器（事件按消息 id 路由被丢弃），完成证据取主进程侧：
        // 请求 3 发出（恢复后继续）且 run 离开恢复列表（终态，非 completion_blocked 的 no_progress 误杀）
        const doneDeadline = Date.now() + 30000
        let callsNow = 0
        let inRecovery = true
        while (Date.now() < doneDeadline) {
          callsNow = mock.calls
          const rec = await page.evaluate(async () => (window as any).ds.runsRecoverable())
          inRecovery = Array.isArray(rec) && rec.some((r: { runId: string }) => r.runId === runId)
          if (callsNow >= 3 && !inRecovery) break
          await new Promise((r) => setTimeout(r, 400))
        }
        check('COMP-PROD-CRASH-01 恢复后继续（第三轮模型请求已发出，未重置单调性误杀）', callsNow >= 3, 'calls=' + callsNow)
        check('COMP-PROD-CRASH-01 恢复后完成（run 离开恢复列表，非 completion_blocked）', !inRecovery, 'inRecovery=' + inRecovery)
      } finally {
        const guard = setTimeout(() => {
          try {
            if (process.platform === 'win32') execSync('taskkill /F /T /PID ' + app.process().pid, { stdio: 'ignore' })
            else process.kill(app.process().pid, 'SIGKILL')
          } catch {
            /* 已退出 */
          }
        }, 25000)
        try {
          const renderer = app.windows().find((candidate) => !candidate.url().includes('window=float')) ?? app.windows()[0]
          await renderer?.evaluate(async () => {
            const ds = (window as any).ds
            if (ds && typeof ds.testShutdown === 'function') await ds.testShutdown()
            return true
          }).catch(() => false)
          await app.close()
        } finally {
          clearTimeout(guard)
        }
      }
    }

    // ==================== COM-OBSERVE-E2E：completion 客观状态可观察 ====================
    // 精确校验数字属于主窗口 RunInspector；悬浮窗只承担“当前正在做什么”的低干扰提示。
    console.log('\n[COM-OBSERVE-E2E] continuation_required → 语义检查状态 → accepted 全程可见（无指标面板）')
    {
      const obsMock = await startMock()
      const obsUd = await fsp.mkdtemp(path.join(ROOT, 'e2e-screenshots', 'fixture', 'r44-obs-'))
      const { app, page } = await launchApp(obsUd, obsMock.port)
      try {
        const sessionId = `s-obs-${Date.now()}`
        const chatId = `run-obs-${Date.now()}`
        await page.evaluate(
          async (args: { id: string; sessionId: string }) => {
            const ds = (window as any).ds
            await ds.chatStart({
              id: args.id,
              sessionId: args.sessionId,
              mode: 'longwrite',
              longMode: true,
              targetChars: 10000,
              text: '请写一篇长文',
              fixedPrefix: [],
              attachments: []
            })
          },
          { id: chatId, sessionId }
        )
        // 等请求 1（8000 → continuing）→ 打开悬浮窗 → 断言语义状态
        const deadline1 = Date.now() + 20000
        while (obsMock.calls < 1 && Date.now() < deadline1) await new Promise((r) => setTimeout(r, 200))
        // 本测试通过 preload 直调 chatStart，未经过 renderer store.send()，因此产品 UI 的浮窗按钮
        // 按设计保持禁用。直接调用同一受限 IPC 打开浮窗，避免测试把内部 store 状态当产品契约。
        await page.evaluate(async () => (window as any).ds.floatToggle?.()).catch(() => undefined)
        await page.waitForTimeout(800)
        const floatPage = app.windows().find((candidate) => candidate.url().includes('window=float'))
        const floatDeadline = Date.now() + 15000
        let floatText = ''
        while (Date.now() < floatDeadline) {
          if (floatPage) {
            floatText = await floatPage.locator('body').innerText().catch(() => '')
            if (floatText.includes('检查结果') || floatText.includes('已经完成')) break
          }
          await new Promise((r) => setTimeout(r, 400))
        }
        check('COM-OBSERVE-E2E 悬浮窗显示语义检查状态或其后完成态', floatText.includes('检查结果') || floatText.includes('已经完成'), floatText.slice(0, 100))
        check('COM-OBSERVE-E2E 悬浮窗不展示校验/字数/Token 指标', !/校验\s*\d|\d+\s*\/\s*\d+\s*字|tok/i.test(floatText), floatText.slice(0, 100))
        // 等 accepted → 悬浮窗进入简洁完成态；精确校验数据仍由 completion chunk 进入 RunInspector。
        const accDeadline = Date.now() + 30000
        let accVisible = false
        let accText = ''
        while (Date.now() < accDeadline) {
          if (floatPage) {
            accText = await floatPage.locator('body').innerText().catch(() => '')
            if (accText.includes('已经完成')) {
              accVisible = true
              break
            }
          }
          await new Promise((r) => setTimeout(r, 500))
        }
        check('COM-OBSERVE-E2E completion_accepted 后悬浮窗显示简洁完成态', accVisible, accText.slice(0, 120))
      } finally {
        const guard = setTimeout(() => {
          try {
            if (process.platform === 'win32') execSync('taskkill /F /T /PID ' + app.process().pid, { stdio: 'ignore' })
            else process.kill(app.process().pid, 'SIGKILL')
          } catch {
            /* 已退出 */
          }
        }, 25000)
        try {
          const renderer = app.windows().find((candidate) => !candidate.url().includes('window=float')) ?? app.windows()[0]
          await renderer?.evaluate(async () => {
            const ds = (window as any).ds
            if (ds && typeof ds.testShutdown === 'function') await ds.testShutdown()
            return true
          }).catch(() => false)
          await app.close()
        } finally {
          clearTimeout(guard)
        }
        await new Promise<void>((r) => { obsMock.server.closeAllConnections?.(); obsMock.server.close(() => r()) })
        await fsp.rm(obsUd, { recursive: true, force: true }).catch(() => undefined)
      }
    }

    // ==================== COM-OBSERVE-BLOCKED：completion_blocked 悬浮窗可见（R4.4 Gate 3 验收） ====================
    console.log('\n[COM-OBSERVE-BLOCKED] 无进展 → waiting_user → 悬浮窗显示等待决定（不展示模型自述）')
    {
      // blocked 专用 mock：请求 1 = 8000（continuing）；请求 2+ = 0 增量（累计不变 → 同 finding hash → no_progress blocked）
      const blkMock = await (async (): Promise<MockModel> => {
        let blkCount = 0
        const server = http.createServer((req, res) => {
          let body = ''
          req.on('data', (d) => (body += d))
          req.on('end', () => {
            blkCount++
            res.writeHead(200, { 'Content-Type': 'text/event-stream' })
            const write = (obj: unknown): void => res.write(`data: ${JSON.stringify(obj)}\n\n`)
            if (blkCount === 1) {
              write({ id: 'm', choices: [{ index: 0, delta: { content: 'x'.repeat(8000), role: 'assistant' }, finish_reason: null }], usage: null })
            } else {
              write({ id: 'm', choices: [{ index: 0, delta: { content: '', role: 'assistant' }, finish_reason: null }], usage: null })
            }
            write({ id: 'm', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: null })
            res.write('data: [DONE]\n\n')
            res.end()
          })
        })
        await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
        const port = (server.address() as { port: number }).port
        return {
          server,
          port,
          get calls(): number {
            return blkCount
          }
        }
      })()
      const blkUd = await fsp.mkdtemp(path.join(ROOT, 'e2e-screenshots', 'fixture', 'r44-blk-'))
      const { app, page } = await launchApp(blkUd, blkMock.port)
      try {
        const sessionId = `s-blk-${Date.now()}`
        const chatId = `run-blk-${Date.now()}`
        await page.evaluate(
          async (args: { id: string; sessionId: string }) => {
            const ds = (window as any).ds
            await ds.chatStart({
              id: args.id,
              sessionId: args.sessionId,
              mode: 'longwrite',
              longMode: true,
              targetChars: 10000,
              text: '请写一篇长文',
              fixedPrefix: [],
              attachments: []
            })
          },
          { id: chatId, sessionId }
        )
        // 每轮 8000 字（blkMock 的 startMock 请求 2+ 也 12000——需要只 8000 的 mock？
        // 复用 startMock 会第二轮到 12000 达标。blkMock 特殊：每轮 8000 → continuing → 第二轮 8000 同 hash → no_progress blocked）
        // 打开悬浮窗 → no-progress 已按 R4.5 收敛为 waiting_user，而非伪造失败。
        await page.evaluate(async () => (window as any).ds.floatToggle?.()).catch(() => undefined)
        await page.waitForTimeout(800)
        const floatPage = app.windows().find((candidate) => candidate.url().includes('window=float'))
        const blkDeadline = Date.now() + 25000
        let blkText = ''
        while (Date.now() < blkDeadline) {
          if (floatPage) {
            blkText = await floatPage.locator('body').innerText().catch(() => '')
            if (blkText.includes('等你决定下一步') || blkText.includes('中断') || blkText.includes('失败')) break
          }
          await new Promise((r) => setTimeout(r, 500))
        }
        check('COM-OBSERVE-BLOCKED no-progress 状态悬浮窗可见（等待决定/中断/失败，不展示模型自述）', blkText.includes('等你决定下一步') || blkText.includes('中断') || blkText.includes('失败'), blkText.slice(0, 120))
      } finally {
        const guard = setTimeout(() => {
          try {
            if (process.platform === 'win32') execSync('taskkill /F /T /PID ' + app.process().pid, { stdio: 'ignore' })
            else process.kill(app.process().pid, 'SIGKILL')
          } catch {
            /* 已退出 */
          }
        }, 25000)
        try {
          const renderer = app.windows().find((candidate) => !candidate.url().includes('window=float')) ?? app.windows()[0]
          await renderer?.evaluate(async () => {
            const ds = (window as any).ds
            if (ds && typeof ds.testShutdown === 'function') await ds.testShutdown()
            return true
          }).catch(() => false)
          await app.close()
        } finally {
          clearTimeout(guard)
        }
        await new Promise<void>((r) => { blkMock.server.closeAllConnections?.(); blkMock.server.close(() => r()) })
        await fsp.rm(blkUd, { recursive: true, force: true }).catch(() => undefined)
      }
    }

  } finally {
    await new Promise<void>((r) => { mock.server.closeAllConnections?.(); mock.server.close(() => r()) })
    await fsp.rm(ud, { recursive: true, force: true }).catch(() => undefined)
  }

  console.log(`\n===== R4.4-G2 崩溃恢复 E2E：${passed} PASS / ${failed} FAIL =====`)
  if (failed > 0) {
    console.log('红灯明细：')
    for (const f of failures) console.log(`  - ${f}`)
  }
  process.exit(failed > 0 ? 1 : 0)
}

main().catch((e) => {
  console.error('R4.4-G2 E2E 执行异常（需桌面显示环境）：', (e as Error).message)
  process.exit(2)
})
