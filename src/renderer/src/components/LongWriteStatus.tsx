import { memo, useMemo } from 'react'
import { useStore, type StudioUiMessage } from '../store'
import type { RunPhase, RunViewState } from '../../../shared/activity'
import { codePointLength } from '../../../shared/textMetrics'
import ElapsedTime from './activity/ElapsedTime'

const PHASE_LABEL: Partial<Record<RunPhase, string>> = {
  queued: '准备任务',
  understanding: '理解要求',
  planning: '整理写作计划',
  reading: '读取上下文',
  thinking: '准备正文',
  executing_tool: '处理素材',
  writing: '生成正文',
  validating: '检查完成条件',
  waiting_permission: '等待确认',
  paused: '等待你的决定',
  stopping: '正在停止',
  cancel_requested: '正在停止',
  recovery_required: '等待恢复',
  completed: '已完成',
  failed: '生成失败',
  cancelled: '已取消'
}

interface LongWriteStatusProps {
  message?: StudioUiMessage | null
  runId?: string | null
}

function cleanPhase(value: string): string {
  return value.replace(/继续写作|继续生成|续写中/g, '自动生成中').trim()
}

function toneFor(status: string): 'running' | 'waiting' | 'completed' | 'error' {
  if (status === 'completed') return 'completed'
  if (status === 'failed' || status === 'cancelled') return 'error'
  if (status === 'waiting_user' || status === 'recovery_required' || status === 'paused') return 'waiting'
  return 'running'
}

function LongWriteStatusInner({ message, runId }: LongWriteStatusProps): React.ReactNode {
  const id = runId ?? message?.id ?? null
  const run = useStore((state) => (id ? state.runs[id] ?? null : null))
  const recoverable = useStore((state) => id ? state.recoverableRuns.find((item) => item.runId === id) ?? null : null)
  const completion = useStore((state) => id ? state.completionProgress[id] ?? null : null)
  const runStop = useStore((state) => state.runStop)
  const resumeRun = useStore((state) => state.resumeRun)
  const abandonRun = useStore((state) => state.abandonRun)
  const openRunInspector = useStore((state) => state.openRunInspector)
  const showToast = useStore((state) => state.showToast)

  const contentChars = codePointLength(message?.content ?? '')
  const artifactChars = useMemo(() => Object.values(run?.artifactsById ?? {}).reduce((max, artifact) => Math.max(max, artifact.completedChars ?? 0), 0), [run?.artifactsById])
  const measuredChars = Math.max(contentChars, artifactChars, completion?.measuredChars ?? 0)
  const targetChars = message?.runConfig?.targetChars ?? completion?.targetChars ?? Object.values(run?.artifactsById ?? {}).find((artifact) => artifact.targetChars && artifact.targetChars > 0)?.targetChars ?? 0
  const ratio = targetChars > 0 ? Math.min(1, measuredChars / targetChars) : 0
  const durableStatus = recoverable?.status ?? run?.status ?? (message?.status === 'error' ? 'failed' : message?.status === 'done' ? 'completed' : 'running')
  const terminalState = run?.terminal?.state
  const status = terminalState ?? durableStatus
  const tone = toneFor(status)
  const waitingForUser = recoverable?.status === 'waiting_user' || recoverable?.status === 'recovery_required' || completion?.state === 'waiting_user'
  const budgetBlocked = completion?.blockedReason === 'budget_exhausted' || recoverable?.errorCode === 'completion_budget_exhausted'
  const visible = Boolean(message && (message.status === 'thinking' || message.status === 'streaming' || message.status === 'tool' || run || recoverable))
  if (!visible) return null

  const phase = cleanPhase(
    run?.terminal?.state === 'completed'
      ? '已完成'
      : run?.terminal?.state === 'failed'
        ? '生成失败'
        : run?.terminal?.state === 'cancelled'
          ? '已取消'
          : run?.currentTitle?.trim() || (run ? PHASE_LABEL[run.status] ?? run.status : message?.status === 'thinking' ? '准备正文' : message?.status === 'tool' ? '处理素材' : '生成正文')
  )
  const active = Boolean(run && !run.terminal && !waitingForUser && !['failed', 'cancelled'].includes(status))
  const elapsed = run?.steps[run.steps.length - 1]?.elapsedMs ?? 0
  const canStop = Boolean(run && !run.terminal)
  const canOpenDetails = Boolean(id && (run || recoverable))

  const continueRun = async (): Promise<void> => {
    if (!id) return
    if (budgetBlocked) {
      openRunInspector(id, 'activity')
      return
    }
    const ok = await resumeRun(id)
    showToast(ok ? '已继续处理该任务' : '无法继续，请打开任务详情查看原因', ok ? 'success' : 'error')
  }

  const stopRun = (): void => {
    if (run) {
      runStop(run.runId)
      return
    }
    if (id) void abandonRun(id).then((ok) => showToast(ok ? '任务已停止' : '停止失败', ok ? 'info' : 'error'))
  }

  return (
    <section
      className={`long-write-status ${tone}`}
      data-testid="long-write-status"
      aria-label={`长文状态：${phase}`}
      aria-live="polite"
    >
      <div className="long-write-status-head">
        <div className="long-write-status-title">
          <span className="long-write-status-dot" aria-hidden="true" />
          <strong>{phase}</strong>
          {run && <span className="long-write-status-elapsed">{active ? <ElapsedTime startedAt={run.startedAt} running /> : elapsed > 0 ? `${Math.round(elapsed / 1000)} 秒` : ''}</span>}
        </div>
        <div className="long-write-status-actions">
          {waitingForUser && id && (
            <button type="button" className={`long-write-status-action${budgetBlocked ? ' budget' : ''}`} data-testid="long-write-continue" onClick={() => void continueRun()}>
              {budgetBlocked ? '增加预算并继续' : '继续处理'}
            </button>
          )}
          {canOpenDetails && <button type="button" className="long-write-status-action" onClick={() => id && openRunInspector(id)}>任务详情</button>}
          {canStop && <button type="button" className="long-write-status-action stop" onClick={stopRun}>停止</button>}
        </div>
      </div>
      <div className="long-write-status-progress-row">
        <span>{measuredChars.toLocaleString()} / {targetChars > 0 ? `${targetChars.toLocaleString()} 字` : '目标待定'}</span>
        {targetChars > 0 && <span>{Math.round(ratio * 100)}%</span>}
      </div>
      <div className="long-write-status-track" data-testid="long-write-status-progress" role="progressbar" aria-label="长文完成进度" aria-valuemin={0} aria-valuemax={targetChars > 0 ? targetChars : undefined} aria-valuenow={targetChars > 0 ? Math.min(targetChars, measuredChars) : undefined}>
        <span style={{ width: `${(ratio * 100).toFixed(2)}%` }} />
      </div>
      {run?.currentDetail && <p className="long-write-status-detail">{cleanPhase(run.currentDetail)}</p>}
    </section>
  )
}

export default memo(LongWriteStatusInner)
