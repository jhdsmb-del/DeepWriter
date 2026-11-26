// ==================== R4.3 Gate 5 实验编排 → R4.6 Gate 2 多人物深度写作主链 ====================
// 纯 Node 模块（不 import electron）：一次场景的多人物编排（模型调用注入，测试用 mock）。
//
// 流程：Scene Router（importance 评分）→ tokenGovernor 截断（预算不足降活跃角色数）
//       → 对活跃角色并发 runCustodian（并发上限真实作用于在途 Promise）→ directScene 仲裁
//       → 唯一 DraftWriter 写正文（writerCall 恰好一次；监护者绝不产正文）→
//       Continuity Arbiter 校验 → 正文产出成功后原子提交场景角色状态（幂等 commitId）。
//
// R4.6 技术约束：
// - 输入为角色卡集合（cards），不再用单个 card 假装并发；
// - 角色 ID 是稳定主键（name 仅展示）；
// - 每个监护调用有独立 correlationId + usage + 错误结果；
// - 并发上限（maxConcurrent）作用于在途 Promise（worker pool，非仅截断数组）；
// - signal 取消：不再启动新监护、在途调用 abort（call 透传 signal）、取消后 usage 不入账、
//   不写状态；
// - 幂等提交：commitId 已存在 → 不重复提交（恢复语义）；
// - 角色卡原文不泄露：结果只含 characterId/摘要（bible 不进结果/日志）。

import { runCustodian } from './characterCustodian'
import { directScene } from './director'
import { checkCharacterKnowledge, checkVoice } from './continuityArbiter'
import { createGovernorOpts, decideGovernor, type TokenGovernorOpts } from './tokenGovernor'
import { routeActiveCharacters } from './sceneRouter'
import type { CharacterStateStore, SceneCharacterState } from './stateStore'
import type { CharacterAdvice, CharacterCard, CharacterModelCall, ContinuityFinding, SceneBrief, ScenePacket } from './types'

/** 编排依赖注入：模型调用（监护者）+ 主笔调用 + packet→主笔 prompt 渲染 */
export interface DeepWriteDeps {
  call: CharacterModelCall
  writerCall: (prompt: string, signal?: AbortSignal) => Promise<string>
  renderDraft: (packet: ScenePacket) => string   // 把 packet 渲染为主笔 prompt（含角色建议摘要，不含整书）
}

/** 单个监护调用的独立结果（correlationId/usage/错误） */
export interface CharacterCustodianRun {
  characterId: string
  correlationId: string
  ok: boolean
  advice: CharacterAdvice | null
  usage: { inputTokens: number; outputTokens: number } | null
  error: string | null
}

/** 场景级状态提交结果（幂等） */
export interface SceneCommitResult {
  commitId: string
  alreadyCommitted: boolean
  stateVersion: number
  stateCount: number
}

/** 监护阶段结果（主链 hook 复用：只跑监护，正文由 engine 主模型产出——唯一 DraftWriter） */
export interface CustodianPhaseResult {
  packet: ScenePacket
  advices: CharacterAdvice[]
  activeCharacterIds: string[]
  skippedCharacterIds: string[]
  perCharacterResults: CharacterCustodianRun[]
  degraded: boolean
  custodianFailures: number
}

export interface RunExperimentalSceneInput {
  /** 全部在场角色卡集合（不再单 card；稳定 ID 为主键） */
  cards: CharacterCard[]
  brief: SceneBrief
  recentSpans: string[]
  governor: TokenGovernorOpts
  projectedSubagentTokens: number
  writerInstructions: string[]
  /** 并发上限（默认 governor.maxConcurrent；真实作用于在途 Promise 的 worker pool） */
  maxConcurrent?: number
  /** 活跃角色数上限（Scene Router 选择层；默认=全量在场角色——预算充足全选，
   *  governor 预算不足时再降活跃数；与执行并发上限解耦） */
  activeCharacterLimit?: number
  /** 取消信号：不再启动新监护、在途调用 abort、取消后不写状态/不入账 */
  signal?: AbortSignal
  deps: DeepWriteDeps
  /** 幂等场景提交（正文产出成功后原子提交；commitId 已存在不重复提交） */
  commit?: {
    projectId: string
    sceneId: string
    commitId: string
    store: CharacterStateStore
  }
}

/** 一次实验场景的运行结果 */
export interface DeepWriteResult extends CustodianPhaseResult {
  draft: string | null
  findings: ContinuityFinding[]
  adviceCount: number
  sceneCommit: SceneCommitResult | null
}

const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e))

/** 并发 worker pool：limit 真实作用于在途 runCustodian Promise（非仅截断数组） */
async function runCustodiansWithLimit(
  cards: CharacterCard[],
  brief: SceneBrief,
  recentSpans: string[],
  call: CharacterModelCall,
  limit: number,
  signal?: AbortSignal
): Promise<CharacterCustodianRun[]> {
  const out: CharacterCustodianRun[] = []
  const queue = [...cards]
  const workers = Array.from({ length: Math.max(1, Math.min(limit, queue.length)) }, async () => {
    for (;;) {
      if (signal?.aborted) return // 取消：不再启动新监护
      const card = queue.shift()
      if (!card) return
      const correlationId = `cust-${brief.sceneId}-${card.id}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`
      const r = await runCustodian(card, brief, recentSpans, call, signal)
      out.push({
        characterId: card.id,
        correlationId,
        ok: r.advice !== null,
        advice: r.advice,
        usage: r.usage,
        error: r.advice === null ? (signal?.aborted ? 'aborted' : 'custodian_failed') : null
      })
    }
  })
  await Promise.all(workers)
  return out
}

/**
 * 监护阶段：Scene Router（importance）→ governor 截断 → 并发监护 → Director 仲裁。
 * 不调用 writerCall（主链场景正文由 engine 主模型产出；实验完整流程见 runExperimentalScene）。
 */
export async function runCustodianPhase(input: RunExperimentalSceneInput): Promise<CustodianPhaseResult> {
  const opts = createGovernorOpts(input.governor)
  const maxConcurrent = input.maxConcurrent ?? opts.maxConcurrent
  const activeLimit = input.activeCharacterLimit ?? input.cards.length

  // —— Scene Router：importance 评分（在场/beats 提及/近期状态；确定性）。
  // 选择层不做截断（maxActive=全量在场角色）——角色数量上限由 token governor 预算决策负责
  // （任务书：预算不足时降活跃角色数）；并发上限（maxConcurrent）只作用于执行层 worker pool。
  const routed = routeActiveCharacters({
    cards: input.cards,
    brief: input.brief,
    maxActive: input.cards.length
  })
  // governor 预算决策（与 usage ledger 一致：超 ratio 降活跃角色数）
  const present = routed.active.map((card) => {
    const score = routed.scores.find((s) => s.characterId === card.id)?.importance ?? 0
    return { characterId: card.id, importance: score }
  })
  // 角色选择上限与执行并发解耦：governor 用 activeLimit 做选择截断（预算不足再降级）
  const decision = decideGovernor({ ...opts, maxConcurrent: activeLimit }, present, input.projectedSubagentTokens)
  const activeCards = routed.active.filter((c) => decision.activeCharacterIds.includes(c.id))
  const skippedIds = [...new Set([...routed.skipped.map((c) => c.id), ...decision.skippedCharacterIds])]

  // —— 监护阶段（并发 worker pool，上限真实作用于在途调用）——
  const perCharacterResults = await runCustodiansWithLimit(activeCards, input.brief, input.recentSpans, input.deps.call, maxConcurrent, input.signal)
  const advices: CharacterAdvice[] = perCharacterResults.filter((r) => r.ok && r.advice).map((r) => r.advice as CharacterAdvice)
  const custodianFailures = perCharacterResults.filter((r) => !r.ok).length

  // —— 导演仲裁（同角色多建议按优先级+confidence 合并）——
  const packet = directScene(input.brief, advices, input.writerInstructions)

  const degraded = skippedIds.length > 0 || custodianFailures > 0
  return {
    packet,
    advices,
    activeCharacterIds: activeCards.map((c) => c.id),
    skippedCharacterIds: skippedIds,
    perCharacterResults,
    degraded,
    custodianFailures
  }
}

/**
 * 运行一次实验场景（完整流程）：监护阶段 → 唯一 DraftWriter 写正文 → Continuity Arbiter →
 * 正文产出成功后原子提交场景角色状态（幂等 commitId；取消/正文失败不提交）。
 */
export async function runExperimentalScene(input: RunExperimentalSceneInput): Promise<DeepWriteResult> {
  const phase = await runCustodianPhase(input)
  if (input.signal?.aborted) {
    return { ...phase, draft: null, findings: [], adviceCount: phase.advices.length, sceneCommit: null }
  }

  // —— 主笔阶段（唯一正文作者；监护者绝不产正文）——
  const writerPrompt = input.deps.renderDraft(phase.packet)
  let draft: string | null = null
  let writerFailed = false
  try {
    draft = await input.deps.writerCall(writerPrompt, input.signal)
  } catch {
    writerFailed = true
  }
  if (input.signal?.aborted) {
    return { ...phase, draft: null, findings: [], adviceCount: phase.advices.length, sceneCommit: null }
  }

  // —— 连续性检查（确定性规则；对全部活跃角色卡）——
  const findings: ContinuityFinding[] = draft
    ? input.cards.flatMap((card) => [...checkCharacterKnowledge(card, draft), ...checkVoice(card, draft)])
    : []

  // —— 场景状态幂等提交（正文产出成功后；取消/失败不提交）——
  let sceneCommit: SceneCommitResult | null = null
  if (input.commit && draft && !writerFailed && input.commit.store) {
    const { projectId, sceneId, commitId, store } = input.commit
    const states: SceneCharacterState[] = phase.activeCharacterIds.map((characterId, i) => ({
      sceneId,
      characterId,
      stateVersion: 1,
      knowledge: [],
      relationships: {},
      status: '出场',
      updatedAt: Date.now(),
      commitId
    }))
    const committed = await store.saveSceneCommit(projectId, sceneId, commitId, states)
    sceneCommit = { commitId, alreadyCommitted: !committed, stateVersion: 1, stateCount: states.length }
  }

  const degraded = phase.degraded || writerFailed
  return { ...phase, draft, findings, adviceCount: phase.advices.length, degraded, sceneCommit }
}
