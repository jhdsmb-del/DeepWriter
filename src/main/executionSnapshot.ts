import { planToolAllowList, type AgentReadOnlyPlan, type AgentPlanApproval } from '../shared/agentPlanPolicy'
import { freezeAgentTools } from '../shared/agentToolPolicy'
// ==================== R4.2 A3：Versioned RunExecutionSnapshot（SNAPSHOT-SETTINGS 完整化） ====================
// run 启动后，设置变化不能改变该 run 的语义或安全边界：
// - provider origin / model / maxTokens / thinking / sampling 冻结；
// - credential 只存 reference（origin 绑定，不存明文 key）；
// - workDir / docDir / galgame project/sdk 冻结；
// - mode profile ID/version、prompt hash、tool policy / output contract / context policy 冻结；
// - memory 快照 + hash 冻结；attachment asset hashes（A7 集成时回填）冻结；
// - completion/deep-write policy 冻结。
// 恢复时若 snapshot 版本不兼容 → 进入明确 recovery 状态，绝不读取当前全局设置替代。

import { createHash } from 'node:crypto'
import { AGENT_WORK_BUDGET_POLICY, normalizeAgentRunBudget, unlimitedAgentRunBudget, type AgentRunBudgetSettings } from '../shared/agentRunBudget'
import { storedOutputTokenLimit } from '../shared/outputTokenPolicy'
import { projectBriefPrompt } from '../shared/projectBrief'
import { getModeProfile, MODE_PROFILES, type DeepWriterMode, type ModeProfile } from './modeProfiles'
import type { CompletionContract } from './completion/types'
import { resolveRegistryContextCapability, type RegistryContextCapability, type CapabilityOverride } from './providerCapability'
import { buildStorySystemPrompt } from './story'
import type { NarrativeLedgerScopeInput, StoryConfig, StrongConstraintSnapshot } from '../shared/types'
import type { ChatStartPayload } from './chatStart'
import { buildStrongConstraintSnapshot, buildStrongConstraintSystemPrompt } from './strongConstraints'
import { buildWritingPipelinePolicy, type WritingPipelinePolicyV1 } from './writingPipeline'
import { frozenExecutableProfiles, type FrozenStageProfileSnapshots, type PricingRecord, type StageProfileBindings } from '../shared/providerRegistry'
import type { FrozenContextSnapshotV2 } from '../shared/contextV2'
import type { GrillMeOutline } from '../shared/grillMe'
import { buildSceneContractPlan } from './narrative/sceneContract'
import type { SceneContractPlan } from '../shared/types'
import { buildUserPresetSystemMessage, normalizeUserPresetPrompt } from '../shared/userPresetPrompt'
import { buildLongWritePlanPrompt, deriveLongWritePlan, deriveLongwriteMaxTurns as derivePlannerMaxTurns, LONGWRITE_MAX_TURNS_CAP as LONGWRITE_PLAN_MAX_TURNS_CAP } from './longformPlanner'
import type { LongWritePlan } from '../shared/types'
import { defaultNarrativeLedgerScope, scopeInputToConfig } from './narrative/storyLedger'
import { freezeWp7FeatureFlags, type Wp7RuntimeFlags } from './narrative/wp7Runtime'

/** 快照 schema 版本；恢复时版本不兼容必须进入 recovery，不得读取当前设置替代
 *  v3（R4.3 Gate 2）：冻结静态 system prompt（frozenSystemMessages）——profile 升级不再改变旧 run 语义 */
export const SNAPSHOT_SCHEMA_VERSION = 5

export interface MemorySnapshot {
  projectPath: string
  projectContent: string
  userContent: string
  /** sha256(projectContent + '\u0000' + userContent) */
  hash: string
}

export interface DeepWritePolicy {
  targetChars: number
  continueOnLength: boolean
  maxRounds: number | null
  /** 续写重复检测阈值（字符）；超过视为重复循环 */
  duplicateThresholdChars: number
  /** R4.3 Gate 5：角色监护 subagent 实验（默认关闭；A/B/C benchmark 证明优势后才允许默认开启）。
   *  R4.5 Gate 2：从 chatStart payload 结构化冻结（不再写死 false）——characters 为快照冻结的角色卡，
   *  engine 每轮调用监护 hook 时传入；无卡时监护降级（不阻断主链）。 */
  experiment: {
    enabled: boolean
    maxConcurrent: number
    subagentTokenRatio: number
    characters: Array<{
      id: string
      name: string
      bible: string
      knownFacts: string[]
      forbiddenKnowledge: string[]
    }>
  }
}

export interface ExecutionSnapshot {
  outputTokenLimit?: number | null
  workBudgetPolicy?: typeof AGENT_WORK_BUDGET_POLICY
  snapshotVersion: number
  /** 旧字段保留：schemaVersion=1 标记"运行配置版本"（与 snapshotVersion 分开演进） */
  schemaVersion: number
  clientRequestId: string
  sessionId: string
  runMode: DeepWriterMode
  goalMode?: 'guided' | 'autonomous'
  modeProfileVersion: number
  workspace: string
  planMode: boolean
  planText: string
  agentPlan?: AgentReadOnlyPlan
  planApproval?: AgentPlanApproval
  /** R4.6 Grill Me：采访答案与用户确认的大纲冻结进正文运行。 */
  grillMe?: {
    /** New interviews bind their exact selection and bytes; legacy runs retain their contract. */
    attachmentSelectionFrozen?: true
    writingForm?: import('../shared/writingForm').WritingForm
    stateId: string
    originalTask: string
    targetChars: number
    answers: Array<{ slotId: string; value: string; source: string }>
    assumptions: string[]
    approvedOutline: GrillMeOutline
    outlineRevision: number
    outlineHash: string
  }
  story: StoryConfig | null
  longMode: boolean
  // ---- provider origin + 参数（冻结；adapter 每轮从快照取） ----
  model: string
  /** Current Agent instruction frozen with the run (never read from mutable settings during execution). */
  userPresetPrompt: string
  /** Audit-only digest of the frozen user preset; no credential material is included. */
  userPresetPromptHash: string
  baseUrl: string
  maxTokens: number
  temperature: number
  topP: number
  thinking: { enabled: boolean; effort: 'default' | 'low' | 'medium' | 'high' | 'max' }
  /** R44: IDs retained for inspection only; execution uses the complete frozen profiles below. */
  profileBindings?: StageProfileBindings
  providerProfileSnapshots?: FrozenStageProfileSnapshots
  /** Optional price evidence frozen with legacy-compatible runs. */
  providerPricingSnapshots?: PricingRecord[]
  /** R45：运行接受前冻结的上下文选择；v4 恢复走 legacy_v1，绝不借用当前偏好。 */
  frozenContext?: FrozenContextSnapshotV2
  // ---- credential reference（不存明文 key；仅 origin 绑定，与快照 origin 不一致拒绝发送） ----
  credentialRef: { origin: string; model: string; issuedAt: number }
  // ---- 目录/项目（冻结） ----
  workDir: string
  docDir: string
  permissionMode?: import('../shared/types').PermissionMode
  permissionWorkspaceRoot?: string
  novelMode: boolean
  galgame: { enabled: boolean; projectDir: string; sdkPath: string }
  // ---- 记忆快照（内容 + hash；buildRunPrefix 只读快照，不读磁盘） ----
  memory: MemorySnapshot
  // ---- 模式执行契约（冻结） ----
  agentOutputContinuation?: true
  pagedFileReads?: boolean
  toolPolicy: { allowList: string[] }
  outputContract: { format: 'prose' | 'markdown' | 'renpy' | 'any'; minParagraphs: number }
  contextPolicy: { historyBudgetTokens: number; contextWindowTokens: number; outputReserveTokens: number; source?: string; management?: 'model_auto_v1' }
  deepWrite: DeepWritePolicy
  /** R39：用户任务与可见写作配置冻结出的边界；普通 Agent 为 enabled=false。 */
  strongConstraints: StrongConstraintSnapshot
  /** R55：目标、模型输出能力和安全余量推导出的长文章节/轮次计划。 */
  longWritePlan?: LongWritePlan
  /** P0-2：新运行明确声明其稿件分段协议，旧快照缺省即进入兼容 backfill。 */
  manuscriptSegmentsVersion?: 1
  /** Confirmed Grill Me outline compiled into stable semantic scenes. */
  sceneContracts?: SceneContractPlan
  /** Stable story/project/branch ownership; run ids remain provenance only. */
  storyScope?: NarrativeLedgerScopeInput
  /** R42：新 run 的冻结 writer→critic→editor 策略；旧 snapshot v4 缺省时继续 legacy 恢复。 */
  writingPipeline?: WritingPipelinePolicyV1
  /** WP7 Phase0：实验开关只从接受运行时的输入冻结；旧快照缺省严格全关。 */
  wp7FeatureFlags: Wp7RuntimeFlags
  wp7FeatureFlagsHash: string
  /** R4.3 Gate 2：冻结的静态 system prompt（buildStaticSystemMessages 每轮直接返回，不随 profile 升级漂移） */
  frozenSystemMessages: Array<{ role: 'system'; content: string }>
  /** R4.3 Gate 4：完成契约（completed 只能由 CompletionController 产生；非深度写作 run 为 null） */
  completionContract: CompletionContract | null
  /** Every new run carries an explicit, durable provider budget. The cost
   * field is either a same-currency upper bound from frozen price evidence or
   * an exhausted deny policy when that evidence is unavailable. */
  providerCallBudget: FrozenProviderCallBudget
  /** 长文完成后的用户可见交付契约；先写盘并校验，再允许 run 进入 completed。 */
  deliveryContract?: { manuscriptFile: boolean; format: 'markdown' }
  // ---- 附件（A7 集成时回填内容 hash） ----
  attachments: Array<{ fileRefId: string; name: string; size: number; hash?: string }>
  /** 静态 system 策略的稳定 hash（mode prompt + story prompt；每轮字节一致的可缓存前缀） */
  promptHash: string
  maxTurns: number | null
  createdAt: number
}

export interface SnapshotInput {
  /** Host/CLI explicit work limits, not a model tool or renderer payload. */
  workBudget?: AgentRunBudgetSettings
  /** Trusted CLI/model resolution; never taken from an arbitrary chat payload. */
  modelContext?: RegistryContextCapability
  payload: ChatStartPayload
  settings: {
    outputTokenLimit?: number | null
    agentRunBudget?: AgentRunBudgetSettings
    permissionMode?: import('../shared/types').PermissionMode
    permissionWorkspaceRoot?: string
    model: string
    baseUrl: string
    maxTokens: number
    temperature: number
    topP: number
    thinkingEnabled: boolean
    reasoningEffort: 'default' | 'low' | 'medium' | 'high' | 'max'
    workDir: string
    docDir: string
    novelMode: boolean
    webAccessEnabled?: boolean
    toolsEnabled?: boolean
    galgame: { enabled: boolean; projectDir: string; sdkPath: string }
    historyBudgetTokens: number
    /** R4.3 Gate 6：用户能力覆盖（校验危险值） */
    providerCapabilityOverride?: CapabilityOverride
    /** R4.4 Gate 5：完成校验预算（usage ledger 真实累计；0/缺省=无限制） */
    completionTokenBudget?: number
    completionWallClockMs?: number
    strongConstraintEnabled?: boolean
    strongConstraintLevel?: 'balanced' | 'strict'
    themeLockMode?: 'strong' | 'guided' | 'off'
    expressionFreedom?: 'high' | 'balanced' | 'controlled'
    antiMoralizingEnabled?: boolean
    strongConstraintPerspective?: 'auto' | 'first' | 'third'
    strongConstraintGenre?: string
    strongConstraintMustKeep?: string
    strongConstraintAvoid?: string
    userPresetPrompt?: string
    /** WP7 Phase0：仅在运行接受时读取；不由 settings 持久化或恢复补齐。 */
    wp7FeatureFlags?: unknown
  }
  sessionId: string
  memory: { projectPath: string; projectContent: string; userContent: string; projectBrief?: string }
  /** R4.2 A3 补充：附件内容 sha256（fileRefId → hash；运行期预计算后冻结进快照） */
  attachmentHashes?: Record<string, string>
  /** R4.5 Gate 5：不可变 credential reference（主进程 registry 签发；快照不存明文 key）。
   *  缺省时回退 origin/model 绑定（issuedAt=now）——不含 version 的旧引用由 getApi 按 origin 兜底 */
  credentialRef?: { slotId: string; version: number; origin: string; model: string; issuedAt: number }
  /** Optional price evidence supplied by a trusted caller and frozen at accept time. */
  pricingSnapshots?: Array<PricingRecord | null>
  now?: number
}

/**
 * Provider cost policy is frozen at run acceptance.  A policy with no usable
 * price evidence is intentionally an exhausted deny policy: it is safer to
 * pause a custom/unknown endpoint than to invent a currency or silently run
 * without a monetary boundary.
 */
export interface ProviderCallBudgetInput {
  maxCalls: number | null
  /** Total token ceiling for the durable run ledger. */
  maxTokens?: number | null
  /** Conservative input-token capacity used to bound the serialized body. */
  maxInputTokens?: number | null
  /** Per-request provider output ceiling. */
  maxOutputTokens?: number | null
  pricingSnapshots?: Array<PricingRecord | null>
}

export interface FrozenProviderCallBudget {
  maxCalls: number | null
  maxTokens: number | null
  maxCost: { amount: number; currency: string | null; unknownPolicy: 'deny' } | null
  maxCostCny?: number | null
  maxWallClockMs?: number | null
}

const PROVIDER_CALL_ABSOLUTE_CAP = 512
const PROVIDER_TOKEN_ABSOLUTE_CAP = 20_000_000
const PROVIDER_COST_ABSOLUTE_CAP = 100_000
const REQUEST_FRAMING_BYTES = 65_536
const UNKNOWN_PROVIDER_COST_POLICY: NonNullable<FrozenProviderCallBudget['maxCost']> = {
  amount: 0,
  currency: null,
  unknownPolicy: 'deny'
}

function positiveInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : null
}

function normalizePricingCurrency(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const currency = value.trim().toUpperCase()
  return /^[A-Z][A-Z0-9_-]{0,15}$/.test(currency) ? currency : null
}

function pricingRecordUsable(record: PricingRecord | null | undefined): record is PricingRecord {
  if (!record || !['official_provider', 'user_supplied'].includes(record.source) || record.unit !== 'per_1m_tokens') return false
  if (!record.id.trim() || !record.providerId.trim() || !record.remoteModelId.trim() || !record.canonicalOrigin.trim()) return false
  // Official quotes must carry their first-party URL and retrieval time. A
  // user-supplied quote is an explicit upper-bound declaration, so its
  // identity/hash/currency and complete rates are sufficient even without a
  // source URL.
  if (record.source === 'official_provider' && (!record.sourceUrl?.trim() || !record.retrievedAt.trim())) return false
  if (!normalizePricingCurrency(record.currency)) return false
  if (record.reasoningBillingRule === 'unknown') return false
  const rates = [record.inputMissPerMillion, record.cacheHitPerMillion, record.outputPerMillion]
  if (record.reasoningBillingRule === 'separate') rates.push(record.reasoningPerMillion)
  if (rates.some((rate) => typeof rate !== 'number' || !Number.isFinite(rate) || rate < 0)) return false
  // Match the hash contract used by ProviderRegistryService.upsertPricing.
  const hashPayload = { ...record, id: undefined, priceProfileHash: undefined }
  const expectedHash = createHash('sha256').update(JSON.stringify(hashPayload)).digest('hex')
  return record.priceProfileHash === expectedHash
}

/**
 * Derive a same-currency upper-bound spend policy from frozen price evidence.
 * The adapter's pre-request quote uses UTF-8 request bytes, so the input side
 * reserves four bytes per estimated token plus a fixed JSON framing margin.
 * Missing, mixed, user-supplied, or malformed prices never receive a guessed
 * amount and instead produce an immediately exhausted deny policy.
 */
export function deriveProviderCallBudget(input: ProviderCallBudgetInput): FrozenProviderCallBudget {
  const maxCalls = input.maxCalls === null ? null : Math.min(PROVIDER_CALL_ABSOLUTE_CAP, Math.max(1, positiveInteger(input.maxCalls) ?? 16))
  const maxInputTokens = positiveInteger(input.maxInputTokens)
  const maxOutputTokens = positiveInteger(input.maxOutputTokens)
  const derivedTokenCeiling = maxCalls !== null && maxInputTokens !== null && maxOutputTokens !== null
    ? maxCalls * (maxInputTokens + maxOutputTokens)
    : PROVIDER_TOKEN_ABSOLUTE_CAP
  const configuredTokens = positiveInteger(input.maxTokens)
  const maxTokens = Math.min(PROVIDER_TOKEN_ABSOLUTE_CAP, Math.max(1, configuredTokens ?? derivedTokenCeiling))
  const records = input.pricingSnapshots ?? []
  const verifiedRecords: PricingRecord[] | null = records.length > 0 && records.every(pricingRecordUsable)
    ? records as PricingRecord[]
    : null
  const currencies = verifiedRecords
    ? new Set(verifiedRecords.map((record) => normalizePricingCurrency(record.currency)))
    : new Set<string | null>()
  const currency = currencies.size === 1 ? [...currencies][0] : null
  let maxCost: FrozenProviderCallBudget['maxCost'] = { ...UNKNOWN_PROVIDER_COST_POLICY }
  if (verifiedRecords && currency && maxInputTokens !== null && maxOutputTokens !== null) {
    const inputRate = Math.max(...verifiedRecords.map((record) => Math.max(record.inputMissPerMillion as number, record.cacheHitPerMillion as number)))
    const outputRate = Math.max(...verifiedRecords.map((record) => (record.outputPerMillion as number) + (record.reasoningBillingRule === 'separate' ? (record.reasoningPerMillion as number) : 0)))
    const inputBytes = maxInputTokens * 4 + REQUEST_FRAMING_BYTES
    const perCall = (inputBytes * inputRate + maxOutputTokens * outputRate) / 1_000_000
    // With unlimited calls, derive spend from the separate finite token
    // ceiling, not from a disguised finite call allowance. Provider request
    // bytes/output tokens are reserved by that same durable token ledger.
    const amount = maxCalls === null
      ? maxTokens * Math.max(inputRate, outputRate) / 1_000_000
      : perCall * maxCalls
    if (Number.isFinite(amount) && amount >= 0) {
      maxCost = { amount: Math.min(PROVIDER_COST_ABSOLUTE_CAP, amount), currency, unknownPolicy: 'deny' }
    }
  }
  return {
    maxCalls,
    maxTokens,
    maxCost,
    maxCostCny: maxCost?.currency === 'CNY' ? maxCost.amount : undefined,
    maxWallClockMs: undefined
  }
}

/** Apply the exact stage profiles frozen by Provider Registry to a snapshot. */
export function applyFrozenProviderPricing(snapshot: ExecutionSnapshot, profiles: FrozenStageProfileSnapshots): ExecutionSnapshot {
  if (snapshot.workBudgetPolicy === AGENT_WORK_BUDGET_POLICY) return snapshot
  const stages = frozenExecutableProfiles(profiles)
  const budget = deriveProviderCallBudget({
    maxCalls: snapshot.providerCallBudget.maxCalls,
    maxTokens: snapshot.providerCallBudget.maxTokens,
    maxInputTokens: Math.max(snapshot.contextPolicy.contextWindowTokens, ...stages.map((stage) => stage.contextBudget?.contextWindowTokens ?? stage.model.contextWindow ?? 0)),
    maxOutputTokens: Math.max(snapshot.maxTokens, ...stages.map((stage) => stage.generation.maxOutputTokens)),
    pricingSnapshots: stages.map((stage) => stage.model.pricing ?? null)
  })
  return {
    ...snapshot,
    providerCallBudget: budget,
    completionContract: snapshot.completionContract
      ? { ...snapshot.completionContract, providerCallBudget: budget }
      : null
  }
}

/** 计算静态 system 前缀的稳定 hash（mode prompt + story prompt；与 buildRunPrefix 的组装规则一致） */
export function computePromptHash(runMode: DeepWriterMode, story: StoryConfig | null | undefined, targetChars: number, galgame: { enabled: boolean }, constraintHash = '', frozenMessages?: Array<{ role: 'system'; content: string }>): string {
  const profile = getModeProfile(runMode)
  let systemLines = profile.systemPrompt
  if (story?.enabled) {
    const storyPrompt = buildStorySystemPrompt(story, targetChars, galgame)
    if (storyPrompt) systemLines = storyPrompt
  }
  const bytes = frozenMessages ? JSON.stringify(frozenMessages) : `${systemLines}\u0000${constraintHash}`
  return createHash('sha256').update(bytes).digest('hex')
}

export function hashMemory(m: { projectContent: string; userContent: string }): string {
  return createHash('sha256').update(`${m.projectContent}\u0000${m.userContent}`).digest('hex')
}

/** 快照版本兼容检查：只有当前 schema 版本可恢复；旧版本不得读取当前全局设置替代 */
export function snapshotVersionOk(cfg: Record<string, unknown>): boolean {
  return cfg.snapshotVersion === SNAPSHOT_SCHEMA_VERSION || cfg.snapshotVersion === 4
}

/**
 * R4.2 A3：恢复版本门——run 启动后设置变化不能改变其语义/安全边界；恢复时若 snapshot 版本
 * 不兼容，进入明确 recovery 状态（recovery_required + snapshot_version_incompatible），
 * 绝不读取当前全局设置替代（旧 run 只能放弃重发，不能带病恢复）。
 */
export function applySnapshotGate(
  repo: { getRun(runId: string): { status: string } | null; updateRun(runId: string, patch: Record<string, unknown>): void },
  runId: string,
  cfg: Record<string, unknown>
): { ok: true } | { ok: false; reason: 'snapshot_version_incompatible' } {
  if (snapshotVersionOk(cfg)) return { ok: true }
  repo.updateRun(runId, {
    status: 'recovery_required',
    phase: 'recovery_required',
    error_code: 'snapshot_version_incompatible',
    error_message: '执行快照版本不兼容：该运行无法自动恢复（不会用当前设置替代旧快照），请放弃后重新发起'
  })
  return { ok: false, reason: 'snapshot_version_incompatible' }
}

/** 构建完整执行快照（run 创建时调用一次；此后该 run 的一切执行语义只读快照） */
export function buildExecutionSnapshot(input: SnapshotInput): ExecutionSnapshot {
  const now = input.now ?? Date.now()
  const runMode: DeepWriterMode = (input.payload.mode as DeepWriterMode) ?? 'agent'
  if (input.payload.planAccess && (runMode !== 'agent' || input.payload.longMode || input.payload.phase !== 'plan')) throw new Error('只读审阅仅用于新 Agent 计划')
  if (input.payload.goalMode && (runMode !== 'agent' || input.payload.longMode || input.payload.phase === 'plan')) throw new Error('目标模式仅用于普通 Agent 执行任务')
  const frozenWp7 = freezeWp7FeatureFlags(input.settings.wp7FeatureFlags)
  const profile: ModeProfile = getModeProfile(runMode)
  const targetChars = input.payload.targetChars ?? 0
  const longMode = input.payload.longMode ?? false
  const official = (() => { try { return new URL(input.settings.baseUrl).origin === 'https://api.deepseek.com' } catch { return false } })()
  const modelContext = input.modelContext ?? resolveRegistryContextCapability({
    providerKind: official ? 'builtin' : 'custom', adapterId: official ? 'builtin.deepseek' : 'custom.openai-compatible-chat',
    remoteModelId: input.settings.model, settingsMaxOutputTokens: input.settings.maxTokens, allowConservativeFallback: true
  })
  const story = (input.payload.story as StoryConfig | null | undefined) ?? null
  const strongConstraints = buildStrongConstraintSnapshot({
    runMode,
    phase: input.payload.phase,
    task: input.payload.text ?? '',
    story,
    settings: input.settings,
    visible: input.payload.strongConstraints
  })
  const hasWritingAxes = input.payload.strongConstraints?.themeLockMode !== undefined || input.settings.themeLockMode !== undefined
  // A confirmed Grill Me longwrite is already an explicit writing contract;
  // it must receive the R42 writer→critic→targeted-editor→verification chain
  // even when an older renderer did not serialize the newer axis fields.  The
  // only opt-out is an explicit strong-constraints=false choice, reflected by
  // strongConstraints.enabled=false above.
  const confirmedGrillLongwrite = runMode === 'longwrite' && longMode && Boolean(input.payload.grillMe && input.payload.grillMe.quickBypass !== true && input.payload.grillMe.approvedOutline)
  const writingPipeline = strongConstraints.enabled && (hasWritingAxes || confirmedGrillLongwrite)
    ? buildWritingPipelinePolicy(strongConstraints, input.payload.grillMe?.writingForm)
    : undefined
  const longWritePlan = runMode === 'longwrite' && longMode
    ? deriveLongWritePlan({ targetChars, modelOutputTokens: input.settings.maxTokens })
    : undefined
  const grill = input.payload.grillMe
  const sceneContracts = runMode === 'longwrite' && longMode && grill && grill.quickBypass !== true && grill.approvedOutline && grill.writingForm !== 'expository' && grill.writingForm !== 'open'
    ? buildSceneContractPlan({
        outline: grill.approvedOutline,
        outlineHash: grill.outlineHash,
        outlineRevision: grill.outlineRevision,
        answers: grill.answers,
        characterNames: story?.enabled ? story.characters.map((character) => character.name) : [],
        strongConstraints
      })
    : undefined
  // 长文轮数从目标、provider 单轮输出能力和每章安全余量推导；绝对上限
  // 只用于坏 provider/停滞保护，不是正常目标的固定截断点。
  const ordinaryAgent = runMode === 'agent' && !longMode
  const workBudget = normalizeAgentRunBudget(input.workBudget ?? (ordinaryAgent ? input.settings.agentRunBudget : {
    ...unlimitedAgentRunBudget(),
    maxTokens: input.settings.completionTokenBudget && input.settings.completionTokenBudget > 0 ? input.settings.completionTokenBudget : null,
    maxWallClockMs: input.settings.completionWallClockMs && input.settings.completionWallClockMs > 0 ? input.settings.completionWallClockMs : null
  }))
  const maxTurns = workBudget.maxTurns
  const completionTokenBudget = workBudget.maxTokens ?? undefined
  const pricingSnapshots = input.pricingSnapshots ?? []
  const verifiedPricingSnapshots = pricingSnapshots.length > 0 && pricingSnapshots.every(pricingRecordUsable)
    ? pricingSnapshots as PricingRecord[]
    : []
  const providerCallBudget: FrozenProviderCallBudget = {
    maxCalls: workBudget.maxCalls, maxTokens: workBudget.maxTokens, maxWallClockMs: workBudget.maxWallClockMs,
    maxCost: workBudget.maxCost, maxCostCny: workBudget.maxCost?.currency === 'CNY' ? workBudget.maxCost.amount : null
  }
  const frozenSystemMessages = computeStaticSystemMessages({
    runMode,
    story,
    targetChars,
    galgame: input.settings.galgame,
    novelMode: input.settings.novelMode,
    planMode: input.payload.phase === 'plan',
    readOnlyPlan: input.payload.planAccess === 'read_only',
    planText: input.payload.planText ?? '',
    userPresetPrompt: input.settings.userPresetPrompt,
    longWritePlan
  })
  const briefMessage = projectBriefPrompt(grill && !grill.quickBypass ? grill.projectBrief : input.memory.projectBrief)
  if (briefMessage) frozenSystemMessages.push({ role: 'system', content: briefMessage })
  if (grill && grill.quickBypass !== true) {
    const answerLines = grill.answers.map((answer) => `- ${answer.slotId}：${answer.value}`).join('\n')
    const outlineLines = grill.approvedOutline.sections.map((section) => `- ${section.title}（${section.targetChars}字）：${section.purpose}（来源：${Array.isArray(section.sourceSlotIds) ? section.sourceSlotIds.join('、') || '无' : '未知'}）\n  推进点：${section.beats.join('；')}`).join('\n')
    frozenSystemMessages.push({ role: 'system', content: `## Grill Me 已确认写作契约\n原始任务：${grill.originalTask}\n目标字数：${grill.targetChars}\n已确认边界：\n${answerLines}\n已确认大纲（不得擅自改题）：\n${outlineLines}\n大纲版本：${grill.outlineRevision} / ${grill.outlineHash}` })
  }
  const strongConstraintPrompt = buildStrongConstraintSystemPrompt(strongConstraints, grill?.writingForm)
  if (strongConstraintPrompt) frozenSystemMessages.push({ role: 'system', content: strongConstraintPrompt })
  const userPresetPrompt = normalizeUserPresetPrompt(input.settings.userPresetPrompt)
  const userPresetPromptHash = createHash('sha256').update(userPresetPrompt).digest('hex')
  const completionContract = buildCompletionContract(runMode, longMode, targetChars, maxTurns, {
    token: completionTokenBudget,
    wallClockMs: workBudget.maxWallClockMs ?? undefined
  }, input.payload.requiredFiles as RequiredFileSpec[] | undefined, strongConstraints)
  if (completionContract) completionContract.providerCallBudget = providerCallBudget
  const snapshot: ExecutionSnapshot = {
    ...(ordinaryAgent ? { outputTokenLimit: storedOutputTokenLimit(input.settings as unknown as Record<string, unknown>) } : {}),
    workBudgetPolicy: AGENT_WORK_BUDGET_POLICY,
    snapshotVersion: SNAPSHOT_SCHEMA_VERSION,
    schemaVersion: 1,
    clientRequestId: input.payload.id,
    sessionId: input.sessionId,
    runMode,
    ...(input.payload.goalMode ? { goalMode: input.payload.goalMode } : {}),
    modeProfileVersion: profile.version,
    ...(input.payload.planAccess === 'read_only' ? { agentPlan: { schemaVersion: 1 as const, access: 'read_only' as const } } : {}),
    ...(input.payload.planApproval ? { planApproval: { ...input.payload.planApproval } } : {}),
    workspace: input.payload.workspace ?? 'chat',
    planMode: input.payload.phase === 'plan',
    planText: input.payload.planText ?? '',
    ...(grill && grill.quickBypass !== true ? {
      grillMe: {
        stateId: grill.stateId,
        ...(grill.attachments ? { attachmentSelectionFrozen: true as const } : {}),
        ...(grill.writingForm ? { writingForm: grill.writingForm } : {}),
        originalTask: grill.originalTask,
        targetChars: grill.targetChars,
        answers: grill.answers.map((item) => ({ ...item })),
        assumptions: [...grill.assumptions],
        approvedOutline: structuredClone(grill.approvedOutline),
        outlineRevision: grill.outlineRevision,
        outlineHash: grill.outlineHash
      }
    } : {}),
    story,
    storyScope: (() => {
      const parsed = defaultNarrativeLedgerScope(input.sessionId, { workDir: input.settings.workDir, storyScope: input.payload.storyScope })
      return scopeInputToConfig({ ...parsed.scope, ...(parsed.parentRevision !== null ? { parentRevision: parsed.parentRevision } : {}), ...(parsed.parentBranchId !== null ? { parentBranchId: parsed.parentBranchId } : {}) })
    })(),
    longMode,
    model: input.settings.model,
    userPresetPrompt,
    userPresetPromptHash,
    baseUrl: input.settings.baseUrl,
    maxTokens: modelContext.outputReserveTokens,
    temperature: input.settings.temperature,
    topP: input.settings.topP,
    thinking: { enabled: input.settings.thinkingEnabled, effort: input.settings.reasoningEffort },
    ...(verifiedPricingSnapshots.length > 0 ? { providerPricingSnapshots: structuredClone(verifiedPricingSnapshots) } : {}),
    // R4.5 Gate 5：credential reference 由主进程 registry 签发（slotId/version；不存明文 key）；
    // 缺省（旧调用方）回退 origin 绑定
    credentialRef: input.credentialRef ?? { slotId: `legacy:${input.settings.baseUrl}`, version: 0, origin: input.settings.baseUrl, model: input.settings.model, issuedAt: now },
    workDir: input.settings.workDir,
    docDir: input.settings.docDir,
    permissionMode: input.settings.permissionMode === 'auto' ? 'auto' : 'safe',
    permissionWorkspaceRoot: input.settings.permissionWorkspaceRoot,
    novelMode: input.settings.novelMode,
    galgame: { enabled: input.settings.galgame.enabled, projectDir: input.settings.galgame.projectDir, sdkPath: input.settings.galgame.sdkPath },
    memory: {
      projectPath: input.memory.projectPath,
      projectContent: input.memory.projectContent,
      userContent: input.memory.userContent,
      hash: hashMemory(input.memory)
    },
    ...(runMode === 'agent' ? { pagedFileReads: true, ...(!longMode && input.payload.phase !== 'plan' ? { agentOutputContinuation: true as const } : {}) } : {}),
    toolPolicy: { allowList: runMode === 'agent'
      ? freezeAgentTools(input.settings.toolsEnabled !== false, false)
      : [...profile.toolPolicy.allowList] },
    outputContract: { format: profile.outputContract.format, minParagraphs: profile.outputContract.minParagraphs },
    contextPolicy: {
      historyBudgetTokens: input.settings.historyBudgetTokens,
      // R4.3 Gate 6（S-04）：窗口能力按 provider/model 解析 + 用户覆盖（未知 provider 保守上限，不默认 1M）
      contextWindowTokens: modelContext.maxContextTokens ?? 8192,
      outputReserveTokens: modelContext.outputReserveTokens,
      source: modelContext.contextSource,
      management: 'model_auto_v1'
    },
    deepWrite: {
      targetChars,
      continueOnLength: longMode,
      maxRounds: maxTurns,
      duplicateThresholdChars: 200,
      // R4.5 Gate 2（B-02 修复）：实验配置从 payload 结构化冻结（不再写死 false）；
      // 仅长文模式允许（schema 已拦，快照双保险）；未传 = 默认关闭（向后兼容）；
      // characters 快照冻结（运行中改设置不影响该 run 的监护语义）
      experiment: {
        enabled: runMode === 'longwrite' && input.payload.deepWriteExperiment?.enabled === true,
        maxConcurrent: input.payload.deepWriteExperiment?.maxConcurrent ?? 3,
        subagentTokenRatio: input.payload.deepWriteExperiment?.subagentTokenRatio ?? 0.35,
        characters: (input.payload.deepWriteExperiment?.characters ?? []).map((c) => ({
          id: c.id,
          name: c.name,
          bible: c.bible,
          knownFacts: c.knownFacts ?? [],
          forbiddenKnowledge: c.forbiddenKnowledge ?? []
        }))
      }
    },
    strongConstraints,
    ...(longWritePlan ? { longWritePlan } : {}),
    ...(longMode ? { manuscriptSegmentsVersion: 1 as const } : {}),
    ...(sceneContracts ? { sceneContracts } : {}),
    ...(writingPipeline ? { writingPipeline } : {}),
    wp7FeatureFlags: frozenWp7.wp7FeatureFlags,
    wp7FeatureFlagsHash: frozenWp7.wp7FeatureFlagsHash,
    attachments: (grill?.attachments ?? input.payload.attachments ?? []).map((a) => {
      const h = grill?.attachments?.find(item => item.fileRefId === a.fileRefId)?.hash ?? input.attachmentHashes?.[a.fileRefId]
      // R4.2 A3 补充：冻结附件内容 hash（内容寻址键；无预计算则不伪造）
      return h ? { fileRefId: a.fileRefId, name: a.name, size: a.size, hash: h } : { fileRefId: a.fileRefId, name: a.name, size: a.size }
    }),
    promptHash: computePromptHash(runMode, story, targetChars, input.settings.galgame, strongConstraints.hash, frozenSystemMessages),
    // R4.3 Gate 2：静态 system prompt 构建时冻结（profile 文案升级不影响旧 run）
    frozenSystemMessages,
    // R4.3 Gate 4：深度写作/Galgame run 冻结完成契约（agent/style 无契约，直接 completed）
    completionContract,
    providerCallBudget,
    ...(runMode === 'longwrite' && longMode ? { deliveryContract: { manuscriptFile: true, format: 'markdown' as const } } : {}),
    maxTurns,
    createdAt: now
  }
  const planTools = planToolAllowList(snapshot as unknown as Record<string, unknown>)
  if (planTools) snapshot.toolPolicy.allowList = planTools
  return snapshot
}


/**
 * R4.3 Gate 4：按模式冻结完成契约——
 * longwrite：目标字数附近 1% 的自然句末交付窗口 + noPendingTools；
 * galgame：renpyLint + noPendingTools + requiredArtifacts(renpy≥1)；
 * agent/style：无契约（null）——模型 finish stop 即 completed（非深度写作路径）。
 */
/**
 * R4.4 Gate 1（B-01/B-02 修复）：真实完成契约——与生产 artifact/evidence 同源：
 * - 聊天长文通过独立 deliveryContract 在完成门之后生成 manuscript 文件；
 * - Galgame 契约只保留 renpyLint（有 renpy 产物时才要求 lint evidence，无产物不要求——B-02）；
 * - 预算字段（tokenBudget/wallClockBudget）由 Gate 5 从真实 usage 冻结填充；
 * - 项目写作（novelv2 场景/chapter）接入 kernel 后按 chapter/manuscript 真实产物校验（ontology 见 types.ts）。
 */
export interface CompletionBudget {
  token?: number
  wallClockMs?: number
}

export interface RequiredFileSpec { path: string; kind: 'text' | 'markdown' | 'renpy'; minChars?: number }

/** Compatibility constant retained for older callers; new planning uses model capability. */
export const LONGWRITE_CHARS_PER_TURN_BUDGET = 1000
/** Re-exported for old imports; the R55 planner owns the absolute safety cap. */
export const LONGWRITE_MAX_TURNS_CAP = LONGWRITE_PLAN_MAX_TURNS_CAP
/** Existing installations use 200k as the default; treat that value as an
 * automatic/unlimited longwrite budget rather than an accidental stop point.
 * The independent max-turns, repetition, cancellation, and hard-error gates
 * remain active when this sentinel is normalized to undefined. */
export const LEGACY_DEFAULT_LONGWRITE_TOKEN_BUDGET = 200000

export function deriveLongwriteMaxTurns(targetChars: number, modelOutputTokens?: number): number {
  return derivePlannerMaxTurns(targetChars, modelOutputTokens)
}

/**
 * Normalize the legacy longwrite default.  The old 200k value was a global
 * cap, but a longwrite request grows with every continuation and each accepted
 * segment may also be reviewed.  Treat that one legacy/default value as
 * automatic/unlimited; explicit smaller or larger user budgets remain
 * enforceable, and 0 remains unlimited.  maxTurns, repetition, cancellation,
 * and hard provider errors remain independent gates.
 */
export function deriveLongwriteCompletionTokenBudget(targetChars: number, requestedBudget?: number): number | undefined {
  if (typeof requestedBudget !== 'number' || !Number.isFinite(requestedBudget) || requestedBudget <= 0) return undefined
  if (requestedBudget === LEGACY_DEFAULT_LONGWRITE_TOKEN_BUDGET) return undefined
  return requestedBudget
}

export function buildCompletionContract(runMode: DeepWriterMode, longMode: boolean, targetChars: number, maxTurns: number | null, budget?: CompletionBudget, requiredFiles?: RequiredFileSpec[], strongConstraints?: StrongConstraintSnapshot): CompletionContract | null {
  if (runMode === 'longwrite' && longMode && targetChars > 0) {
    return {
      schemaVersion: 1,
      runId: '',
      // 用户输入仍是交付目标。只允许 ±1% 的窄窗口，用这点余量换取完整句末，
      // 禁止在精确 code point 位置把正文硬切成半句话。
      targetChars: { min: targetChars, max: Math.ceil(targetChars * 1.01), tolerance: 0.01 },
      validators: [
        { id: 'targetChars', severity: 'hard', config: {} },
        ...(requiredFiles && requiredFiles.length > 0 ? [{ id: 'fileEvidence' as const, severity: 'hard' as const, config: {} }] : []),
        ...(strongConstraints?.enabled ? [{ id: 'strongConstraints' as const, severity: 'hard' as const, config: { constraintHash: strongConstraints.hash, rulesVersion: strongConstraints.schemaVersion } }] : []),
        { id: 'noPendingTools', severity: 'hard', config: {} }
      ],
      requiredFiles,
      // R4.5 Gate 4（复审 B-03）：修复次数上限与目标规模推导一致（每轮 ~6000 字能力估算），
      // 不再写死 3——稳定增长的长文不会被 maxRepair 在达标前误杀；仍是防失控硬上限
      maxRepairAttempts: Math.max(3, Math.ceil(targetChars / 6000)),
      tokenBudget: budget?.token && budget.token > 0 ? budget.token : undefined,
      wallClockBudgetMs: budget?.wallClockMs && budget.wallClockMs > 0 ? budget.wallClockMs : undefined,
      createdAt: Date.now()
    }
  }
  if (runMode === 'galgame') {
    // R4.5 Gate 1（复审 B-01 修复）：fail-closed——Galgame run 必须产出真实 renpy 产物
    // （requiredArtifacts minCount=1），无产物不许 completed；renpyLint validator 无条件
    // 要求 lint evidence（不再条件式跳过）。lint evidence 需与 artifact manifest 匹配（gate 比对）。
    return {
      schemaVersion: 1,
      runId: '',
      requiredArtifacts: [{ kind: 'renpy', minCount: 1 }],
      validators: [
        { id: 'renpyLint', severity: 'hard', config: {} },
        { id: 'requiredArtifacts', severity: 'hard', config: {} },
        { id: 'noPendingTools', severity: 'hard', config: {} }
      ],
      maxRepairAttempts: 2,
      tokenBudget: budget?.token && budget.token > 0 ? budget.token : undefined,
      wallClockBudgetMs: budget?.wallClockMs && budget.wallClockMs > 0 ? budget.wallClockMs : undefined,
      createdAt: Date.now()
    }
  }
  return null
}

/** 静态 system 前缀的纯构建器（构建快照时冻结；与 promptHash 同源） */
export function computeStaticSystemMessages(input: {
  runMode: DeepWriterMode
  story: StoryConfig | null
  targetChars: number
  galgame: { enabled: boolean }
  novelMode: boolean
  planMode: boolean
  readOnlyPlan?: boolean
  planText: string
  userPresetPrompt?: string
  longWritePlan?: LongWritePlan
}): Array<{ role: 'system'; content: string }> {
  const profile = getModeProfile(input.runMode)
  let systemLines = profile.systemPrompt
  if (input.story?.enabled) {
    const storyPrompt = buildStorySystemPrompt(input.story, input.targetChars, input.galgame)
    if (storyPrompt) systemLines = storyPrompt
  }
  const out: Array<{ role: 'system'; content: string }> = [{ role: 'system', content: systemLines }]
  const userPresetMessage = buildUserPresetSystemMessage(input.userPresetPrompt)
  if (userPresetMessage) out.push(userPresetMessage)
  if (input.longWritePlan) out.push({ role: 'system', content: buildLongWritePlanPrompt(input.longWritePlan) })
  if (input.novelMode) out.push({ role: 'system', content: '你处于对话成书模式：把对话内容作为小说素材累积，输出保持创作语境。' })
  if (input.planMode && input.readOnlyPlan) {
    out.push({ role: 'system', content: '当前是只读查稿与方案阶段。可以使用本任务已授权的文件读取、列举、搜索与可选联网核对来源；不得写入、编辑、删除文件，不得执行命令或启动扩展。先读取实际材料，区分已核实事实与建议，再给出可批准的 Markdown 执行方案。不要声称已修改稿件。用户批准后会开启新的正常 Agent 运行，文件写入仍须原有授权。' })
  } else if (input.planMode) {
    out.push({ role: 'system', content: '当前处于计划模式。你的任务：先制定详细执行计划，不执行任何工具。输出 Markdown 格式：\n## 执行计划\n1. ...' })
  } else if (input.planText) {
    out.push({ role: 'system', content: `以下计划已获用户批准，请严格按计划逐步执行：\n${input.planText}` })
  }
  return out
}

/**
 * R4.3 Gate 2（G-02 修复）：每轮重建静态 system 前缀——
 * 优先返回快照冻结的 frozenSystemMessages（profile 升级不影响旧 run）；冻结内容缺失（旧版本快照）
 * 时抛错 fail-closed（绝不回退当前 profile 默认值；调用方应经 applySnapshotGate 拦截）。
 */
export function buildStaticSystemMessages(snap: ExecutionSnapshot): Array<{ role: 'system'; content: string }> {
  if (Array.isArray(snap.frozenSystemMessages) && snap.frozenSystemMessages.length > 0) {
    return snap.frozenSystemMessages.map((m) => ({ role: 'system' as const, content: m.content }))
  }
  throw new Error(`执行快照缺少冻结的静态 system prompt（snapshotVersion=${snap.snapshotVersion}，当前要求 v${SNAPSHOT_SCHEMA_VERSION}）：拒绝回退当前 profile 默认值`)
}

export type { ModeProfile }
export { MODE_PROFILES }
