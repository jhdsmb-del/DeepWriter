import { TOOL_NAMES } from '../../toolLabels'
import { memo, useState } from 'react'
import type { ActivityStep, ToolActivity } from '../../../../shared/activity'


function fmtDuration(ms: number | undefined): string {
  if (ms == null) return ''
  if (ms < 1000) return ms < 100 ? '不到 1 秒' : '约 1 秒'
  return `${(ms / 1000).toFixed(1)} 秒`
}

interface ToolActivityRowProps {
  step: ActivityStep
  tool?: ToolActivity
}

function ToolActivityRowInner({ step, tool }: ToolActivityRowProps): React.ReactNode {
  const [open, setOpen] = useState(false)
  const status = tool?.status ?? (step.type === 'tool.completed' ? 'done' : step.type === 'tool.failed' ? 'failed' : step.type === 'tool.requested' ? 'requested' : 'running')
  const failed = status === 'failed'
  const label = { requested: '待执行', running: '执行中', failed: '失败', done: '已完成' }[status]
  const name = tool ? (TOOL_NAMES[tool.toolName] ?? tool.toolName) : step.title
  const hasOutput = tool?.outputPreview != null && tool.outputPreview.length > 0
  return (
    <>
      <div className={`step-row tool${failed ? ' failed' : ''}`}>
        <span role="img" aria-label={label} title={label} className={`step-icon ${failed ? 'err' : status === 'done' ? 'ok' : ''}`}>{failed ? '×' : status === 'done' ? '✓' : '…'}</span>
        <span className="step-title" title={step.title}>
          {name}
        </span>
        {tool?.safeInputSummary && <span className="step-args">{tool.safeInputSummary}</span>}
        <span className="step-meta">
          {tool?.exitCode != null && (
            <span className={`step-exit${tool.exitCode !== 0 ? ' bad' : ''}`}>exit {tool.exitCode}</span>
          )}
          {tool?.durationMs != null && <span>{fmtDuration(tool.durationMs)}</span>}
          {hasOutput && (
            <button className="step-expand" onClick={() => setOpen(!open)}>
              {open ? '▾' : '▸'}
            </button>
          )}
        </span>
      </div>
      {open && hasOutput && <pre className="step-output">{tool!.outputPreview}</pre>}
    </>
  )
}

export default memo(ToolActivityRowInner)
