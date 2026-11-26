import { useEffect, useState } from 'react'
import type { FloatingRunState } from '../../shared/floating'
import { EMPTY_FLOATING_RUN_STATE } from '../../shared/floating'
import Icon from './components/Icon'

const PHASE_LABELS: Record<string, string> = {
  idle: '暂时没有进行中的任务',
  queued: '正在准备',
  running: '正在处理当前任务',
  understanding: '正在理解你的要求',
  planning: '正在整理思路',
  reading: '正在查看和整理素材',
  thinking: '正在思考下一步',
  writing: '正在写作',
  executing_tool: '正在处理项目文件',
  validating: '正在检查结果',
  waiting_permission: '等你确认后继续',
  paused: '等你决定下一步',
  stopping: '正在停止任务',
  completed: '已经完成，点开看看',
  failed: '出了点问题，点开查看',
  cancelled: '任务已停止',
  recovery_required: '需要你选择恢复方式'
}

function statusCopy(state: FloatingRunState): string {
  return PHASE_LABELS[state.phase] || PHASE_LABELS[state.status] || '正在处理当前任务'
}

export default function FloatWindow(): React.ReactNode {
  const [state, setState] = useState<FloatingRunState>(EMPTY_FLOATING_RUN_STATE)
  const [hovered, setHovered] = useState(false)

  useEffect(() => {
    const api = (window as any).dwFloat
    if (!api) return
    void api.getState().then((next: FloatingRunState) => setState(next)).catch(() => undefined)
    return api.onState((next: FloatingRunState) => setState(next))
  }, [])

  const running = ['queued', 'running', 'waiting_approval', 'stopping'].includes(state.status)
  const phase = statusCopy(state)
  const canStop = running && state.status !== 'stopping' && state.status !== 'waiting_approval'
  const projectName = state.projectName?.trim() || 'DeepWriter'

  return (
    <div
      className={`dw-float-root status-${state.status}${hovered ? ' is-hovered' : ''}`}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <span className="dw-float-drag-handle" title="拖动悬浮窗" aria-hidden="true">
        <span className="dw-float-grip"><i /><i /><i /></span>
      </span>
      <button className="dw-float-summary" aria-label={`${projectName}，${phase}，打开 DeepWriter`} onClick={() => void (window as any).dwFloat?.openMain?.()}>
        <span className="dw-float-project-row">
          <span className="dw-float-project" title={projectName}>{projectName}</span>
        </span>
        <span className="dw-float-status-row" aria-live="polite">
          <span className="dw-float-dot" aria-hidden="true" />
          <span className="dw-float-phase" title={phase}>{phase}</span>
        </span>
        <span className="dw-float-open-hint" aria-hidden="true"><Icon name="open" size={14} /></span>
      </button>
      <div className="dw-float-actions" aria-hidden={!hovered}>
        {canStop && (
          <button aria-label="停止当前任务" title="停止" onClick={() => void (window as any).dwFloat?.stop?.()}><Icon name="stop" size={13} /></button>
        )}
        <button aria-label="隐藏悬浮窗" title="隐藏" onClick={() => void (window as any).dwFloat?.hide?.()}><Icon name="close" size={13} /></button>
      </div>
    </div>
  )
}
