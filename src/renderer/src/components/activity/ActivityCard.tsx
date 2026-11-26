import { memo } from 'react'
import { useStore } from '../../store'
import { isTerminalPhase, type RunPhase } from '../../../../shared/activity'

const PHASE_LABEL: Record<RunPhase, string> = {
  queued: '准备中…', understanding: '正在理解你的需求…', planning: '正在整理思路…',
  reading: '正在阅读文件…', thinking: '思考中…', executing_tool: '正在处理…',
  writing: '正在回复…', validating: '正在检查结果…', waiting_permission: '需要你的确认',
  paused: '已暂停', stopping: '正在停止…', cancel_requested: '正在停止…',
  recovery_required: '需要你的确认', completed: '已完成', failed: '未能完成', cancelled: '已停止'
}

/** Everyday chat shows one status. Logs, usage and actions live in the inspector. */
export default memo(function ActivityCard({ runId }: { runId: string }): React.ReactNode {
  const run = useStore((state) => state.runs[runId])
  if (!run || run.terminal || isTerminalPhase(run.status)) return null
  return <div className="activity-brief" role="status"><span className="phase-dot running" />{PHASE_LABEL[run.status]}</div>
})
