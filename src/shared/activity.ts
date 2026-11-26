export const ACTIVITY_SCHEMA_VERSION = 1

export type RunPhase =
  | 'queued'
  | 'understanding'
  | 'planning'
  | 'reading'
  | 'thinking'
  | 'executing_tool'
  | 'writing'
  | 'validating'
  | 'waiting_permission'
  | 'paused'
  | 'stopping'
  | 'cancel_requested'
  | 'recovery_required'
  | 'completed'
  | 'failed'
  | 'cancelled'

export type ActivityEventType =
  | 'run.started'
  | 'phase.changed'
  | 'activity.message'
  | 'reasoning.delta'
  | 'content.delta'
  | 'tool.requested'
  | 'tool.started'
  | 'tool.output'
  | 'tool.completed'
  | 'tool.failed'
  | 'permission.requested'
  | 'permission.resolved'
  | 'artifact.started'
  | 'artifact.progress'
  | 'artifact.completed'
  | 'usage.updated'
  | 'run.completed'
  | 'run.failed'
  | 'run.cancelled'

export interface ToolPayload {
  kind: 'tool'
  toolCallId: string
  toolName: string
  safeInputSummary: string
  cwdDisplay?: string
  outputPreview?: string
  exitCode?: number | null
  durationMs?: number
}

export interface ArtifactPayload {
  kind: 'artifact'
  artifactId: string
  artifactType: 'chapter' | 'scene' | 'renpy' | 'document' | 'file' | 'manuscript'
  displayName: string
  status: 'started' | 'progress' | 'completed' | 'failed'
  completedChars?: number
  targetChars?: number
  completedItems?: number
  totalItems?: number
  relativePath?: string
}

export interface UsagePayload {
  kind: 'usage'
  source: 'estimated' | 'actual'
  inputTokens?: number
  outputTokens?: number
  cacheHitTokens?: number
  cacheMissTokens?: number
  reasoningTokens?: number
  cost?: number
}

export interface PermissionPayload {
  kind: 'permission'
  permissionId: string
  risk: 'low' | 'medium' | 'high'
  actionSummary: string
}

export type ActivityPayload = ToolPayload | ArtifactPayload | UsagePayload | PermissionPayload

export interface ActivityEvent {
  schemaVersion: number
  runId: string
  sessionId: string
  seq: number
  timestamp: number
  elapsedMs: number
  type: ActivityEventType
  phase: RunPhase
  title?: string
  detail?: string
  payload?: ActivityPayload
}

export interface ActivityStep {
  seq: number
  type: ActivityEventType
  phase: RunPhase
  title: string
  detail?: string
  timestamp: number
  elapsedMs: number
}

export interface ToolActivity {
  toolCallId: string
  toolName: string
  safeInputSummary: string
  status: 'requested' | 'running' | 'done' | 'failed'
  startedAt?: number
  durationMs?: number
  exitCode?: number | null
  outputPreview?: string
  cwdDisplay?: string
}

export interface ArtifactActivity {
  artifactId: string
  artifactType: ArtifactPayload['artifactType']
  displayName: string
  status: 'started' | 'progress' | 'completed' | 'failed'
  completedChars?: number
  targetChars?: number
  completedItems?: number
  totalItems?: number
  relativePath?: string
}

export interface RunUsageView {
  source: 'estimated' | 'actual'
  inputTokens?: number
  outputTokens?: number
  cacheHitTokens?: number
  cacheMissTokens?: number
  reasoningTokens?: number
  cost?: number
}

export interface RunSnapshot {
  runId: string
  sessionId: string
  status: RunPhase
  startedAt: number
  lastSeq: number
  currentTitle?: string
  currentDetail?: string
  steps: ActivityStep[]
  toolsById: Record<string, ToolActivity>
  artifactsById: Record<string, ArtifactActivity>
  usage: RunUsageView
  terminal?: { state: 'completed' | 'failed' | 'cancelled'; summary?: string; error?: string }
}

export type RunViewState = RunSnapshot & { needsResync?: boolean }

const TERMINAL_PHASES = new Set<RunPhase>(['completed', 'failed', 'cancelled'])

export function isTerminalPhase(p: RunPhase): boolean {
  return TERMINAL_PHASES.has(p)
}

/**
 * 幂等 run reducer：按 seq 应用事件。
 * - seq <= lastSeq → 忽略（重复事件）
 * - seq === lastSeq + 1 → 正常应用
 * - seq > lastSeq + 1 → 置 needsResync（UI 应调用 getSnapshot）
 * - 终态后忽略后续事件（迟到 chunk/工具输出不再改变 UI 状态）
 */
export function createRunReducer(): (state: RunViewState | null, ev: ActivityEvent) => RunViewState | null {
  return (state, ev) => {
    if (ev.schemaVersion !== ACTIVITY_SCHEMA_VERSION) return state
    if (!state) {
      const init: RunViewState = {
        runId: ev.runId,
        sessionId: ev.sessionId,
        status: ev.phase,
        startedAt: ev.timestamp,
        lastSeq: ev.seq,
        currentTitle: ev.title,
        currentDetail: ev.detail,
        steps: [],
        toolsById: {},
        artifactsById: {},
        usage: { source: 'estimated' },
        needsResync: ev.seq !== 0
      }
      return applyTo(init, ev)
    }
    if (state.runId !== ev.runId) return state
    if (isTerminalPhase(state.status)) return state
    if (ev.seq <= state.lastSeq) return state
    const next = { ...state, lastSeq: ev.seq, needsResync: ev.seq !== state.lastSeq + 1 || state.needsResync }
    return applyTo(next, ev)
  }
}

function applyTo(state: RunViewState, ev: ActivityEvent): RunViewState {
  let next: RunViewState = { ...state }
  if (ev.title) next.currentTitle = ev.title
  if (ev.detail) next.currentDetail = ev.detail
  if (ev.type === 'phase.changed' || ev.type === 'run.started' || ev.type === 'run.completed' || ev.type === 'run.failed' || ev.type === 'run.cancelled') {
    next.status = ev.phase
  }
  if (ev.type === 'run.completed') {
    next.terminal = { state: 'completed', summary: ev.title }
  } else if (ev.type === 'run.failed') {
    next.terminal = { state: 'failed', error: ev.detail || ev.title }
  } else if (ev.type === 'run.cancelled') {
    next.terminal = { state: 'cancelled', summary: ev.title }
  }
  if (ev.type === 'usage.updated' && ev.payload?.kind === 'usage') {
    next.usage = { ...ev.payload }
  }
  if (ev.type === 'tool.requested' || ev.type === 'tool.started' || ev.type === 'tool.completed' || ev.type === 'tool.failed') {
    const p = ev.payload
    if (p?.kind === 'tool') {
      const prev = next.toolsById[p.toolCallId]
      next.toolsById = {
        ...next.toolsById,
        [p.toolCallId]: {
          toolCallId: p.toolCallId,
          toolName: p.toolName,
          safeInputSummary: p.safeInputSummary,
          status: ev.type === 'tool.completed' ? 'done' : ev.type === 'tool.failed' ? 'failed' : prev?.status === 'running' ? 'running' : ev.type === 'tool.started' ? 'running' : 'requested',
          startedAt: prev?.startedAt ?? ev.timestamp,
          durationMs: p.durationMs ?? prev?.durationMs,
          exitCode: p.exitCode ?? prev?.exitCode,
          outputPreview: p.outputPreview ?? prev?.outputPreview,
          cwdDisplay: p.cwdDisplay ?? prev?.cwdDisplay
        }
      }
    }
  }
  if (ev.type === 'artifact.started' || ev.type === 'artifact.progress' || ev.type === 'artifact.completed') {
    const p = ev.payload
    if (p?.kind === 'artifact') {
      next.artifactsById = {
        ...next.artifactsById,
        [p.artifactId]: {
          artifactId: p.artifactId,
          artifactType: p.artifactType,
          displayName: p.displayName,
          status: ev.type === 'artifact.completed' ? 'completed' : 'started',
          completedChars: p.completedChars,
          targetChars: p.targetChars,
          completedItems: p.completedItems,
          totalItems: p.totalItems,
          relativePath: p.relativePath
        }
      }
    }
  }
  const keepStep =
    ev.type === 'phase.changed' ||
    ev.type === 'activity.message' ||
    ev.type === 'tool.requested' ||
    ev.type === 'tool.started' ||
    ev.type === 'tool.completed' ||
    ev.type === 'tool.failed' ||
    ev.type === 'permission.requested' ||
    ev.type === 'permission.resolved' ||
    ev.type === 'artifact.started' ||
    ev.type === 'artifact.progress' ||
    ev.type === 'artifact.completed'
  if (keepStep) {
    const step: ActivityStep = {
      seq: ev.seq,
      type: ev.type,
      phase: ev.phase,
      title: ev.title ?? ev.type,
      detail: ev.detail,
      timestamp: ev.timestamp,
      elapsedMs: ev.elapsedMs
    }
    next.steps = [...next.steps, step].slice(-200)
  }
  return next
}

// ==================== 校验与脱敏 ====================

const EVENT_TYPES = new Set<ActivityEventType>([
  'run.started', 'phase.changed', 'activity.message', 'reasoning.delta', 'content.delta',
  'tool.requested', 'tool.started', 'tool.output', 'tool.completed', 'tool.failed',
  'permission.requested', 'permission.resolved', 'artifact.started', 'artifact.progress',
  'artifact.completed', 'usage.updated', 'run.completed', 'run.failed', 'run.cancelled'
])

const PHASES = new Set<RunPhase>([
  'queued', 'understanding', 'planning', 'reading', 'thinking', 'executing_tool', 'writing',
  'validating', 'waiting_permission', 'paused', 'stopping', 'cancel_requested', 'recovery_required', 'completed', 'failed', 'cancelled'
])

export function validateActivityEvent(raw: unknown): { ok: true; ev: ActivityEvent } | { ok: false; error: string } {
  const ev = raw as Record<string, unknown> | null
  if (!ev || typeof ev !== 'object') return { ok: false, error: '非对象' }
  if (ev.schemaVersion !== ACTIVITY_SCHEMA_VERSION) return { ok: false, error: `schemaVersion 应为 ${ACTIVITY_SCHEMA_VERSION}` }
  if (typeof ev.runId !== 'string' || !ev.runId) return { ok: false, error: 'runId 缺失' }
  if (typeof ev.sessionId !== 'string') return { ok: false, error: 'sessionId 缺失' }
  if (typeof ev.seq !== 'number' || !Number.isInteger(ev.seq) || ev.seq < 0) return { ok: false, error: 'seq 非法' }
  if (typeof ev.timestamp !== 'number') return { ok: false, error: 'timestamp 缺失' }
  if (typeof ev.elapsedMs !== 'number') return { ok: false, error: 'elapsedMs 缺失' }
  if (typeof ev.type !== 'string' || !EVENT_TYPES.has(ev.type as ActivityEventType)) return { ok: false, error: `type 非法: ${String(ev.type)}` }
  if (typeof ev.phase !== 'string' || !PHASES.has(ev.phase as RunPhase)) return { ok: false, error: `phase 非法: ${String(ev.phase)}` }
  if (ev.title !== undefined && typeof ev.title !== 'string') return { ok: false, error: 'title 非法' }
  if (ev.detail !== undefined && typeof ev.detail !== 'string') return { ok: false, error: 'detail 非法' }
  return { ok: true, ev: ev as unknown as ActivityEvent }
}

const META_CHARS = /[&|;<>`$(){}\*?~"'!]/g
const SK_KEY_RE = /sk-[A-Za-z0-9]{16,}/g
const EMAIL_RE = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g
const WIN_PATH_RE = /[A-Za-z]:\\[^\s"'<>|]+/g
const POSIX_PATH_RE = /\/(?:[\w.-]+\/)+[\w.-]+/g

function basenameReplacer(match: string): string {
  const sep = match.includes('/') ? '/' : '\\'
  const parts = match.split('/').join('\\').split('\\')
  return `…${sep}${parts[parts.length - 1]}`
}

export function redactText(text: string): string {
  return text
    .replace(META_CHARS, '·')
    .replace(SK_KEY_RE, 'sk-***')
    .replace(EMAIL_RE, '***@***')
    .replace(WIN_PATH_RE, basenameReplacer)
    .replace(POSIX_PATH_RE, basenameReplacer)
}

export function safeToolInputSummary(raw: unknown, max = 160): string {
  let s = ''
  try {
    s = typeof raw === 'string' ? raw : JSON.stringify(raw)
  } catch {
    s = String(raw)
  }
  s = redactText(s)
  return s.length > max ? s.slice(0, max) + '…' : s
}

export function safeOutputPreview(output: string, max = 2000): string {
  const cleaned = redactText(output)
  return cleaned.length > max ? cleaned.slice(0, max) + `\n…（共 ${output.length} 字符）` : cleaned
}
