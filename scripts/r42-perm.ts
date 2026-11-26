// ==================== R4.2 A2 红灯回归：owner-scoped permission lease（SEC-PERM-OWNER/REVISION/TERMINAL） ====================
// 复审 S-02：旧实现 setVolatileMode('off') 是全局开关——窗口 A 授权后，窗口 B 或另一个恢复 run
// 在 10 分钟内无需批准即可执行危险操作；token 只在 apply 前绑定 sender，apply 后无身份。
// 本测试证明：
//  1) lease 绑定 {webContentsId, sessionId, runId, scopes, issuedAt, expiresAt, revision}；
//  2) 窗口 A 的 lease 不能授权窗口 B / 其他 session / 其他 run（runId 绑定时）；
//  3) 旧 timer/旧 lease 的过期撤销不能影响新 lease（revision/按 id 管理）；
//  4) 窗口销毁 / run terminal / 到期 / 显式撤销均立即失效；
//  5) 进程重启一律失效（新 manager 无 lease）。
// 运行：npx esbuild scripts/r42-perm.ts --bundle --format=esm --platform=node --outfile=out/r42-perm.mjs && node out/r42-perm.mjs

import * as path from 'node:path'
import * as url from 'node:url'
import * as fs from 'node:fs'
import { promises as fsp } from 'node:fs'
import * as os from 'node:os'
import { createRequire } from 'node:module'

const __dirname = path.dirname(url.fileURLToPath(import.meta.url))
const require = createRequire(import.meta.url)
const esbuild = require('esbuild') as { build(opts: Record<string, unknown>): Promise<unknown> }

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

async function loadTsModule(rel: string): Promise<Record<string, unknown>> {
  const abs = path.resolve(__dirname, '..', rel)
  const outfile = path.resolve(__dirname, '..', 'out', `r42mod-${Date.now()}-${Math.random().toString(36).slice(2)}.mjs`)
  try {
    await esbuild.build({
      entryPoints: [abs],
      bundle: true,
      format: 'esm',
      platform: 'node',
      target: 'node20',
      write: true,
      outfile,
      external: ['node:sqlite'],
      logLevel: 'silent',
      plugins: [
        {
          name: 'electron-shim',
          setup(build: { onResolve(o: unknown, cb: (r: { path: string; namespace: string }) => unknown): void; onLoad(o: unknown, cb: () => unknown): void }): void {
            build.onResolve({ filter: /^electron$/ }, () => ({ path: 'electron', namespace: 'electron-shim' }))
            build.onLoad({ filter: /.*/, namespace: 'electron-shim' }, () => ({
              contents: [
                'export const app = { getPath: (n) => String(n), isPackaged: false };',
                'export const dialog = { showMessageBox: async () => ({ response: 1 }) };',
                'export const ipcMain = { handle: () => undefined, on: () => undefined };',
                'export const safeStorage = { isEncryptionAvailable: () => false, encryptString: () => null, decryptString: () => "" };',
                'export const shell = { openExternal: () => undefined, openPath: async () => "" };',
                'export const clipboard = { writeText: () => undefined };',
                'export const Menu = { buildFromTemplate: (t) => ({ popup: () => undefined, template: t }) };'
              ].join('\n'),
              loader: 'js'
            }))
          }
        }
      ]
    })
    const mod = await import(url.pathToFileURL(outfile).href)
    return mod as Record<string, unknown>
  } finally {
    try {
      await fs.promises.unlink(outfile)
    } catch {
      /* 清理失败忽略 */
    }
  }
}

async function main(): Promise<void> {
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'dw-r42-perm-'))

  console.log('\n[R42-A2] SEC-PERM-OWNER/REVISION/TERMINAL：owner-scoped permission lease')
  const permMod = await loadTsModule('src/main/permissions.ts')
  const createPermissionManager = permMod.createPermissionManager as (baseDir: string, askUser?: (type: string, target: string) => Promise<{ action: string; remember: boolean }>) => {
    decide(type: string, target: string, identity?: { webContentsId?: number; sessionId?: string; runId?: string }): Promise<{ action: string; reason?: string }>
    issueLease(input: { webContentsId: number; sessionId: string; runId?: string | null; scopes: 'full' | string[]; ttlMs: number }): unknown
    revokeLease(leaseId: string): void
    revokeLeasesByWebContentsId(id: number): void
    revokeLeasesByRunId(runId: string): void
    revokeLeasesBySessionId(sessionId: string): void
    pruneExpiredLeases(): void
    listLeases(): Array<{ leaseId: string; webContentsId: number; sessionId: string; runId: string | null; expiresAt: number }>
    getActiveFullAccess(webContentsId: number): { expiresAt: number } | null
  }

  const pm = createPermissionManager(path.join(tmp, 'perm'))

  // ---- SEC-PERM-OWNER-01：窗口/session/run 隔离 ----
  pm.issueLease({ webContentsId: 1, sessionId: 'S', runId: null, scopes: 'full', ttlMs: 600_000 })
  const d11 = await pm.decide('command', 'rm -rf /', { webContentsId: 1, sessionId: 'S', runId: 'R1' })
  check('SEC-PERM-OWNER-01 窗口1+sessionS+任意 run：lease 放行', d11.action === 'allow', JSON.stringify(d11))
  const d12 = await pm.decide('path', 'C:/anything', { webContentsId: 1, sessionId: 'S', runId: 'R2' })
  check('SEC-PERM-OWNER-01 runId 未绑定（null）时同窗口同 session 其他 run 放行', d12.action === 'allow', JSON.stringify(d12))
  const d13 = await pm.decide('command', 'rm -rf /', { webContentsId: 2, sessionId: 'S', runId: 'R1' })
  check('SEC-PERM-OWNER-01 窗口 B 即使同 session 也拒绝（lease 不跨窗口）', d13.action !== 'allow', JSON.stringify(d13))
  const d14 = await pm.decide('command', 'rm -rf /', { webContentsId: 1, sessionId: 'T', runId: 'R1' })
  check('SEC-PERM-OWNER-01 同窗口不同 session 拒绝（lease 不跨 session）', d14.action !== 'allow', JSON.stringify(d14))
  const d15 = await pm.decide('command', 'rm -rf /', { webContentsId: 1 })
  check('SEC-PERM-OWNER-01 identity 缺 sessionId 时 lease 不匹配（不降级放行）', d15.action !== 'allow', JSON.stringify(d15))

  // runId 绑定的 lease：只能授权该 run
  const rb = pm.issueLease({ webContentsId: 3, sessionId: 'S3', runId: 'R3', scopes: 'full', ttlMs: 600_000 }) as { leaseId: string }
  const d16 = await pm.decide('command', 'rm -rf /', { webContentsId: 3, sessionId: 'S3', runId: 'R3' })
  check('SEC-PERM-OWNER-01 runId 绑定 lease 授权目标 run', d16.action === 'allow', JSON.stringify(d16))
  const d17 = await pm.decide('command', 'rm -rf /', { webContentsId: 3, sessionId: 'S3', runId: 'R4' })
  check('SEC-PERM-OWNER-01 runId 绑定 lease 拒绝其他 run（另一恢复 run 不可借用）', d17.action !== 'allow', JSON.stringify(d17))
  const d18 = await pm.decide('command', 'rm -rf /', { webContentsId: 3, sessionId: 'S3', runId: 'R3' })
  check('SEC-PERM-OWNER-01 lease 可重复使用（token 单次使用仅限申请环节，lease 生命周期内有效）', d18.action === 'allow', JSON.stringify(d18))

  // ---- SEC-PERM-REVISION-01：旧 timer/旧 lease 不能撤销新 lease ----
  const a = pm.issueLease({ webContentsId: 10, sessionId: 'SA', runId: null, scopes: 'full', ttlMs: 50 }) as { leaseId: string; expiresAt: number }
  await new Promise((r) => setTimeout(r, 80)) // A 过期
  const b = pm.issueLease({ webContentsId: 10, sessionId: 'SB', runId: null, scopes: 'full', ttlMs: 600_000 }) as { leaseId: string }
  check('SEC-PERM-REVISION-01 新 lease 已签发（revision 递增）', typeof b.leaseId === 'string' && b.leaseId !== a.leaseId)
  // 模拟"A 的过期 timer 触发"：只清理 A
  pm.revokeLease(a.leaseId)
  const dR1 = await pm.decide('command', 'rm -rf /', { webContentsId: 10, sessionId: 'SB', runId: 'RX' })
  check('SEC-PERM-REVISION-01 撤销旧 lease A 不影响新 lease B', dR1.action === 'allow', JSON.stringify(dR1))
  // 惰性过期清理：A 已过期，prune 后 B 仍有效
  pm.pruneExpiredLeases()
  const dR2 = await pm.decide('command', 'rm -rf /', { webContentsId: 10, sessionId: 'SB', runId: 'RY' })
  check('SEC-PERM-REVISION-01 过期清理只清过期项，新 lease 不受影响', dR2.action === 'allow', JSON.stringify(dR2))

  // ---- SEC-PERM-TERMINAL-01：窗口销毁 / run terminal / 到期 / 显式撤销立即失效 ----
  pm.issueLease({ webContentsId: 20, sessionId: 'ST', runId: 'RT1', scopes: 'full', ttlMs: 600_000 })
  pm.issueLease({ webContentsId: 21, sessionId: 'ST2', runId: 'RT2', scopes: 'full', ttlMs: 600_000 })
  // run terminal → 该 run 的 lease 失效
  pm.revokeLeasesByRunId('RT1')
  const dT1 = await pm.decide('command', 'rm -rf /', { webContentsId: 20, sessionId: 'ST', runId: 'RT1' })
  check('SEC-PERM-TERMINAL-01 run terminal 后该 run 的 lease 立即失效', dT1.action !== 'allow', JSON.stringify(dT1))
  const dT2 = await pm.decide('command', 'rm -rf /', { webContentsId: 21, sessionId: 'ST2', runId: 'RT2' })
  check('SEC-PERM-TERMINAL-01 其他 run 的 lease 不受影响', dT2.action === 'allow', JSON.stringify(dT2))
  // 窗口销毁 → 该窗口全部 lease 失效
  pm.revokeLeasesByWebContentsId(21)
  const dT3 = await pm.decide('command', 'rm -rf /', { webContentsId: 21, sessionId: 'ST2', runId: 'RT2' })
  check('SEC-PERM-TERMINAL-01 窗口销毁后其 lease 立即失效', dT3.action !== 'allow', JSON.stringify(dT3))
  // 显式撤销
  const lc = pm.issueLease({ webContentsId: 22, sessionId: 'SC', runId: 'RC', scopes: 'full', ttlMs: 600_000 }) as { leaseId: string }
  pm.revokeLease(lc.leaseId)
  const dT4 = await pm.decide('command', 'rm -rf /', { webContentsId: 22, sessionId: 'SC', runId: 'RC' })
  check('SEC-PERM-TERMINAL-01 显式撤销后立即失效', dT4.action !== 'allow', JSON.stringify(dT4))
  // 到期自动失效（真实过期）
  pm.issueLease({ webContentsId: 23, sessionId: 'SD', runId: 'RD', scopes: 'full', ttlMs: 40 })
  await new Promise((r) => setTimeout(r, 90))
  const dT5 = await pm.decide('command', 'rm -rf /', { webContentsId: 23, sessionId: 'SD', runId: 'RD' })
  check('SEC-PERM-TERMINAL-01 TTL 到期后自动失效', dT5.action !== 'allow', JSON.stringify(dT5))
  // 进程重启 = 新 manager 实例，无任何 lease
  const pm2 = createPermissionManager(path.join(tmp, 'perm'))
  const dT6 = await pm2.decide('command', 'rm -rf /', { webContentsId: 1, sessionId: 'S', runId: 'R1' })
  check('SEC-PERM-TERMINAL-01 进程重启后一切 lease 失效（新实例无内存态）', dT6.action !== 'allow', JSON.stringify(dT6))

  // ---- 全局 volatile off 必须移除：off 只能来自 lease ----
  const settings = pm.getSettings()
  check('SEC-PERM-OWNER-01 持久配置仍为 safe/auto（off 不落盘）', settings.mode !== 'off', JSON.stringify(settings))

  await fsp.rm(tmp, { recursive: true, force: true })
  console.log(`\n===== R4.2-A2 红灯回归：${passed} PASS / ${failed} FAIL =====`)
  if (failed > 0) {
    console.log('红灯明细（修绿目标）：')
    for (const f of failures) console.log(`  - ${f}`)
  }
  process.exit(failed > 0 ? 1 : 0)
}

main().catch((e) => {
  console.error('R4.2-A2 红灯回归执行异常：', e)
  process.exit(2)
})
