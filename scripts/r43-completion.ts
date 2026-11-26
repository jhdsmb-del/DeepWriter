// ==================== R4.3 Gate 4 外部可验证完成契约（纯核心模块）测试 ====================
// 覆盖：COMP-FALSE-CLAIM-01 / COMP-TARGET-01 / COMP-ARTIFACT-01 / COMP-LINT-01
//       / COMP-NO-PROGRESS-01 / COMP-BUDGET-01 / COMP-CANCEL-01 / COMP-DURABLE-01
// 运行：npx esbuild scripts/r43-completion.ts --bundle --format=esm --platform=node --outfile=out/r43-completion.mjs && node out/r43-completion.mjs
// 全部使用内存 fake CompletionStore（Map 版），纯 Node 可测（不 import electron、不依赖 DB 表）。

import * as CompletionModule from '../src/main/completion/CompletionController'
import { CompletionController } from '../src/main/completion/CompletionController'
import type { CompletionContract, CompletionEvaluation, CompletionEvidence, CompletionStore } from '../src/main/completion/types'

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

// ---------- 公共 mock / 工厂 ----------

interface FakeStore extends CompletionStore {
  /** saveEvaluation 累计调用次数 */
  count: number
}

/** 内存 fake CompletionStore：按 runId 存数组，getLatest 取最后一条 */
function makeFakeStore(): FakeStore {
  const byRun = new Map<string, CompletionEvaluation[]>()
  let count = 0
  return {
    get count(): number {
      return count
    },
    saveEvaluation(runId: string, ev: CompletionEvaluation): void {
      count += 1
      const arr = byRun.get(runId) ?? []
      arr.push(ev)
      byRun.set(runId, arr)
    },
    getLatestEvaluation(runId: string): CompletionEvaluation | null {
      const arr = byRun.get(runId) ?? []
      return arr.length > 0 ? arr[arr.length - 1] : null
    }
  }
}

let runSeq = 0

/** 每次调用创建独立 controller + fake store（默认 maxRepairAttempts=3，与契约默认一致） */
function makeController(partial: Partial<CompletionContract>, now?: () => number): { controller: CompletionController; store: FakeStore; runId: string } {
  const store = makeFakeStore()
  const contract: CompletionContract = {
    schemaVersion: 1,
    runId: `run-${runSeq++}`,
    validators: [],
    maxRepairAttempts: 3,
    createdAt: 0,
    ...partial
  }
  return { controller: new CompletionController({ contract, store, now }), store, runId: contract.runId }
}

/** 构造最小合法 evidence（调用方按需覆盖字段） */
function makeEvidence(partial: Partial<CompletionEvidence> = {}): CompletionEvidence {
  return {
    artifacts: [],
    pendingToolCount: 0,
    pendingToolNames: [],
    ...partial
  }
}

const TARGET_GATE = { id: 'targetChars' as const, severity: 'hard' as const, config: { min: 10000, tolerance: 0.05 } }

function main(): void {
  // ==================== COMP-FALSE-CLAIM-01 ====================
  console.log('\n[COMP-FALSE-CLAIM-01] 模型自述"已完成"没有状态权限：无 setCompleted 类接口，欠字数只能 validating')
  {
    const keys = Object.keys(CompletionModule)
    const dangerous = keys.filter((k) => /^(set|force|mark|finish)/i.test(k))
    const proto = Object.getOwnPropertyNames(CompletionController.prototype)
    // setAccumulatedCost/getAccumulatedCost 是预算访问器（Gate 2/5 真实 usage 挂钩），不是完成接口
    const badProto = proto.filter((m) => /^(set|force|mark|finish)|complete/i.test(m) && !/Accumulated/i.test(m))
    check('COMP-FALSE-CLAIM-01 模块导出无 set/force/mark 类完成接口（无强制完成 API）', dangerous.length === 0 && badProto.length === 0, `keys=${keys.join(',')} proto=${proto.join(',')}`)
    const c = makeController({ targetChars: { min: 10000, tolerance: 0.05 }, validators: [TARGET_GATE] })
    const ev = c.controller.submitCandidate(makeEvidence({ measuredChars: 8000 }))
    check('COMP-FALSE-CLAIM-01 欠字数（8000 < 10000）→ validating 而非 completed', ev.state === 'validating', `state=${ev.state}`)
    check('COMP-FALSE-CLAIM-01 hard finding below_target + 结构化缺口 remainingWork（非自然语言结案）', ev.hardFailures.length === 1 && ev.hardFailures[0].code === 'below_target' && ev.hardFailures[0].severity === 'hard' && ev.remainingWork.length === 1 && ev.remainingWork[0].code === 'below_target', JSON.stringify(ev.hardFailures))
  }

  // ==================== COMP-TARGET-01 ====================
  console.log('\n[COMP-TARGET-01] 目标字数契约：达标 / 容差 / 欠字数 / 上限缺省 / 超上限 / 软门不阻断')
  {
    const mk = () => makeController({ targetChars: { min: 10000, tolerance: 0.05 }, validators: [TARGET_GATE] })
    const evFull = mk().controller.submitCandidate(makeEvidence({ measuredChars: 10000 }))
    check('COMP-TARGET-01 measured=10000（≥min）→ completed 且无 hard 失败', evFull.state === 'completed' && evFull.hardFailures.length === 0, `state=${evFull.state}`)
    const evTol = mk().controller.submitCandidate(makeEvidence({ measuredChars: 9501 }))
    check('COMP-TARGET-01 measured=9501（≥9500=min*(1-0.05)）→ completed（容差内）', evTol.state === 'completed', `state=${evTol.state}`)
    const evLow = mk().controller.submitCandidate(makeEvidence({ measuredChars: 8000 }))
    check('COMP-TARGET-01 measured=8000（<9500）→ validating + below_target', evLow.state === 'validating' && evLow.hardFailures.some((f) => f.code === 'below_target'), `state=${evLow.state}`)
    const evNoMax = mk().controller.submitCandidate(makeEvidence({ measuredChars: 12000 }))
    check('COMP-TARGET-01 max 缺省不查上限（12000 仍 completed）', evNoMax.state === 'completed', `state=${evNoMax.state}`)
    const cMax = makeController({ targetChars: { min: 10000, max: 11000, tolerance: 0.05 }, validators: [{ id: 'targetChars', severity: 'hard', config: { min: 10000, max: 11000, tolerance: 0.05 } }] })
    const evOver = cMax.controller.submitCandidate(makeEvidence({ measuredChars: 12000 }))
    check('COMP-TARGET-01 measured=12000 超 max=11000 → validating + over_target', evOver.state === 'validating' && evOver.hardFailures.some((f) => f.code === 'over_target'), JSON.stringify(evOver.hardFailures))
    const cSoft = makeController({ targetChars: { min: 10000, tolerance: 0.05 }, validators: [TARGET_GATE, { id: 'noPendingTools', severity: 'soft', config: {} }] })
    const evSoft = cSoft.controller.submitCandidate(makeEvidence({ measuredChars: 10000, pendingToolCount: 1, pendingToolNames: ['imageGen'] }))
    check('COMP-TARGET-01 软门（noPendingTools=soft）不阻断：completed 且保留 softWarnings', evSoft.state === 'completed' && evSoft.softWarnings.some((f) => f.code === 'pending_tool') && evSoft.hardFailures.length === 0, JSON.stringify(evSoft.softWarnings))
  }

  // ==================== COMP-ARTIFACT-01 ====================
  console.log('\n[COMP-ARTIFACT-01] 必需产物契约：按 kind 计数，判定与 measuredChars 无关')
  {
    const mk = () => makeController({
      requiredArtifacts: [{ kind: 'novel', minCount: 1 }],
      validators: [{ id: 'requiredArtifacts', severity: 'hard', config: {} }]
    })
    const a1 = mk()
    const evEmpty = a1.controller.submitCandidate(makeEvidence({ measuredChars: 50000 }))
    check('COMP-ARTIFACT-01 artifacts 为空 → validating + hard missing_artifact', evEmpty.state === 'validating' && evEmpty.hardFailures.length === 1 && evEmpty.hardFailures[0].code === 'missing_artifact', JSON.stringify(evEmpty.hardFailures))
    check('COMP-ARTIFACT-01 missing_artifact 缺失明细含 kind 与实际计数', evEmpty.hardFailures[0]?.message.includes('novel') === true && evEmpty.hardFailures[0]?.message.includes('0') === true, evEmpty.hardFailures[0]?.message ?? '')
    const a2 = mk()
    const evHas = a2.controller.submitCandidate(makeEvidence({ measuredChars: undefined, artifacts: [{ kind: 'novel', path: 'out/novel.md', hash: 'hash-novel-1' }] }))
    check('COMP-ARTIFACT-01 1 个 novel artifact → completed（artifactHashes 含该 hash）', evHas.state === 'completed' && evHas.hardFailures.length === 0 && evHas.artifactHashes.includes('hash-novel-1'), `state=${evHas.state}`)
    const a3 = mk()
    const evDiffMeasured = a3.controller.submitCandidate(makeEvidence({ measuredChars: 999999, artifacts: [{ kind: 'novel', path: 'out/novel.md', hash: 'hash-novel-1' }] }))
    check('COMP-ARTIFACT-01 判定只用 evidence.artifacts（传入不同 measuredChars 结果不变）', evDiffMeasured.state === 'completed' && evDiffMeasured.hardFailures.length === 0, `state=${evDiffMeasured.state}`)
    const a4 = makeController({
      requiredArtifacts: [{ kind: 'novel', minCount: 2 }],
      validators: [{ id: 'requiredArtifacts', severity: 'hard', config: {} }]
    })
    const evCount = a4.controller.submitCandidate(makeEvidence({ artifacts: [{ kind: 'novel', path: 'a.md', hash: 'h1' }, { kind: 'novel', path: 'b.md', hash: 'h2' }] }))
    check('COMP-ARTIFACT-01 minCount=2 且 2 个同 kind → completed（按 kind 计数）', evCount.state === 'completed', `state=${evCount.state}`)
  }

  // ==================== COMP-LINT-01 ====================
  console.log('\n[COMP-LINT-01] RenPy lint 契约：未运行 / 失败 / 通过 / 软门')
  {
    const mk = () => makeController({ validators: [{ id: 'renpyLint', severity: 'hard', config: {} }] })
    const evNoLint = mk().controller.submitCandidate(makeEvidence({ artifacts: [{ kind: 'renpy', path: 'a.rpy', hash: 'h1' }] }))
    check('COMP-LINT-01 lint 缺失 → hard lint_not_run + validating', evNoLint.state === 'validating' && evNoLint.hardFailures.length === 1 && evNoLint.hardFailures[0].code === 'lint_not_run', JSON.stringify(evNoLint.hardFailures))
    const evFail = mk().controller.submitCandidate(makeEvidence({ artifacts: [{ kind: 'renpy', path: 'a.rpy', hash: 'h1' }], renpyLint: { ok: false, errorCount: 2, warningCount: 1, output: 'E001 undefined label' } }))
    check('COMP-LINT-01 ok=false errorCount=2 → hard lint_failed + validating', evFail.state === 'validating' && evFail.hardFailures[0]?.code === 'lint_failed', JSON.stringify(evFail.hardFailures))
    const evOk = mk().controller.submitCandidate(makeEvidence({ artifacts: [{ kind: 'renpy', path: 'a.rpy', hash: 'h1' }], renpyLint: { ok: true, errorCount: 0, warningCount: 0, output: 'lint clean' } }))
    check('COMP-LINT-01 ok=true → completed 且无 hard 失败', evOk.state === 'completed' && evOk.hardFailures.length === 0, `state=${evOk.state}`)
    const cSoft = makeController({ validators: [{ id: 'renpyLint', severity: 'soft', config: {} }] })
    const evSoft = cSoft.controller.submitCandidate(makeEvidence({ artifacts: [{ kind: 'renpy', path: 'a.rpy', hash: 'h1' }], renpyLint: { ok: false, errorCount: 1, warningCount: 0, output: 'x' } }))
    check('COMP-LINT-01 软门 lint（soft）不阻断：completed + softWarnings lint_failed', evSoft.state === 'completed' && evSoft.softWarnings.some((f) => f.code === 'lint_failed'), JSON.stringify(evSoft.softWarnings))
  }

  // ==================== COMP-NO-PROGRESS-01 ====================
  console.log('\n[COMP-NO-PROGRESS-01] 单调性：同一 finding hash 连续两轮无改善 → no_progress；修复次数上限 → max_repair_attempts')
  {
    const mk = () => makeController({ targetChars: { min: 10000, tolerance: 0.05 }, validators: [TARGET_GATE] })
    const c1 = mk()
    const ev1 = c1.controller.submitCandidate(makeEvidence({ measuredChars: 8000, artifacts: [{ kind: 'novel', path: 'out/novel.md', hash: 'h-art-1' }] }))
    check('COMP-NO-PROGRESS-01 首轮 submit 欠字数 → validating', ev1.state === 'validating', `state=${ev1.state}`)
    const cont1 = c1.controller.requestContinuation()
    check('COMP-NO-PROGRESS-01 首轮 requestContinuation → continuing 且 nextAttempt（focus=失败 code，evidenceRefs=artifact hash）', cont1.state === 'continuing' && cont1.nextAttempt !== undefined && cont1.nextAttempt.focus.includes('below_target') && cont1.nextAttempt.evidenceRefs.includes('h-art-1'), JSON.stringify(cont1.nextAttempt))
    c1.controller.submitCandidate(makeEvidence({ measuredChars: 8000, artifacts: [{ kind: 'novel', path: 'out/novel.md', hash: 'h-art-1' }] }))
    const cont2 = c1.controller.requestContinuation()
    check('COMP-NO-PROGRESS-01 同一 finding hash 连续两轮无改善 → pause_user（waiting_user，等用户决策）', cont2.state === 'waiting_user' && cont2.blockedReason === 'no_progress', `state=${cont2.state} reason=${cont2.blockedReason ?? ''}`)
    check('COMP-NO-PROGRESS-01 pause 仍带结构化 remainingWork（below_target）', cont2.remainingWork.length === 1 && cont2.remainingWork[0].code === 'below_target', JSON.stringify(cont2.remainingWork))
    const c2 = makeController({ targetChars: { min: 10000, tolerance: 0.05 }, maxRepairAttempts: 2, validators: [TARGET_GATE] })
    c2.controller.submitCandidate(makeEvidence({ measuredChars: 8000 }))
    const r1 = c2.controller.requestContinuation()
    c2.controller.submitCandidate(makeEvidence({ measuredChars: 8000 }))
    const r2 = c2.controller.requestContinuation()
    check('COMP-NO-PROGRESS-01 maxRepairAttempts=2 第三轮续作 → pause_user max_repair_attempts', r1.state === 'continuing' && r2.state === 'waiting_user' && r2.blockedReason === 'max_repair_attempts', `r1=${r1.state} r2=${r2.state} reason=${r2.blockedReason ?? ''}`)
    const r3 = c2.controller.requestContinuation()
    check('COMP-NO-PROGRESS-01 blocked 后再次 requestContinuation → blocked not_validating', r3.state === 'blocked' && r3.blockedReason === 'not_validating', `reason=${r3.blockedReason ?? ''}`)
  }

  // ==================== COMP-BUDGET-01 ====================
  console.log('\n[COMP-BUDGET-01] 预算：墙钟超限 / token 成本超限 → blocked budget_exhausted')
  {
    // 墙钟：now 可注入（可变时间轴：第一次 reqCont 0ms，第二次 2000ms）
    let fakeNow = 0
    const c1 = makeController({ targetChars: { min: 10000, tolerance: 0.05 }, wallClockBudgetMs: 1000, validators: [TARGET_GATE] }, () => fakeNow)
    c1.controller.submitCandidate(makeEvidence({ measuredChars: 8000 }))
    const w1 = c1.controller.requestContinuation()
    fakeNow = 2000
    const w2 = c1.controller.requestContinuation()
    check('COMP-BUDGET-01 墙钟未超限（0ms）→ continuing；超限（2000ms>1000ms）→ pause_user budget_exhausted', w1.state === 'continuing' && w2.state === 'waiting_user' && w2.blockedReason === 'budget_exhausted', `w1=${w1.state} w2=${w2.state} reason=${w2.blockedReason ?? ''}`)
    // token：新增 artifact hash × 1000 作为成本近似
    const c2 = makeController({ targetChars: { min: 10000, tolerance: 0.05 }, tokenBudget: 1500, validators: [TARGET_GATE] })
    c2.controller.submitCandidate(makeEvidence({ measuredChars: 8000, artifacts: [{ kind: 'novel', path: 'a.md', hash: 'h-a' }, { kind: 'novel', path: 'b.md', hash: 'h-b' }] }))
    const t1 = c2.controller.requestContinuation()
    check('COMP-BUDGET-01 token 成本 2×1000=2000 > 预算 1500 → pause_user budget_exhausted', t1.state === 'waiting_user' && t1.blockedReason === 'budget_exhausted', `state=${t1.state} reason=${t1.blockedReason ?? ''}`)
    const c3 = makeController({ targetChars: { min: 10000, tolerance: 0.05 }, tokenBudget: 3000, validators: [TARGET_GATE] })
    c3.controller.submitCandidate(makeEvidence({ measuredChars: 8000, artifacts: [{ kind: 'novel', path: 'a.md', hash: 'h-a' }, { kind: 'novel', path: 'b.md', hash: 'h-b' }] }))
    const t2 = c3.controller.requestContinuation()
    check('COMP-BUDGET-01 token 成本 2000 ≤ 预算 3000 → continuing', t2.state === 'continuing', `state=${t2.state}`)
    const c4 = makeController({ targetChars: { min: 10000, tolerance: 0.05 }, tokenBudget: 2500, validators: [TARGET_GATE] })
    c4.controller.submitCandidate(makeEvidence({ measuredChars: 8000, artifacts: [{ kind: 'novel', path: 'a.md', hash: 'h-a' }, { kind: 'novel', path: 'b.md', hash: 'h-b' }] }))
    c4.controller.submitCandidate(makeEvidence({ measuredChars: 8500, artifacts: [{ kind: 'novel', path: 'a.md', hash: 'h-a' }, { kind: 'novel', path: 'b.md', hash: 'h-b' }] }))
    const t3 = c4.controller.requestContinuation()
    check('COMP-BUDGET-01 相同 artifact hash 不重复计费（成本 2000 ≤ 预算 2500 → continuing）', t3.state === 'continuing', `state=${t3.state}`)
  }

  // ==================== COMP-CANCEL-01 ====================
  console.log('\n[COMP-CANCEL-01] 用户停止优先：cancel → cancelled，取消后提交被拒（不复活 run）')
  {
    const c1 = makeController({ targetChars: { min: 10000, tolerance: 0.05 }, validators: [TARGET_GATE] })
    c1.controller.submitCandidate(makeEvidence({ measuredChars: 8000 }))
    const cv = c1.controller.cancel('用户停止')
    check('COMP-CANCEL-01 validating 中 cancel → cancelled（用户停止优先于"不达字数不停止"）', cv.state === 'cancelled', `state=${cv.state}`)
    const afterCancel = c1.controller.submitCandidate(makeEvidence({ measuredChars: 10000 }))
    check('COMP-CANCEL-01 cancel 后 submitCandidate 返回 blocked（已取消，即使字数已达标也不复活）', afterCancel.state === 'blocked' && afterCancel.blockedReason === 'cancelled', `state=${afterCancel.state} reason=${afterCancel.blockedReason ?? ''}`)
    const c2 = makeController({ validators: [] })
    const cv2 = c2.controller.cancel()
    check('COMP-CANCEL-01 未提交即 cancel → cancelled（默认 reason=user_cancelled）', cv2.state === 'cancelled' && cv2.blockedReason === 'user_cancelled', JSON.stringify(cv2))
  }

  // ==================== COMP-DURABLE-01 ====================
  console.log('\n[COMP-DURABLE-01] 评估先落库再对外：每次调用 saveEvaluation + revision 单调递增 + getLatest 最新')
  {
    const c = makeController({ targetChars: { min: 10000, tolerance: 0.05 }, validators: [TARGET_GATE] })
    check('COMP-DURABLE-01 初始 getLatest → null（尚无评估）', c.controller.getLatest() === null, '')
    const s1 = c.controller.submitCandidate(makeEvidence({ measuredChars: 8000 }))
    const cc1 = c.controller.requestContinuation()
    const s2 = c.controller.submitCandidate(makeEvidence({ measuredChars: 8000 }))
    const cc2 = c.controller.requestContinuation()
    check('COMP-DURABLE-01 每次 submit/requestContinuation 均落库（save 计数 = 4）', c.store.count === 4, `count=${c.store.count}`)
    check('COMP-DURABLE-01 revision 单调递增（1,2,3,4）', [s1.revision, cc1.revision, s2.revision, cc2.revision].join(',') === '1,2,3,4', [s1.revision, cc1.revision, s2.revision, cc2.revision].join(','))
    check('COMP-DURABLE-01 getLatest 与 store 均返回最新评估（与返回值同一引用，先落库再对外）', c.controller.getLatest() === cc2 && c.store.getLatestEvaluation(c.runId) === cc2, '')
  }


  // ==================== R4.3 补：COMP-CRASH-01（强杀恢复：durable revision 不重复、单调性水位保持） ====================
  console.log('\n[COMP-CRASH-01] validating 中强杀 → 从 durable evaluation 恢复 → revision 继续且不重复副作用')
  {
    const crashStore = (() => {
      let evs: CompletionEvaluation[] = []
      return {
        saveEvaluation: (r: string, ev: CompletionEvaluation) => { evs.push(ev) },
        getLatestEvaluation: () => (evs.length ? evs[evs.length - 1] : null),
        _count: () => evs.length
      }
    })()
    const crashContract = {
      schemaVersion: 1,
      runId: 'run-crash',
      targetChars: { min: 10000, tolerance: 0.05 },
      validators: [{ id: 'targetChars', severity: 'hard', config: {} }],
      maxRepairAttempts: 3,
      createdAt: Date.now()
    }
    // 阶段 1：8000 字 → validating（revision 1 落库）
    const a = new CompletionController({ contract: crashContract, store: crashStore })
    const ev1 = a.submitCandidate({ measuredChars: 8000, artifacts: [], pendingToolCount: 0, pendingToolNames: [] })
    check('COMP-CRASH-01 强杀前 evaluation 已 durable 落库（revision 1）', crashStore._count() === 1 && ev1.revision === 1 && ev1.state === 'validating', JSON.stringify(ev1))
    // 阶段 2：进程强杀 = 丢弃 controller 实例；重启 = fromStore 恢复
    const b = CompletionController.fromStore({ contract: crashContract, store: crashStore }, crashStore.getLatestEvaluation())
    check('COMP-CRASH-01 恢复后 revision 从 1 继续（不重复计轮）', b.getRevision() === 1, 'rev=' + b.getRevision())
    const ev2 = b.submitCandidate({ measuredChars: 9000, artifacts: [], pendingToolCount: 0, pendingToolNames: [] })
    check('COMP-CRASH-01 恢复后提交 revision 递增为 2（不重复副作用/不重复审计）', ev2.revision === 2 && crashStore._count() === 2, JSON.stringify(ev2))
    const cont = b.requestContinuation()
    check('COMP-CRASH-01 恢复后单调性水位保持（9000 较 8000 有改善 → continuing 非 no_progress）', cont.state === 'continuing', JSON.stringify(cont))
    // 阶段 3：再次"强杀"后无进展 → blocked（prevFailures 跨重启保持）
    const c = CompletionController.fromStore({ contract: crashContract, store: crashStore }, crashStore.getLatestEvaluation())
    c.submitCandidate({ measuredChars: 9000, artifacts: [], pendingToolCount: 0, pendingToolNames: [] })
    const cont2 = c.requestContinuation()
    check('COMP-CRASH-01 跨重启单调性：同值第二次提交 → pause_user(no_progress)（不无限循环）', cont2.state === 'waiting_user', JSON.stringify(cont2))
    // 强杀恢复不执行任何工具（无副作用）：fromStore 只是装载（断言无 artifacts/无额外提交）
    const d = CompletionController.fromStore({ contract: crashContract, store: crashStore }, crashStore.getLatestEvaluation())
    check('COMP-CRASH-01 fromStore 恢复是纯装载（不触发任何工具/提交）', d.getRevision() === crashStore.getLatestEvaluation()?.revision, '')
  }

  console.log(`\n===== R4.3 Gate 4 完成契约：${passed} PASS / ${failed} FAIL =====`)
  if (failed > 0) {
    console.log('失败明细：')
    for (const f of failures) {
      console.log(`  - ${f}`)
    }
  }
  process.exit(failed > 0 ? 1 : 0)
}

main()
