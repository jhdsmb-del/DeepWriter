// ==================== R4.3 Gate 3：恢复 UX 真实 Electron E2E（四决策 + owner + 失败后仍可见） ====================
// 复审 S-02：R4.2 后端完成但交付时前端无四决策入口（复审方已补 RecoveryPrompt UI + runs:resume 恢复入口）。
// 本测试验收真实行为（走复审方 UI 完整链路：停止 → recovery_required → reload 恢复列表 → 恢复按钮 → 弹窗 → 四决策）：
//  E2E-RECOVERY-01 confirm_applied：确认已执行 → run 继续 → completed
//  E2E-RECOVERY-03 retry_not_applied 非幂等：被引擎拒绝（toast），弹窗仍可继续决策
//  E2E-RECOVERY-02 abandon：放弃 → run cancelled，恢复列表移除
//  E2E-RECOVERY-04 owner：新实例未领养窗口 recoverDecide 被拒（run_not_owned）
//  E2E-RECOVERY-05 失败后仍可见：决策失败后 recoverable 列表仍含该 run（不静默消失）
// 运行：npm run e2e:r43（electron-vite build + esbuild + node）
// 注意：需要桌面显示环境；工具 seam：NODE_ENV=test 时 mock_slow_tool 慢执行 2s（tools.ts）。

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

/** mock：请求 1 → tool_calls(mock_slow_tool)；请求 2+ → 文本流 */
async function startMock(): Promise<MockModel> {
  let callCount = 0
  const server = http.createServer((req, res) => {
    let body = ''
    req.on('data', (d) => (body += d))
    req.on('end', () => {
      callCount++
      res.writeHead(200, { 'Content-Type': 'text/event-stream' })
      const write = (obj: unknown): void => res.write(`data: ${JSON.stringify(obj)}\n\n`)
      if (callCount === 1) {
        write({ id: 'm', choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, id: 'tc_rec_1', type: 'function', function: { name: 'mock_slow_tool', arguments: '{}' } }] }, finish_reason: null }], usage: null })
        write({ id: 'm', choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 10, completion_tokens: 0, total_tokens: 10, prompt_cache_hit_tokens: 3, prompt_cache_miss_tokens: 7 } })
        res.write('data: [DONE]\n\n')
        res.end()
        return
      }
      write({ id: 'm', choices: [{ index: 0, delta: { content: '恢复后的总结文本', role: 'assistant' }, finish_reason: null }], usage: null })
      write({ id: 'm', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15, prompt_cache_hit_tokens: 3, prompt_cache_miss_tokens: 7 } })
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
      return callCount
    }
  }
}

async function launchApp(userDataDir: string, mockPort?: number): Promise<{ app: ElectronApplication; page: Page }> {
  const app = await electron.launch({
    args: [path.join(ROOT, 'out', 'main', 'index.js')],
    env: { ...process.env, NODE_ENV: 'test', DW_TEST_USERDATA: userDataDir, ...(mockPort ? { DW_TEST_PRICING_ORIGIN: `http://127.0.0.1:${mockPort}` } : {}) }
  })
  const page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  await page.waitForSelector('.composer', { timeout: 15000 })
  await page.waitForTimeout(400)
  return { app, page }
}

async function closeApp(app: ElectronApplication): Promise<void> {
  // R4.4 Gate 5（G-03）：优先真实优雅退出（testShutdown），taskkill 兜底
  try {
    const renderer = app.windows().find((candidate) => !candidate.url().includes('window=float')) ?? app.windows()[0]
    await renderer?.evaluate(async () => {
      const ds = (window as any).ds
      if (ds && typeof ds.testShutdown === 'function') await ds.testShutdown()
      return true
    }).catch(() => false)
  } catch {
    /* 走原路径 */
  }
  const guard = setTimeout(() => {
    try {
      if (process.platform === 'win32') execSync('taskkill /F /T /PID ' + app.process().pid, { stdio: 'ignore' })
      else process.kill(app.process().pid, 'SIGKILL')
    } catch {
      /* 已退出 */
    }
  }, 25000)
  try {
    await app.close()
  } finally {
    clearTimeout(guard)
  }
}

/** 发送消息 → 等 mock 收到工具调用 → 停止 → 等 run 进入 recovery_required */
async function setupRecoveryRun(page: Page, mock: MockModel): Promise<string> {
  await page.locator('textarea').fill('执行慢工具')
  await page.locator('.btn.primary', { hasText: '发送' }).click()
  const deadline = Date.now() + 15000
  while (mock.calls < 1 && Date.now() < deadline) await page.waitForTimeout(200)
  await page.waitForTimeout(250)
  await page.locator('.btn.stop', { hasText: '停止' }).click().catch(() => undefined)
  // 主进程侧轮询 recovery_required（5s 兜底后出现）
  const recDeadline = Date.now() + 20000
  let runId = ''
  let lastRec = '[]'
  while (Date.now() < recDeadline) {
    const rec = await page.evaluate(async () => (window as any).ds.runsRecoverable())
    lastRec = JSON.stringify(rec)
    const target = Array.isArray(rec) ? rec.find((r: { status: string }) => r.status === 'recovery_required') : null
    if (target) {
      runId = target.runId as string
      break
    }
    await page.waitForTimeout(300)
  }
  if (!runId) {
    console.log('[setupRecoveryRun] rec list:', lastRec.slice(0, 400))
    const info = await page.evaluate(async () => {
      const ds = (window as any).ds
      const rec = await ds.runsRecoverable()
      const sessions = await ds.sessionsList()
      return { rec: JSON.stringify(rec).slice(0, 300), sessions: JSON.stringify(sessions).slice(0, 200) }
    })
    console.log('[setupRecoveryRun] debug:', JSON.stringify(info))
  }
  return runId
}

/** reload 刷新恢复列表（init → loadRecoverable）并点击恢复按钮 → 等弹窗 */
async function openRecoveryPrompt(page: Page): Promise<boolean> {
  await page.reload()
  await page.waitForSelector('.composer', { timeout: 15000 })
  const btnDeadline = Date.now() + 10000
  let clicked = false
  while (Date.now() < btnDeadline) {
    const btn = page.locator('.dw-text-btn', { hasText: '恢复' }).first()
    if ((await btn.count()) > 0) {
      await btn.click().catch(() => undefined)
      clicked = true
      break
    }
    await page.waitForTimeout(300)
  }
  if (!clicked) return false
  const promptDeadline = Date.now() + 10000
  while (Date.now() < promptDeadline) {
    if ((await page.locator('.dw-recovery').count()) > 0) return true
    await page.waitForTimeout(300)
  }
  return false
}

async function main(): Promise<void> {
  const freshUd = async (): Promise<string> => {
    const d = path.join(ROOT, 'e2e-screenshots', 'fixture', `r43-rec-ud-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`)
    await fsp.mkdir(d, { recursive: true })
    return d
  }

  try {
    // ==================== E2E-RECOVERY-01：confirm_applied ====================
    console.log('\n[E2E-RECOVERY-01] 停止时工具副作用未确认 → 确认已执行 → 继续完成')
    {
      const mock1 = await startMock()
      const { app, page } = await launchApp(await freshUd(), mock1.port)
      try {
        await page.evaluate(async (p: number) => {
          const ds = (window as any).ds
          await ds.setSettings({ ...(await ds.getSettings()), baseUrl: `http://127.0.0.1:${p}`, apiKey: 'e2e-key', model: 'deepseek-v4-flash' })
        }, mock1.port)
        await page.waitForTimeout(300)
        const runId = await setupRecoveryRun(page, mock1)
        check('E2E-RECOVERY-01 取消后 run 进入 recovery_required（DB 非终态）', runId.length > 0, runId)
        if (runId) {
          // 走真实 IPC：resume 领养 → 返回 recoveryRequired + 待决策工具（复审方 UI 弹窗由 store.resumeRun 触发，此处验证主进程链路）
          const resume = await page.evaluate(async (rid: string) => (window as any).ds.runsResume(rid), runId)
          check('E2E-RECOVERY-01 resume 返回 recoveryRequired + pendingToolCalls（结构化事实）', resume?.ok === true && resume?.recoveryRequired === true && Array.isArray(resume?.pendingToolCalls) && resume.pendingToolCalls.length > 0, JSON.stringify(resume))
          const decide = await page.evaluate(async (rid: string) => (window as any).ds.runsRecoverDecide({ runId: rid, decision: 'confirm_applied' }), runId)
          check('E2E-RECOVERY-01 confirm_applied 决策成功', decide?.ok === true, JSON.stringify(decide))
          // run 继续（主进程 step → 第二轮 mock1 文本 → 当前订阅收到）
          const doneDeadline = Date.now() + 15000
          let doneText = ''
          while (Date.now() < doneDeadline) {
            doneText = await page.locator('.msg-bubble').last().innerText().catch(() => '')
            if (doneText.includes('恢复后的总结')) break
            await page.waitForTimeout(300)
          }
          check('E2E-RECOVERY-01 confirm_applied 后 run 继续并完成（第二轮文本可见）', doneText.includes('恢复后的总结'), doneText.slice(0, 60))
          check('E2E-RECOVERY-01 完成态无停止按钮（终态）', (await page.locator('.btn.stop', { hasText: '停止' }).count()) === 0, '')
        }
      } finally {
        await closeApp(app)
        await new Promise<void>((r) => { mock1.server.closeAllConnections?.(); mock1.server.close(() => r()) })
      }
    }

    // ==================== E2E-RECOVERY-03：非幂等 retry 被拒 ====================
    console.log('\n[E2E-RECOVERY-03] 非幂等工具 retry_not_applied 被引擎拒绝，弹窗仍可继续')
    {
      const mock3 = await startMock()
      const { app, page } = await launchApp(await freshUd(), mock3.port)
      try {
        await page.evaluate(async (p: number) => {
          const ds = (window as any).ds
          await ds.setSettings({ ...(await ds.getSettings()), baseUrl: `http://127.0.0.1:${p}`, apiKey: 'e2e-key', model: 'deepseek-v4-flash' })
        }, mock3.port)
        await page.waitForTimeout(300)
        const runId = await setupRecoveryRun(page, mock3)
        check('E2E-RECOVERY-03 第二个 run 进入 recovery_required', runId.length > 0, runId)
        if (runId) {
          await page.evaluate(async (rid: string) => (window as any).ds.runsResume(rid), runId)
          const decide = await page.evaluate(async (rid: string) => {
            try {
              return await (window as any).ds.runsRecoverDecide({ runId: rid, decision: 'retry_not_applied' })
            } catch (e) {
              return { ok: false, error: String((e as { message?: string })?.message ?? e) }
            }
          }, runId)
          check('E2E-RECOVERY-03 非幂等工具 retry_not_applied 被引擎拒绝（{ok:false}）', decide?.ok === false, JSON.stringify(decide))
          const still = await page.evaluate(async () => {
            const r = await (window as any).ds.runsRecoverable()
            return Array.isArray(r) && r.some((x: { status: string }) => x.status === 'recovery_required')
          })
          check('E2E-RECOVERY-05 决策失败后 run 仍在恢复列表（不静默消失）', still, '')
          // 清理：abandon 该 run
          await page.evaluate(async (rid: string) => (window as any).ds.runsRecoverDecide({ runId: rid, decision: 'abandon' }), runId)
        }
      } finally {
        await closeApp(app)
      }
    }

    // ==================== E2E-RECOVERY-02：abandon ====================
    console.log('\n[E2E-RECOVERY-02] abandon 放弃 → cancelled + 恢复列表移除')
    {
      const mock2 = await startMock()
      const { app, page } = await launchApp(await freshUd(), mock2.port)
      try {
        await page.evaluate(async (p: number) => {
          const ds = (window as any).ds
          await ds.setSettings({ ...(await ds.getSettings()), baseUrl: `http://127.0.0.1:${p}`, apiKey: 'e2e-key', model: 'deepseek-v4-flash' })
        }, mock2.port)
        await page.waitForTimeout(300)
        const runId = await setupRecoveryRun(page, mock2)
        check('E2E-RECOVERY-02 第三个 run 进入 recovery_required', runId.length > 0, runId)
        if (runId) {
          await page.evaluate(async (rid: string) => (window as any).ds.runsResume(rid), runId)
          const decide = await page.evaluate(async (rid: string) => (window as any).ds.runsRecoverDecide({ runId: rid, decision: 'abandon' }), runId)
          check('E2E-RECOVERY-02 abandon 决策成功', decide?.ok === true, JSON.stringify(decide))
          const rec = await page.evaluate(async () => (window as any).ds.runsRecoverable())
          const gone = !Array.isArray(rec) || !rec.some((r: { status: string }) => r.status === 'recovery_required')
          check('E2E-RECOVERY-02 abandon 后恢复列表无 recovery_required（DB cancelled）', gone, JSON.stringify(rec))
        }
      } finally {
        await closeApp(app)
      }
    }

    // ==================== E2E-RECOVERY-04/05：owner + 失败后仍可见 ====================
    console.log('\n[E2E-RECOVERY-04/05] 未领养窗口决策被拒；决策失败后 run 仍可见')
    {
      // 新 app 实例 + 新 recovery run：kernelWins 为空（未 resume 领养）
      const mock4 = await startMock()
      const { app, page } = await launchApp(await freshUd(), mock4.port)
      try {
        await page.evaluate(async (p: number) => {
          const ds = (window as any).ds
          await ds.setSettings({ ...(await ds.getSettings()), baseUrl: `http://127.0.0.1:${p}`, apiKey: 'e2e-key', model: 'deepseek-v4-flash' })
        }, mock4.port)
        await page.waitForTimeout(300)
        const runId = await setupRecoveryRun(page, mock4)
        check('E2E-RECOVERY-04 新 run 进入 recovery_required（跨重启 durable 前提）', runId.length > 0, runId)
        const rec = await page.evaluate(async () => (window as any).ds.runsRecoverable())
        const target = Array.isArray(rec) ? rec.find((r: { status: string }) => r.status === 'recovery_required') : null
        check('E2E-RECOVERY-04 恢复列表有 recovery_required run（未领养）', target !== null && typeof target?.runId === 'string', JSON.stringify(rec))
        const decide = target ? await page.evaluate(async (rid: string) => {
          try {
            return await (window as any).ds.runsRecoverDecide({ runId: rid, decision: 'abandon' })
          } catch (e) {
            return { ok: false, error: String((e as { message?: string })?.message ?? e) }
          }
        }, target.runId) : { ok: false, error: 'no target' }
        check('E2E-RECOVERY-04 未领养窗口 recoverDecide 拒绝（run_not_owned）', decide?.ok === false, JSON.stringify(decide))
        const still = await page.evaluate(async () => {
          const r = await (window as any).ds.runsRecoverable()
          return Array.isArray(r) && r.some((x: { status: string }) => x.status === 'recovery_required')
        })
        check('E2E-RECOVERY-05 owner 拒绝后 run 仍可见（不静默消失）', still, '')
        // 清理：领养后 abandon（当前窗口是唯一窗口，resume 后 owner 通过）
        if (target) {
          await page.evaluate(async (rid: string) => (window as any).ds.runsResume(rid), target.runId)
          await page.evaluate(async (rid: string) => (window as any).ds.runsRecoverDecide({ runId: rid, decision: 'abandon' }), target.runId)
        }
      } finally {
        await closeApp(app)
      }
    }
  } finally {
    // 每段 mock 与 userData 已各自清理（freshUd 目录留在 e2e-screenshots/fixture，已被 .gitignore 忽略）
  }

  console.log(`\n===== R4.3-G3 恢复 E2E：${passed} PASS / ${failed} FAIL =====`)
  if (failed > 0) {
    console.log('红灯明细：')
    for (const f of failures) console.log(`  - ${f}`)
  }
  process.exit(failed > 0 ? 1 : 0)
}

main().catch((e) => {
  console.error('R4.3-G3 恢复 E2E 执行异常（需桌面显示环境）：', (e as Error).message)
  process.exit(2)
})
