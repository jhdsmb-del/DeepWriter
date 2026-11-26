import { useEffect, useMemo, useRef, useState } from 'react'
import { isTerminalPhase, type RunPhase, type RunViewState } from '../../../shared/activity'
import { useStore } from '../store'
import ElapsedTime from './activity/ElapsedTime'
import ConfirmDialog from './ConfirmDialog'
import Icon from './Icon'
import { prefetchInspectorPanel } from '../panelModules'

interface RecentRun {
  runId: string
  sessionId: string
  sessionTitle: string
  status: string
  phase: string
  startedAt: number
  updatedAt: number
  model: string
  durableCompleted: boolean
}
const PHASE_LABEL: Partial<Record<RunPhase, string>> = {
  queued: '正在准备',
  understanding: '正在理解要求',
  planning: '正在制定计划',
  reading: '正在读取上下文',
  thinking: '正在思考',
  executing_tool: '正在执行工具',
  writing: '正在写作',
  validating: '正在检查结果',
  waiting_permission: '等待你的确认',
  paused: '已暂停',
  stopping: '正在停止',
  cancel_requested: '正在取消',
  recovery_required: '需要恢复决定',
  completed: '已完成',
  failed: '失败',
  cancelled: '已取消'
}

function phaseLabel(run: RunViewState): string {
  return run.currentTitle?.trim() || PHASE_LABEL[run.status] || '状态同步中'
}

function dateLabel(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return '时间未知'
  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit'
  }).format(new Date(value))
}

function useRecentRuns(runs: Record<string, RunViewState>, revision: number): { runs: RecentRun[]; loading: boolean } {
  const [recent, setRecent] = useState<RecentRun[]>([])
  const [loading, setLoading] = useState(true)
  const terminalRevision = Object.values(runs)
    .filter((run) => run.terminal)
    .map((run) => `${run.runId}:${run.lastSeq}`)
    .sort()
    .join('|')
  useEffect(() => {
    let live = true
    const ds = (window as any).ds
    if (!ds?.runsListRecent) {
      setLoading(false)
      return
    }
    void ds.runsListRecent(50)
      .then((next: RecentRun[]) => { if (live) setRecent(Array.isArray(next) ? next : []) })
      .catch(() => { if (live) setRecent([]) })
      .finally(() => { if (live) setLoading(false) })
    return () => { live = false }
  }, [terminalRevision, revision])
  return { runs: recent, loading }
}

function ActiveRunRow({ run }: { run: RunViewState }): React.ReactNode {
  const open = useStore((state) => state.openRunInspector)
  const stop = useStore((state) => state.runStop)
  return (
    <li className="dw-task-run">
      <button className="dw-task-run-main" aria-label={`${phaseLabel(run)}，查看任务 ${run.runId.slice(0, 8)}`} onPointerEnter={prefetchInspectorPanel} onFocus={prefetchInspectorPanel} onClick={() => open(run.runId)}>
        <span className="dw-task-live-dot" aria-hidden="true" />
        <span>
          <b>{phaseLabel(run)}</b>
          <small>{PHASE_LABEL[run.status] !== phaseLabel(run) ? `${PHASE_LABEL[run.status] ?? '状态同步中'} · ` : ''}{run.runId.slice(0, 8)}</small>
          {run.currentDetail && <small className="dw-task-run-detail">{run.currentDetail}</small>}
          <small className="dw-task-run-elapsed">已运行 <ElapsedTime startedAt={run.startedAt} running /></small>
        </span>
      </button>
      <button className="dw-text-btn danger" disabled={run.status === 'stopping' || run.status === 'cancel_requested'} onClick={() => void stop(run.runId)}><Icon name="stop" />{run.status === 'stopping' || run.status === 'cancel_requested' ? '停止中' : '停止'}</button>
    </li>
  )
}

function RecentRunRow({ run, onDelete }: { run: RecentRun; onDelete: (run: RecentRun) => void }): React.ReactNode {
  const open = useStore((state) => state.openRunInspector)
  const title = run.sessionTitle.trim() || `任务 ${run.runId.slice(0, 8)}`
  const statusLabel = run.status === 'completed' ? '已完成' : run.status === 'cancelled' ? '已停止' : '失败'
  return (
    <li className="dw-task-recent">
      <button className="dw-task-run-main" aria-label={`${title}，${dateLabel(run.updatedAt)}${statusLabel}，查看详情`} onPointerEnter={prefetchInspectorPanel} onFocus={prefetchInspectorPanel} onClick={() => open(run.runId)}>
        <span className={`dw-task-complete-dot status-${run.status}`} aria-hidden="true" />
        <span><b>{title}</b><small>{dateLabel(run.updatedAt)} · {run.model || '模型未知'} · {statusLabel}</small></span>
      </button>
      <div className="dw-task-inline-actions">
        <button className="dw-text-btn" onPointerEnter={prefetchInspectorPanel} onFocus={prefetchInspectorPanel} onClick={() => open(run.runId, 'billing')}><Icon name="receipt" />账单</button>
        <button className="dw-text-btn danger" onClick={() => onDelete(run)}><Icon name="trash" />删除</button>
      </div>
    </li>
  )
}

export function AgentTaskCenter(): React.ReactNode {
  const runs = useStore((state) => state.runs)
  const newSession = useStore((state) => state.newSession)
  const running = useStore((state) => state.running || state.submitting)
  const recoverableRuns = useStore((state) => state.recoverableRuns)
  const openInspector = useStore((state) => state.openRunInspector)
  const showToast = useStore((state) => state.showToast)
  const setMode = useStore((state) => state.setMode)
  const deleteRun = useStore((state) => state.deleteRun)
  const runListRevision = useStore((state) => state.runListRevision)
  const [deleteTarget, setDeleteTarget] = useState<RecentRun | null>(null)
  const active = useMemo(() => Object.values(runs)
    .filter((run) => !run.terminal && !isTerminalPhase(run.status))
    .sort((a, b) => b.startedAt - a.startedAt), [runs])
  const recentState = useRecentRuns(runs, runListRevision)
  const completed = recentState.runs.filter((run) => (run.status === 'completed' && run.durableCompleted) || run.status === 'failed' || run.status === 'cancelled').slice(0, 20)
  const startTask = (): void => {
    newSession()
    setMode('agent')
  }
  return (
    <section className="dw-agent-task-center is-full" aria-labelledby="dw-agent-task-title">
      <header className="dw-task-center-head">
        <div><h2 id="dw-agent-task-title">任务中心</h2></div>
        <div className="dw-task-center-actions">
          <button className="btn primary" disabled={running} onClick={startTask}><Icon name="plus" />新建任务</button>
          {recoverableRuns.length > 0 && <button className="ghost-btn" onClick={() => {
            const first = recoverableRuns[0]
            if (first) openInspector(first.runId)
            else showToast('当前没有需要恢复的任务', 'info')
          }}>恢复未完成任务 ({recoverableRuns.length})</button>}
        </div>
      </header>
      <div className="dw-task-center-grid">
        <section aria-labelledby="dw-active-runs-title">
          <h3 id="dw-active-runs-title">正在做什么</h3>
          {active.length > 0 ? <ul>{active.map((run) => <ActiveRunRow key={run.runId} run={run} />)}</ul> : <p className="dw-task-empty">当前没有进行中的任务。</p>}
        </section>
        <section aria-labelledby="dw-completed-runs-title">
          <h3 id="dw-completed-runs-title">最近结束</h3>
          {recentState.loading ? <p className="dw-task-empty">正在同步任务记录…</p> : completed.length > 0 ? <ul>{completed.map((run) => <RecentRunRow key={run.runId} run={run} onDelete={setDeleteTarget} />)}</ul> : <p className="dw-task-empty">已结束的任务会显示在这里。</p>}
        </section>
      </div>
      {deleteTarget ? <ConfirmDialog
        title="删除这个工作流？"
        description={`“${deleteTarget.sessionTitle || deleteTarget.runId.slice(0, 8)}”的流程、账单与运行证据将从本机删除；当前故事线修订默认保留。若本轮内容有误，可选择同时撤回故事修订。`}
        confirmLabel="仅删除执行记录"
        secondaryLabel="删除并撤回故事修订"
        destructive
        onCancel={() => setDeleteTarget(null)}
        onConfirm={() => { const runId = deleteTarget.runId; setDeleteTarget(null); void deleteRun(runId, 'preserve') }}
        onSecondary={() => { const runId = deleteTarget.runId; setDeleteTarget(null); void deleteRun(runId, 'retract') }}
      /> : null}
    </section>
  )
}
