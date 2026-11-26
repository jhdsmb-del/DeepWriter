// ==================== R4.5 Gate 3：Completion 恢复状态精确化（红灯先行） ====================
// 复审 S-01：一次失败候选产生 validating revision，requestContinuation 又产生 continuing revision；
// fromStore 用 repairAttempts=latest.revision 高估尝试次数；startTime=latest.createdAt 用最近评估
// 时间代替原始预算起点（反复重启可延后墙钟预算）；below_target 的 hash 含实测字数（8000→8100
// 被视为 finding 改变，绕过 no_progress）。
// 本测试验收：
//  COMP-RESTORE-ATTEMPT-EXACT-01  repairAttempts 精确恢复（validating×1 + continuing×1 → 恢复后=1，非 revision=2）
//  COMP-RESTORE-WALLCLOCK-ORIGIN-01 startedAt = contract.createdAt（不随重启刷新）
//  COMP-RESTORE-TWICE-01          连续两次恢复 startedAt/attempts 不变
//  COMP-FINDING-IDENTITY-01       below_target 稳定 key 不含 measured（8000 与 8100 同 hash）；
//                                 8000→10000（≥95% 目标）真实改善 completed
//  COMP-DELTA-LOW-GROWTH-01       8000→8100 低增长（identity 稳定）→ continuing（不误杀）；
//                                 8000→8000 零增长 → no_progress blocked
//  COMP-MIGRATE-OLD-01            旧格式 evaluation（缺新字段）→ fromStore 明确迁移规则
//                                 （attempts=0、startedAt=contract.createdAt）并重写落库（不猜）

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
  const outfile = path.resolve(__dirname, '..', 'out', `r45g3-${Date.now()}-${Math.random().toString(36).slice(2)}.mjs`)
  try {
    await esbuild.build({
      entryPoints: [abs],
      bundle: true,
      format: 'esm',
      platform: 'node',
      target: 'node20',
      write: true,
      outfile,
      external: ['iconv-lite', 'pdf-parse', 'mammoth', 'fflate', 'node:sqlite'],
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

interface EvalLike {
  revision: number
  state: string
  hardFailures: Array<{ hash: string; code: string }>
  measuredChars: number | null
  repairAttempts?: number
  startedAt?: number
  previousFindingKeys?: string[]
  currentFindingKeys?: string[]
  lastDeltaChars?: number | null
  latestMeasuredChars?: number | null
  blockedReason?: string
}

interface StoreLike {
  saveEvaluation(runId: string, ev: EvalLike): void
  getLatestEvaluation(runId: string): EvalLike | null
}

/** 内存 store：记录每次保存（迁移重写检测用） */
function memStore(): { store: StoreLike; saved: Array<{ runId: string; ev: EvalLike }> } {
  const saved: Array<{ runId: string; ev: EvalLike }> = []
  return {
    saved,
    store: {
      saveEvaluation: (runId, ev) => {
        saved.push({ runId, ev })
      },
      getLatestEvaluation: () => (saved.length ? saved[saved.length - 1].ev : null)
    }
  }
}

const LONGWRITE_CONTRACT = {
  schemaVersion: 1,
  runId: '',
  targetChars: { min: 10000, tolerance: 0.05 },
  validators: [
    { id: 'targetChars', severity: 'hard', config: {} },
    { id: 'noPendingTools', severity: 'hard', config: {} }
  ],
  maxRepairAttempts: 2,
  createdAt: 1_000_000
}

const NO_TOOLS_EVIDENCE = (measured: number) => ({
  measuredChars: measured,
  artifacts: [],
  pendingToolCount: 0,
  pendingToolNames: []
})

/** 低增长/零增长场景专用契约：maxRepair=3（避免上限先于单调性判定触发） */
const LOW_GROWTH_CONTRACT = { ...LONGWRITE_CONTRACT, maxRepairAttempts: 3 }

async function main(): Promise<void> {
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'dw-r45-g3-'))

  console.log('\n[R4.5-G3] Completion 恢复状态精确化（repairAttempts/startedAt/identity 分离）')

  const ctrlMod = await loadTsModule('src/main/completion/CompletionController.ts')
  const CompletionController = ctrlMod.CompletionController as new (opts: Record<string, unknown>) => {
    submitCandidate(ev: Record<string, unknown>): EvalLike
    requestContinuation(): EvalLike
    getRevision(): number
  }
  const targetMod = await loadTsModule('src/main/completion/validators/targetLength.ts')
  const validateTargetChars = targetMod.validateTargetChars as (cfg: { min: number; max?: number; tolerance: number }, measured: number | undefined) => Array<{ code: string; hash: string }>

  // ---- COMP-FINDING-IDENTITY-01：below_target 稳定 key 不含 measured ----
  {
    const f8000 = validateTargetChars({ min: 10000, tolerance: 0.05 }, 8000)
    const f8100 = validateTargetChars({ min: 10000, tolerance: 0.05 }, 8100)
    const f8200 = validateTargetChars({ min: 10000, tolerance: 0.05 }, 8200)
    const bt = (f: Array<{ code: string; hash: string }>): string => f.find((x) => x.code === 'below_target')?.hash ?? ''
    check('COMP-FINDING-IDENTITY-01 8000 与 8100 的 below_target hash 相同（identity 稳定，不含测量值）', bt(f8000) === bt(f8100) && bt(f8100) === bt(f8200), `${bt(f8000)} vs ${bt(f8100)}`)
    const f9000 = validateTargetChars({ min: 10000, tolerance: 0.05 }, 9000)
    const f8999 = validateTargetChars({ min: 10000, tolerance: 0.05 }, 8999)
    check('COMP-FINDING-IDENTITY-01 9000/8999（均低于 floor）与 8000 同 identity', bt(f9000) === bt(f8000) && bt(f8999) === bt(f8000), '')
    // 容差边界：9500 = floor（达标，无 below_target）
    const f9500 = validateTargetChars({ min: 10000, tolerance: 0.05 }, 9500)
    check('COMP-FINDING-IDENTITY-01 9500（容差边界=floor）达标 → 无 below_target', f9500.length === 0, JSON.stringify(f9500))
    const fOver = validateTargetChars({ min: 10000, max: 12000, tolerance: 0.05 }, 13000)
    check('COMP-FINDING-IDENTITY-01 over_target 单独稳定 key（不与 below_target 混淆）', fOver.find((x) => x.code === 'over_target')?.hash !== bt(f8000), '')
    const f10000 = validateTargetChars({ min: 10000, tolerance: 0.05 }, 10000)
    check('COMP-FINDING-IDENTITY-01 达标（10000）→ below_target 消失（真实改善）', f10000.length === 0, JSON.stringify(f10000))
  }

  // ---- COMP-DELTA-LOW-GROWTH-01：低增长（identity 稳定）→ continuing；零增长 → no_progress ----
  {
    const m = memStore()
    const c = new CompletionController({ contract: LOW_GROWTH_CONTRACT, store: m.store, now: () => 2_000_000 })
    const ev1 = c.submitCandidate(NO_TOOLS_EVIDENCE(8000))
    check('COMP-DELTA-LOW-GROWTH-01 首轮 8000 → validating + repairAttempts=1', ev1.state === 'validating' && ev1.repairAttempts === 1, JSON.stringify(ev1))
    const cont1 = c.requestContinuation()
    check('COMP-DELTA-LOW-GROWTH-01 首轮后 continuing（revision=2）', cont1.state === 'continuing' && cont1.revision === 2, '')
    const ev2 = c.submitCandidate(NO_TOOLS_EVIDENCE(8100))
    check('COMP-DELTA-LOW-GROWTH-01 8000→8100 低增长 delta=100 记录', ev2.lastDeltaChars === 100 && ev2.latestMeasuredChars === 8100, JSON.stringify({ delta: ev2.lastDeltaChars, measured: ev2.latestMeasuredChars }))
    check('COMP-DELTA-LOW-GROWTH-01 低增长但 identity 稳定（keys 内容一致，非 finding 改变）', (ev2.currentFindingKeys ?? []).join(',') === (ev2.previousFindingKeys ?? []).join(','), JSON.stringify({ cur: ev2.currentFindingKeys, prev: ev2.previousFindingKeys }))
    const cont2 = c.requestContinuation()
    check('COMP-DELTA-LOW-GROWTH-01 低增长续作 → continuing（非 no_progress 误杀）', cont2.state === 'continuing', JSON.stringify(cont2))
    // 零增长：新控制器 8000 → 8000
    const m2 = memStore()
    const c2 = new CompletionController({ contract: LOW_GROWTH_CONTRACT, store: m2.store, now: () => 3_000_000 })
    c2.submitCandidate(NO_TOOLS_EVIDENCE(8000))
    c2.requestContinuation()
    c2.submitCandidate(NO_TOOLS_EVIDENCE(8000))
    const contZero = c2.requestContinuation()
    check('COMP-DELTA-LOW-GROWTH-01 零增长（delta=0）→ pause_user no_progress（R4.5 等用户决策）', contZero.state === 'waiting_user' && contZero.blockedReason === 'no_progress', JSON.stringify(contZero))
    // 8000→10000 真实改善：第三轮达标
    const m3 = memStore()
    const c3 = new CompletionController({ contract: LOW_GROWTH_CONTRACT, store: m3.store, now: () => 4_000_000 })
    c3.submitCandidate(NO_TOOLS_EVIDENCE(8000))
    c3.requestContinuation()
    const evDone = c3.submitCandidate(NO_TOOLS_EVIDENCE(10000))
    check('COMP-DELTA-LOW-GROWTH-01 8000→10000 真实改善 → completed（finding 集合变化）', evDone.state === 'completed', JSON.stringify(evDone))
  }

  // ---- COMP-RESTORE-ATTEMPT-EXACT-01：repairAttempts 精确恢复（不从 revision 推导） ----
  {
    const m = memStore()
    const c = new CompletionController({ contract: LONGWRITE_CONTRACT, store: m.store, now: () => 5_000_000 })
    c.submitCandidate(NO_TOOLS_EVIDENCE(8000)) // revision=1, validating, attempts=1
    c.requestContinuation()                     // revision=2, continuing
    // 恢复：latest = revision=2（continuing），attempts 必须=1 而非 revision=2
    const ctrlMod2 = await loadTsModule('src/main/completion/CompletionController.ts')
    const fromStore = ctrlMod2.CompletionController.fromStore as (opts: Record<string, unknown>, latest: EvalLike | null) => {
      submitCandidate(ev: Record<string, unknown>): EvalLike
      requestContinuation(): EvalLike
      getRevision(): number
    }
    const restored = fromStore({ contract: LONGWRITE_CONTRACT, store: m.store, now: () => 5_100_000 }, m.saved[m.saved.length - 1].ev)
    check('COMP-RESTORE-ATTEMPT-EXACT-01 恢复后 revision 保持（=2）', restored.getRevision() === 2, `rev=${restored.getRevision()}`)
    // 恢复后 1 次失败候选 → 再 requestContinuation：attempts=1 < maxRepair=2 → continuing（不因 revision 推导误判已达上限）
    const evAfter = restored.submitCandidate(NO_TOOLS_EVIDENCE(8100))
    check('COMP-RESTORE-ATTEMPT-EXACT-01 恢复后失败候选 attempts=2（非 revision 推导的 3）', evAfter.repairAttempts === 2, `attempts=${evAfter.repairAttempts}`)
    const cont = restored.requestContinuation()
    check('COMP-RESTORE-ATTEMPT-EXACT-01 attempts=2 = maxRepair=2 → pause_user（max_repair_attempts）', cont.state === 'waiting_user' && cont.blockedReason === 'max_repair_attempts', JSON.stringify(cont))
  }

  // ---- COMP-RESTORE-WALLCLOCK-ORIGIN-01：startedAt = contract.createdAt（不随重启刷新） ----
  {
    const m = memStore()
    const c = new CompletionController({ contract: LONGWRITE_CONTRACT, store: m.store, now: () => 6_000_000 })
    const ev1 = c.submitCandidate(NO_TOOLS_EVIDENCE(8000))
    check('COMP-RESTORE-WALLCLOCK-ORIGIN-01 首次评估 startedAt = contract.createdAt', ev1.startedAt === LONGWRITE_CONTRACT.createdAt, `startedAt=${ev1.startedAt}`)
    c.requestContinuation()
    const ctrlMod2 = await loadTsModule('src/main/completion/CompletionController.ts')
    const fromStore = ctrlMod2.CompletionController.fromStore as (opts: Record<string, unknown>, latest: EvalLike | null) => { submitCandidate(ev: Record<string, unknown>): EvalLike }
    // 模拟"重启后很久"（now 大幅前移）：恢复不得把起点刷新到最近评估时间
    const restored = fromStore({ contract: LONGWRITE_CONTRACT, store: m.store, now: () => 9_999_999 }, m.saved[m.saved.length - 1].ev)
    const ev2 = restored.submitCandidate(NO_TOOLS_EVIDENCE(8100))
    check('COMP-RESTORE-WALLCLOCK-ORIGIN-01 恢复后评估 startedAt 仍 = contract.createdAt（不刷新为最近时间）', ev2.startedAt === LONGWRITE_CONTRACT.createdAt, `startedAt=${ev2.startedAt}`)
  }

  // ---- COMP-RESTORE-TWICE-01：连续两次恢复 startedAt/attempts 不变 ----
  {
    const m = memStore()
    const c = new CompletionController({ contract: LONGWRITE_CONTRACT, store: m.store, now: () => 7_000_000 })
    c.submitCandidate(NO_TOOLS_EVIDENCE(8000))
    c.requestContinuation()
    const ctrlMod2 = await loadTsModule('src/main/completion/CompletionController.ts')
    const fromStore = ctrlMod2.CompletionController.fromStore as (opts: Record<string, unknown>, latest: EvalLike | null) => { submitCandidate(ev: Record<string, unknown>): EvalLike }
    const r1 = fromStore({ contract: LONGWRITE_CONTRACT, store: m.store, now: () => 7_100_000 }, m.saved[m.saved.length - 1].ev)
    const e1 = r1.submitCandidate(NO_TOOLS_EVIDENCE(8100))
    const r2 = fromStore({ contract: LONGWRITE_CONTRACT, store: m.store, now: () => 7_200_000 }, m.saved[m.saved.length - 1].ev)
    const e2 = r2.submitCandidate(NO_TOOLS_EVIDENCE(8200))
    check('COMP-RESTORE-TWICE-01 两次恢复 startedAt 均 = contract.createdAt（不漂移）', e1.startedAt === LONGWRITE_CONTRACT.createdAt && e2.startedAt === LONGWRITE_CONTRACT.createdAt, '')
    check('COMP-RESTORE-TWICE-01 两次恢复 attempts 连续递增（2 → 3），无跳变', e1.repairAttempts === 2 && e2.repairAttempts === 3, `a1=${e1.repairAttempts} a2=${e2.repairAttempts}`)
    check('COMP-RESTORE-TWICE-01 delta 连续累计（100 → 200）', e1.lastDeltaChars === 100 && e2.lastDeltaChars === 100, `d1=${e1.lastDeltaChars} d2=${e2.lastDeltaChars}`)
  }

  // ---- COMP-MIGRATE-OLD-01：旧格式 evaluation → 明确迁移规则（不猜）+ 重写落库 ----
  {
    const ctrlMod2 = await loadTsModule('src/main/completion/CompletionController.ts')
    const fromStore = ctrlMod2.CompletionController.fromStore as (opts: Record<string, unknown>, latest: EvalLike | null) => { submitCandidate(ev: Record<string, unknown>): EvalLike }
    // 旧格式：只有 revision/state/hardFailures/measuredChars（无 repairAttempts/startedAt/keys/delta）
    const oldEval: EvalLike = {
      revision: 3,
      state: 'continuing',
      hardFailures: [{ hash: 'stable-hash-a', code: 'below_target' }],
      measuredChars: 8000
    }
    const m = memStore()
    // 先塞旧记录再恢复（getLatestEvaluation 返回旧格式）
    const storeWithOld: StoreLike = {
      saveEvaluation: (r, ev) => m.saved.push({ runId: r, ev }),
      getLatestEvaluation: () => oldEval
    }
    const restored = fromStore({ contract: LONGWRITE_CONTRACT, store: storeWithOld, now: () => 8_000_000 }, oldEval)
    const ev = restored.submitCandidate(NO_TOOLS_EVIDENCE(8100))
    check('COMP-MIGRATE-OLD-01 旧格式恢复：attempts 从零算（明确迁移规则，非 revision=3）', ev.repairAttempts === 1, `attempts=${ev.repairAttempts}`)
    check('COMP-MIGRATE-OLD-01 旧格式恢复：startedAt = contract.createdAt（权威起点，不猜）', ev.startedAt === LONGWRITE_CONTRACT.createdAt, `startedAt=${ev.startedAt}`)
    check('COMP-MIGRATE-OLD-01 迁移后新格式 evaluation 已落库（字段齐全）', m.saved[m.saved.length - 1].ev.repairAttempts !== undefined && m.saved[m.saved.length - 1].ev.startedAt !== undefined, JSON.stringify(m.saved[m.saved.length - 1].ev))
  }

  await fsp.rm(tmp, { recursive: true, force: true }).catch(() => undefined)
  console.log(`\n===== R4.5-G3 红灯测试：${passed} PASS / ${failed} FAIL =====`)
  if (failed > 0) {
    for (const f of failures) console.log(`  - ${f}`)
    process.exitCode = 1
  }
}

main().catch((e) => {
  console.error('R4.5-G3 运行异常（红灯阶段预期：目标接口尚未实现）:', e instanceof Error ? e.message : String(e))
  process.exitCode = 2
})
