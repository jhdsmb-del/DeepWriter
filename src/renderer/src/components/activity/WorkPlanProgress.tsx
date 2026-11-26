import { memo, useEffect, useState } from 'react'
import type { ActivityEvent } from '../../../../shared/activity'
import type { ChunkEvent } from '../../../../shared/types'
import { WORK_PLAN_TOOL, type WorkPlanSnapshot } from '../../../../shared/workPlan'

const STATUS_LABEL = { pending: '待处理', in_progress: '进行中', done: '已完成' }
const STATUS_MARK = { pending: '○', in_progress: '●', done: '✓' }

/** Read committed tool receipts, including when a run is opened after reload. */
export default memo(function WorkPlanProgress({ runId, detail = false }: { runId: string; detail?: boolean }): React.ReactNode {
  const [loaded, setLoaded] = useState<{ runId: string; plan: WorkPlanSnapshot | null } | null>(null)
  useEffect(() => {
    let live = true
    let request = 0
    const ds = (window as any).ds
    const load = (): void => {
      if (!ds?.runsGet) return
      const current = ++request
      void ds.runsGet(runId).then((result: { workPlan?: WorkPlanSnapshot | null } | null) => {
        if (live && current === request) setLoaded({ runId, plan: result?.workPlan ?? null })
      }).catch(() => undefined)
    }
    const unsubscribeTool = ds?.onChatEvent?.(({ id, ev }: { id: string; ev: ChunkEvent }) => {
      if (id === runId && ev.type === 'tool_result' && ev.toolResult?.name === WORK_PLAN_TOOL && ev.toolResult.ok) load()
    })
    const unsubscribe = ds?.onActivityEvent?.((event: ActivityEvent) => {
      if (event.runId !== runId) return
      if (['run.completed', 'run.failed', 'run.cancelled'].includes(event.type)) load()
    })
    load()
    return () => { live = false; unsubscribeTool?.(); unsubscribe?.() }
  }, [runId])

  const plan = loaded?.runId === runId ? loaded.plan : null
  if (!plan?.steps.length) return null
  return <section className={`work-plan-progress${detail ? ' ri-section' : ''}`} aria-label="任务清单" data-testid="work-plan-progress">
    {detail && <h4>任务清单</h4>}
    <ol>
      {plan.steps.map((step, index) => <li key={index} className={step.status}>
        <span className="work-plan-mark" role="img" aria-label={STATUS_LABEL[step.status]}>{STATUS_MARK[step.status]}</span>
        <span>{step.text}</span>
      </li>)}
    </ol>
    {plan.blockedOn && <p className="work-plan-blocked">等待：{plan.blockedOn}</p>}
  </section>
})
