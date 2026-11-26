export type FloatingRunStatus = 'idle' | 'queued' | 'running' | 'waiting_approval' | 'stopping' | 'completed' | 'failed' | 'cancelled' | 'recovery_required'

export interface FloatingRunState {
  runId: string | null
  /** 用户正在处理的项目或会话名称；悬浮窗抬头使用，避免暴露内部 run id。 */
  projectName: string
  status: FloatingRunStatus
  phase: string
  title: string
  generatedChars: number
  targetChars: number
  inputTokens: number
  outputTokens: number
  stepCurrent: number
  stepTotal: number
  startedAt: number | null
  updatedAt: number
  error?: string
  /** R4.4 Gate 3：completion 一行客观进度（如 "校验 2/3 · 8,400/10,000 字"；不展示模型自述） */
  completionSummary?: string
}

export const EMPTY_FLOATING_RUN_STATE: FloatingRunState = {
  runId: null,
  projectName: 'DeepWriter',
  status: 'idle',
  phase: 'idle',
  title: '等待任务',
  generatedChars: 0,
  targetChars: 0,
  inputTokens: 0,
  outputTokens: 0,
  stepCurrent: 0,
  stepTotal: 0,
  startedAt: null,
  updatedAt: Date.now(),
  completionSummary: undefined
}
