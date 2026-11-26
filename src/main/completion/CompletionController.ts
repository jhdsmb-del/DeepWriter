// ==================== R4.3 Gate 4：外部可验证完成契约控制器 ====================
// - completed 只能由外部可验证完成契约产生（submitCandidate 全 hard 通过）；
// - 模型自述"已完成"没有任何权限——本模块不读任何自然语言，也没有 setCompleted 类接口；
// - submitCandidate：revision 递增（从 1 起），跑 contract.validators 分发的全部校验，
//   只允许进入 validating / completed，绝不直接置 completed；
// - requestContinuation：单调性检测（同一 finding hash 连续两轮无改善 → no_progress）、
//   修复次数上限（maxRepairAttempts）、墙钟/token 预算（budget_exhausted）；
// - cancel：用户停止优先，任何状态可取消，不得被"不达字数不停止"覆盖；
// - 所有 evaluation 先 store.saveEvaluation 落库再对外返回。

import { validateTargetChars } from './validators/targetLength'
import { validateRequiredArtifacts } from './validators/requiredArtifacts'
import { validateNoPendingTools } from './validators/noPendingTools'
import { validateRenpyLint } from './validators/renpyLint'
import { validateFileEvidence } from './validators/fileEvidence'
import { validateStrongConstraints } from './validators/strongConstraints'
import { decideContinuation, type ContinuationDecision, type ContinuationPolicyInput } from './ContinuationPolicy'
import type {
  CompletionContract,
  CompletionEvaluation,
  CompletionEvidence,
  CompletionState,
  CompletionStore,
  Finding
} from './types'

export interface CompletionControllerOpts {
  contract: CompletionContract
  store: CompletionStore
  now?: () => number
}

/** 每次 submitCandidate 中"新增 artifact hash"的 token 成本近似 */
const COST_PER_NEW_ARTIFACT_HASH = 1000

/** 两个 finding 集合的 hash 集合是否完全一致（单调性判定依据） */
function sameHashSet(a: Finding[], b: Finding[]): boolean {
  const ha = new Set(a.map((f) => f.hash))
  const hb = new Set(b.map((f) => f.hash))
  if (ha.size !== hb.size) {
    return false
  }
  for (const h of ha) {
    if (!hb.has(h)) {
      return false
    }
  }
  return true
}

export class CompletionController {
  readonly #contract: CompletionContract
  readonly #store: CompletionStore
  readonly #now: () => number
  /** 墙钟预算起点：R4.5 Gate 3 权威值为 contract.createdAt（重启不刷新；不再用最近评估时间） */
  #startTime: number
  #state: CompletionState = 'planning'
  #revision = 0
  #lastEvaluation: CompletionEvaluation | null = null
  /** 上一轮 hard 失败集合（submitCandidate / 续作时滚动） */
  #prevFailures: Finding[] = []
  /** 当前 hard 失败集合 */
  #curFailures: Finding[] = []
  /** 失败候选次数（进入 validating 的 submitCandidate 计数）——R4.5 精确字段，不从 revision 推导 */
  #repairAttempts = 0
  /** token 预算累计成本：新增 artifact hash 数 × COST_PER_NEW_ARTIFACT_HASH */
  #accumulatedCost = 0
  readonly #seenArtifactHashes = new Set<string>()
  #lastEvidence: CompletionEvidence | null = null
  /** R4.5 Gate 3：上一轮实测字数（delta 基准） */
  #prevMeasured: number | null = null
  /** R4.5 Gate 3：最近一轮实测字数增量（进展水位；finding identity 与测量值分离） */
  #lastDeltaChars: number | null = null
  /** R4.5 Gate 4：连续低进展轮数（delta < 阈值 且 finding 未变时累计；供 ContinuationPolicy） */
  #lowProgressRounds = 0

  constructor(opts: CompletionControllerOpts) {
    this.#contract = opts.contract
    this.#store = opts.store
    this.#now = opts.now ?? Date.now
    // R4.5 Gate 3：墙钟起点 = contract.createdAt（权威；缺省回退构造时间）
    this.#startTime = typeof opts.contract.createdAt === 'number' ? opts.contract.createdAt : this.#now()
  }

  /**
   * R4.3 补（COMP-CRASH-01）：从 durable 评估恢复控制器状态（进程强杀/重启后不丢 revision 与
   * 单调性水位，不重复副作用——恢复只是装载状态，不重跑任何工具）。
   * latest 为 store 中最新 evaluation（getLatestEvaluation）；缺失时等同新实例。
   * R4.5 Gate 3（复审 S-01）：逐字段恢复——repairAttempts 从 durable 精确字段恢复（禁止
   * repairAttempts=revision 推导）；startedAt 用 contract.createdAt（权威起点，重启不刷新）；
   * 旧格式 evaluation（缺新字段）走明确迁移规则：attempts 从零算（历史无法审计）、起点用
   * 契约时间——绝不静默猜；迁移后重写一条新格式记录落库（同 revision 覆盖，主键不变）。
   */
  static fromStore(opts: CompletionControllerOpts, latest: CompletionEvaluation | null): CompletionController {
    const c = new CompletionController(opts)
    if (latest) {
      c.#revision = latest.revision
      c.#state = latest.state
      c.#lastEvaluation = latest
      c.#prevFailures = latest.hardFailures
      c.#curFailures = latest.hardFailures
      // R4.5 Gate 3：新格式逐字段恢复；旧格式（无 repairAttempts 字段）按明确迁移规则：
      // attempts=0（历史失败候选无法从 revision 可靠推导——validating/continuing 混在同一序列），
      // startedAt=contract.createdAt（权威起点）
      const isNewFormat = typeof latest.repairAttempts === 'number'
      c.#repairAttempts = isNewFormat ? (latest.repairAttempts as number) : 0
      c.#lastDeltaChars = isNewFormat && typeof latest.lastDeltaChars === 'number' ? (latest.lastDeltaChars as number) : null
      c.#prevMeasured = isNewFormat && typeof latest.latestMeasuredChars === 'number' ? (latest.latestMeasuredChars as number) : (latest.measuredChars ?? null)
      // token 成本从评估 artifactHashes 恢复（防重复计费；旧格式缺字段防御）
      for (const h of latest.artifactHashes ?? []) c.#seenArtifactHashes.add(h)
      if (latest.measuredChars !== null && c.#lastEvidence === null) {
        c.#lastEvidence = { measuredChars: latest.measuredChars, artifacts: [], pendingToolCount: 0, pendingToolNames: [] }
      }
      // R4.5 Gate 3：墙钟起点固定为 contract.createdAt（旧实现用 latest.createdAt 会被重启刷新——修复）
      c.#startTime = typeof opts.contract.createdAt === 'number' ? opts.contract.createdAt : c.#now()
      if (!isNewFormat) {
        // 迁移重写：以同 revision 落一条新格式记录（明确的迁移决策；主键 (run_id, revision) 覆盖）
        const migrated: CompletionEvaluation = {
          ...latest,
          repairAttempts: c.#repairAttempts,
          startedAt: c.#startTime,
          previousFindingKeys: latest.hardFailures.map((f) => f.hash),
          currentFindingKeys: latest.hardFailures.map((f) => f.hash),
          latestMeasuredChars: latest.measuredChars,
          lastDeltaChars: null
        }
        opts.store.saveEvaluation(opts.contract.runId, migrated)
      }
    }
    return c
  }

  /** R4.3 补：当前 revision（跨重启一致性验证用） */
  getRevision(): number {
    return this.#revision
  }

  /** R4.5 Gate 3：当前墙钟预算起点（contract.createdAt 权威值；测试验证不随重启刷新） */
  getStartTime(): number {
    return this.#startTime
  }

  /** R4.4 Gate 2：当前累计 token 成本（真实 usage 汇总由 engine 注入，见 setAccumulatedCost） */
  getAccumulatedCost(): number {
    return this.#accumulatedCost
  }

  setAccumulatedCost(cost: number): void {
    this.#accumulatedCost = cost
  }

  /**
   * R47：用户明确扩展预算后，从 waiting_user 重新进入一次 continuation
   * 决策。不能把同一份已落盘候选再次 submitCandidate——那会得到 0 增量，
   * 被 no_progress 误判为再次暂停。清除上一轮进展水位只影响这次显式
   * 用户授权的恢复，不会改写正文或累计用量。
   */
  resumeAfterUserDecision(): CompletionEvaluation {
    if (this.#state !== 'waiting_user') {
      return this.#emitBlocked('not_waiting_user', `run 当前状态 ${this.#state}，不需要用户恢复`, false)
    }
    this.#state = 'validating'
    this.#lastDeltaChars = null
    this.#lowProgressRounds = 0
    return this.requestContinuation()
  }

  /** 模型提交候选完成：只允许进入 validating；绝不直接把 run 置 completed */
  submitCandidate(evidence: CompletionEvidence): CompletionEvaluation {
    this.#revision += 1
    if (this.#state === 'cancelled') {
      return this.#emitBlocked('cancelled', 'run 已取消，不再接受候选提交', true)
    }
    if (this.#state === 'completed' || this.#state === 'blocked') {
      return this.#emitBlocked('run_not_active', `run 当前状态 ${this.#state}，不再接受候选提交`, true)
    }

    // token 预算成本：本轮 evidence 中"新增"的 artifact hash 数 × 1000（重复提交不重复计费）
    const newHashes = evidence.artifacts.filter((a) => !this.#seenArtifactHashes.has(a.hash)).map((a) => a.hash)
    for (const h of newHashes) {
      this.#seenArtifactHashes.add(h)
    }
    this.#accumulatedCost += newHashes.length * COST_PER_NEW_ARTIFACT_HASH
    // R4.5 Gate 3：进展水位——delta 单独记录（finding identity 稳定时低增长不误判无进展）
    const measured = evidence.measuredChars ?? null
    if (measured !== null && this.#prevMeasured !== null) {
      this.#lastDeltaChars = measured - this.#prevMeasured
    } else {
      this.#lastDeltaChars = null
    }
    if (measured !== null) this.#prevMeasured = measured
    this.#lastEvidence = evidence

    const findings = this.#runValidators(evidence)
    if (typeof evidence.repetitionRatio === 'number' && evidence.repetitionRatio >= 0.85) {
      findings.push({
        id: 'contentQuality',
        severity: 'hard',
        code: 'repetition_high',
        message: '最新续写与已有正文高度重复，不能用重复内容凑足目标篇幅',
        hash: 'contentQuality:repetition_high'
      })
    }
    const hardFailures = findings.filter((f) => f.severity === 'hard')
    const softWarnings = findings.filter((f) => f.severity === 'soft')
    this.#prevFailures = this.#curFailures
    this.#curFailures = hardFailures

    const state: CompletionState = hardFailures.length === 0 ? 'completed' : 'validating'
    if (state === 'validating') {
      this.#repairAttempts += 1
    }
    this.#state = state

    // R4.5 Gate 4：低进展水位——delta 低于阈值 且 finding 集合未变 → 累计；改善/达标 → 清零
    const setChanged = !sameHashSet(this.#prevFailures, this.#curFailures)
    if (this.#lastDeltaChars !== null && this.#lastDeltaChars < 200 && !setChanged) {
      this.#lowProgressRounds += 1
    } else {
      this.#lowProgressRounds = 0
    }

    const ev: CompletionEvaluation = {
      revision: this.#revision,
      state,
      hardFailures,
      softWarnings,
      measuredChars: evidence.measuredChars ?? null,
      artifactHashes: evidence.artifacts.map((a) => a.hash),
      remainingWork: hardFailures.map((f) => ({ code: f.code, message: f.message, hash: f.hash })),
      // R4.5 Gate 3：durable 精确恢复字段
      repairAttempts: this.#repairAttempts,
      startedAt: this.#startTime,
      previousFindingKeys: this.#prevFailures.map((f) => f.hash),
      currentFindingKeys: this.#curFailures.map((f) => f.hash),
      latestMeasuredChars: evidence.measuredChars ?? null,
      lastDeltaChars: this.#lastDeltaChars
    }
    return this.#commit(ev)
  }

  /**
   * 已提交未完成的自动续作：由 ContinuationPolicy 决策 continue / pause_user / blocked / cancelled。
   * R4.5 Gate 4（复审 B-03）：预算耗尽、达修复上限、零增长、低进展 → pause_user（waiting_user 状态，
   * 用户选择增加预算/降低目标/停止）——不再直接 blocked/failed，也不伪 completed。
   * input.repetitionRatio / effectiveDeltaChars 由 engine 计算（重复率/有效新内容；未知传 0/null）。
   */
  requestContinuation(input: { repetitionRatio?: number; effectiveDeltaChars?: number } = {}): CompletionEvaluation {
    this.#revision += 1
    if (this.#state !== 'validating') {
      return this.#emitBlocked('not_validating', `requestContinuation 仅在 validating 可用（当前 ${this.#state}）`, false)
    }
    const decision: ContinuationDecision = decideContinuation({
      measuredChars: this.#lastEvidence?.measuredChars ?? null,
      lastDeltaChars: this.#lastDeltaChars,
      findingSetChanged: !sameHashSet(this.#prevFailures, this.#curFailures),
      lowProgressRounds: this.#lowProgressRounds,
      repetitionRatio: input.repetitionRatio ?? 0,
      effectiveDeltaChars: input.effectiveDeltaChars ?? this.#lastDeltaChars,
      usageTokens: this.#accumulatedCost,
      tokenBudget: this.#contract.tokenBudget,
      elapsedMs: this.#now() - this.#startTime,
      wallClockBudgetMs: this.#contract.wallClockBudgetMs,
      repairAttempts: this.#repairAttempts,
      maxRepairAttempts: this.#contract.maxRepairAttempts ?? 3,
      pendingToolCount: this.#lastEvidence?.pendingToolCount ?? 0,
      cancelled: false
    })
    if (decision.decision === 'pause_user') {
      this.#state = 'waiting_user'
      const ev: CompletionEvaluation = {
        revision: this.#revision,
        state: 'waiting_user',
        hardFailures: this.#curFailures,
        softWarnings: [],
        measuredChars: this.#lastEvidence?.measuredChars ?? null,
        artifactHashes: this.#lastEvidence?.artifacts.map((a) => a.hash) ?? [],
        remainingWork: this.#curFailures.map((f) => ({ code: f.code, message: f.message, hash: f.hash })),
        blockedReason: decision.reason,
        pausedMessage: decision.message,
        repairAttempts: this.#repairAttempts,
        startedAt: this.#startTime,
        previousFindingKeys: this.#prevFailures.map((f) => f.hash),
        currentFindingKeys: this.#curFailures.map((f) => f.hash),
        latestMeasuredChars: this.#lastEvidence?.measuredChars ?? null,
        lastDeltaChars: this.#lastDeltaChars
      }
      return this.#commit(ev)
    }
    if (decision.decision === 'cancelled') {
      return this.cancel()
    }
    if (decision.decision === 'blocked') {
      return this.#emitBlocked(decision.reason, decision.message, true)
    }

    const ev: CompletionEvaluation = {
      revision: this.#revision,
      state: 'continuing',
      hardFailures: this.#curFailures,
      softWarnings: [],
      measuredChars: this.#lastEvidence?.measuredChars ?? null,
      artifactHashes: this.#lastEvidence?.artifacts.map((a) => a.hash) ?? [],
      remainingWork: this.#curFailures.map((f) => ({ code: f.code, message: f.message, hash: f.hash })),
      nextAttempt: {
        focus: [...new Set(this.#curFailures.map((f) => f.code))],
        evidenceRefs: this.#lastEvidence?.artifacts.map((a) => a.hash) ?? []
      },
      // R4.5 Gate 3：durable 精确恢复字段
      repairAttempts: this.#repairAttempts,
      startedAt: this.#startTime,
      previousFindingKeys: this.#prevFailures.map((f) => f.hash),
      currentFindingKeys: this.#curFailures.map((f) => f.hash),
      latestMeasuredChars: this.#lastEvidence?.measuredChars ?? null,
      lastDeltaChars: this.#lastDeltaChars
    }
    // 续作也算一轮：滚动上一轮失败集合（防止无新证据的重复续作被误判为进展）
    this.#prevFailures = this.#curFailures
    return this.#commit(ev)
  }

  /** 用户停止优先：任何状态可取消；不得被"不达字数不停止"覆盖 */
  cancel(reason?: string): CompletionEvaluation {
    this.#revision += 1
    this.#state = 'cancelled'
    const ev: CompletionEvaluation = {
      revision: this.#revision,
      state: 'cancelled',
      hardFailures: this.#curFailures,
      softWarnings: [],
      measuredChars: this.#lastEvidence?.measuredChars ?? null,
      artifactHashes: this.#lastEvidence?.artifacts.map((a) => a.hash) ?? [],
      remainingWork: [],
      blockedReason: reason ?? 'user_cancelled',
      // R4.5 Gate 3：durable 精确恢复字段
      repairAttempts: this.#repairAttempts,
      startedAt: this.#startTime,
      previousFindingKeys: this.#prevFailures.map((f) => f.hash),
      currentFindingKeys: this.#curFailures.map((f) => f.hash),
      latestMeasuredChars: this.#lastEvidence?.measuredChars ?? null,
      lastDeltaChars: this.#lastDeltaChars
    }
    return this.#commit(ev)
  }

  getLatest(): CompletionEvaluation | null {
    return this.#lastEvaluation
  }

  // ---------- 内部 ----------

  /** 按 contract.validators 的 id 分发到四个校验函数；severity 以契约为准（软门不阻断） */
  #runValidators(evidence: CompletionEvidence): Finding[] {
    const findings: Finding[] = []
    for (const v of this.#contract.validators) {
      let fs: Finding[] = []
      switch (v.id) {
        case 'targetChars': {
          const cfg = { ...(this.#contract.targetChars ?? {}), ...(v.config ?? {}) }
          fs = validateTargetChars(cfg as unknown as { min: number; max?: number; tolerance: number }, evidence.measuredChars)
          break
        }
        case 'requiredArtifacts':
          fs = validateRequiredArtifacts(this.#contract.requiredArtifacts ?? [], evidence)
          break
        case 'noPendingTools':
          fs = validateNoPendingTools(evidence)
          break
        case 'renpyLint':
          fs = validateRenpyLint(evidence)
          break
        case 'fileEvidence':
          fs = validateFileEvidence(this.#contract.requiredFiles ?? [], evidence)
          break
        case 'strongConstraints':
          fs = validateStrongConstraints(v.config ?? {}, evidence)
          break
        default:
          fs = [{ id: String(v.id), severity: 'hard', code: 'unknown_validator', message: `未知完成校验器：${String(v.id)}`, hash: `unknown_validator:${String(v.id)}` }]
          break
      }
      for (const f of fs) {
        // 未知 validator 代表当前程序不理解冻结契约，不能被 future/损坏配置
        // 伪装成 soft 后绕过；必须无条件 fail-closed。
        if (f.code !== 'unknown_validator') f.severity = v.severity
      }
      findings.push(...fs)
    }
    return findings
  }

  /** 生成 blocked evaluation（内部状态切换 + 先落库再返回） */
  #emitBlocked(reason: string, _message: string, flipToBlocked: boolean): CompletionEvaluation {
    if (flipToBlocked) {
      this.#state = 'blocked'
    }
    const ev: CompletionEvaluation = {
      revision: this.#revision,
      state: 'blocked',
      hardFailures: this.#curFailures,
      softWarnings: [],
      measuredChars: this.#lastEvidence?.measuredChars ?? null,
      artifactHashes: this.#lastEvidence?.artifacts.map((a) => a.hash) ?? [],
      remainingWork: this.#curFailures.map((f) => ({ code: f.code, message: f.message, hash: f.hash })),
      blockedReason: reason,
      // R4.5 Gate 3：durable 精确恢复字段
      repairAttempts: this.#repairAttempts,
      startedAt: this.#startTime,
      previousFindingKeys: this.#prevFailures.map((f) => f.hash),
      currentFindingKeys: this.#curFailures.map((f) => f.hash),
      latestMeasuredChars: this.#lastEvidence?.measuredChars ?? null,
      lastDeltaChars: this.#lastDeltaChars
    }
    return this.#commit(ev)
  }

  /** 评估先落库（store.saveEvaluation）再对外返回（同一引用） */
  #commit(ev: CompletionEvaluation): CompletionEvaluation {
    const stamped: CompletionEvaluation = { ...ev, createdAt: this.#now() }
    this.#lastEvaluation = stamped
    this.#store.saveEvaluation(this.#contract.runId, stamped)
    return stamped
  }
}
