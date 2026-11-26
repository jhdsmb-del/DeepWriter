import { memo, useState } from 'react'
import type { ActivityStep, RunPhase, ToolActivity } from '../../../../shared/activity'
import ToolActivityRow from './ToolActivityRow'

const AGGREGATE_WINDOW_MS = 500

interface StepGroup {
  title: string
  phase: RunPhase
  steps: ActivityStep[]
}

function groupSteps(steps: ActivityStep[]): StepGroup[] {
  const groups: StepGroup[] = []
  for (const st of steps) {
    const last = groups[groups.length - 1]
    if (
      last &&
      last.title === st.title &&
      last.phase === st.phase &&
      last.steps[0].type === st.type &&
      st.timestamp - last.steps[last.steps.length - 1].timestamp <= AGGREGATE_WINDOW_MS
    ) {
      last.steps.push(st)
    } else {
      groups.push({ title: st.title, phase: st.phase, steps: [st] })
    }
  }
  return groups
}

function matchTools(steps: ActivityStep[], tools: ToolActivity[]): (ToolActivity | undefined)[] {
  const pool = [...tools]
  return steps.map((st) => {
    const want = st.type === 'tool.failed' ? 'failed' : 'done'
    const stripped = st.title.replace(/完成$/, '').replace(/失败$/, '')
    let idx = pool.findIndex((t) => t.status === want && (t.toolName === stripped || t.toolName.includes(stripped) || stripped.includes(t.toolName)))
    if (idx < 0) idx = pool.findIndex((t) => t.status === want)
    if (idx < 0) return undefined
    const [t] = pool.splice(idx, 1)
    return t
  })
}

function fmtStepTime(ms: number): string {
  if (ms < 1000) return ms < 100 ? '刚刚' : '约 1 秒'
  return `${Math.round(ms / 1000)} 秒`
}

interface ActivityTimelineProps {
  steps: ActivityStep[]
  toolsById: Record<string, ToolActivity>
  limit?: number
}

function ActivityTimelineInner({ steps, toolsById, limit }: ActivityTimelineProps): React.ReactNode {
  const [openAgg, setOpenAgg] = useState<Record<string, boolean>>({})
  const recent = steps.slice(-(limit ?? 50))
  const groups = groupSteps(recent)
  if (groups.length === 0) return null
  const lastSeq = recent[recent.length - 1].seq
  return (
    <div className="activity-timeline">
      {groups.map((g) => {
        const count = g.steps.length
        const lastStep = g.steps[count - 1]
        const isLast = lastStep.seq === lastSeq
        const key = `${g.steps[0].seq}`
        if (lastStep.type === 'tool.completed' || lastStep.type === 'tool.failed') {
          const tools = matchTools(g.steps, Object.values(toolsById))
          if (count === 1) return <ToolActivityRow key={key} step={lastStep} tool={tools[0]} />
          const aggOpen = !!openAgg[key]
          return (
            <div key={key} className="step-group">
              <div
                className={`step-row tool agg${aggOpen ? ' open' : ''}`}
                onClick={() => setOpenAgg((prev) => ({ ...prev, [key]: !aggOpen }))}
              >
                <span className={`step-icon ${lastStep.type === 'tool.failed' ? 'err' : 'ok'}`}>
                  {lastStep.type === 'tool.failed' ? '✗' : '✓'}
                </span>
                <span className="step-title">{g.title}</span>
                <span className="agg-badge">×{count}</span>
                <span className="step-meta">
                  <span className="step-expand">{aggOpen ? '▾' : '▸'}</span>
                </span>
              </div>
              {aggOpen && g.steps.map((st, i) => <ToolActivityRow key={st.seq} step={st} tool={tools[i]} />)}
            </div>
          )
        }
        if (lastStep.type === 'permission.requested') {
          return (
            <div key={key} className="step-row permission">
              <span className="step-icon warn">◉</span>
              <span className="step-title">{g.title}</span>
              {lastStep.detail && <span className="step-args">{lastStep.detail}</span>}
            </div>
          )
        }
        const icon =
          lastStep.type === 'artifact.completed' || lastStep.type === 'permission.resolved'
            ? '✓'
            : isLast
              ? '›'
              : lastStep.type === 'phase.changed' || lastStep.type === 'activity.message'
                ? '✓'
                : '○'
        const iconClass = icon === '✓' ? ' ok' : icon === '›' ? ' run' : ''
        return (
          <div key={key} className={`step-row${isLast ? ' current' : ''}`}>
            <span className={`step-icon${iconClass}`}>{icon}</span>
            <span className="step-title">{g.title}</span>
            {count > 1 && <span className="agg-badge">×{count}</span>}
            {lastStep.detail && <span className="step-args">{lastStep.detail}</span>}
            <span className="step-meta">{fmtStepTime(lastStep.elapsedMs)}</span>
          </div>
        )
      })}
    </div>
  )
}

export default memo(ActivityTimelineInner)
