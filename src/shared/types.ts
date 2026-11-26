import type { FileEditUndoRef } from './editUndo'
import type { AgentPlanApproval } from './agentPlanPolicy'
import type { Wp7FeatureFlags } from './narrativeV2'

export interface ToolCall {
  id: string
  name: string
  arguments: string
}

export interface DsMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string
  tool_call_id?: string
  tool_calls?: ToolCall[]
  prefix?: boolean
  reasoning_content?: string
}

export interface DsTool {
  type: 'function'
  function: {
    name: string
    description: string
    parameters: Record<string, unknown>
  }
}

export interface ThinkingOpts {
  enabled: boolean
  effort: 'default' | 'low' | 'medium' | 'high' | 'max'
}

export interface ChatParams {
  /** Host-only planning/accounting; these fields are never serialized. */
  outputReserveTokens?: number
  outputTokenUpperBound?: number
  omitOutputTokenLimit?: boolean
  outputLimitSource?: string
  model: string
  messages: DsMessage[]
  thinking: ThinkingOpts
  maxTokens?: number
  temperature?: number
  topP?: number
  tools?: DsTool[]
  toolChoice?: 'auto' | 'none' | 'required'
  apiKey: string
  baseUrl?: string
  user?: string
  provider?: {
    adapterId: 'builtin.deepseek' | 'custom.openai-compatible-chat'
    protocol?: 'deepseek-chat' | 'openai-chat' | 'openai-responses' | 'anthropic-messages'
    chatPath: string
    authStyle: 'bearer' | 'none'
    transportPolicy: { scope: 'public_https' | 'loopback_http'; allowNonDefaultPort: boolean; protocol?: 'deepseek-chat' | 'openai-chat' | 'openai-responses' | 'anthropic-messages'; authHeaderName?: string; fixedHeaders?: Record<string, string>; extraHeaders?: Record<string, string> }
    reasoning: { mode: 'default' | 'disabled' | 'enabled' | 'adaptive'; effort: string | null; budgetTokens?: number | null }
    compatibilityMappingId: import('./providerRegistry').CompatibilityMappingId | null
    authHeaderName?: string
    extraHeaders?: Record<string, string>
  }
}

export interface Usage {
  prompt_tokens: number
  completion_tokens: number
  total_tokens: number
  prompt_cache_hit_tokens: number
  prompt_cache_miss_tokens: number
  reasoning_tokens: number
  /** provider 原始 usage 是否真的返回这些可选字段；false 时 UI 必须显示未知，不能把归一化 0 当事实。 */
  cache_tokens_known?: boolean
  reasoning_tokens_known?: boolean
}

export type ChunkEventType = 'text' | 'text_replace' | 'reasoning' | 'tool_call' | 'tool_result' | 'plan_ready' | 'retry' | 'done' | 'usage' | 'completion' | 'performance'

/** R4.2 A6：独立 usage 指标（metrics 与 lifecycle 分离；terminal 不携带 usage） */
/** R4.4 Gate 3：completion 客观进度（UI 只展示结构化事实，不展示模型自述） */
export interface CompletionChunk {
  revision: number
  /** contract_created / validator_result / continuation_required / completion_blocked / completion_accepted */
  subtype: string
  state: string
  measuredChars?: number
  targetChars?: number
  validatorPassed?: number
  validatorTotal?: number
  remainingWork: Array<{ code: string; message: string }>
  blockedReason?: string
  pausedMessage?: string
}

export interface UsageChunk {
  /** 每次更新递增；迟到/重连场景据此判定过期 */
  revision: number
  /** partial=流中估算；estimated=上下文预算估算；actual=provider 实测 */
  kind: 'partial' | 'estimated' | 'actual'
  inputTokens: number
  outputTokens: number
  cacheHitTokens: number
  cacheMissTokens: number
  reasoningTokens: number
  segmentBreakdown?: Array<{ label: string; tokens: number; cacheable: boolean }>
  cacheablePrefixHash?: string
}

export interface FileDiff {
  /** 变更文件路径（相对 workDir 或绝对） */
  path: string
  /** 快照 id（可回滚） */
  backupId: string
  /** unified diff 文本（UI 直接着色展示） */
  content: string
  added: number
  removed: number
}

export interface ChunkEvent {
  type: ChunkEventType
  delta?: string
  /**
   * Provider tool events use snapshot semantics.  For a given provider call
   * index/id every event contains the complete name and arguments collected
   * so far; consumers must replace the prior snapshot, never concatenate it.
   * `id` is the executable provider call id (OpenAI Responses `call_id`,
   * Anthropic tool-use id, or the Chat Completions tool-call id).
   */
  tool?: { index: number; id: string; name: string; arguments: string; callId?: string; itemId?: string }
  toolResult?: {
    toolId: string
    name: string
    ok: boolean
    result: string
    durationMs: number
    exitCode?: number | null
    diff?: FileDiff | null
    editReceipt?: EditReceipt
    editUndo?: FileEditUndoRef
    /** Captured file excerpts are fetched lazily by run/tool/source identity. */
    sourceCount?: number
  }
  plan?: { planId: string; text: string; approval?: AgentPlanApproval }
  /** 自动重试通知（重试前清空已接收的流内容） */
  retry?: { attempt: number }
  finishReason?: string | null
  usage?: Usage | null
  /** R4.2 A6：独立 usage 指标（type='usage' 时携带；只累计不改 lifecycle） */
  usageChunk?: UsageChunk
  /** Display-only provider-boundary samples; never billing usage. */
  performance?: import('./performanceTelemetry').ProviderPerformanceSnapshot
  /** R4.4 Gate 3：completion 客观进度（type='completion' 时携带） */
  completionChunk?: CompletionChunk
  /** text_replace 的单调修订号与内容 hash；旧/重复修订不得覆盖新正文。 */
  replaceRevision?: number
  contentHash?: string
}

/** API 错误分类（展示给用户的中文可读信息） */
export interface ApiErrorInfo {
  kind: 'unauthorized' | 'insufficient_balance' | 'rate_limited' | 'server_error' | 'network' | 'timeout' | 'content_filter' | 'unknown'
  message: string
  retryable: boolean
}

export const MODELS = [
  // Official CNY / 1M tokens, checked 2026-10-03. These are off-peak
  // reference rates, not a bill; peak rates are twice these values.
  // https://api-docs.deepseek.com/zh-cn/quick_start/pricing/
  // Keep the old first item and exact IDs so existing preferences do not move.
  { id: 'deepseek-v4-flash', name: 'DeepSeek V4.1-Flash（旧 Flash 名称）', desc: '旧名称由 V4.1-Flash 服务 / 1M 上下文 / 384K 输出 / 人民币空闲档参考，高峰 2 倍', cacheHit: 0.02, cacheMiss: 1, out: 4 },
  { id: 'deepseek-v4-pro', name: 'DeepSeek V4-Pro-0813', desc: '1M 上下文 / 384K 输出 / 人民币空闲档参考，高峰 2 倍', cacheHit: 0.15, cacheMiss: 4.5, out: 13.5 },
  { id: 'deepseek-flash', name: 'DeepSeek V4.1-Flash', desc: '官方推荐名称 deepseek-flash / 1M 上下文 / 384K 输出 / 人民币空闲档参考，高峰 2 倍', cacheHit: 0.02, cacheMiss: 1, out: 4 },
  { id: 'deepseek-v4-flash-vision-exp', name: 'DeepSeek V4.1-Flash（旧 Vision 名称）', desc: '旧名称由 V4.1-Flash 服务 / 1M 上下文 / 384K 输出 / 人民币空闲档参考，高峰 2 倍', cacheHit: 0.02, cacheMiss: 1, out: 4 }
] as const

export interface Settings {
  /** Check the fixed public stable feed in packaged desktop builds. */
  autoCheckUpdates?: boolean
  /** null uses provider defaults; maxTokens remains a local planning reserve. */
  outputTokenLimit?: number | null
  agentRunBudget?: import('./agentRunBudget').AgentRunBudgetSettings
  apiKey: string
  /** Current Agent user-owned instruction; persisted without credentials and frozen per run. */
  userPresetPrompt: string
  model: string
  baseUrl: string
  thinkingEnabled: boolean
  reasoningEffort: 'default' | 'low' | 'medium' | 'high' | 'max'
  temperature: number
  topP: number
  maxTokens: number
  toolsEnabled: boolean
  /** Public search and page reading for new Agent runs. Older preferences default on. */
  webAccessEnabled?: boolean
  docDir: string
  historyBudgetTokens: number
  /** agent 工作目录（沙箱根） */
  workDir: string
  permissionWorkspaceRoot?: string
  /** 计划模式：复杂任务先出计划，批准后执行 */
  planMode: boolean
  /** 权限模式快捷入口（与 permissions.json 同步） */
  permissionMode: PermissionMode
  /** 对话成书模式：勾选后对话即为创作累积，可一键成书 */
  novelMode: boolean
  /** Ren'Py Galgame 模式 */
  galgame: GalgameConfig
  /** WP7 实验叙事增强：仅在新任务接受时读取；缺省/异常值由主进程归零。 */
  wp7FeatureFlags: Wp7FeatureFlags
  /** R4.3 Gate 6：provider 能力覆盖（可选；危险值被主进程校验拒绝） */
  providerCapabilityOverride?: { contextWindowTokens?: number; maxOutputTokens?: number; supportsTools?: boolean; supportsThinking?: boolean }
  /** R4.4 Gate 5：完成校验总 token 预算（可选；0/缺省=无预算限制；usage ledger 真实累计） */
  completionTokenBudget?: number
  /** R4.4 Gate 5：完成校验墙钟预算 ms（可选；0/缺省=无限制） */
  completionWallClockMs?: number
  /** 长文默认启用；普通 Agent 永远不应用。运行开始后冻结进 execution snapshot。 */
  strongConstraintEnabled?: boolean
  strongConstraintLevel?: StrongConstraintLevel
  /** R42：主题是否作为完成边界；缺省时从旧 strongConstraint* 迁移。 */
  themeLockMode?: ThemeLockMode
  /** R42：控制审校对文风的干预程度，默认 high（只修明确命中的局部）。 */
  expressionFreedom?: ExpressionFreedom
  /** 自动识别说教式尾段并交给局部审校；不是用户事实硬约束。 */
  antiMoralizingEnabled?: boolean
  strongConstraintPerspective?: StrongConstraintPerspective
  strongConstraintGenre?: string
  strongConstraintMustKeep?: string
  strongConstraintAvoid?: string
}

/** Durable execution plan for a long-form run.  The plan is frozen with the
 * run snapshot so a resumed run cannot silently change its chapter or turn
 * budget when global settings change. */
export interface LongWriteChapterPlan {
  id: string
  index: number
  startChars: number
  targetChars: number
  endChars: number
}

export interface LongWritePlan {
  schemaVersion: 1
  targetChars: number
  modelOutputTokens: number
  estimatedCharsPerTurn: number
  chapterTargetChars: number
  safetyTurnsPerChapter: number
  chapters: LongWriteChapterPlan[]
  maxTurns: number
  /** Diagnostic estimate only; automatic longwrite completion has no hard token cap. */
  estimatedCompletionTokens: number
  contextRecentChars: number
  contextSummaryChars: number
  maxContextSummaryChars: number
}

export interface SceneContractTargetChars {
  min: number
  ideal: number
  max: number
}

export interface SceneContractThreadAction {
  threadId: string
  action: 'open' | 'advance' | 'delay' | 'close'
}

/**
 * A beat is kept as both the human-authored sentence (`source`) and a small
 * structured envelope.  The envelope is deliberately conservative: empty
 * arrays mean that a field was not explicit in the outline, rather than that
 * the verifier may invent one.  This lets the local verifier handle the
 * unambiguous parts of a beat and leave the genuinely semantic remainder to a
 * bound model evidence record.
 */
export type SceneBeatModality = 'actual' | 'reported' | 'hypothetical' | 'dream' | 'memory' | 'planned' | 'unknown'

/**
 * Predicate-local actuality/assertion.  `modality` is retained as the coarse
 * v1.2 field used by older snapshots; this field is the authoritative answer
 * to whether a particular event changed the story world.  In particular,
 * mentioning a transfer inside a request, quote, attempt, or refusal must not
 * be treated as a completed transfer.
 */
export type SceneBeatActuality =
  | 'asserted_actual'
  | 'negated'
  | 'planned'
  | 'reported'
  | 'remembered'
  | 'dreamed'
  | 'conditional'
  | 'imperative'
  | 'requested'
  | 'attempted'
  | 'near_miss'
  | 'pretended'
  | 'quoted'
  | 'refused'
  | 'proposed'
  | 'questioned'
  | 'threatened'
  | 'unknown'

export type SceneBeatAssertion = 'asserted' | 'negated' | 'non_asserted' | 'unknown'

/**
 * Explicit event-role evidence.  These are intentionally arrays because a
 * single authored beat may contain a coordinated subject or more than one
 * patient.  An empty role is not an invitation to infer the first character;
 * for directional actions it is an unresolved binding that must remain
 * unknown/pending until a user or a bound model evidence record resolves it.
 */
export interface SceneBeatSemanticRoles {
  agent: string[]
  patient: string[]
  source: string[]
  recipient: string[]
  beneficiary: string[]
}

/** A lexical actuality cue and the predicate span it can (or cannot) govern.
 * Offsets are UTF-16 offsets into the scene text.  `relation=outside` is
 * retained deliberately: it explains why a cue in an earlier adverbial or
 * coordinated event did not affect this predicate. */
export interface SceneBeatCueSpan {
  actuality: SceneBeatActuality
  text: string
  start: number
  end: number
  scopeStart: number
  scopeEnd: number
  relation: 'governs' | 'outside' | 'ambiguous'
  rationale: string
}

/** Predicate-local scope confidence.  A low-confidence scope is never
 * allowed to project a current character/object state. */
export interface SceneBeatEventScope {
  start: number
  end: number
  confidence: 'high' | 'uncertain'
  rationale: string
}

/**
 * A local, predicate-anchored event inside an authored beat.  Keeping these
 * groups on the frozen requirement prevents a comma-linked sentence from
 * being reduced to the first verb (for example, “取出钥匙，递给沈遥”).
 * Offsets are UTF-16 offsets, matching JavaScript string indices and the
 * evidence span convention used by the renderer.
 */
export interface SceneBeatEventGroup {
  eventId: string
  source: string
  action: string
  surface: string
  start: number
  end: number
  actor: string[]
  agent: string[]
  patient: string[]
  sourceRole: string[]
  recipient: string[]
  beneficiary: string[]
  object: string[]
  location: string[]
  result: string[]
  time: string[]
  negation: boolean
  modality: SceneBeatModality
  /** Predicate-local actuality; absent only in legacy pre-v1.2.4 snapshots. */
  actuality: SceneBeatActuality
  assertion: SceneBeatAssertion
  /** Exact predicate span in the containing scene/beat text. */
  predicateSpan?: { start: number; end: number; text: string }
  /** All cues considered for this predicate, including cues proven outside
   * the predicate scope for auditability. */
  cueSpans?: SceneBeatCueSpan[]
  scope?: SceneBeatEventScope
}

export interface SceneBeatRequirement {
  beatId: string
  source: string
  actor: string[]
  action: string[]
  object: string[]
  location: string[]
  result: string[]
  time: string[]
  negation: boolean
  modality: SceneBeatModality
  /** The first-class predicate-local actuality of this requirement. */
  actuality: SceneBeatActuality
  assertion: SceneBeatAssertion
  /** New contracts carry explicit semantic roles; absent is accepted only for
   * legacy pre-v1.2.2 snapshots and is treated as unresolved by directional
   * extraction. */
  agent?: string[]
  patient?: string[]
  /** Entity/source side of a transfer; `source` remains the authored beat text. */
  sourceRole?: string[]
  recipient?: string[]
  beneficiary?: string[]
  /** Predicate-local evidence groups. Optional for legacy snapshots. */
  eventGroups?: SceneBeatEventGroup[]
}

export type SceneBeatEvidenceStatus = 'satisfied' | 'missing' | 'uncertain' | 'contradicted'

export interface SceneBeatAgentBinding {
  name: string
  relation: 'explicit' | 'pronoun' | 'body_owner' | 'instrument_owner'
  mention: { spanIndex: number; text: string }
  antecedent?: { spanIndex: number; text: string }
}

export interface SceneBeatPartEvidence {
  partId: string
  status: SceneBeatEvidenceStatus
  spanIndexes: number[]
}

/** A critic's semantic reading of one exact, local narrated predicate. The
 * predicate is an authored surface, not a closed lexical action dictionary. */
export interface SceneBeatSemanticEventEvidence {
  spanIndex: number
  predicate: string
  agent: string[]
  patient: string[]
  sourceRole?: string[]
  recipient?: string[]
  beneficiary?: string[]
  actuality: SceneBeatActuality
  assertion: SceneBeatAssertion
  negation: boolean
  agentBindings?: SceneBeatAgentBinding[]
  partIds?: string[]
}

/** Structured model evidence is only admissible when it is bound to the full
 * accepted scene prefix.  Unbound/invalid evidence is ignored by the caller
 * and can never turn a deferred scene into a completed one. */
export interface SceneBeatModelEvidence {
  beatId: string
  scenePrefixHash: string
  status: SceneBeatEvidenceStatus
  actor?: string[]
  action?: string[]
  object?: string[]
  location?: string[]
  result?: string[]
  time?: string[]
  negation?: boolean
  modality?: SceneBeatModality
  /** Optional for legacy model evidence; deterministic local evidence remains authoritative. */
  actuality?: SceneBeatActuality
  assertion?: SceneBeatAssertion
  spans?: Array<{ start: number; end: number; text: string; startCp?: number; endCp?: number; source?: 'candidate' | 'scene_prefix' }>
  rationale?: string
  /** Explicit role bindings for directional events. */
  agent?: string[]
  patient?: string[]
  sourceRole?: string[]
  recipient?: string[]
  beneficiary?: string[]
  /** Predicate-local deterministic evidence copied into completion decisions. */
  eventGroups?: SceneBeatEventGroup[]
  /** Versioned semantic readings additionally bind the exact frozen source
   * and candidate; absent means the original, stricter lexical evidence path. */
  semanticVersion?: 1 | 2
  contractHash?: string
  candidateHash?: string
  requiredSource?: string
  semanticEvents?: SceneBeatSemanticEventEvidence[]
  partEvidence?: SceneBeatPartEvidence[]
}

export interface SceneContractStateChange {
  key: string
  description: string
}

/**
 * A frozen semantic writing unit derived from a confirmed Grill Me outline.
 * Generation chunks remain an implementation detail of LongWritePlan; they
 * must not change this contract's identity or order.
 */
export interface SceneContract {
  schemaVersion: 1
  contractId: string
  sceneId: string
  sectionId: string
  revision: number
  order: number
  title: string
  objective: string
  activeCharacterIds: string[]
  /** Alias retained for consumers that call the participants characterIds. */
  characterIds: string[]
  povCharacterId?: string
  locationId?: string
  storyTime?: string
  desire: string
  obstacle: string
  conflict: string
  expectedTurn?: string
  reveal?: string
  requiredBeatIds: string[]
  /** Structured form of `mustHappen`; optional only for pre-R60 snapshots. */
  requiredBeatEvidence?: SceneBeatRequirement[]
  requiredFactIds: string[]
  forbiddenFactIds: string[]
  mustHappen: string[]
  mustNotHappen: string[]
  handoff: string
  threadActions: SceneContractThreadAction[]
  expectedStateChanges: SceneContractStateChange[]
  targetChars: SceneContractTargetChars
  acceptanceCriteria: string[]
  sourceIds: string[]
  outlineHash: string
  frozenHash: string
}

export interface SceneContractPlan {
  schemaVersion: 1
  source: 'grill_me'
  outlineHash: string
  outlineRevision: number
  targetChars: number
  contracts: SceneContract[]
  planHash: string
}

/** Durable scene lifecycle.  Character counts are advisory budget signals;
 * only this state decides which scene is active after a restart. */
export type SceneLifecycle = 'planned' | 'writing' | 'candidate' | 'accepted' | 'committed'

export interface SceneCompletionDecision {
  schemaVersion: 1
  decisionId: string
  sceneId: string
  contractId: string
  contractHash: string
  candidateSegmentId: string
  candidateHash: string
  candidateCharCount: number
  status: 'complete' | 'defer'
  requiredBeatIds: string[]
  satisfiedBeatIds: string[]
  missingBeatIds: string[]
  evidenceHash: string
  decidedAt: number
  /** Hash of the complete accepted scene prefix used by the verifier. */
  scenePrefixHash?: string
  /** Structured beat evidence copied into the durable decision when present. */
  beatEvidence?: SceneBeatModelEvidence[]
}

export interface SceneStateRecord {
  schemaVersion: 1
  runId: string
  sceneId: string
  sectionId: string
  contractId: string
  contractHash: string
  order: number
  lifecycle: SceneLifecycle
  revision: number
  candidateSegmentId: string | null
  candidateHash: string | null
  acceptedSegmentId: string | null
  acceptedHash: string | null
  completionDecision: SceneCompletionDecision | null
  completionEvidenceHash: string | null
  createdAt: number
  updatedAt: number
  completedAt: number | null
  committedAt: number | null
}

export interface SceneStateTransitionInput {
  runId: string
  sceneId: string
  contractId: string
  contractHash: string
  expectedRevision: number
  from: SceneLifecycle | SceneLifecycle[]
  to: SceneLifecycle
  candidateSegmentId?: string | null
  candidateHash?: string | null
  acceptedSegmentId?: string | null
  acceptedHash?: string | null
  completionDecision?: SceneCompletionDecision | null
  completionEvidenceHash?: string | null
  at: number
}

export interface SceneCommitInput {
  acceptance: ManuscriptAcceptanceInput
  contractId: string
  contractHash: string
  expectedSceneRevision: number
  decision: SceneCompletionDecision
  completionEvidenceHash: string
  stateDelta: NarrativeStateDelta
  /**
   * Complete, ordered identity of the scene being committed.  The repository
   * can derive this for legacy callers, but production callers should provide
   * it so a stale prefix is rejected before the transaction is published.
   */
  manifest?: SceneCommitManifest
  /** Source-bound projection published after the canonical ledger revision is
   * allocated, but before the surrounding commit transaction is released. */
  projection?: {
    card: SceneMemoryCard
    context: SceneMemoryCardValidationContext
  }
  /** Exact cursor/head/epoch observed before the provider result was made. */
  expectedLedgerFence?: {
    expectedRevision: number
    expectedEpoch: number
    expectedHeadRevision: number
    expectedHeadHash: string | null
  }
  committedAt: number
}

export interface SceneCommitManifestSegment {
  segmentId: string
  contentHash: string
  charCount: number
  chunkIndex: number
  revision: number
}

/** Immutable commit identity for an entire accepted scene, not just its tail. */
export interface SceneCommitManifest {
  schemaVersion: 1
  runId: string
  sceneId: string
  contractId: string
  contractHash: string
  acceptedSegments: SceneCommitManifestSegment[]
  sceneContentHash: string
  sceneCharCount: number
  completionDecisionHash: string
  stateDeltaHash: string
}

export type NarrativeLedgerChangeKind =
  | 'timeline_event'
  | 'character_state'
  | 'object_state'
  | 'relationship'
  | 'knowledge'
  | 'foreshadow'

export type NarrativeForeshadowLifecycle = 'open' | 'advanced' | 'delayed' | 'resolved' | 'abandoned'

/** Semantic roles whose binding may be explicitly preserved as unknown at the
 * user review boundary.  Unknown is a recorded state, never an omitted
 * field or an inferred first character. */
export type NarrativeSemanticRole = 'agent' | 'patient' | 'source' | 'recipient' | 'beneficiary'

export interface NarrativeStateChangeBase {
  changeId: string
  revision: number
  kind: NarrativeLedgerChangeKind
  entityId: string
  runId: string
  sceneId: string
  acceptedSegmentId: string
  acceptedContentHash: string
  contractHash: string
}

export interface NarrativeTimelineEventChange extends NarrativeStateChangeBase {
  kind: 'timeline_event'
  eventType: string
  actorIds: string[]
  objectIds: string[]
  locationId: string | null
  storyTime: string | number | null
  causeEventIds: string[]
  consequenceEventIds: string[]
  summary: string
  /** Predicate-local event semantics; old rows may omit this field. */
  actuality?: SceneBeatActuality
  assertion?: SceneBeatAssertion
  /** Present only when a review decision explicitly preserves one or more
   * unresolved role bindings as unknown. */
  unknownRoles?: NarrativeSemanticRole[]
}

export interface NarrativeCharacterStateChange extends NarrativeStateChangeBase {
  kind: 'character_state'
  characterId: string
  status: string | null
  locationId: string | null
  goals: string[]
  physicalState: string | null
  emotionalBaseline: string | null
}

export interface NarrativeObjectStateChange extends NarrativeStateChangeBase {
  kind: 'object_state'
  objectId: string
  ownerId: string | null
  holderId: string | null
  /**
   * Directional prose with no explicit agent/recipient is retained as an
   * unknown binding instead of assigning the first visible character.
   */
  holderStatus?: 'known' | 'unknown' | 'pending_review'
  locationId: string | null
  condition: string | null
}

export interface NarrativeRelationshipChange extends NarrativeStateChangeBase {
  kind: 'relationship'
  fromCharacterId: string
  toCharacterId: string
  dimension: string
  value: number | string
  reason: string
}

/**
 * A fact is a versioned, addressable piece of story knowledge.  Narrative
 * knowledge edges point at this registry entry instead of making a bare
 * opaque id the only source of meaning.  The registry is intentionally
 * provider-independent: a fact can originate in Grill Me, a committed scene,
 * or an explicit user edit and can later be superseded without rewriting
 * history.
 */
export type NarrativeFactSourceType = 'answer' | 'scene' | 'segment' | 'user'
export type NarrativeFactStatus = 'active' | 'superseded' | 'retracted' | 'pending_review'
export type NarrativeFactVisibility = 'public' | 'restricted' | 'private'

export interface NarrativeFactSource {
  sourceType: NarrativeFactSourceType
  sourceId: string
  sourceSlotId?: string | null
  sourceRevision?: number | null
  sourceHash: string
}

export interface NarrativeFact {
  schemaVersion: 1
  factId: string
  version: number
  sessionId: string
  runId: string | null
  canonicalStatement: string
  canonicalHash: string
  aliases: string[]
  entities: string[]
  sourceSlotIds: string[]
  sources: NarrativeFactSource[]
  validFrom: string | number | null
  validUntil: string | number | null
  confidence: number
  status: NarrativeFactStatus
  visibility: NarrativeFactVisibility
  knowers: string[]
  provenanceHash: string
  createdAt: number
  updatedAt: number
}

/** Inline, hash-bound reference carried by a knowledge edge. */
export interface NarrativeFactReference {
  factId: string
  version: number
  canonicalStatement: string
  canonicalHash: string
  provenanceHash: string
}

export interface NarrativeKnowledgeChange extends NarrativeStateChangeBase {
  kind: 'knowledge'
  factId: string
  knowerId: string
  stance: 'knows' | 'believes' | 'disbelieves' | 'unknown'
  certainty: number
  sourceSceneId: string
  effectiveTime: string | number | null
  confidence: number
  /**
   * Optional for reading pre-R61 deltas.  New producer paths should always
   * carry this registry reference; the repository rejects a new reference
   * whose hash does not resolve to the durable fact.
   */
  factRef?: NarrativeFactReference
}

export interface NarrativeForeshadowChange extends NarrativeStateChangeBase {
  kind: 'foreshadow'
  threadId: string
  lifecycle: NarrativeForeshadowLifecycle
  reason: string | null
  setupChangeId: string | null
  payoffChangeId: string | null
}

export type NarrativeStateChange =
  | NarrativeTimelineEventChange
  | NarrativeCharacterStateChange
  | NarrativeObjectStateChange
  | NarrativeRelationshipChange
  | NarrativeKnowledgeChange
  | NarrativeForeshadowChange

/** Stable story ownership for the durable narrative ledger. */
export interface NarrativeLedgerScope {
  schemaVersion: 1
  storyId: string
  projectId: string
  branchId: string
}

/** A run is provenance for a story revision, never the revision owner. */
export interface NarrativeLedgerScopeInput extends NarrativeLedgerScope {
  parentRevision?: number | null
  parentBranchId?: string | null
}

export interface NarrativeLedgerScopeInfo extends NarrativeLedgerScope {
  parentRevision: number
  parentBranchId: string | null
  currentRevision: number
  highWatermark: number
  /** Epoch observed by the run that requested this view. */
  validityEpoch: number
  /** Current authoritative epoch at the branch head. */
  headValidityEpoch: number
  /** False when the run cursor belongs to an invalidated pre-retraction epoch. */
  epochValid: boolean
}

export interface NarrativeStateDelta {
  schemaVersion: 1
  runId: string
  sceneId: string
  acceptedSegmentId: string
  acceptedContentHash: string
  contractHash: string
  changes: NarrativeStateChange[]
  deltaHash: string
}

/** Content-addressed evidence used by the v1.2.5 scene-memory projection. */
export type SceneMemoryEvidenceKind = 'source_span' | 'contract' | 'ledger'

export interface SceneMemoryEvidenceRef {
  kind: SceneMemoryEvidenceKind
  id: string
  hash: string
  /** Required and equal to id for kind=source_span; absent for contract/ledger refs. */
  spanId?: string
}

/** Accepted segment bytes plus the commit identity that made them canonical. */
export interface SceneMemorySourceSegment {
  segmentId: string
  content: string
  contentHash: string
  segmentRevision: number
  status: ManuscriptSegmentStatus
  sceneId: string
  commitId: string
  commitManifestHash: string
  chunkIndex: number
}

/** UTF-16 offsets intentionally match JavaScript string slicing and renderer spans. */
export interface SceneMemorySourceSpan {
  spanId: string
  segmentId: string
  segmentHash: string
  segmentRevision: number
  manifestHash: string
  startUtf16: number
  endUtf16: number
  text: string
  spanHash: string
}

export interface EvidenceBoundText {
  text: string
  evidence: SceneMemoryEvidenceRef[]
}

export interface EvidenceBoundFact {
  factId: string
  statement: string
  evidence: SceneMemoryEvidenceRef[]
}

export interface EvidenceBoundBeliefChange {
  characterId: string
  from: string | null
  to: string | null
  evidence: SceneMemoryEvidenceRef[]
}

export interface EvidenceBoundRelationshipChange {
  fromCharacterId: string
  toCharacterId: string
  dimension: string
  from: string | null
  to: string | null
  evidence: SceneMemoryEvidenceRef[]
}

export type SceneMemoryThreadLifecycle = 'open' | 'advanced' | 'delayed' | 'resolved' | 'abandoned'

/** One immutable, content-addressed ledger fact that may corroborate a card. */
interface SceneMemoryLedgerClaimBase {
  id: string
  hash: string
  revision: number
  validityEpoch: number
  storyId: string
  projectId: string
  branchId: string
  stateDeltaHash: string
  commitManifestHash: string
}

export interface SceneMemoryRelationshipLedgerClaim extends SceneMemoryLedgerClaimBase {
  kind: 'relationship'
  fromCharacterId: string
  toCharacterId: string
  dimension: string
}

export interface SceneMemoryForeshadowLedgerClaim extends SceneMemoryLedgerClaimBase {
  kind: 'foreshadow'
  threadId: string
  lifecycle: SceneMemoryThreadLifecycle
}

export type SceneMemoryLedgerClaim = SceneMemoryRelationshipLedgerClaim | SceneMemoryForeshadowLedgerClaim

export interface EvidenceBoundThreadChange {
  threadId: string
  lifecycle: SceneMemoryThreadLifecycle
  summary: string | null
  evidence: SceneMemoryEvidenceRef[]
}

export interface SceneMemoryParticipant {
  id: string
  role: string
  evidence: SceneMemoryEvidenceRef[]
}

export interface SceneMemoryEmbedding {
  status: 'ready' | 'unavailable' | 'stale'
  version: string | null
  modelId: string | null
  dimensions: number | null
  vectorHash: string | null
}

export type SceneMemoryCardStatus = 'canonical' | 'partial' | 'pending_review' | 'legacy_unverified'

/**
 * Rebuildable, source-bound memory projection for one committed scene.  The
 * fieldEvidence map is the explicit binding for scalar/list fields whose
 * values cannot carry an evidence array in the compact public shape.
 */
export interface SceneMemoryCard {
  schemaVersion: 1
  status: SceneMemoryCardStatus
  cardId: string
  storyId: string
  projectId: string
  branchId: string
  validityEpoch: number
  storyRevision: number
  runId: string
  sceneId: string
  sceneOrder: number
  contractId: string
  contractHash: string
  sceneContentHash: string
  commitManifestHash: string
  stateDeltaHash: string

  povCharacterId: string | null
  participants: SceneMemoryParticipant[]
  locations: string[]
  objects: string[]
  dramaticQuestion: string | null
  valueShift: { from: string; to: string } | null
  decisiveAction: string | null
  turn: string | null
  cost: string | null

  factsEstablished: EvidenceBoundFact[]
  beliefChanges: EvidenceBoundBeliefChange[]
  relationshipChanges: EvidenceBoundRelationshipChange[]
  threads: EvidenceBoundThreadChange[]
  motifs: EvidenceBoundText[]
  distinctivePhrases: EvidenceBoundText[]

  sourceSegmentIds: string[]
  sourceSpans: SceneMemorySourceSpan[]
  embedding: SceneMemoryEmbedding
  /** Evidence for scalar/list fields, keyed by the field and stable value. */
  fieldEvidence: Record<string, SceneMemoryEvidenceRef[]>
  cardHash: string
  createdAt: number
}

export type SceneMemoryCardBuildInput = Omit<SceneMemoryCard, 'sourceSegmentIds' | 'sourceSpans' | 'embedding' | 'fieldEvidence' | 'cardHash' | 'createdAt'> & {
  sourceSegments: SceneMemorySourceSegment[]
  sourceSpans: SceneMemorySourceSpan[]
  sourceSegmentIds?: string[]
  embedding?: SceneMemoryEmbedding
  fieldEvidence: Record<string, SceneMemoryEvidenceRef[]>
  createdAt?: number
  expectedScope: Pick<SceneMemoryCard, 'storyId' | 'projectId' | 'branchId'>
  expectedValidityEpoch: number
  expectedStoryRevision: number
  expectedContract: { contractId: string; contractHash: string }
  expectedBindings: { sceneContentHash: string; commitManifestHash: string; stateDeltaHash: string }
  ledgerClaims: readonly SceneMemoryLedgerClaim[]
}

export interface SceneMemoryCardValidationContext {
  sourceSegments: readonly SceneMemorySourceSegment[]
  expectedScope: Pick<SceneMemoryCard, 'storyId' | 'projectId' | 'branchId'>
  expectedValidityEpoch: number
  expectedStoryRevision: number
  expectedContract: { contractId: string; contractHash: string }
  expectedBindings: { sceneContentHash: string; commitManifestHash: string; stateDeltaHash: string }
  ledgerClaims: readonly SceneMemoryLedgerClaim[]
}

export interface SceneMemoryCardValidationResult {
  ok: boolean
  errors: string[]
}

export type SceneRecallReasonCode =
  | 'hard_fact'
  | 'causal_parent'
  | 'active_entity'
  | 'open_thread'
  | 'payoff_due'
  | 'pov_knowledge'
  | 'location_object'
  | 'recent_tail'
  | 'semantic_match'
  | 'bm25_support'

export type SceneRecallOmissionReasonCode =
  | 'invalid_scope'
  | 'invalid_source'
  | 'stale'
  | 'retracted'
  | 'old_epoch'
  | 'future_revision'
  | 'current_scene'
  | 'already_injected'
  | 'knowledge_boundary'
  | 'unknown_hard_source'
  | 'legacy_unverified'
  | 'budget_omitted'
  | 'blocked_required_sources'

export interface SceneRecallScope {
  storyId: string
  projectId: string
  branchId: string
  /** Explicitly approved ancestors for cross-branch recall. */
  branchLineage: readonly string[]
  validityEpoch: number
  storyRevision: number
  sceneId: string
  headRevision: number
  headHash: string
  /** Content-addressed snapshot of the complete recall corpus used for this query. */
  expectedSourceCardSetHash: string
}

export interface SceneRecallEmbeddingInput {
  status: 'ready' | 'unavailable' | 'stale'
  version: string | null
  similarity?: number
  vector?: readonly number[]
  dimensions: number | null
  vectorHash: string | null
  sourceCardHash: string
  storyId: string
  projectId: string
  branchId: string
  validityEpoch: number
  storyRevision: number
  headRevision: number
  headHash: string
  authorityHash: string
}

export interface SceneRecallPayoffUrgency {
  value: number
  sourceCardHash: string
  evidenceHash: string
  storyId: string
  projectId: string
  branchId: string
  validityEpoch: number
  storyRevision: number
  headRevision: number
  headHash: string
  authorityHash: string
}

export type SceneRecallDependencyKind = 'fact' | 'beat' | 'entity' | 'location' | 'object' | 'thread' | 'callback'

export interface SceneRecallAuthorityTag {
  key: string
  kind: 'entity' | 'thread' | 'location' | 'object' | 'payoff'
  sourceCardHash: string
  evidenceHash: string
  storyId: string
  projectId: string
  branchId: string
  validityEpoch: number
  storyRevision: number
  headRevision: number
  headHash: string
  authorityHash: string
}

export interface SceneRecallHardDependency {
  key: string
  kind: SceneRecallDependencyKind
  sourceCardHash: string
  evidenceHash: string
  storyId: string
  projectId: string
  branchId: string
  validityEpoch: number
  storyRevision: number
  headRevision: number
  headHash: string
  authorityHash: string
}

export interface SceneRecallCausalEdge {
  fromCardId: string
  toCardId: string
  relationType: 'depends_on' | 'causes' | 'pays_off'
  sourceCardHash: string
  evidenceHash: string
  storyId: string
  projectId: string
  branchId: string
  validityEpoch: number
  storyRevision: number
  headRevision: number
  headHash: string
  authorityHash: string
}

export interface SceneRecallKnowledgeBoundary {
  status: 'known' | 'unknown' | 'not_applicable'
  povCharacterId: string | null
  sourceCardHash: string
  evidenceHash: string
  storyId: string
  projectId: string
  branchId: string
  validityEpoch: number
  storyRevision: number
  headRevision: number
  headHash: string
  authorityHash: string
  unknownEntityIds?: readonly string[]
  unknownHardSource?: boolean
}

/** A card plus deterministic, rebuildable graph/search metadata.  This is a
 * pure WP3 input; it is deliberately not a database row or a write port. */
export interface SceneRecallCorpusItem {
  card: SceneMemoryCard
  sourceSegments?: readonly SceneMemorySourceSegment[]
  sourceValidated?: boolean
  authority: {
    storyId: string
    projectId: string
    branchId: string
    branchLineage: readonly string[]
    validityEpoch: number
    storyRevision: number
    headRevision: number
    headHash: string
    sourceSnapshotHash: string
    cardHash: string
    authorityHash: string
  }
  stale?: boolean
  retracted?: boolean
  hardDependencies?: readonly SceneRecallHardDependency[]
  causalEdges?: readonly SceneRecallCausalEdge[]
  entityTags?: readonly SceneRecallAuthorityTag[]
  threadTags?: readonly SceneRecallAuthorityTag[]
  payoffTags?: readonly SceneRecallAuthorityTag[]
  payoffUrgency?: SceneRecallPayoffUrgency
  povKnowledge?: SceneRecallKnowledgeBoundary
  knowledgeBoundary?: SceneRecallKnowledgeBoundary
  unknownHardSource?: boolean
  embedding?: SceneRecallEmbeddingInput
}

export interface SceneRecallQuery {
  scope: SceneRecallScope
  hardDependencyKeys?: readonly string[]
  requiredCardIds?: readonly string[]
  requiredFactIds?: readonly string[]
  /** Canonical registry facts already authenticated outside the card corpus.
   * Their identities remain in the deterministic query hash, but they do not
   * require a historical SceneMemoryCard to exist (important for scene one). */
  requiredFacts?: readonly SceneRecallRequiredFact[]
  requiredBeatIds?: readonly string[]
  activeEntityIds?: readonly string[]
  locations?: readonly string[]
  objects?: readonly string[]
  entityIds?: readonly string[]
  threadIds?: readonly string[]
  openThreadIds?: readonly string[]
  payoffThreadIds?: readonly string[]
  causalSeedCardIds?: readonly string[]
  queryText?: string
  queryTerms?: readonly string[]
  alreadyInjectedCardIds?: readonly string[]
  povCharacterId?: string | null
  knownEntityIds?: readonly string[]
  embedding?: { version: string; vector?: readonly number[] }
  tokenizerVersion: string
  bm25Version: string
  topK: number
  budget?: number
}

/** Source-bound fact material used by the v2 Working Set.  `requiredId` is
 * the SceneContract source slot (or direct fact id); the remaining fields are
 * copied from a validated NarrativeFact without prose inference. */
export interface SceneRecallRequiredFact {
  requiredId: string
  factId: string
  version: number
  canonicalStatement: string
  canonicalHash: string
  provenanceHash: string
  sourceSlotIds: string[]
}

export type SceneRecallSortTuple = [number, number, number, number, number, number, number, number, number, string]

export interface SceneRecallCandidate {
  cardId: string
  card: SceneMemoryCard
  sortTuple: SceneRecallSortTuple
  reasonCodes: SceneRecallReasonCode[]
}

export interface SceneRecallOmission {
  cardId: string
  reason: SceneRecallOmissionReasonCode
}

export interface SceneRecallIndexInput {
  corpus: readonly SceneRecallCorpusItem[]
  query: SceneRecallQuery
}

export interface SceneRecallIndexResult {
  queryHash: string
  indexHash: string
  status: 'ready' | 'blocked_required_sources'
  candidates: SceneRecallCandidate[]
  omitted: SceneRecallOmission[]
  blockedHardDependencies: string[]
}

/** The immutable, repository-authenticated input to the Scene Working Set.
 * The compiler must never assemble a set from a free-form summary or an
 * unbound projection. */
export interface SceneRecallCorpusSnapshot {
  schemaVersion: 1
  runId: string
  sceneId: string
  scope: SceneRecallScope
  /** Normalized hash of the complete per-card source snapshot set; this is
   * distinct from each item's authority.sourceSnapshotHash. */
  sourceSnapshotHash: string
  sourceCardSetHash: string
  corpus: readonly SceneRecallCorpusItem[]
  /**
   * The bounded, repository-authenticated tail of the active scene.  It is
   * deliberately outside the recall corpus: the current scene is not yet a
   * committed SceneMemoryCard, but a durable partial must still be carried
   * into the next outer writer round.
   */
  currentSceneTail?: SceneRecallCurrentSceneTail
}

export interface SceneRecallCurrentSceneTailSegment {
  segmentId: string
  runId: string
  /** Null only for an authenticated post-scene closing continuation. */
  sceneId: string | null
  contractHash: string
  status: 'accepted' | 'partial'
  content: string
  contentHash: string
  /** Hash of the complete durable segment body before bounded suffixing. */
  fullContentHash: string
  /** Code-point source span represented by content. */
  sourceStartCp: number
  sourceEndCp: number
  charCount: number
  chunkIndex: number
  revision: number
}

export interface SceneRecallCurrentSceneTail {
  schemaVersion: 1
  sceneId: string
  contractHash: string
  /** Repository proves all original scenes committed; the last contract is
   * a completed boundary, not permission to reopen that scene. */
  closing?: true
  /** Full accepted-prefix cursor hash, binding the bounded tail to the
   * complete durable accepted manuscript without sending that manuscript. */
  acceptedPrefixHash: string
  /** Hash of the exact ordered segment identities and bodies below. */
  tailHash: string
  segments: readonly SceneRecallCurrentSceneTailSegment[]
}

export type SceneContextSectionId =
  | 'hard_constraints'
  | 'scene_contract'
  | 'pov_state'
  | 'world_state'
  | 'causal_memories'
  | 'payoff'
  | 'exact_anchors'
  | 'recent_tail'
  | 'anti_repetition'
  | 'omitted'

export interface SceneContextSectionInput {
  id: SceneContextSectionId
  text: string
  required?: boolean
  sourceCardIds?: readonly string[]
}

export interface SceneContextCompilerInput {
  snapshot: SceneRecallCorpusSnapshot
  recall: SceneRecallIndexResult
  recallQuery: SceneRecallQuery
  contract: SceneContract
  hardConstraints: string | readonly string[]
  /** Optional section text is deliberately explicit; it is not inferred from
   * prose or POV identifiers. */
  sections?: Partial<Record<SceneContextSectionId, string>>
  requiredSections?: readonly SceneContextSectionInput[]
  /** Registry facts resolved from the structured SceneContract.  They are
   * rendered as required world-state lines and are never budget-omitted. */
  requiredFacts?: readonly SceneRecallRequiredFact[]
  requiredCardIds?: readonly string[]
  budgetTokens?: number
  workingSetId?: string
}

export interface SceneContextSectionDecision {
  id: SceneContextSectionId
  required: boolean
  included: boolean
  estimatedTokens: number
  contentHash: string
  sourceCardIds: string[]
  omissionReason: SceneRecallOmissionReasonCode | null
}

export interface SceneContextManifest {
  schemaVersion: 1
  runId: string
  sceneId: string
  storyId: string
  projectId: string
  branchId: string
  validityEpoch: number
  storyRevision: number
  headRevision: number
  headHash: string
  sourceSnapshotHash: string
  sourceCardSetHash: string
  /** Hash of the bounded current-scene continuation source, if any. */
  currentSceneTailHash?: string
  queryHash: string
  indexHash: string
  contractId: string
  contractHash: string
  contractContentHash: string
  budgetTokens: number
  estimatedTokens: number
  estimatorVersion: string
  sections: SceneContextSectionDecision[]
  omitted: SceneRecallOmission[]
  workingSetHash: string
  manifestHash: string
  /** Hash of the one compiler-produced working-set message only.  The final
   * provider envelope is owned and hashed by runKernelAdapter. */
  workingSetMessageHash: string
}

export interface SceneWorkingSetMessage {
  schemaVersion: 1
  runId: string
  sceneId: string
  manifestHash: string
  messages: Array<{ role: 'system'; content: string }>
  messageHash: string
}

/** Backward-compatible type name; this is only the compiler working-set
 * message, never the final provider envelope. */
export type SceneContextEnvelope = SceneWorkingSetMessage

export type SceneWorkingSetStatus = 'ready' | 'required_overflow' | 'blocked_required_sources'

export interface SceneWorkingSet {
  schemaVersion: 1
  workingSetId: string
  runId: string
  sceneId: string
  storyId: string
  projectId: string
  branchId: string
  validityEpoch: number
  storyRevision: number
  headRevision: number
  headHash: string
  sourceSnapshotHash: string
  sourceCardSetHash: string
  /** Hash of the bounded current-scene continuation source, if any. */
  currentSceneTailHash?: string
  queryHash: string
  indexHash: string
  contractId: string
  contractHash: string
  contractContentHash: string
  budgetTokens: number
  estimatedTokens: number
  estimatorVersion: string
  sections: SceneContextSectionDecision[]
  omitted: SceneRecallOmission[]
  workingSetHash: string
  manifestHash: string
  workingSetMessageHash: string
  status: SceneWorkingSetStatus
}

export interface SceneContextCompileResult {
  workingSet: SceneWorkingSet
  manifest: SceneContextManifest
  workingSetMessage: SceneWorkingSetMessage
}

/** Explicit user boundary for a scene/narrative-state review. */
export type NarrativeSemanticReviewDecision = 'accept_delta' | 'accept_unknown' | 'accept_prose_no_state' | 'reject_rewrite' | 'abandon'

export type NarrativeSemanticReviewStatus = 'pending_review' | 'accepted' | 'unknown_accepted' | 'rewrite_requested' | 'abandoned'

/**
 * Authoritative lifecycle returned by a semantic-review decision.  The
 * decision label and the run lifecycle are deliberately separate: accepting
 * a candidate can complete, pause, fail, or resume a run depending on the
 * completion gate.  Renderer code must consume this snapshot instead of
 * inferring `running` from the decision label.
 */
export type NarrativeReviewRunStatus = 'queued' | 'running' | 'cancelling' | 'cancel_requested' | 'recovery_required' | 'recoverable' | 'waiting_user' | 'completed' | 'failed' | 'cancelled'

export type NarrativeReviewPhase = 'queued' | 'understanding' | 'planning' | 'reading' | 'thinking' | 'executing_tool' | 'writing' | 'validating' | 'waiting_permission' | 'paused' | 'stopping' | 'cancel_requested' | 'recovery_required' | 'completed' | 'failed' | 'cancelled'

export interface NarrativeSemanticReviewDecisionResult {
  ok: true
  /** Kept for the existing IPC callers. */
  status: Exclude<NarrativeSemanticReviewStatus, 'pending_review'>
  decisionStatus: Exclude<NarrativeSemanticReviewStatus, 'pending_review'>
  runStatus: NarrativeReviewRunStatus
  phase: NarrativeReviewPhase
  terminal: boolean
  /** Main may call step only when this is true, and only with runStatus=running. */
  needsStep: boolean
}

export interface NarrativeSemanticReviewDecisionRecord {
  decisionId: string
  runId: string
  decision: NarrativeSemanticReviewDecision
  actor: string
  /** Monotonic packet revision the user decided against. */
  expectedRevision: number
  /** Revision after this decision is durably recorded. */
  revision: number
  packetHash: string
  candidateHash: string
  contractHash: string
  deltaHash: string | null
  note: string
  /** Hash of every semantic decision field, including the effective delta hash. */
  canonicalPayloadHash: string
  decisionHash: string
  createdAt: number
}

export interface NarrativeReviewPendingOperation {
  /** Idempotency key selected by the main process. */
  operationId: string
  decisionId: string
  expectedRevision: number
  /** Null until the decision payload has been durably claimed. */
  canonicalPayloadHash: string | null
  /** False for the deterministic pre-claim identity exposed before the first click. */
  durable?: boolean
}

export interface NarrativeReviewDecisionCapability {
  allowed: boolean
  disabledReason: string | null
}

export type NarrativeReviewDecisionCapabilities = Record<NarrativeSemanticReviewDecision, NarrativeReviewDecisionCapability>

export interface NarrativeSemanticReviewCandidate {
  segmentId: string
  contentHash: string
  charCount: number
  /** Candidate prose is attached only to the renderer response; durable
   * evidence stores the hash and segment identity. */
  content?: string
  acceptedSegments: Array<Pick<SceneCommitManifestSegment, 'segmentId' | 'contentHash' | 'charCount' | 'chunkIndex' | 'revision'>>
}

/** Content-addressed, restart-safe packet exposed by the review UI. */
export interface NarrativeSemanticReviewPacket {
  schemaVersion: 1
  status: NarrativeSemanticReviewStatus
  reason: 'scene_semantic_ambiguous' | 'narrative_state_pending_review'
  runId: string
  sceneId: string
  contractId: string
  contractHash: string
  revision: number
  candidate: NarrativeSemanticReviewCandidate
  acceptedCharsBefore: number
  sceneChars: number
  scenePrefixHash: string
  scenePrefixCharCount: number
  sceneContentHash: string
  /** Full frozen contract, missing/conflict beats, and deterministic/model
   * evaluation are shown together so a decision is auditable. */
  contract: SceneContract
  completionDecision: SceneCompletionDecision
  evaluation: unknown
  missingBeatIds: string[]
  conflictBeatIds: string[]
  reasons: Array<{ code: string; severity: 'blocking' | 'advisory'; evidence: string[]; message: string }>
  proposedDelta: NarrativeStateDelta | null
  /** Main-process action authority; renderer must not recreate review policy. */
  allowedDecisions?: NarrativeReviewDecisionCapabilities
  /** Current presentation only; not persisted or included in packetHash.
   * Main remains the authority when submitting a decision. */
  effectiveAllowedDecisions?: NarrativeReviewDecisionCapabilities
  packetHash: string
  recordedAt: number
  decision?: NarrativeSemanticReviewDecisionRecord
  /** Main-issued identity; durable claims add the canonical payload hash. */
  pendingOperation?: NarrativeReviewPendingOperation
}

export interface NarrativeSemanticReviewDecisionInput {
  runId: string
  decision: NarrativeSemanticReviewDecision
  expectedRevision: number
  /** Main-issued, restart-stable idempotency key. */
  decisionId: string
  delta?: NarrativeStateDelta | null
  note?: string
}

export type NarrativeLedgerEntry = NarrativeStateChange & {
  deltaHash: string
  committedAt: number
  /** Stable story scope and global revision; absent only on pre-v1.2.2 rows. */
  storyId?: string
  projectId?: string
  branchId?: string
  storyRevision?: number
  /** Validity epoch of the accepted ledger node, when read from the story ledger. */
  storyValidityEpoch?: number
}

export interface NarrativeCommitRecord {
  schemaVersion: 1
  runId: string
  sceneId: string
  acceptedSegmentId: string
  acceptedContentHash: string
  contractHash: string
  deltaHash: string
  stateDelta: NarrativeStateDelta
  revision: number
  committedAt: number
}

export type NarrativeQualityFindingCode = 'repetition' | 'character_conflict' | 'pov_conflict' | 'continuity_conflict' | 'meta_language'

export interface NarrativeQualityFinding {
  code: NarrativeQualityFindingCode
  severity: 'blocking' | 'advisory'
  message: string
  evidence: string[]
  startCp: number
  endCp: number
}

export interface NarrativeQualityEvaluation {
  schemaVersion: 1
  candidateHash: string
  acceptedPrefixHash: string
  sceneContractHash: string
  candidateChars: number
  acceptedPrefixChars: number
  status: 'passed' | 'advisory' | 'blocked'
  findings: NarrativeQualityFinding[]
}

export interface LongWriteChapterCheckpoint {
  id: string
  index: number
  targetChars: number
  measuredChars: number
  status: 'pending' | 'writing' | 'completed'
  contentHash: string
  excerpt: string
}

export interface LongWriteCheckpoint {
  schemaVersion: 1
  runId: string
  planHash: string
  measuredChars: number
  currentChapter: number
  chapters: LongWriteChapterCheckpoint[]
  summaryHash: string
  latestTurnId: string | null
  latestTurnSeq: number | null
  updatedAt: number
}

export type StrongConstraintLevel = 'balanced' | 'strict'
export type StrongConstraintPerspective = 'auto' | 'first' | 'third'
export type ThemeLockMode = 'strong' | 'guided' | 'off'
export type ExpressionFreedom = 'high' | 'balanced' | 'controlled'

/** renderer 可见配置随 chat:start 提交；主进程会与用户任务、StoryConfig 合并并冻结。 */
export interface StrongConstraintInput {
  /** 与本次可见用户任务一同提交；plan→execute 时不能退化为计划确认短语。 */
  task?: string
  enabled: boolean
  level: StrongConstraintLevel
  themeLockMode?: ThemeLockMode
  expressionFreedom?: ExpressionFreedom
  antiMoralizingEnabled?: boolean
  perspective: StrongConstraintPerspective
  genre: string
  mustKeep: string
  avoid: string
}

export type StrongConstraintViolationCode =
  | 'topic_anchor_missing'
  | 'must_keep_missing'
  | 'forbidden_expression'
  | 'perspective_mismatch'
  | 'genre_mismatch'
  | 'preachy_ending'

export interface StrongConstraintViolation {
  code: StrongConstraintViolationCode
  category: '主题' | '必须保持' | '禁止项' | '叙事视角' | '体裁' | '说教式收尾'
  message: string
  evidence: string[]
  /** 用户明示事实/禁项/格式/视角才可 hard；自动风格信号一律 soft。 */
  severity?: 'hard' | 'soft'
  /** Unicode code-point offset；供定点修订，不得用 UTF-16 slice。 */
  startCp?: number
  endCp?: number
  source?: 'explicit' | 'deterministic' | 'critic'
  repairIntent?: string
}

/** 运行级不可变约束；不含隐藏推理，只含用户可见事实与可审计规则。 */
export interface StrongConstraintSnapshot {
  schemaVersion: 1
  enabled: boolean
  level: StrongConstraintLevel
  /** 新字段均可选以兼容已经持久化的 snapshot v4；读取端会做确定性迁移。 */
  themeLockMode?: ThemeLockMode
  expressionFreedom?: ExpressionFreedom
  antiMoralizingEnabled?: boolean
  sourceTask: string
  themeAnchors: string[]
  genre: string
  perspective: StrongConstraintPerspective
  tone: string
  forbiddenTerms: string[]
  mustKeep: string[]
  characterAnchors: string[]
  worldAnchors: string[]
  maxRepairAttempts: number
  hash: string
}

export interface GalgameConfig {
  enabled: boolean
  /** Ren'Py 项目根目录（含 game/ 的目录） */
  projectDir: string
  /** Ren'Py SDK 可执行文件路径（renpy.exe） */
  sdkPath: string
}

// ==================== 本地文件导入 ====================

export interface ImportedFileInfo {
  name: string
  path: string
  size: number
  /** 提取出的纯文本 */
  text: string
  truncated: boolean
  /** 原始编码（txt）或提取方式（docx/pdf/epub）；图片素材为 image */
  source: 'utf8' | 'gbk' | 'docx' | 'pdf' | 'epub' | 'zip' | 'xlsx' | 'pptx' | 'image' | 'unknown'
}

// ==================== 小说模式（一键成书） ====================

export type NovelExportFormat = 'md' | 'txt' | 'docx'

export type NovelExportStage = 'collecting' | 'material' | 'exporting' | 'done' | 'error'

/**
 * Legacy export event contract kept for archived R19–R21 partial-artifact tests.
 * It is not part of the current renderer/main long-form entry; Grill Me uses
 * the durable activity/run event contracts instead.
 */
export interface NovelExportEvent {
  sessionId: string
  stage: NovelExportStage
  message?: string
  path?: string
  usage?: Usage | null
  error?: string
}

// ==================== Ren'Py Galgame 项目 ====================

export interface RenpyCharacter {
  /** 变量名，如 sara */
  varName: string
  /** 显示名，如 莎拉 */
  displayName: string
}

export interface RenpyProjectInfo {
  root: string
  scriptDir: string
  scriptFiles: string[]
  characters: RenpyCharacter[]
  /** 好感度等数字变量（$ xxx += 1 模式） */
  affinityVars: string[]
  labels: string[]
  gameName: string | null
}

export interface RenpyLintResult {
  ok: boolean
  output: string
  exitCode: number | null
}

export interface CharacterCard {
  name: string
  role: string
  traits: string
  motivation: string
  voice: string
}

export type StoryIntensity = 'calm' | 'standard' | 'intense' | 'turbulent'
export type StoryStructure = 'three-act' | 'kishotenketsu' | 'episodic'
export type StoryOutputFormat = 'novel' | 'scene' | 'renpy'

export interface StoryConfig {
  enabled: boolean
  genre: string
  intensity: StoryIntensity
  structure: StoryStructure
  outputFormat: StoryOutputFormat
  tone: string
  characters: CharacterCard[]
  worldSetting: string
}

export const GENRES = [
  'Galgame 恋爱日常',
  'Galgame 校园',
  '悬疑推理',
  '热血冒险',
  '科幻',
  '奇幻',
  '都市职场',
  '历史架空',
  '恐怖惊悚',
  '轻小说'
] as const

export const INTENSITY_LEVELS: Record<StoryIntensity, { label: string; desc: string }> = {
  calm: { label: '平缓', desc: '情绪波动 0-6，日常、铺垫为主，冲突温和' },
  standard: { label: '标准', desc: '情绪波动 2-8，常规起承转合，张弛有度' },
  intense: { label: '剧烈', desc: '情绪波动 4-10，高密度冲突与反转，戏剧性强' },
  turbulent: { label: '颠覆', desc: '情绪波动 1-10 大幅震荡，多线反转，意外频发' }
}

export const STRUCTURE_NAMES: Record<StoryStructure, string> = {
  'three-act': '三幕结构',
  kishotenketsu: '起承转合',
  episodic: '单元剧'
}

export const OUTPUT_FORMAT_NAMES: Record<StoryOutputFormat, string> = {
  novel: '小说正文',
  scene: '分镜脚本',
  renpy: 'RenPy 剧本 (.rpy)'
}

// ==================== 会话持久化 ====================

export interface SessionMeta {
  id: string
  title: string
  createdAt: number
  updatedAt: number
  messageCount: number
  model: string
}

export type SessionEventType = 'message' | 'meta'

export interface SessionMessageSnapshot {
  id: string
  role: 'user' | 'assistant'
  content: string
  reasoning: string
  status: 'thinking' | 'streaming' | 'tool' | 'done' | 'stopped' | 'error'
  usage: Usage | null
  rounds: number
  /** 工具调用轨迹（仅存名称用于恢复展示） */
  toolNames: string[]
  /** SQLite 中有属于本条回复的改稿记录；展开时才读取有界回执。 */
  hasEditHistory?: boolean
  /** Count of stored, completed file evidence spans; loaded only on demand. */
  fileEvidenceCount?: number
  /** 计划状态：assistant 消息为待批准计划时为 'pending'，已批准为 'approved' */
  plan?: 'pending' | 'approved' | 'rejected'
  planApproval?: AgentPlanApproval
  createdAt: number
}

export interface SessionEvent {
  ts: number
  type: SessionEventType
  message?: SessionMessageSnapshot
}

/** 附件（用户拖入/选择输入框的本地文件；只携带主进程签发的 FileRef 引用，不携带可授权路径） */
export interface AttachmentRef {
  name: string
  /** 主进程 FileRef 签发的引用 id（原 path 字段已移除，禁止裸路径进运行 IPC） */
  fileRefId: string
  size: number
}

// ==================== 命令模板（/commands） ====================

export interface CommandTemplate {
  id: string
  name: string
  desc: string
  /** 注入输入框的 prompt 模板，支持 {n} 目标字数占位 */
  prompt: string
}

// ==================== 预设系统（Presets） ====================

export interface Preset {
  id: string
  name: string
  desc: string
  /** 应用到输入框的完整 prompt（支持 {n} 目标字数占位） */
  prompt: string
  builtin: boolean
  /** 可选：应用预设时同步的配置 */
  story?: StoryConfig | null
  longMode?: boolean
  targetChars?: number
  category: '创作' | 'Agent' | '文档' | 'RenPy' | '自定义'
}

// ==================== 权限系统 ====================

export type PermissionMode = 'safe' | 'auto' | 'off'
export type PermissionAction = 'allow' | 'deny' | 'ask'
export type PermissionTargetType = 'command' | 'path'

export interface PermissionRule {
  id: string
  type: PermissionTargetType
  /** command: 匹配目标命令（默认字面量前缀；literal:false 时为正则）；path: 路径前缀（大小写不敏感） */
  pattern: string
  action: PermissionAction
  /** false 表示仅此一次（使用后移除） */
  persistent: boolean
  /** false 时 pattern 按正则匹配（默认 true=字面量，防元字符扩权） */
  literal?: boolean
  label?: string
}

export interface PermissionSettings {
  mode: PermissionMode
  rules: PermissionRule[]
}

export interface PermissionDecision {
  action: PermissionAction
  ruleId?: string
  reason: string
}

// ==================== 记忆层 ====================

export interface MemoryInfo {
  brief?: import('./projectBrief').ProjectBrief
  userMemoryPath: string
  userMemoryContent: string
  projectMemoryPath: string | null
  projectMemoryContent: string
}

// ==================== UI 状态 ====================

export interface EditReceipt { before: string; after: string }

export interface SessionEditHistoryPage { events: ToolEventUI[]; nextOffset: number | null }

export interface ToolEventUI {
  sourceCount?: number
  editUndo?: FileEditUndoRef
  editReceipt?: EditReceipt
  id: string
  name: string
  argsPreview: string
  status: 'running' | 'done' | 'error'
  result?: string
  resultOk?: boolean
  durationMs?: number
  exitCode?: number | null
}

export interface UiMessage {
  id: string
  role: 'user' | 'assistant'
  content: string
  reasoning: string
  status: 'thinking' | 'streaming' | 'tool' | 'done' | 'stopped' | 'error'
  error?: string
  usage: Usage | null
  rounds: number
  toolEvents: ToolEventUI[]
  plan?: 'pending' | 'approved' | 'rejected'
  planApproval?: AgentPlanApproval
  /** run 开始时的配置快照（终态判断用 run 自身配置，不读全局） */
  runConfig?: { longMode: boolean; targetChars: number }
}

export type ManuscriptSegmentStatus = 'candidate' | 'accepted' | 'rejected' | 'superseded' | 'partial'

export type AssistantOutputKind = 'prose' | 'meta' | 'refusal' | 'plan' | 'critic' | 'repair'

export interface ManuscriptSegment {
  schemaVersion: 1
  segmentId: string
  runId: string
  sessionId: string
  sourceTurnId?: string
  sectionId?: string
  sceneId?: string
  chunkIndex: number
  revision: number
  status: ManuscriptSegmentStatus
  kind: AssistantOutputKind
  content: string
  contentHash: string
  charCount: number
  supersedesSegmentId?: string
  createdAt: number
  updatedAt: number
  acceptedAt?: number
}

export interface ManuscriptAcceptanceInput {
  runId: string
  segmentId: string
  expectedContentHash: string
  expectedCharCount: number
  evidenceRevision: number
  evidenceIdentity: string
  sceneId: string | null
  acceptedAt: number
  /**
   * A second accepted row in the same slot is never an implicit overwrite.
   * It is legal only when this explicit replacement id is supplied and the
   * repository supersedes that row in the same transaction.
   */
  supersedesAcceptedSegmentId?: string
}

export type LegacyManuscriptBackfillStatus = 'pending' | 'in_progress' | 'complete' | 'unverified'

export type LegacyManuscriptBackfillVerification = 'artifact_exact' | 'legacy_unverified' | 'active_run' | 'artifact_missing' | 'source_mismatch'

export interface LegacyManuscriptBackfillSource {
  sourceTurnId: string
  sourceTurnSeq: number
  sourceContentHash: string
  sourceCharCount: number
}

export interface LegacyManuscriptBackfillState {
  schemaVersion: 1
  runId: string
  status: LegacyManuscriptBackfillStatus
  verification: LegacyManuscriptBackfillVerification
  sourceTurns: LegacyManuscriptBackfillSource[]
  sourceSummaryHash: string
  expectedSourceCount: number
  expectedSegmentCount: number
  expectedAcceptedCharCount: number
  expectedAcceptedContentHash: string | null
  expectedArtifactId: string | null
  expectedArtifactHash: string | null
  expectedArtifactCharCount: number | null
  processedSourceTurnIds: string[]
  acceptedSegmentIds: string[]
  completionMarker: string | null
  createdAt: number
  updatedAt: number
  completedAt: number | null
}

export function estimateTokens(text: string): number {
  if (!text) return 0
  let t = 0
  for (const ch of text) {
    const code = ch.codePointAt(0)!
    if (code >= 0x3000 && code <= 0x9fff) t += 1
    else t += 0.25
  }
  return Math.ceil(t)
}

export interface CommandResult {
  exitCode: number | null
  stdout: string
  stderr: string
  timedOut: boolean
  cancelled?: boolean
  durationMs: number
}
