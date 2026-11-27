import type { FileEvidenceEntry, FileEvidencePage } from '../../shared/fileEvidenceView'
import { projectComposerPerformance, type ComposerPerformanceState } from './composerPerformance'
import type { AgentPlanApproval } from '../../shared/agentPlanPolicy'
import { normalizeLongTarget } from './writingMode'
import { changeComposerSession, clearAcceptedComposerText, updateComposerAttachments, type ComposerDraft } from './composerDrafts'
import { createDraftPersistence } from './draftPersistence'
import { createStreamBatcher, type ChatStreamEvent } from './streamBatcher'
import type { PersistedComposerDraft } from '../../shared/composerDraft'
import { create } from 'zustand'
import { createRunReducer, type ActivityEvent, type RunViewState } from '../../shared/activity'
import { createUsageAccumulator } from '../../shared/usageAccumulator'
import { applyCompletionChunk, type CompletionProgress } from '../../shared/completionProgress'
import { buildDeepWriteExperimentInput } from '../../shared/deepWriteUi'
import {
  deriveWritingRunMode,
  transitionComposerMode,
  transitionLongMode,
  transitionWorkspace,
  type ComposerMode,
  type WorkspaceKey
} from './writingMode'
import type {
  CandidateEvaluation,
  StyleCandidate,
  StyleGenTask,
  StyleJobStage,
  StyleJobState
} from '../../shared/styleV2'
import type {
  AttachmentRef,
  ChunkEvent,
  FileDiff,
  ImportedFileInfo,
  MemoryInfo,
  PermissionMode,
  PermissionSettings,
  SessionMessageSnapshot,
  SessionMeta,
  Settings,
  StrongConstraintInput,
  StoryConfig,
  ToolEventUI,
  UiMessage,
  Usage,
  NarrativeSemanticReviewDecisionInput,
  NarrativeSemanticReviewPacket,
  NarrativeStateDelta,
  NarrativeLedgerScopeInput
} from '../../shared/types'
import type { ContextMode, ContextPinView, ContextPreferenceView, ContextPreviewV1 } from '../../shared/contextV2'
import type { GrillMeState } from '../../shared/grillMe'
import { DEFAULT_WP7_FEATURE_FLAGS, type Wp7FeatureFlags } from '../../shared/narrativeV2'
import type { DesktopCostChallenge } from '../../shared/ipcSchemas'

export type UiToolEvent = ToolEventUI & { diff?: FileDiff | null }

export type { WorkspaceKey, ComposerMode } from './writingMode'
/** 目录设置值：纯字符串（未变更）或 {value, dirRefId}（选择器签发 FileRef，R4-1） */
export type DirSettingValue = string | { value: string; dirRefId: string }
export type SettingsPatch = Omit<Partial<Settings>, 'workDir' | 'docDir' | 'galgame'> & {
  workDir?: DirSettingValue
  docDir?: DirSettingValue
  galgame?: { enabled?: boolean; projectDir?: DirSettingValue; sdkPath?: DirSettingValue }
}

const WP7_FEATURE_FLAG_KEYS = [
  'sceneContractV2',
  'deterministicDirector',
  'dramaticCritic',
  'localizedRevision',
  'reorientation'
] as const satisfies readonly (keyof Wp7FeatureFlags)[]

export function wp7FeatureFlagsForToggle(enabled: boolean): Wp7FeatureFlags {
  return WP7_FEATURE_FLAG_KEYS.reduce((flags, key) => {
    flags[key] = enabled
    return flags
  }, { ...DEFAULT_WP7_FEATURE_FLAGS } as Wp7FeatureFlags)
}

export function wp7FeatureFlagsEnabled(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  const keys = Object.keys(record)
  return keys.length === WP7_FEATURE_FLAG_KEYS.length
    && keys.every((key) => (WP7_FEATURE_FLAG_KEYS as readonly string[]).includes(key))
    && WP7_FEATURE_FLAG_KEYS.every((key) => record[key] === true)
}

export type ToastKind = 'info' | 'success' | 'error'

export type SendResult =
  | { ok: true }
  | { ok: false; reason: string; error?: string }
type UnknownCostChoice = 'accept' | 'cancel' | 'settings'

export interface ToastState {
  id: number
  text: string
  kind: ToastKind
}

/** 附件状态机（R4-6）：parsing（解析中）/ ready（可用）/ failed（失败可重试） */
export type PendingAttachment = AttachmentRef & {
  source?: ImportedFileInfo['source']
  state?: 'parsing' | 'ready' | 'failed'
  failure?: import('../../shared/attachmentPreview').AttachmentPreviewFailure
  notice?: import('./attachmentSummary').AttachmentNotice
}

/**
 * UI attachments carry preview-only state/source fields.  IPC schemas are
 * intentionally strict, so every renderer→main boundary must send only the
 * durable FileRef contract and never leak view state into the wire payload.
 */
function toWireAttachments(attachments: AttachmentRef[] | undefined): AttachmentRef[] {
  return (attachments ?? []).map(({ fileRefId, name, size }) => ({ fileRefId, name, size }))
}

export interface StyleV2CorpusStats {
  chunks: number
  splits: { profile: number; example: number; holdout: number }
  effectiveChars: number
  sceneTypes: Record<string, number>
  exemplarCount: number
  backgroundBaselineId?: string
}

export interface StyleV2BuildState {
  status: 'idle' | 'building' | 'done' | 'failed'
  profileId: string
  stats: StyleV2CorpusStats | null
  error?: string
}

export interface StyleV2ExemplarState {
  status: 'idle' | 'building' | 'done' | 'failed'
  count: number
  error?: string
}

export interface StyleV2JobState {
  status: 'idle' | 'running' | 'done' | 'failed' | 'cancelled'
  jobId: string
  stage: StyleJobStage | null
  task: StyleGenTask | null
  candidates: StyleCandidate[]
  evaluations: CandidateEvaluation[]
  chosenCandidateId: string | null
  chosenText: string
  usageTokens: { skeleton: number; candidates: number; revise: number; total: number }
  version: number
  signature: string
  error?: string
}

export interface StyleSpanRevision {
  candidateId: string
  spanStart: number
  spanEnd: number
  spanText: string
  preserveFacts: string[]
  failedRules: string[]
  leftContext: string
  rightContext: string
}

export type StudioUiMessage = UiMessage & {
  fileEvidence?: { status: 'idle' | 'loading' | 'loaded' | 'error'; nextOffset: number | null; revision: number; entries: FileEvidenceEntry[] }
  editHistory?: { status: 'idle' | 'loading' | 'loaded' | 'error'; nextOffset: number | null }
  runConfig?: { longMode: boolean; targetChars: number }
}

export interface StyleV2State {
  build: StyleV2BuildState
  exemplar: StyleV2ExemplarState
  job: StyleV2JobState
}

export const DEFAULT_STYLEV2: StyleV2State = {
  build: { status: 'idle', profileId: '', stats: null },
  exemplar: { status: 'idle', count: 0 },
  job: {
    status: 'idle',
    jobId: '',
    stage: null,
    task: null,
    candidates: [],
    evaluations: [],
    chosenCandidateId: null,
    chosenText: '',
    usageTokens: { skeleton: 0, candidates: 0, revise: 0, total: 0 },
    version: 0,
    signature: ''
  }
}

export const DEFAULT_STORY: StoryConfig = {
  enabled: false,
  genre: 'Galgame 恋爱日常',
  intensity: 'standard',
  structure: 'three-act',
  outputFormat: 'novel',
  tone: '',
  characters: [],
  worldSetting: ''
}

async function sha256Text(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))
  return [...new Uint8Array(digest)].map((part) => part.toString(16).padStart(2, '0')).join('')
}

export type ChatPhase = 'plan' | 'execute'

interface PendingPlan {
  messageId: string
  planId: string
  planText: string
  approval?: AgentPlanApproval
}

function selectPendingPlan(state: { pendingPlan: PendingPlan | null; messages: UiMessage[] }, messageId?: string): PendingPlan | null {
  if (!messageId || state.pendingPlan?.messageId === messageId) return state.pendingPlan
  const message = state.messages.find(item => item.id === messageId && item.plan === 'pending' && item.planApproval)
  return message ? { messageId: message.id, planId: `plan_${message.planApproval!.runId}`, planText: message.content, approval: message.planApproval } : null
}

export interface RecoveryPrompt {
  runId: string
  message: string
  pendingToolCalls: Array<{ toolCallId: string; name: string; argsJson: string; startedAt?: number }>
}

export interface NarrativeReviewPrompt extends NarrativeSemanticReviewPacket {}

/** R47：从任意长文工作区入口请求进入 Grill Me；真正的 provider 调用由 Composer 消费。 */
export interface GrillLaunchRequest {
  requestId: string
  sessionId: string
  attachments: AttachmentRef[]
  task: string
  targetChars: number
  genre: string
  kind: string
}

/** R4.4 Gate 3：completion 客观进度（UI 只展示结构化事实，不展示模型自述） */
export type { CompletionProgress } from '../../shared/completionProgress'

interface StudioStore {
  messages: StudioUiMessage[]
  sessions: SessionMeta[]
  currentSessionId: string | null
  runs: Record<string, RunViewState>
  /** 跨重启待恢复运行（R4-4 恢复入口） */
  recoverableRuns: Array<{ runId: string; sessionId: string; status: string; phase: string; errorCode?: string; errorMessage?: string; startedAt: number; updatedAt: number; config: Record<string, unknown> }>
  recoveryPrompt: RecoveryPrompt | null
  narrativeReview: NarrativeReviewPrompt | null
  /** R4.4 Gate 3：completion 客观进度（按 run 保存最新 revision） */
  completionProgress: Record<string, CompletionProgress>
  activeRunId: string | null
  inspectorRunId: string | null
  inspectorTab: 'activity' | 'billing' | 'manuscript'
  runListRevision: number
  permissions: PermissionSettings | null
  memory: MemoryInfo | null
  settings: Settings | null
  story: StoryConfig
  longMode: boolean
  targetChars: number
  /** R4.4 Gate 4：角色监护实验开关（默认关闭；A/B/C benchmark 证明优势后才允许默认开启） */
  deepWriteExperimentEnabled: boolean
  /** 本地角色卡属于创作资料，必须由用户明确允许后才进入配置的模型端点。 */
  deepWriteCharacterConsent: boolean
  workspace: WorkspaceKey
  mode: ComposerMode
  sessionCollapsed: boolean
  setWorkspace: (w: WorkspaceKey) => void
  setMode: (m: ComposerMode) => void
  toggleSessionCollapsed: () => void
  setSessionCollapsed: (collapsed: boolean) => void
  running: boolean
  submitting: boolean
  unknownCostPrompt: DesktopCostChallenge | null
  decideUnknownCost: (choice: UnknownCostChoice) => void
  runningId: string | null
  totalUsage: Usage | null
  estimatedContext: Usage | null
  actualUsage: Usage | null
  composerPerformance: ComposerPerformanceState | null
  contextMode: ContextMode
  contextPreferenceRevision: number
  contextPreview: ContextPreviewV1 | null
  /** 最近一次上下文预览失败的可展示原因；只用于恢复/重试提示，不参与运行语义。 */
  contextPreviewError: string | null
  contextPins: ContextPinView[]
  contextLoading: boolean
  /** Explicit branch prepared after a story-ledger epoch invalidation. */
  pendingStoryScope: NarrativeLedgerScopeInput | null
  pendingPlan: PendingPlan | null
  pendingAttachments: PendingAttachment[]
  composerText: string
  composerDrafts: Record<string, ComposerDraft>
  draftSaveError: string | null
  closing: boolean
  flushComposerDrafts: () => Promise<void>
  setComposerText: (text: string) => void
  clearSubmittedText: (sessionId: string, text: string) => void
  styleState: { profiles: any[]; sources: any[]; activeProfileId: string } | null
  loadStyle: () => Promise<void>
  styleBuild: (name: string, sourceIds: string[]) => Promise<void>
  styleSetActive: (profileId: string | null) => Promise<void>
  styleUpdate: (id: string, patch: unknown) => Promise<void>
  styleDeleteProfile: (id: string) => Promise<void>
  styleCheckOverlap: (profileId: string, text: string) => Promise<any | null>
  styleV2: StyleV2State
  buildProfileV2: (sourceIds: string[]) => Promise<void>
  restoreV2Profile: (profileId: string) => Promise<void>
  buildExemplarsV2: (profileId: string) => Promise<void>
  jobStartV2: (profileId: string, task: StyleGenTask) => Promise<string | null>
  jobGetV2: (jobId: string) => Promise<StyleJobState | null>
  jobStopV2: (jobId: string) => Promise<void>
  chooseCandidateV2: (jobId: string, candidateId: string) => Promise<void>
  reviseStyleSpan: (input: { jobId: string; revision: StyleSpanRevision }) => Promise<void>
  presets: any[]
  loadPresets: () => Promise<void>
  savePreset: (preset: any) => Promise<void>
  removePreset: (id: string) => Promise<void>
  applyPreset: (preset: any, onApplied?: (text: string) => void) => void
  grillLaunchRequest: GrillLaunchRequest | null
  toast: ToastState | null
  init: () => Promise<void>
  send: (text: string, attachments?: AttachmentRef[], grillMe?: GrillMeState, quickBypass?: boolean, goalMode?: 'guided' | 'autonomous') => Promise<SendResult>
  stop: () => void
  setPendingAttachments: (list: PendingAttachment[] | ((prev: PendingAttachment[]) => PendingAttachment[]), sessionId?: string) => void
  showToast: (text: string, kind?: ToastKind) => void
  updateSettings: (patch: SettingsPatch) => Promise<boolean>
  updateStory: (patch: Partial<StoryConfig>) => void
  setLongMode: (v: boolean) => void
  setTargetChars: (v: number) => void
  setDeepWriteExperimentEnabled: (v: boolean) => void
  setDeepWriteCharacterConsent: (v: boolean) => void
  loadSessions: () => Promise<void>
  /** 启动扫描跨重启待恢复运行（R4-4） */
  loadRecoverable: () => Promise<void>
  resumeRun: (runId: string, tokenBudget?: number, removeCallLimit?: true, reauthorizeGoal?: true) => Promise<boolean>
  rebaseStoryRun: (runId: string) => Promise<boolean>
  abandonRun: (runId: string) => Promise<boolean>
  decideRecovery: (decision: 'confirm_applied' | 'retry_not_applied' | 'rollback_then_retry' | 'abandon', note?: string) => Promise<boolean>
  closeRecoveryPrompt: () => void
  decideNarrativeReview: (decision: NarrativeSemanticReviewDecisionInput['decision'], delta?: NarrativeStateDelta | null, note?: string) => Promise<boolean>
  closeNarrativeReview: () => void
  newSession: () => void
  /** 返回稳定会话 id（不存在则创建）；附件注册/预览/发送共用（R4-5 scope 一致性） */
  ensureSessionId: () => string
  loadMessageEdits: (messageId: string) => Promise<void>
  loadMessageSources: (messageId: string) => Promise<void>
  switchSession: (id: string) => Promise<void>
  /** 将跨重启恢复出的 Grill 状态绑定到当前 renderer 会话。 */
  restoreGrillSession: (state: GrillMeState) => Promise<void>
  deleteSession: (id: string) => Promise<boolean>
  loadPermissions: () => Promise<void>
  updatePermissions: (patch: Partial<PermissionSettings>) => void
  setPermissionMode: (mode: PermissionMode) => void
  /** 长文起稿统一进入 Grill Me；格式选择只属于后续导出，不参与正文启动。 */
  startGuidedLongwrite: (prompt: string, attachments?: PendingAttachment[]) => boolean
  clearGrillLaunchRequest: (requestId: string) => void
  loadMemory: () => Promise<void>
  approvePlan: (planText: string, messageId?: string) => Promise<void>
  rejectPlan: (messageId?: string) => Promise<void>
  runStop: (runId: string) => Promise<boolean>
  deleteRun: (runId: string, storyAction?: 'preserve' | 'retract') => Promise<boolean>
  resyncRun: (runId: string) => Promise<void>
  openRunInspector: (runId: string, tab?: 'activity' | 'billing' | 'manuscript') => void
  closeRunInspector: () => void
  loadContext: (sessionId?: string) => Promise<void>
  previewContext: (draftText: string, attachments?: AttachmentRef[], planText?: string, phase?: ChatPhase, sourceTask?: string, grillMe?: GrillMeState, storyScope?: NarrativeLedgerScopeInput) => Promise<ContextPreviewV1 | null>
  pinMessage: (message: StudioUiMessage) => Promise<void>
  pinFact: (text: string) => Promise<void>
  unpinContext: (pinId: string, expectedRevision: number) => Promise<void>
  activeRun: (s: StudioStore) => RunViewState | null
}

let evUnsub: (() => void) | null = null
let errUnsub: (() => void) | null = null
let activityUnsub: (() => void) | null = null
let attachUnsub: (() => void) | null = null
let toastTimer: ReturnType<typeof setTimeout> | null = null
let sessionLoadVersion = 0
let draftPersistence: ReturnType<typeof createDraftPersistence> | null = null
let draftFlushUnsub: (() => void) | null = null
let composerDraftRestoreState: { loaded: boolean; edits: Set<string> } | null = null
const unavailableComposerSessions = new Set<string>()
const composerSessionDeletionBarriers = new Map<string, Promise<void>>()
let initialization: Promise<void> | null = null
let streamBatcher: ReturnType<typeof createStreamBatcher> | null = null
let contextPreviewRequest = 0
let resolveUnknownCost: ((choice: UnknownCostChoice) => void) | null = null
/** Prevent repeated init/activity scans from issuing duplicate semantic-review resumes. */
const narrativeReviewAutoRestore = new Map<string, string>()

const runReducer = createRunReducer()
const MAX_RUNS = 20
// R4.2 A6 补充：UI 端 usage revision 去重（迟到/重复更新不重复累计；重连 resync 后 reset）
const usageAcc = createUsageAccumulator()
const contentReplaceRevisions = new Map<string, number>()
// SidePanel/SettingsModal 可能近同时保存不同字段；串行读取最新值再合并，避免后返回的旧整包覆盖新设置。
let settingsWriteQueue: Promise<void> = Promise.resolve()

function capRuns(runs: Record<string, RunViewState>): Record<string, RunViewState> {
  const keys = Object.keys(runs)
  if (keys.length <= MAX_RUNS) return runs
  for (const k of keys.slice(0, keys.length - MAX_RUNS)) delete runs[k]
  return runs
}

function cloneUsage(u: Usage | null | undefined): Usage | null {
  return u ? { ...u } : null
}

function errorMessage(error: unknown): string {
  if (typeof error === 'string') return error.trim().slice(0, 240)
  if (!error || typeof error !== 'object') return ''
  const value = error as { message?: unknown; code?: unknown }
  const message = typeof value.message === 'string' ? value.message.trim() : ''
  const code = typeof value.code === 'string' ? value.code.trim() : ''
  if (!message && !code) return ''
  return `${code && !message ? `${code}: ` : ''}${message}`.slice(0, 240)
}

function zeroUsage(): Usage {
  return { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0, prompt_cache_hit_tokens: 0, prompt_cache_miss_tokens: 0, reasoning_tokens: 0 }
}

function snapshotToUiMessage(s: SessionMessageSnapshot): StudioUiMessage {
  return {
    id: s.id,
    role: s.role,
    content: s.content ?? '',
    reasoning: s.reasoning ?? '',
    status: s.status ?? 'done',
    usage: s.usage ?? null,
    rounds: s.rounds ?? 0,
    toolEvents: [],
    ...(s.fileEvidenceCount ? { fileEvidence: { status: 'idle' as const, nextOffset: 0, revision: 0, entries: [] } } : {}),
    ...(s.hasEditHistory ? { editHistory: { status: 'idle' as const, nextOffset: 0 } } : {}),
    plan: s.plan,
    planApproval: s.planApproval
  }
}

function visibleStrongConstraints(settings: Settings, story: StoryConfig, longwrite: boolean, task: string): StrongConstraintInput | undefined {
  if (!longwrite) return undefined
  const themeLockMode = settings.themeLockMode ?? ((settings.strongConstraintEnabled ?? true) ? 'strong' : 'off')
  const expressionFreedom = settings.expressionFreedom ?? ((settings.strongConstraintLevel ?? 'balanced') === 'strict' ? 'controlled' : 'high')
  const antiMoralizingEnabled = settings.antiMoralizingEnabled ?? true
  return {
    task,
    enabled: themeLockMode !== 'off' || antiMoralizingEnabled || Boolean(settings.strongConstraintMustKeep?.trim()) || Boolean(settings.strongConstraintAvoid?.trim()),
    level: settings.strongConstraintLevel ?? 'balanced',
    themeLockMode,
    expressionFreedom,
    antiMoralizingEnabled,
    perspective: settings.strongConstraintPerspective ?? 'auto',
    genre: (settings.strongConstraintGenre || (story.enabled ? story.genre : '')).trim(),
    mustKeep: settings.strongConstraintMustKeep ?? '',
    avoid: settings.strongConstraintAvoid ?? ''
  }
}

export const useStore = create<StudioStore>((set, get) => ({
  messages: [],
  sessions: [],
  currentSessionId: null,
  runs: {},
  /** 跨重启待恢复运行（R4-4 恢复入口） */
  recoverableRuns: [],
  recoveryPrompt: null,
  narrativeReview: null,
  completionProgress: {},
  activeRunId: null,
  inspectorRunId: null,
  inspectorTab: 'activity',
  runListRevision: 0,
  permissions: null,
  memory: null,
  settings: null,
  story: { ...DEFAULT_STORY },
  longMode: false,
  targetChars: 8000,
  deepWriteExperimentEnabled: false,
  deepWriteCharacterConsent: false,
  workspace: 'chat',
  mode: 'agent',
  sessionCollapsed: false,
  running: false,
  submitting: false,
  unknownCostPrompt: null,
  decideUnknownCost: (choice) => {
    const resolve = resolveUnknownCost
    resolveUnknownCost = null
    set({ unknownCostPrompt: null })
    resolve?.(choice)
  },
  runningId: null,
  totalUsage: null,
  estimatedContext: null,
  actualUsage: null,
  composerPerformance: null,
  contextMode: 'optimized',
  contextPreferenceRevision: 0,
  contextPreview: null,
  contextPreviewError: null,
  contextPins: [],
  contextLoading: false,
  pendingStoryScope: null,
  pendingPlan: null,
  pendingAttachments: [],
  composerText: '',
  composerDrafts: {},
  draftSaveError: null,
  closing: false,
  styleState: null,
  styleV2: { build: { ...DEFAULT_STYLEV2.build }, exemplar: { ...DEFAULT_STYLEV2.exemplar }, job: { ...DEFAULT_STYLEV2.job, usageTokens: { ...DEFAULT_STYLEV2.job.usageTokens } } },
  presets: [],
  grillLaunchRequest: null,
  toast: null,

  init: () => {
    if (initialization) return initialization
    initialization = (async () => {
      const ds = (window as any).ds
      if (!ds) return
      const startupEdits = new Set<string>()
      const startupDrafts = { loaded: false, edits: startupEdits }
      composerDraftRestoreState = startupDrafts
      if (ds.composerDraftSave) {
        draftPersistence = createDraftPersistence((input) => ds.composerDraftSave(input), (error) => {
          const failed = Boolean(get().draftSaveError)
          set({ draftSaveError: error ? '草稿保存失败，请重试；当前文字仍保留在窗口中。' : null })
          if (error && !failed) get().showToast('草稿尚未保存，请重试', 'error')
        })
      }
      draftFlushUnsub?.()
      draftFlushUnsub = ds.onDraftFlushRequested?.(async () => {
        set({ closing: true })
        try { await get().flushComposerDrafts() } catch (error) { set({ closing: false }); throw error }
      }, () => set({ closing: false })) ?? null
      // Subscribe before the first awaited snapshot/settings call. Activity events are
      // durable-before-push; reducer seq de-dup + resync closes the subscribe/snapshot race.
      if (activityUnsub) activityUnsub()
      activityUnsub = ds.onActivityEvent?.((ev: ActivityEvent) => {
        if (['run.completed', 'run.failed', 'run.cancelled'].includes(ev.type)) streamBatcher?.flush()
        const r = runReducer(get().runs[ev.runId] ?? null, ev)
        if (!r) return
        set((state) => {
          const runs = { ...state.runs, [ev.runId]: r }
          const ownsLifecycle = state.runningId === ev.runId
          const inactive = ownsLifecycle && (r.status === 'paused' || r.status === 'recovery_required' || r.terminal != null)
          return {
            runs: capRuns(runs),
            ...(inactive ? { running: false, runningId: null } : {})
          }
        })
        if (r.status === 'paused' || r.status === 'recovery_required') void get().loadRecoverable()
        if (r.needsResync) void get().resyncRun(ev.runId)
      }) ?? null
      streamBatcher?.flush()
      if (evUnsub) evUnsub()
      const applyChatEvent = ({ id, ev }: ChatStreamEvent): void => {
        const s = get()
        if (ev.type === 'performance' && ev.performance) {
          const activeId = s.runningId ?? s.activeRunId
          const visibleRun = s.messages.some(message => message.role === 'assistant' && (message.id === id || message.id === `m_${id}_assistant`))
          if (id === activeId && visibleRun) {
            const next = projectComposerPerformance(s.composerPerformance, ev.performance, id)
            if (next !== s.composerPerformance) set({ composerPerformance: next })
          }
          return
        }
        const idx = s.messages.findIndex((m) => m.id === id || m.id === `m_${id}_assistant`)
        if (idx < 0) return
        const msg = { ...s.messages[idx] }
        const isFinal =
          ev.type === 'done' &&
          (ev.finishReason === 'stop' ||
            ev.finishReason === 'content_filter' ||
            ev.finishReason === 'insufficient_system_resource' ||
            ev.finishReason === 'stopped' ||
            (ev.finishReason ?? '').startsWith('error') ||
            // Gate 2：终态判断使用该消息的 runConfig，不再读全局 longMode（防非长模式提前解锁）
            (ev.finishReason === 'length' && !(msg.runConfig?.longMode ?? false)))

        if (ev.type === 'text') {
          msg.content += ev.delta ?? ''
          if (!msg.content || msg.status === 'thinking') msg.status = 'streaming'
        } else if (ev.type === 'text_replace') {
          const revision = ev.replaceRevision ?? 0
          const previous = contentReplaceRevisions.get(id) ?? -1
          if (revision > previous && !['done', 'error', 'stopped'].includes(msg.status)) {
            contentReplaceRevisions.set(id, revision)
            msg.content = ev.delta ?? ''
            msg.status = 'streaming'
          }
        } else if (ev.type === 'reasoning') {
          msg.reasoning += ev.delta ?? ''
          msg.status = 'thinking'
        } else if (ev.type === 'tool_call' && ev.tool) {
          msg.toolEvents = msg.toolEvents.map((tool) => ({ ...tool }))
          msg.status = 'tool'
          const args = ev.tool.arguments.length > 120 ? ev.tool.arguments.slice(0, 120) + '…' : ev.tool.arguments
          let tool = msg.toolEvents.find((t) => t.id === ev.tool!.id)
          if (!tool) tool = msg.toolEvents.find((t) => t.name === ev.tool!.name && t.status === 'running')
          if (tool) {
            tool.argsPreview = args
          } else {
            msg.toolEvents.push({ id: ev.tool.id, name: ev.tool.name, argsPreview: args, status: 'running' })
          }
        } else if (ev.type === 'tool_result' && ev.toolResult) {
          msg.toolEvents = msg.toolEvents.map((tool) => ({ ...tool }))
          const tr = ev.toolResult
          const tool = msg.toolEvents.find((t) => t.id === tr.toolId) ?? msg.toolEvents.find((t) => t.name === tr.name)
          if (tool) {
            tool.status = tr.ok ? 'done' : 'error'
            tool.result = tr.result
            tool.resultOk = tr.ok
            tool.editReceipt = tr.editReceipt
            tool.editUndo = tr.editUndo
            tool.sourceCount = tr.ok ? tr.sourceCount : undefined
            tool.durationMs = tr.durationMs
            tool.exitCode = tr.exitCode ?? null
            if (tr.diff) (tool as UiToolEvent).diff = tr.diff
          }
          if (tr.ok && tr.sourceCount) msg.fileEvidence = { status: 'idle', nextOffset: 0, revision: (msg.fileEvidence?.revision ?? 0) + 1, entries: [] }
        } else if (ev.type === 'plan_ready' && ev.plan) {
          msg.status = 'done'
          msg.plan = 'pending'
          if (ev.plan.approval || !msg.content) msg.content = ev.plan.text
          msg.planApproval = ev.plan.approval
          // R4-4：计划文本兜底——plan_ready 可能不带正文，用已流式展示的消息内容
          const planText = ev.plan.text || msg.content || ''
          // Gate 2：只有事件归属当前 runningId 才解锁（迟到事件不能清新 run 状态）
          if (id === s.runningId) {
            set({
              pendingPlan: { messageId: id, planId: ev.plan.planId, planText, approval: ev.plan.approval },
              running: false,
              runningId: null
            })
          }
        } else if (ev.type === 'retry') {
          msg.content = ''
          msg.reasoning = ''
          msg.toolEvents = []
          msg.status = 'thinking'
          get().showToast(`请求失败（第 ${ev.retry?.attempt ?? 1} 次重试），正在自动重连…`, 'info')
        } else if (ev.type === 'usage') {
          // R4.2 A6：独立 usage 指标——只累计 metrics，不改变 lifecycle（终态由 done 决定）
          if (ev.usageChunk) {
            const u = ev.usageChunk
            // revision 去重：迟到/重复更新丢弃（部分→实际覆盖规则由 revision 保证）
            const applied = usageAcc.apply(id, u.revision, u.inputTokens, u.outputTokens)
            if (applied) {
              const prev = get().actualUsage ?? zeroUsage()
              const next: Usage = {
                prompt_tokens: prev.prompt_tokens + applied.inputTokens,
                completion_tokens: prev.completion_tokens + applied.outputTokens,
                total_tokens: prev.total_tokens + applied.inputTokens + applied.outputTokens,
                prompt_cache_hit_tokens: prev.prompt_cache_hit_tokens + u.cacheHitTokens,
                prompt_cache_miss_tokens: prev.prompt_cache_miss_tokens + u.cacheMissTokens,
                reasoning_tokens: prev.reasoning_tokens + u.reasoningTokens
              }
              set({ actualUsage: next, totalUsage: next })
            }
          }
        } else if (ev.type === 'completion') {
          // R4.4 Gate 3：客观进度——revision 去重（迟到丢弃），不改 lifecycle
          if (ev.completionChunk) {
            const next = applyCompletionChunk(id, ev.completionChunk, get().completionProgress[id])
            if (next) {
              set({ completionProgress: { ...get().completionProgress, [id]: next } })
            }
          }
        } else if (ev.type === 'done') {
          if (ev.finishReason === 'context') {
            set({ estimatedContext: cloneUsage(ev.usage) })
          } else if ((ev.finishReason ?? '').startsWith('round_')) {
            msg.rounds += 1
            msg.status = 'streaming'
          } else if (ev.finishReason === 'tool_calls') {
            msg.toolEvents = msg.toolEvents.map((t) => ({ ...t, status: t.status === 'running' ? 'done' : t.status }))
          } else if ((ev.finishReason ?? '').startsWith('error')) {
            msg.status = 'error'
            msg.error = ev.delta?.trim() || (ev.finishReason ?? 'error').slice(6).trim() || '模型调用失败，请检查模型和接口配置后重试'
          } else if (ev.finishReason === 'stopped') {
            msg.status = 'stopped'
          } else {
            msg.status = 'done'
          }
          if (ev.usage) {
            const prev = get().actualUsage ?? zeroUsage()
            const next: Usage = {
              prompt_tokens: prev.prompt_tokens + ev.usage.prompt_tokens,
              completion_tokens: prev.completion_tokens + ev.usage.completion_tokens,
              total_tokens: prev.total_tokens + ev.usage.total_tokens,
              prompt_cache_hit_tokens: prev.prompt_cache_hit_tokens + ev.usage.prompt_cache_hit_tokens,
              prompt_cache_miss_tokens: prev.prompt_cache_miss_tokens + ev.usage.prompt_cache_miss_tokens,
              reasoning_tokens: prev.reasoning_tokens + ev.usage.reasoning_tokens
            }
            set({ actualUsage: next, totalUsage: next })
          }
          if (isFinal && id === s.runningId) {
            contentReplaceRevisions.delete(id)
            set({ running: false, runningId: null })
            void get().loadSessions()
          }
        }
        const messages = [...s.messages]
        messages[idx] = msg
        set({ messages })
      }
      streamBatcher = createStreamBatcher(applyChatEvent)
      evUnsub = ds.onChatEvent((event: ChatStreamEvent) => streamBatcher!.push(event))
      if (errUnsub) errUnsub()
      errUnsub = ds.onChatError(({ id, message }: { id: string; message: string }) => {
        streamBatcher?.flush()
        const s = get()
        const idx = s.messages.findIndex((m) => m.id === id || m.id === `m_${id}_assistant`)
        if (idx < 0) return
        const messages = [...s.messages]
        messages[idx] = { ...messages[idx], status: 'error', error: message }
        contentReplaceRevisions.delete(id)
        set({ messages, ...(s.runningId === id ? { running: false, runningId: null } : {}) })
      })
      // 任务三：右键菜单"附加到下一次请求"→ 主进程事件 → 加入待发送附件（R4-1 用 fileRefId）
      if (attachUnsub) attachUnsub()
      attachUnsub = ds.onAttachmentAttached?.((data: { fileRefId: string; name: string; size: number; sessionId: string }) => {
        const s = get()
        if (!data.sessionId || unavailableComposerSessions.has(data.sessionId)) return
        const items = s.currentSessionId === data.sessionId ? s.pendingAttachments : s.composerDrafts[data.sessionId]?.attachments ?? []
        if (items.some((a) => a.fileRefId === data.fileRefId)) return
        const attachment = { name: data.name, fileRefId: data.fileRefId, size: data.size }
        if (s.currentSessionId !== data.sessionId && !s.composerDrafts[data.sessionId]) {
          // Unlike a preview, an explicit native attach may create the draft
          // of an empty origin session after navigation. Deleted owners cannot.
          set((state) => ({ composerDrafts: { ...state.composerDrafts, [data.sessionId]: { text: '', attachments: [attachment], updatedAt: Date.now() } } }))
        } else get().setPendingAttachments((attachments) => [...attachments, attachment], data.sessionId)
        if (s.currentSessionId === data.sessionId) get().showToast(`已附加：${data.name}`, 'success')
      }) ?? null
      const settings = await ds.getSettings()
      set({ settings })
      await get().loadSessions()
      if (ds.composerDraftsList) {
        try {
          const savedDrafts = await ds.composerDraftsList() as PersistedComposerDraft[]
          // Do not discard a snapshot during a delete that can still fail.
          // A failed delete releases this barrier before awaiting restoration.
          await Promise.all(savedDrafts.map((draft) => composerSessionDeletionBarriers.get(draft.sessionId)))
          const drafts = savedDrafts.filter((draft) => !unavailableComposerSessions.has(draft.sessionId))
          draftPersistence?.seed(drafts)
          set((state) => {
            const restored = { ...state.composerDrafts }
            let composerText = state.composerText
            for (const draft of drafts) {
              // Empty text can be an intentional edit; absence of a draft is
              // not proof that a late startup snapshot should overwrite it.
              if (startupEdits.has(draft.sessionId)) continue
              if (draft.sessionId === state.currentSessionId) {
                if (!composerText) composerText = draft.text
              } else {
                const existing = restored[draft.sessionId]
                if (!existing) restored[draft.sessionId] = { text: draft.text, attachments: [], updatedAt: draft.updatedAt }
                else if (!existing.text) restored[draft.sessionId] = { ...existing, text: draft.text }
              }
            }
            return { composerText, composerDrafts: restored }
          })
          startupDrafts.loaded = true
          // Use the normal session loader so a draft in an existing session
          // restores its canonical history as well. Preserve any user selection
          // made while startup snapshots were loading.
          const firstRestored = drafts.find((draft) => get().composerDrafts[draft.sessionId])
          if (!get().currentSessionId && firstRestored) await get().switchSession(firstRestored.sessionId)
        } catch {
          get().showToast('未能加载已保存草稿，请稍后重启重试', 'error')
        }
        if (get().currentSessionId) await get().loadContext(get().currentSessionId!)
      }
      void get().loadRecoverable() // R4-4：启动扫描跨重启待恢复运行
      if (ds.runsListRecent) {
        try {
          const recent = await ds.runsListRecent(50) as Array<{ runId: string; status: string }>
          const resumable = recent.filter((run) => ['queued', 'running', 'recoverable', 'cancelling', 'cancel_requested', 'recovery_required', 'waiting_user'].includes(run.status))
          await Promise.all(resumable.map((run) => get().resyncRun(run.runId)))
        } catch {
          /* Activity Rail will remain in explicit empty/sync state; no status is invented. */
        }
      }
      await get().loadPermissions()
      await get().loadMemory()
      await get().loadStyle()
      await get().loadPresets()
    })().finally(() => { initialization = null })
    return initialization
  },

  /** 发送：等待 main 返回 ack（{runId,status:'queued'}）后才算成功；ack 前不清草稿/附件。
   *  返回 {ok}：main 拒绝或异常时回滚乐观状态并返回 ok:false（Composer 恢复草稿）。 */
  send: async (text, attachments, grillState, quickBypass = false, goalMode) => {
    const s = get()
    const unavailable: PendingAttachment | undefined = !grillState ? attachments?.find((item: PendingAttachment) => item.state === 'failed' || item.state === 'parsing') : undefined
    if (unavailable) return { ok: false, reason: 'attachment_not_ready', error: `附件「${unavailable.name}」${unavailable.state === 'parsing' ? '仍在解析' : '尚未读取成功'}，请先处理或移除后再发送` }
    const wireAttachments = toWireAttachments(grillState ? grillState.attachments ?? [] : attachments)
    if (s.running || s.submitting) return { ok: false, reason: 'busy', error: '当前已有任务正在提交或运行，请先等待它结束' }
    if (!s.settings) return { ok: false, reason: 'settings_unavailable', error: '设置尚未加载完成，请稍后重试' }
    const ds = (window as any).ds
    if (!ds) return { ok: false, reason: 'no_bridge', error: '桌面通信桥未就绪，请重启应用后重试' }
    set({ submitting: true })
    try {
      try { await get().flushComposerDrafts() } catch {
        return { ok: false, reason: 'draft_save_failed', error: '草稿保存失败，请重试保存后再发送' }
      }
      const id = crypto.randomUUID()
      const runMode = deriveWritingRunMode(s)
      // R4-5/R48：普通发送沿用当前会话；Grill handoff 必须以 durable state
      // 自带的 sessionId 为唯一事实源。采访期间用户可能切换过会话，若此处
      // 继续读取 renderer 当前值，context:preview 或 chat:start 会在 Grill
      // confirmation gate 前失败，而且原 UI 只会显示一条无定位意义的失败文案。
      const sessionId = grillState?.sessionId ?? s.currentSessionId ?? (() => {
        const sid = crypto.randomUUID()
        set({ currentSessionId: sid })
        return sid
      })()
      if (get().currentSessionId !== sessionId) set((state) => ({ ...changeComposerSession(state, sessionId), currentSessionId: sessionId }))
      // Reload the authoritative preference before submission, including when
      // the user sends immediately after switching sessions or another window
      // has changed its pinned context.
      await get().loadContext(sessionId)
      const preview = await get().previewContext(text, wireAttachments, undefined, undefined, undefined, grillState, s.pendingStoryScope ?? undefined)
      if (!preview) {
        const detail = get().contextPreviewError
        return { ok: false, reason: 'context_preview_failed', error: detail || '上下文预览未返回可用结果' }
      }
      if (preview.budget.status !== 'ready') {
        const error = preview.budget.status === 'overflow' ? '上下文超过模型窗口，请减少素材后重试' : '模型上下文能力未知，已安全停止'
        return { ok: false, reason: 'context_overflow', error }
      }
      if (get().currentSessionId !== sessionId || get().closing) return { ok: false, reason: 'session_changed', error: '会话已变化，未提交原草稿' }
      const userMsg: UiMessage = { id: `u_${id}`, role: 'user', content: text, reasoning: '', status: 'done', usage: null, rounds: 0, toolEvents: [] }
      const asstMsg: StudioUiMessage = {
        id,
        role: 'assistant',
        content: '',
        reasoning: '',
        status: 'thinking',
        usage: null,
        rounds: 0,
        toolEvents: [],
        runConfig: { longMode: runMode.longMode, targetChars: s.targetChars }
      }
      // R4.1 B-05：不再上传全量历史——只提交新 user 消息，主进程从 canonical SQLite 构建上下文
      const phase: ChatPhase = s.settings.planMode ? 'plan' : 'execute'
      set({
        messages: [...s.messages, userMsg, asstMsg],
        running: true,
        runningId: id,
        activeRunId: id,
        totalUsage: null,
        estimatedContext: null,
        actualUsage: null,
        composerPerformance: null,
        currentSessionId: sessionId,
        pendingPlan: null,
        mode: runMode.mode,
        longMode: runMode.longMode,
        workspace: runMode.longMode ? 'chat' : s.workspace
      })
      try {
        const request = {
          id,
          sessionId,
          phase,
          ...(phase === 'plan' && runMode.mode === 'agent' && !runMode.longMode ? { planAccess: 'read_only' as const } : {}),
          fixedPrefix: [],
          text,
          story: s.story.enabled ? { ...s.story, characters: s.story.characters.filter((c) => c.name.trim()) } : null,
          longMode: runMode.longMode,
          targetChars: s.targetChars,
          attachments: wireAttachments,
          // R4-6：runConfig 快照输入（main 持久化）
          mode: runMode.mode,
          workspace: runMode.workspace,
          ...(goalMode && phase === 'execute' && runMode.mode === 'agent' && runMode.workspace === 'chat' && !runMode.longMode ? { goalMode } : {}),
          strongConstraints: visibleStrongConstraints(s.settings, s.story, runMode.longMode, text),
          contextSelection: { mode: preview.mode, preferenceRevision: preview.policyRevision, previewId: preview.previewId },
          ...(s.pendingStoryScope ? { storyScope: s.pendingStoryScope } : {}),
          deepWriteExperiment: buildDeepWriteExperimentInput({
            mode: runMode.mode,
            longMode: runMode.longMode,
            experimentEnabled: s.deepWriteExperimentEnabled,
            characterConsent: s.deepWriteCharacterConsent,
            story: s.story
          }),
          ...(grillState ? {
            grillMe: {
              stateId: grillState.stateId,
              originalTask: grillState.originalTask,
              targetChars: grillState.targetChars,
              answers: grillState.slots.filter((slot) => slot.answer.trim()).map((slot) => ({ slotId: slot.id, value: slot.answer, source: slot.source ?? 'user' })),
              assumptions: [...grillState.assumptions],
              approvedOutline: grillState.approvedOutline!,
              outlineRevision: grillState.outlineRevision,
              outlineHash: grillState.outlineHash
            }
          } : {}),
          quickBypass
        }
        // Changes while the modal is open must not silently authorize another
        // draft, attachment set, session or visible model/configuration.
        const visibleIdentity = (): string => {
          const current = get()
          return JSON.stringify({ sessionId: current.currentSessionId, text: current.composerText,
            attachments: toWireAttachments(current.pendingAttachments), settings: current.settings,
            story: current.story, targetChars: current.targetChars, mode: current.mode, longMode: current.longMode,
            storyScope: current.pendingStoryScope, contextRevision: current.contextPreferenceRevision,
            experiment: current.deepWriteExperimentEnabled, characterConsent: current.deepWriteCharacterConsent })
        }
        const submittedIdentity = visibleIdentity()
        const removeOptimistic = (): void => set((state) => ({
          ...(state.currentSessionId === sessionId ? { messages: state.messages.filter((message) => message.id !== id && message.id !== userMsg.id) } : {}),
          ...(state.runningId === id ? { running: false, runningId: null, activeRunId: s.activeRunId } : {})
        }))
        let ack = await ds.chatStart(request)
        if (ack?.status === 'cost_confirmation_required') {
          removeOptimistic()
          const challenge = ack.challenge as DesktopCostChallenge
          if (!challenge || challenge.runId !== id || !/^[a-f0-9]{64}$/.test(challenge.nonce) || !Number.isFinite(challenge.expiresAt) || challenge.expiresAt <= Date.now()) {
            throw new Error('费用确认已过期，请重新发送')
          }
          const choice = await new Promise<UnknownCostChoice>((resolve) => {
            const timer = window.setTimeout(() => get().decideUnknownCost('cancel'), Math.max(0, challenge.expiresAt - Date.now()))
            resolveUnknownCost = (decision) => { window.clearTimeout(timer); resolve(decision) }
            set({ unknownCostPrompt: challenge })
          })
          if (choice !== 'accept') return { ok: false, reason: 'cost_confirmation_cancelled', error: '本次发送已取消，草稿和附件已保留' }
          if (get().closing || submittedIdentity !== visibleIdentity()) return { ok: false, reason: 'cost_confirmation_stale', error: '会话、草稿或配置已变化，请重新发送并确认费用' }
          // Reinstall only this submission's optimistic pair. Real activity
          // can arrive before the ACK, so it must exist before the retry.
          set((state) => ({ messages: [...state.messages, userMsg, asstMsg], running: true, runningId: id, activeRunId: id }))
          ack = await ds.chatStart({ ...request, unknownCostConsent: { nonce: challenge.nonce, decision: 'accept_unknown_cost' } })
          if (ack?.status === 'cost_confirmation_required') throw new Error('费用确认已失效，请重新发送')
        }
        if (!ack || typeof ack.runId !== 'string') throw new Error('main rejected chat:start')
        // Only consume the submitted attachments; additions made while awaiting
        // the acknowledgement belong to the next request.
        const sentRefs = new Set(wireAttachments.map((item) => item.fileRefId))
        set((state) => ({ ...updateComposerAttachments(state, sessionId, (items) => items.filter((item) => !sentRefs.has(item.fileRefId))), pendingStoryScope: null }))
        return { ok: true as const }
      } catch (e) {
        console.warn('[send] 主进程未确认任务启动，保留草稿')
        set((st) => ({
          ...(st.currentSessionId === sessionId ? { messages: st.messages.filter((message) => message.id !== id && message.id !== userMsg.id) } : {}),
          ...(st.runningId === id ? { running: false, runningId: null, activeRunId: s.activeRunId } : {})
        }))
        const detail = errorMessage(e)
        return { ok: false, reason: 'main_error', error: detail || '主进程拒绝启动正文，未创建运行' }
      }
    } catch (error) {
      return { ok: false, reason: 'start_failed', error: errorMessage(error) || '任务提交失败，请重试' }
    } finally {
      set({ submitting: false })
    }
  },

  stop: () => {
    const s = get()
    if (s.runningId) {
      ;(window as any).ds?.chatStop(s.runningId)
    }
  },

  runStop: async (runId) => {
    const ds = (window as any).ds
    try {
      const result = await ds?.activityCancel?.(runId) as { ok?: boolean; error?: string } | undefined
      const ok = result?.ok === true
      get().showToast(ok ? '停止请求已生效' : result?.error === 'run_not_found' ? '任务已经结束或不存在' : '停止失败', ok ? 'info' : 'error')
      return ok
    } catch {
      get().showToast('停止失败', 'error')
      return false
    }
  },

  deleteRun: async (runId, storyAction = 'preserve') => {
    const ds = (window as any).ds
    if (!ds?.runsDelete) return false
    try {
      const result = await ds.runsDelete(runId, storyAction) as { ok?: boolean; error?: string; storyAction?: 'preserve' | 'retract'; retractedRevisions?: number }
      if (!result?.ok) {
        get().showToast(result?.error === 'run_active' ? '请先停止任务，再删除工作流记录' : '删除工作流失败', 'error')
        return false
      }
      set((state) => {
        const runs = { ...state.runs }
        const completionProgress = { ...state.completionProgress }
        delete runs[runId]
        delete completionProgress[runId]
        return {
          runs,
          completionProgress,
          recoverableRuns: state.recoverableRuns.filter((item) => item.runId !== runId),
          inspectorRunId: state.inspectorRunId === runId ? null : state.inspectorRunId,
          inspectorTab: state.inspectorRunId === runId ? 'activity' : state.inspectorTab,
          runListRevision: state.runListRevision + 1
        }
      })
      get().showToast(result.storyAction === 'retract'
        ? `工作流记录已删除，故事线已撤回 ${result.retractedRevisions ?? 0} 条修订`
        : '工作流记录已删除，故事记忆仍保留', 'info')
      return true
    } catch {
      get().showToast('删除工作流失败', 'error')
      return false
    }
  },

  resyncRun: async (runId) => {
    const ds = (window as any).ds
    if (!ds?.activityGetSnapshot) return
    try {
      const snap = await ds.activityGetSnapshot(runId)
      if (!snap) return
      set((state) => {
        const current = state.runs[runId]
        // 拉取期间可能已收到更新事件；旧快照不能把 UI 状态倒退。
        if (current && snap.lastSeq < current.lastSeq) return state
        const runs = { ...state.runs, [runId]: { ...snap, needsResync: false } }
        const inactive = state.runningId === runId && (snap.status === 'paused' || snap.status === 'recovery_required' || snap.terminal != null)
        return { runs: capRuns(runs), ...(inactive ? { running: false, runningId: null } : {}) }
      })
    } catch {
      return
    }
  },

  activeRun: (s) => (s.activeRunId ? (s.runs[s.activeRunId] ?? null) : null),

  openRunInspector: (runId, tab = 'activity') => set({ inspectorRunId: runId, inspectorTab: tab }),
  closeRunInspector: () => set({ inspectorRunId: null, inspectorTab: 'activity' }),

  loadContext: async (sessionId) => {
    const id = sessionId ?? get().currentSessionId
    const ds = (window as any).ds
    if (!id || !ds?.contextGetPreference) return
    set({ contextLoading: true })
    try {
      const [preference, pins] = await Promise.all([ds.contextGetPreference(id), ds.contextListPins(id)]) as [ContextPreferenceView, ContextPinView[]]
      if (get().currentSessionId === id) set({ contextMode: preference.mode, contextPreferenceRevision: preference.revision, contextPins: pins, contextPreview: null, contextPreviewError: null, contextLoading: false })
    } catch {
      if (get().currentSessionId === id) set({ contextLoading: false })
    }
  },

  previewContext: async (draftText, attachments, planText, phase, sourceTask, grillState, storyScope) => {
    // A confirmed Grill state owns the session used by its durable interview
    // and outline. Do not let a stale renderer session redirect the preview.
    const id = grillState?.sessionId ?? get().ensureSessionId()
    const state = get()
    const ds = (window as any).ds
    if (!ds?.contextPreview) return null
    const request = ++contextPreviewRequest
    const wireAttachments = toWireAttachments(grillState ? grillState.attachments ?? [] : attachments)
    set({ contextLoading: true, contextPreviewError: null })
    try {
      const approval = phase === 'execute' && planText !== undefined ? state.pendingPlan?.approval : undefined
      const runMode = deriveWritingRunMode(approval ? { ...state, mode: 'agent', workspace: 'chat', longMode: false } : state)
      const effectivePhase = phase ?? (state.settings?.planMode ? 'plan' : 'execute')
      const preview = await ds.contextPreview({
        sessionId: id,
        mode: 'optimized',
        preferenceRevision: state.contextPreferenceRevision,
        draftText,
        attachments: wireAttachments,
        runMode: runMode.mode,
        longMode: runMode.longMode,
        phase: effectivePhase,
        ...(effectivePhase === 'plan' && runMode.mode === 'agent' && !runMode.longMode ? { planAccess: 'read_only' } : {}),
        ...(approval ? { planApproval: approval } : {}),
        planText: planText ?? state.pendingPlan?.planText ?? '',
        story: state.story.enabled ? { ...state.story, characters: state.story.characters.filter((character) => character.name.trim()) } : null,
        targetChars: state.targetChars,
        strongConstraints: state.settings ? visibleStrongConstraints(state.settings, state.story, runMode.longMode, sourceTask ?? draftText) : undefined,
        storyScope: storyScope ?? state.pendingStoryScope ?? undefined,
        grillMe: grillState ? {
          stateId: grillState.stateId,
          originalTask: grillState.originalTask,
          targetChars: grillState.targetChars,
          answers: grillState.slots.filter((slot) => slot.answer.trim()).map((slot) => ({ slotId: slot.id, value: slot.answer, source: slot.source ?? 'user' })),
          assumptions: [...grillState.assumptions],
          approvedOutline: grillState.approvedOutline!,
          outlineRevision: grillState.outlineRevision,
          outlineHash: grillState.outlineHash
        } : undefined
      }) as ContextPreviewV1
      if (request === contextPreviewRequest && get().currentSessionId === id) set({ contextPreview: preview, contextLoading: false, contextPreviewError: null })
      return preview
    } catch (error) {
      if (request === contextPreviewRequest) set({ contextLoading: false, contextPreview: null, contextPreviewError: errorMessage(error) || '上下文预览失败，主进程未返回具体原因' })
      return null
    }
  },

  pinMessage: async (message) => {
    const id = get().currentSessionId
    const ds = (window as any).ds
    if (!id || !ds?.contextPinMessage || !['done', 'stopped'].includes(message.status)) return
    const canonicalId = message.role === 'user' && message.id.startsWith('u_') ? `m_${message.id.slice(2)}_user` : message.role === 'assistant' && !message.id.startsWith('m_') ? `m_${message.id}_assistant` : message.id
    try {
      await ds.contextPinMessage({ sessionId: id, messageId: canonicalId, expectedContentHash: await sha256Text(message.content), displayLabel: message.content.slice(0, 60) })
      await get().loadContext(id)
      get().showToast('已固定，优化上下文不会裁剪它', 'success')
    } catch { get().showToast('固定失败：消息可能仍在生成或已变化', 'error') }
  },

  pinFact: async (text) => {
    const fact = text.trim()
    const id = get().ensureSessionId()
    const ds = (window as any).ds
    if (!fact || !ds?.contextPinFact) return
    try {
      await ds.contextPinFact({ sessionId: id, factText: fact, displayLabel: fact.slice(0, 60) })
      await get().loadContext(id)
      get().showToast('事实已固定', 'success')
    } catch { get().showToast('固定事实失败', 'error') }
  },

  unpinContext: async (pinId, expectedRevision) => {
    const id = get().currentSessionId
    const ds = (window as any).ds
    if (!id || !ds?.contextUnpin) return
    try { await ds.contextUnpin({ sessionId: id, pinId, expectedRevision }); await get().loadContext(id) } catch { get().showToast('取消固定失败，请刷新后重试', 'error') }
  },

  updateSettings: (patch) => {
    const operation = settingsWriteQueue.then(async (): Promise<boolean> => {
      const prev = get().settings
      // Capability-bearing path inputs are requests, not display settings.
      // Publish only the normalized snapshot returned by the main process.
      try {
        const ds = (window as any).ds
        if (!prev || !ds?.setSettings || !ds?.getSettings) throw new Error('桌面设置尚未就绪')
        const latest = await ds.getSettings()
        if (!latest) throw new Error('未收到当前设置')
        const settings = { ...latest, ...patch, ...(patch.galgame ? { galgame: { ...latest.galgame, ...patch.galgame } } : {}) }
        const keys = Object.keys(patch)
        // Single-field controls must not write back a stale renderer credential
        // or overwrite unrelated values changed in the main process.
        if (keys.length === 1 && ds.setSettingField) await ds.setSettingField(keys[0], settings[keys[0]])
        else await ds.setSettings(settings)
        const normalized = await ds.getSettings()
        if (!normalized) throw new Error('未收到已保存的设置')
        set({ settings: normalized })
        return true
      } catch (e) {
        set({ settings: prev })
        get().showToast(`设置保存失败：${String((e as { message?: string })?.message ?? e)}`, 'error')
        return false
      }
    })
    settingsWriteQueue = operation.then(() => undefined, () => undefined)
    return operation
  },

  updateStory: (patch) => set({ story: { ...get().story, ...patch } }),

  setLongMode: (v) => set((s) => transitionLongMode(s, v)),
  setTargetChars: (v) => set({ targetChars: normalizeLongTarget(v) }),
  setDeepWriteExperimentEnabled: (v) => set({ deepWriteExperimentEnabled: v }),
  setDeepWriteCharacterConsent: (v) => set({ deepWriteCharacterConsent: v }),

  setWorkspace: (w) => set((s) => transitionWorkspace(s, w)),
  setMode: (m) => set((s) => transitionComposerMode(s, m)),
  toggleSessionCollapsed: () => set((s) => ({ sessionCollapsed: !s.sessionCollapsed })),
  setSessionCollapsed: (collapsed) => set({ sessionCollapsed: collapsed }),

  setComposerText: (text) => {
    const id = get().ensureSessionId()
    composerDraftRestoreState?.edits.add(id)
    set({ composerText: text })
    draftPersistence?.queue(id, text)
  },
  clearSubmittedText: (sessionId, text) => {
    composerDraftRestoreState?.edits.add(sessionId)
    set((state) => clearAcceptedComposerText(state, sessionId, text))
    const state = get()
    draftPersistence?.queue(sessionId, sessionId === state.currentSessionId ? state.composerText : state.composerDrafts[sessionId]?.text ?? '')
  },
  flushComposerDrafts: async () => { await draftPersistence?.flush() },
  setPendingAttachments: (list, sessionId) => {
    const owner = sessionId ?? get().ensureSessionId()
    set((state) => updateComposerAttachments(state, owner, (items) => typeof list === 'function' ? list(items) : list))
  },

  showToast: (text, kind = 'info') => {
    const id = Date.now() + Math.random()
    set({ toast: { id, text, kind } })
    if (toastTimer) clearTimeout(toastTimer)
    toastTimer = setTimeout(() => {
      set((st) => (st.toast?.id === id ? { toast: null } : {}))
    }, 3200)
  },

  loadSessions: async () => {
    const ds = (window as any).ds
    if (!ds?.sessionsList) return
    try {
      const sessions: SessionMeta[] = await ds.sessionsList()
      set({ sessions })
      // An unsent session has no SQLite row yet. Refreshing the list must not
      // change its id or detach its scoped attachment capabilities.
    } catch {
      // Keep the last successful list available during a transient IPC error.
    }
  },

  loadRecoverable: async () => {
    const ds = (window as any).ds
    if (!ds?.runsRecoverable) return
    try {
      const runs = (await ds.runsRecoverable()) ?? []
      set({ recoverableRuns: runs })
      // A semantic review is a durable user boundary, but it still needs a
      // main-process restore call after a renderer restart so the authoritative
      // packet (including operation id and capabilities) is reloaded.  Do not
      // auto-resume generic waiting_user or recovery_required runs.
      await Promise.all(runs
        .filter((run: { errorCode?: string; status?: string }) => run.status === 'waiting_user' && run.errorCode === 'narrative_state_pending_review')
        .map(async (run: { runId: string; updatedAt?: number }) => {
          const restoreKey = String(run.updatedAt ?? '')
          if (narrativeReviewAutoRestore.get(run.runId) === restoreKey) return
          narrativeReviewAutoRestore.set(run.runId, restoreKey)
          const ok = await get().resumeRun(run.runId)
          if (!ok) narrativeReviewAutoRestore.delete(run.runId)
        }))
    } catch {
      set({ recoverableRuns: [] })
    }
  },

  resumeRun: async (runId, tokenBudget, removeCallLimit, reauthorizeGoal) => {
    const ds = (window as any).ds
    if (!ds?.runsResume) return false
    const goalResume = get().recoverableRuns.some(run => run.runId === runId && run.config.goalMode)
    const previousReply = goalResume ? get().messages.find(message => message.role === 'assistant' && (message.id === runId || message.id === `m_${runId}_assistant`)) : undefined
    if (previousReply) set(state => ({ messages: state.messages.map(message => message.id === previousReply.id ? { ...message, content: '', status: 'thinking' } : message) }))
    const rollbackReply = (): void => {
      if (!previousReply) return
      set(state => ({ messages: state.messages.map(message => message.id === previousReply.id && message.status === 'thinking' && !message.content ? previousReply : message) }))
    }
    try {
      const r = await ds.runsResume(runId, tokenBudget, removeCallLimit, reauthorizeGoal)
      if (r?.ok) {
        void get().resyncRun(runId)
        if (r.storyEpochInvalidated) {
          get().showToast(r.message ?? '故事线已撤回，请基于当前安全故事线新建分支', 'info')
          await get().loadRecoverable()
          return true
        }
        if (r.recovered) {
          const status = r.runStatus as string | null | undefined
          set((state) => {
            // Recovery requests are asynchronous.  Another run may have
            // become the workspace owner while this IPC call was in flight;
            // a background review recovery must never clear or steal it.
            const ownsLifecycle = state.runningId === runId || (!state.running && state.runningId === null)
            return {
              recoverableRuns: state.recoverableRuns.filter((x) => x.runId !== runId),
              ...(state.narrativeReview?.runId === runId ? { narrativeReview: null } : {}),
              ...(ownsLifecycle ? {
                running: status === 'running',
                runningId: status === 'running' ? runId : null
              } : {}),
              activeRunId: runId
            }
          })
          return true
        }
        if (r.recoveryRequired) {
          set({ recoveryPrompt: { runId, message: r.message ?? '该运行包含结果未知的工具副作用，需要你决定如何处理。', pendingToolCalls: r.pendingToolCalls ?? [] } })
          return true
        }
        if (r.waitingUser) {
          // Semantic review is not a running state. Keep the recoverable row
          // visible and surface the durable packet returned by IPC; only a
          // later explicit decision may make this run running again.
          let review = r.semanticReview ?? null
          if (!review && ds.runsNarrativeReview) {
            try {
              const refreshed = await ds.runsNarrativeReview(runId)
              if (refreshed?.ok) review = refreshed.review ?? null
            } catch { /* Keep the recoverable row; the next scan can retry. */ }
          }
          set((state) => {
            // A pending review can be restored in parallel with an unrelated
            // active run.  Surface the review, but only mutate lifecycle
            // ownership when this run already owns it or the store is at the
            // normal idle review boundary (false + null).
            const ownsLifecycle = state.runningId === runId || (!state.running && state.runningId === null)
            return {
              narrativeReview: review,
              ...(ownsLifecycle ? { running: false, runningId: null } : {}),
              activeRunId: runId
            }
          })
          return Boolean(review)
        }
        set((state) => {
          const ownsLifecycle = state.runningId === runId || (!state.running && state.runningId === null)
          return {
            recoverableRuns: state.recoverableRuns.filter((x) => x.runId !== runId),
            ...(ownsLifecycle ? { running: true, runningId: runId } : {}),
            activeRunId: runId
          }
        })
        return true
      }
      rollbackReply()
      if (r?.message) get().showToast(r.message, 'error')
      return false
    } catch {
      rollbackReply()
      return false
    }
  },

  rebaseStoryRun: async (runId) => {
    const ds = (window as any).ds
    if (!ds?.runsStoryRebase) return false
    try {
      const result = await ds.runsStoryRebase(runId)
      if (!result?.ok || !result.storyScope) return false
      if (result.sessionId && get().currentSessionId !== result.sessionId) await get().switchSession(result.sessionId)
      set({ pendingStoryScope: result.storyScope, workspace: 'chat' })
      get().showToast('已准备当前安全故事线分支；下一次发送会从新有效期开始', 'success')
      return true
    } catch (error) {
      get().showToast(errorMessage(error) || '无法准备安全故事线分支', 'error')
      return false
    }
  },

  abandonRun: async (runId) => {
    const ds = (window as any).ds
    if (!ds?.runsAbandon) return false
    try {
      const r = await ds.runsAbandon(runId)
      set((state) => ({
        recoverableRuns: state.recoverableRuns.filter((x) => x.runId !== runId),
        ...(state.narrativeReview?.runId === runId ? { narrativeReview: null } : {}),
        ...(state.runningId === runId ? { running: false, runningId: null } : {})
      }))
      return r?.ok ?? false
    } catch {
      return false
    }
  },

  decideRecovery: async (decision, note) => {
    const ds = (window as any).ds
    const prompt = get().recoveryPrompt
    if (!ds?.runsRecoverDecide || !prompt) return false
    try {
      const r = await ds.runsRecoverDecide({ runId: prompt.runId, decision, note })
      if (!r?.ok) return false
      set({
        recoveryPrompt: null,
        recoverableRuns: get().recoverableRuns.filter((x) => x.runId !== prompt.runId),
        running: true,
        runningId: prompt.runId,
        activeRunId: prompt.runId
      })
      return true
    } catch {
      return false
    }
  },

  closeRecoveryPrompt: () => set({ recoveryPrompt: null }),

  decideNarrativeReview: async (decision, delta, note) => {
    const ds = (window as any).ds
    let prompt = get().narrativeReview
    if (!ds?.runsNarrativeReviewDecide || !prompt) return false
    try {
      // Capabilities and operation identity are main-process authority.  A
      // stale/incomplete renderer snapshot is refreshed once; it is never
      // repaired with a client-generated UUID or a guessed policy.
      const hasOperation = (review: NarrativeReviewPrompt): boolean => Boolean(
        review.pendingOperation?.decisionId || review.decision?.decisionId
      )
      if (!prompt.allowedDecisions || !hasOperation(prompt)) {
        if (!ds.runsNarrativeReview) return false
        const refreshed = await ds.runsNarrativeReview(prompt.runId)
        if (!refreshed?.ok || !refreshed.review) return false
        prompt = refreshed.review as NarrativeReviewPrompt
        set({ narrativeReview: prompt })
      }
      const currentPrompt = prompt
      if (!currentPrompt || (currentPrompt.effectiveAllowedDecisions ?? currentPrompt.allowedDecisions)?.[decision]?.allowed !== true) return false
      const decisionId = currentPrompt.pendingOperation?.decisionId ?? currentPrompt.decision?.decisionId
      if (!decisionId || (currentPrompt.pendingOperation && currentPrompt.pendingOperation.operationId !== decisionId) || (currentPrompt.pendingOperation && currentPrompt.pendingOperation.expectedRevision !== currentPrompt.revision)) return false
      const input: NarrativeSemanticReviewDecisionInput = {
        runId: currentPrompt.runId,
        decision,
        expectedRevision: currentPrompt.revision,
        decisionId,
        ...(delta !== undefined ? { delta } : {}),
        ...(note ? { note } : {})
      }
      const result = await ds.runsNarrativeReviewDecide(input)
      if (!result?.ok) return false
      // A decision label (accepted/unknown/rewrite) is not a lifecycle state.
      // The main process returns the post-commit snapshot; never resurrect a
      // completed/paused/failed run as running based on the button clicked.
      if (typeof result.runStatus !== 'string' || typeof result.phase !== 'string' || typeof result.needsStep !== 'boolean' || typeof result.terminal !== 'boolean') return false
      const isRunning = result.runStatus === 'running' && result.needsStep && !result.terminal
      set((state) => ({
        ...(state.narrativeReview?.runId === currentPrompt.runId ? { narrativeReview: null } : {}),
        recoverableRuns: isRunning ? state.recoverableRuns.filter((item) => item.runId !== currentPrompt.runId) : state.recoverableRuns,
        // A review response belongs to prompt.runId.  Do not let a paused or
        // completed decision for that run clear an unrelated run currently
        // owned by the workspace.  A null runningId is the normal review
        // boundary (the event reducer cleared this same run), so it may be
        // claimed again when the authoritative result says running.
        ...(state.runningId === null || state.runningId === currentPrompt.runId
          ? { running: isRunning, runningId: isRunning ? currentPrompt.runId : null }
          : {}),
        activeRunId: currentPrompt.runId
      }))
      if (!isRunning) void get().loadRecoverable()
      return true
    } catch {
      return false
    }
  },

  closeNarrativeReview: () => set({ narrativeReview: null }),

  newSession: () => {
    if (get().submitting) return
    get().stop()
    sessionLoadVersion += 1
    const sessionId = crypto.randomUUID()
    set({
      ...changeComposerSession(get(), sessionId),
      messages: [],
      currentSessionId: sessionId,
      running: false,
      runningId: null,
      totalUsage: null,
      estimatedContext: null,
      actualUsage: null,
      composerPerformance: null,
      pendingPlan: null,
      contextMode: 'optimized',
      contextPreferenceRevision: 0,
      contextPreview: null,
      contextPreviewError: null,
      contextLoading: false,
      contextPins: [],
      pendingStoryScope: null
    })
  },

  ensureSessionId: () => {
    const s = get()
    if (s.currentSessionId) return s.currentSessionId
    const sid = crypto.randomUUID()
    set({ currentSessionId: sid })
    return sid
  },

  loadMessageSources: async (messageId) => {
    const state = get(), sessionId = state.currentSessionId
    const evidence = state.messages.find(message => message.id === messageId)?.fileEvidence
    if (!sessionId || !evidence || evidence.status === 'loading' || evidence.nextOffset === null) return
    const version = sessionLoadVersion, offset = evidence.nextOffset, revision = evidence.revision
    set(s => ({ messages: s.messages.map(message => message.id !== messageId || !message.fileEvidence ? message : { ...message, fileEvidence: { ...message.fileEvidence, status: 'loading' } }) }))
    try {
      const page: FileEvidencePage = await window.ds.sessionsFileEvidence(sessionId, messageId, offset)
      if (get().currentSessionId !== sessionId || sessionLoadVersion !== version) return
      set(s => ({ messages: s.messages.map(message => {
        if (message.id !== messageId || message.fileEvidence?.revision !== revision) return message
        const entries = [...message.fileEvidence.entries]
        for (const entry of page.entries) if (!entries.some(previous => previous.runId === entry.runId && previous.toolCallId === entry.toolCallId && previous.sourceIndex === entry.sourceIndex)) entries.push(entry)
        return { ...message, fileEvidence: { ...message.fileEvidence, status: 'loaded', nextOffset: page.nextOffset, entries } }
      }) }))
    } catch {
      if (get().currentSessionId !== sessionId || sessionLoadVersion !== version) return
      set(s => ({ messages: s.messages.map(message => message.id !== messageId || message.fileEvidence?.revision !== revision ? message : { ...message, fileEvidence: { ...message.fileEvidence, status: 'error' } }) }))
    }
  },

  loadMessageEdits: async (messageId) => {
    const state = get()
    const sessionId = state.currentSessionId
    const message = state.messages.find(item => item.id === messageId)
    if (!sessionId || !message?.editHistory || message.editHistory.status === 'loading' || message.editHistory.nextOffset === null) return
    const version = sessionLoadVersion
    const offset = message.editHistory.nextOffset
    set(s => ({ messages: s.messages.map(item => item.id !== messageId ? item : { ...item, editHistory: { status: 'loading', nextOffset: offset } }) }))
    try {
      const page: import('../../shared/types').SessionEditHistoryPage = await (window as any).ds.sessionsEditHistory(sessionId, messageId, offset)
      if (get().currentSessionId !== sessionId || sessionLoadVersion !== version) return
      set(s => ({ messages: s.messages.map(item => item.id !== messageId ? item : { ...item,
        toolEvents: [...item.toolEvents, ...page.events.filter(event => !item.toolEvents.some(existing => existing.id === event.id))],
        editHistory: { status: 'loaded', nextOffset: page.nextOffset } }) }))
    } catch {
      if (get().currentSessionId === sessionId && sessionLoadVersion === version)
        set(s => ({ messages: s.messages.map(item => item.id !== messageId ? item : { ...item, editHistory: { status: 'error', nextOffset: offset } }) }))
    }
  },

  switchSession: async (id) => {
    const s = get()
    if (id === s.currentSessionId || s.submitting) return
    s.stop()
    const loadVersion = ++sessionLoadVersion
    set({ ...changeComposerSession(s, id), messages: [], running: false, runningId: null, composerPerformance: null, currentSessionId: id, pendingPlan: null, contextMode: 'optimized', contextPreferenceRevision: 0, contextPreview: null, contextPins: [], contextLoading: false, contextPreviewError: null, pendingStoryScope: null })
    const ds = (window as any).ds
    if (!ds?.sessionsLoad) {
      set({ messages: [] })
      return
    }
    try {
      const msgs: StudioUiMessage[] = (await ds.sessionsLoad(id)).map(snapshotToUiMessage)
      if (loadVersion === sessionLoadVersion && get().currentSessionId === id) {
        const pending = [...msgs].reverse().find(message => message.plan === 'pending' && message.planApproval)
        set({ messages: msgs, pendingPlan: pending ? { messageId: pending.id, planId: `plan_${pending.planApproval!.runId}`, planText: pending.content, approval: pending.planApproval } : null })
        await get().loadContext(id)
        try {
          const grill: GrillMeState | null = await ds.grillLatestUnconsumed?.(id)
          if (grill?.sessionId === id && loadVersion === sessionLoadVersion && get().currentSessionId === id)
            set(current => transitionWorkspace(current, 'novel'))
        } catch { /* A failed interview lookup must not erase loaded conversation history. */ }
      }
    } catch {
      if (loadVersion === sessionLoadVersion && get().currentSessionId === id) set({ messages: [] })
    }
  },

  restoreGrillSession: async (state) => {
    if (get().currentSessionId !== state.sessionId) await get().switchSession(state.sessionId)
    if (get().currentSessionId !== state.sessionId) return
    const version = sessionLoadVersion
    // An orphan Grill state may legitimately have no row in sessions yet;
    // context preferences are created lazily, so retry the load independently
    // of sessions:load rather than losing the durable handoff.
    await get().loadContext(state.sessionId)
    if (version !== sessionLoadVersion || get().currentSessionId !== state.sessionId) return
    set((current) => transitionWorkspace(current, 'novel'))
  },

  deleteSession: async (id) => {
    if (unavailableComposerSessions.has(id)) return false
    const ds = (window as any).ds
    const startupDrafts = composerDraftRestoreState
    unavailableComposerSessions.add(id)
    let finishDeletion!: () => void
    const barrier = new Promise<void>((resolve) => { finishDeletion = resolve })
    composerSessionDeletionBarriers.set(id, barrier)
    const settleDeletion = (): void => { composerSessionDeletionBarriers.delete(id); finishDeletion() }
    await draftPersistence?.beforeDelete(id)
    const resumeDraft = async (): Promise<void> => {
      unavailableComposerSessions.delete(id)
      settleDeletion()
      // Restoring a not-yet-loaded durable draft must precede queuing its
      // current value, otherwise an empty UI can overwrite its saved text.
      try { await initialization } catch { /* Preserve local edits if startup failed. */ }
      draftPersistence?.afterDelete(id, false)
      const state = get()
      const text = id === state.currentSessionId ? state.composerText : state.composerDrafts[id]?.text ?? ''
      // A failed startup read leaves durable text unknown, not empty. Only an
      // explicit edit can authorize replacing that unknown value with ''.
      if (startupDrafts && !startupDrafts.loaded && !startupDrafts.edits.has(id) && !text) return
      draftPersistence?.queue(id, text)
    }
    if (ds?.sessionsDelete) {
      try {
        const deleted = await ds.sessionsDelete(id)
        if (!deleted) {
          await resumeDraft()
          return false
        }
      } catch {
        await resumeDraft()
        return false
      }
    }
    settleDeletion()
    draftPersistence?.afterDelete(id, true)
    const current = get()
    const sessions = current.sessions.filter((x) => x.id !== id)
    const nextId = current.currentSessionId === id ? (sessions.length > 0 ? sessions[0].id : null) : current.currentSessionId
    const composerDrafts = { ...current.composerDrafts }
    delete composerDrafts[id]
    set({ sessions, composerDrafts })
    if (current.currentSessionId === id) {
      sessionLoadVersion += 1
      set({ messages: [], currentSessionId: null, composerText: '', pendingAttachments: [], running: false, runningId: null, totalUsage: null, estimatedContext: null, actualUsage: null, composerPerformance: null, pendingPlan: null })
      if (nextId) await get().switchSession(nextId)
    }
    return true
  },

  loadPermissions: async () => {
    const ds = (window as any).ds
    if (!ds?.permissionsGet) {
      set({ permissions: { mode: 'safe', rules: [] } })
      return
    }
    try {
      const permissions: PermissionSettings = await ds.permissionsGet()
      set({ permissions })
    } catch {
      set({ permissions: { mode: 'safe', rules: [] } })
    }
  },

  updatePermissions: (patch) => {
    const s = get()
    const permissions = { ...(s.permissions ?? { mode: 'safe', rules: [] }), ...patch }
    set({ permissions })
    ;(window as any).ds?.permissionsUpdate?.(permissions)
  },

  setPermissionMode: (mode) => {
    const s = get()
    if (!s.settings) return
    s.updateSettings({ permissionMode: mode })
    s.updatePermissions({ mode })
  },

  startGuidedLongwrite: (prompt, selected) => {
    const s = get()
    const task = prompt.trim()
    if (task.length < 10) {
      get().showToast('请先写下至少 10 个字的创作需求', 'info')
      return false
    }
    if (s.running || s.submitting) {
      get().showToast('当前已有任务正在提交或运行，请完成后再开始梳理', 'info')
      return false
    }
    const attachments = selected ?? s.pendingAttachments
    if (attachments.some(item => item.state === 'parsing' || item.state === 'failed')) {
      get().showToast('请等待素材解析完成，失败的素材请重新选择后再开始梳理', 'info')
      return false
    }
    const sessionId = get().ensureSessionId()
    set((current) => ({
      ...transitionLongMode(current, true),
      grillLaunchRequest: {
        requestId: crypto.randomUUID(),
        sessionId,
        attachments: toWireAttachments(attachments),
        task,
        targetChars: s.targetChars,
        genre: (s.settings?.strongConstraintGenre || (s.story.enabled ? s.story.genre : '')).trim() || '未定',
        kind: '长文'
      }
    }))
    return true
  },

  clearGrillLaunchRequest: (requestId) => {
    if (get().grillLaunchRequest?.requestId === requestId) {
      set({ grillLaunchRequest: null })
      void get().loadSessions()
    }
  },

  loadMemory: async () => {
    const ds = (window as any).ds
    if (!ds?.memoryGet) {
      set({ memory: null })
      return
    }
    try {
      const memory: MemoryInfo = await ds.memoryGet()
      set({ memory })
    } catch {
      set({ memory: null })
    }
  },

  loadStyle: async () => {
    const ds = (window as any).ds
    if (!ds?.styleList) {
      set({ styleState: null })
      return
    }
    try {
      const styleState = await ds.styleList()
      set({ styleState })
    } catch {
      set({ styleState: null })
    }
  },

  styleBuild: async (name, sourceIds) => {
    const ds = (window as any).ds
    if (!ds?.styleBuild) return
    await ds.styleBuild({ name, sourceIds })
    await get().loadStyle()
  },

  styleSetActive: async (profileId) => {
    const ds = (window as any).ds
    if (!ds?.styleSetActive) return
    await ds.styleSetActive(profileId)
    await get().loadStyle()
    get().showToast(profileId ? '已启用风格参照，后续生成将注入画像' : '已停用风格参照', 'success')
  },

  styleUpdate: async (id, patch) => {
    const ds = (window as any).ds
    if (!ds?.styleUpdate) return
    await ds.styleUpdate({ id, patch })
    await get().loadStyle()
  },

  styleDeleteProfile: async (id) => {
    const ds = (window as any).ds
    if (!ds?.styleDeleteProfile) return
    await ds.styleDeleteProfile(id)
    await get().loadStyle()
  },

  styleCheckOverlap: async (profileId, text) => {
    const ds = (window as any).ds
    if (!ds?.styleCheckOverlap) return null
    try {
      return await ds.styleCheckOverlap({ profileId, text })
    } catch {
      return null
    }
  },

  buildProfileV2: async (sourceIds) => {
    const ds = (window as any).ds
    set((s) => ({
      styleV2: {
        ...s.styleV2,
        build: { status: 'building', profileId: '', stats: null, error: undefined }
      }
    }))
    let profileId = ''
    let v2Err = ''
    if (ds?.styleV2BuildProfile) {
      try {
        const res = await ds.styleV2BuildProfile(sourceIds)
        profileId = res?.profileId ?? ''
        if (!profileId) v2Err = '画像构建未返回 profileId'
      } catch (e) {
        v2Err = String((e as { message?: string })?.message ?? e)
      }
    } else {
      v2Err = '主进程高保真流水线未就绪'
    }
    let stats: StyleV2CorpusStats | null = null
    if (profileId && ds?.styleV2CorpusStatus) {
      try {
        const res = await ds.styleV2CorpusStatus(profileId)
        stats = {
          chunks: res?.chunks ?? 0,
          splits: {
            profile: res?.splits?.profile ?? 0,
            example: res?.splits?.example ?? 0,
            holdout: res?.splits?.holdout ?? 0
          },
          effectiveChars: res?.effectiveChars ?? 0,
          sceneTypes: res?.sceneTypes ?? {},
          exemplarCount: res?.exemplarCount ?? 0,
          backgroundBaselineId: res?.profile?.quality?.backgroundBaselineId
        }
      } catch {
        stats = null
      }
    }
    await get().loadStyle()
    if (profileId) {
      try {
        localStorage.setItem('dw.stylev2.profile', JSON.stringify({ profileId }))
      } catch {
        /* 忽略存储失败 */
      }
    }
    set((s) => ({
      styleV2: {
        ...s.styleV2,
        build: {
          status: profileId ? 'done' : 'failed',
          profileId,
          stats,
          error: profileId ? undefined : v2Err
        }
      }
    }))
  },

  restoreV2Profile: async (profileId) => {
    const ds = (window as any).ds
    if (!ds?.styleV2CorpusStatus || !profileId) return
    try {
      const res = await ds.styleV2CorpusStatus(profileId)
      const stats: StyleV2CorpusStats | null = {
        chunks: res?.chunks ?? 0,
        splits: {
          profile: res?.splits?.profile ?? 0,
          example: res?.splits?.example ?? 0,
          holdout: res?.splits?.holdout ?? 0
        },
        effectiveChars: res?.effectiveChars ?? 0,
        sceneTypes: res?.sceneTypes ?? {},
        exemplarCount: res?.exemplarCount ?? 0,
        backgroundBaselineId: res?.profile?.quality?.backgroundBaselineId
      }
      set((s) => ({
        styleV2: {
          ...s.styleV2,
          build: { status: 'done', profileId, stats, error: undefined }
        }
      }))
      get().showToast('已恢复上次构建的 V2 画像', 'success')
    } catch {
      return
    }
  },

  buildExemplarsV2: async (profileId) => {
    const ds = (window as any).ds
    if (!ds?.styleV2BuildExemplars) {
      get().showToast('示例库构建模块未就绪', 'error')
      return
    }
    set((s) => ({ styleV2: { ...s.styleV2, exemplar: { status: 'building', count: 0, error: undefined } } }))
    try {
      const res = await ds.styleV2BuildExemplars(profileId)
      const count = res?.exemplarCount ?? res?.count ?? 0
      set((s) => {
        const build = s.styleV2.build
        const stats = build.stats && build.profileId === profileId ? { ...build.stats, exemplarCount: count } : build.stats
        return {
          styleV2: {
            ...s.styleV2,
            exemplar: { status: 'done', count, error: undefined },
            build: { ...build, stats }
          }
        }
      })
      get().showToast(`示例库构建完成：${count} 条`, 'success')
    } catch (e) {
      const msg = String((e as { message?: string })?.message ?? e)
      set((s) => ({ styleV2: { ...s.styleV2, exemplar: { status: 'failed', count: 0, error: msg } } }))
      get().showToast(`示例库构建失败：${msg}`, 'error')
    }
  },

  jobStartV2: async (profileId, task) => {
    const ds = (window as any).ds
    if (!ds?.styleV2JobStart) {
      get().showToast('高保真生成模块未就绪', 'error')
      return null
    }
    set((s) => ({
      styleV2: {
        ...s.styleV2,
        job: {
          status: 'running',
          jobId: '',
          stage: 'skeleton',
          task,
          candidates: [],
          evaluations: [],
          chosenCandidateId: null,
          chosenText: '',
          usageTokens: { skeleton: 0, candidates: 0, revise: 0, total: 0 },
          version: s.styleV2.job.version + 1,
          signature: '',
          error: undefined
        }
      }
    }))
    try {
      const res = await ds.styleV2JobStart({ profileId, task })
      const jobId = res?.jobId ?? ''
      if (!jobId) throw new Error('未返回 jobId')
      set((s) => ({ styleV2: { ...s.styleV2, job: { ...s.styleV2.job, jobId } } }))
      return jobId
    } catch (e) {
      const msg = String((e as { message?: string })?.message ?? e)
      set((s) => ({ styleV2: { ...s.styleV2, job: { ...s.styleV2.job, status: 'failed', error: msg } } }))
      get().showToast(`生成任务启动失败：${msg}`, 'error')
      return null
    }
  },

  jobGetV2: async (jobId) => {
    const ds = (window as any).ds
    if (!ds?.styleV2JobGet) return null
    try {
      const job = await ds.styleV2JobGet(jobId)
      if (!job) return null
      set((s) => {
        const prev = s.styleV2.job
        const sig = JSON.stringify({
          stage: job.stage ?? '',
          error: job.error ?? '',
          candidates: (job.candidates ?? []).map((c: StyleCandidate) => [c.id, c.charCount]),
          evals: (job.evaluations ?? []).map((e: CandidateEvaluation) => [e.candidateId, e.finalRank ?? -1, e.naturalnessScore]),
          chosen: job.chosenCandidateId ?? '',
          usage: job.usageTokens?.total ?? 0,
          exemplars: (job.exemplarIds ?? []).length
        })
        if (prev.signature === sig && prev.jobId === jobId) return {}
        const chosenId = job.chosenCandidateId ?? prev.chosenCandidateId
        const chosenCand = (job.candidates ?? prev.candidates).find((c: StyleCandidate) => c.id === chosenId)
        return {
          styleV2: {
            ...s.styleV2,
            job: {
              status: job.stage === 'done' ? 'done' : job.stage === 'failed' ? 'failed' : job.stage === 'cancelled' ? 'cancelled' : 'running',
              jobId: job.jobId ?? jobId,
              stage: job.stage ?? prev.stage,
              task: job.task ?? prev.task,
              candidates: job.candidates ?? prev.candidates,
              evaluations: job.evaluations ?? prev.evaluations,
              chosenCandidateId: chosenId,
              chosenText: chosenCand ? chosenCand.text : prev.chosenText,
              usageTokens: job.usageTokens ?? prev.usageTokens,
              version: prev.version + 1,
              signature: sig,
              error: job.error ?? prev.error
            }
          }
        }
      })
      return job
    } catch {
      return null
    }
  },

  jobStopV2: async (jobId) => {
    const ds = (window as any).ds
    if (ds?.styleV2JobStop) {
      try {
        await ds.styleV2JobStop(jobId)
      } catch {
        return
      }
    }
    set((s) => ({
      styleV2: {
        ...s.styleV2,
        job: { ...s.styleV2.job, status: 'cancelled', stage: 'cancelled', version: s.styleV2.job.version + 1 }
      }
    }))
  },

  chooseCandidateV2: async (jobId, candidateId) => {
    const ds = (window as any).ds
    if (!ds?.styleV2ChooseCandidate) {
      get().showToast('候选选择模块未就绪', 'error')
      return
    }
    try {
      const res = await ds.styleV2ChooseCandidate({ jobId, candidateId })
      set((s) => {
        const cand = s.styleV2.job.candidates.find((c) => c.id === candidateId)
        return {
          styleV2: {
            ...s.styleV2,
            job: { ...s.styleV2.job, chosenCandidateId: candidateId, chosenText: res?.text ?? cand?.text ?? '', version: s.styleV2.job.version + 1, signature: '' }
          }
        }
      })
      get().showToast('候选已选定', 'success')
    } catch (e) {
      get().showToast(`选择失败：${String((e as { message?: string })?.message ?? e)}`, 'error')
    }
  },

  reviseStyleSpan: async ({ jobId, revision }) => {
    const ds = (window as any).ds
    if (!ds?.styleV2Revise) {
      get().showToast('局部修订模块未就绪', 'error')
      return
    }
    set((s) => ({ styleV2: { ...s.styleV2, job: { ...s.styleV2.job, status: 'running', stage: 'revising', version: s.styleV2.job.version + 1, signature: '', error: undefined } } }))
    try {
      await ds.styleV2Revise({ jobId, revision })
      get().showToast('已提交局部修订', 'success')
    } catch (e) {
      const msg = String((e as { message?: string })?.message ?? e)
      set((s) => ({ styleV2: { ...s.styleV2, job: { ...s.styleV2.job, status: 'failed', error: msg } } }))
      get().showToast(`修订失败：${msg}`, 'error')
    }
  },

  loadPresets: async () => {
    const ds = (window as any).ds
    if (!ds?.presetsList) return
    try {
      const presets = await ds.presetsList()
      set({ presets })
    } catch {
      set({ presets: [] })
    }
  },

  savePreset: async (preset) => {
    const ds = (window as any).ds
    if (!ds?.presetsSave) return
    const presets = await ds.presetsSave(preset)
    set({ presets })
  },

  removePreset: async (id) => {
    const ds = (window as any).ds
    if (!ds?.presetsRemove) return
    const presets = await ds.presetsRemove(id)
    set({ presets })
  },

  applyPreset: (preset, onApplied) => {
    const s = get()
    const text = String(preset.prompt ?? '').replaceAll('{n}', String(s.targetChars))
    if (preset.story && preset.story.enabled) s.updateStory(preset.story)
    if (typeof preset.longMode === 'boolean') s.setLongMode(preset.longMode)
    if (typeof preset.targetChars === 'number' && preset.targetChars > 0) s.setTargetChars(preset.targetChars)
    onApplied?.(text)
  },

  approvePlan: async (planText, messageId) => {
    const s = get()
    const pending = selectPendingPlan(s, messageId)
    const runMode = deriveWritingRunMode(pending?.approval ? { ...s, mode: 'agent', workspace: 'chat', longMode: false } : s)
    const approvedText = pending?.approval ? pending.planText : planText || pending?.planText || ''
    if (!pending || s.running || s.closing) return
    if (get().pendingPlan !== pending) set({ pendingPlan: pending })
    const sessionId = s.currentSessionId
    const sourceTask = [...s.messages].reverse().find((message) => message.role === 'user')?.content ?? ''
    // Plan approval bypasses the composer send path, so it must still obtain
    // a fresh preview before freezing the execute run.  The execute run has
    // no new user turn; an empty draft is the same value sent to chat:start.
    let preview: ContextPreviewV1 | null
    try {
      preview = await get().previewContext('', [], approvedText, 'execute', sourceTask, undefined, s.pendingStoryScope ?? undefined)
    } catch (error) {
      if (get().currentSessionId === sessionId && get().pendingPlan === pending) get().showToast(errorMessage(error) || '上下文预览失败，计划已保留，请重试', 'error')
      return
    }
    if (get().currentSessionId !== sessionId || get().pendingPlan !== pending || get().running || get().closing) return
    if (!preview || preview.budget.status !== 'ready') {
      get().showToast(preview?.budget.status === 'overflow' ? '上下文超过模型窗口，请调整后重试' : get().contextPreviewError || '上下文预览失败，未执行计划', 'error')
      return
    }
    const execId = crypto.randomUUID()
    const messages = s.messages.map((m) => (pending && m.id === pending.messageId ? { ...m, plan: 'approved' as const } : m))
    const execMsg: StudioUiMessage = {
      id: execId,
      role: 'assistant',
      content: '',
      reasoning: '',
      status: 'thinking',
      usage: null,
      rounds: 0,
      toolEvents: [],
      runConfig: { longMode: runMode.longMode, targetChars: s.targetChars }
    }
    set({
      messages: [...messages, execMsg],
      pendingPlan: null,
      running: true,
      runningId: execId,
      activeRunId: execId,
      totalUsage: null,
      estimatedContext: null,
      actualUsage: null,
      composerPerformance: null,
      mode: runMode.mode,
      longMode: runMode.longMode,
      workspace: runMode.longMode ? 'chat' : s.workspace
    })
    const ds = (window as any).ds
    try {
      if (!ds?.chatStart) throw new Error('主进程连接不可用，请重试执行计划')
      const ack = await ds.chatStart({
      id: execId,
      sessionId: s.currentSessionId ?? crypto.randomUUID(),
      phase: 'execute' as ChatPhase,
      planText: approvedText,
      ...(pending.approval ? { planApproval: pending.approval } : {}),
      fixedPrefix: [],
      story: s.story.enabled ? { ...s.story, characters: s.story.characters.filter((c) => c.name.trim()) } : null,
      longMode: runMode.longMode,
      targetChars: s.targetChars,
      mode: runMode.mode,
      workspace: runMode.workspace,
      contextSelection: { mode: preview.mode, preferenceRevision: preview.policyRevision, previewId: preview.previewId },
      ...(s.pendingStoryScope ? { storyScope: s.pendingStoryScope } : {}),
      strongConstraints: visibleStrongConstraints(
        s.settings!,
        s.story,
        runMode.longMode,
        sourceTask
      ),
      deepWriteExperiment: buildDeepWriteExperimentInput({
        mode: runMode.mode,
        longMode: runMode.longMode,
        experimentEnabled: s.deepWriteExperimentEnabled,
        characterConsent: s.deepWriteCharacterConsent,
        story: s.story
      })
      })
      if (ack?.status === 'cost_confirmation_required') throw new Error('当前版本需要费用确认，计划已保留；请更新应用后重试执行')
      if (!ack || ack.runId !== execId) throw new Error('主进程未确认计划执行，计划已保留，请重试')
      if (get().currentSessionId === sessionId && get().activeRunId === execId) set({ pendingStoryScope: null })
    } catch (error) {
      const current = get()
      if (current.currentSessionId !== sessionId || current.runningId !== execId || current.activeRunId !== execId) return
      set({
        messages: current.messages.filter((message) => message.id !== execId).map((message) =>
          message.id === pending.messageId ? { ...message, plan: s.messages.find((original) => original.id === message.id)?.plan } : message),
        pendingPlan: { ...pending, planText: approvedText },
        running: false,
        runningId: null,
        activeRunId: s.activeRunId
      })
      get().showToast(errorMessage(error) || '计划执行失败，计划已保留，请重试', 'error')
    }
  },

  rejectPlan: async (messageId) => {
    const s = get()
    const pending = selectPendingPlan(s, messageId)
    if (!pending || s.running || s.closing) return
    if (pending.approval) {
      try {
        if (!(window as any).ds?.planReject) throw new Error('主进程连接不可用')
        await (window as any).ds.planReject(pending.approval)
      } catch (error) { get().showToast(errorMessage(error) || '拒绝未保存，请重试', 'error'); return }
    }
    if (get().currentSessionId !== s.currentSessionId) return
    set(current => ({ messages: current.messages.map(message => message.id === pending.messageId ? { ...message, plan: 'rejected' as const } : message), pendingPlan: current.pendingPlan?.messageId === pending.messageId ? null : current.pendingPlan }))
  }
}))
