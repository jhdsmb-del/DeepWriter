import { memo, useCallback, useSyncExternalStore } from 'react'
import { getWorkPlan, subscribeWorkPlan } from '../../workPlanSubscriptions'

const STATUS_LABEL = { pending: '待处理', in_progress: '进行中', done: '已完成' }
const STATUS_MARK = { pending: '○', in_progress: '●', done: '✓' }

/** Read committed tool receipts, including when a run is opened after reload. */
export default memo(function WorkPlanProgress({ runId, detail = false }: { runId: string; detail?: boolean }): React.ReactNode {
  const subscribe = useCallback((listener: () => void) => subscribeWorkPlan(runId, listener), [runId])
  const snapshot = useCallback(() => getWorkPlan(runId), [runId])
  const plan = useSyncExternalStore(subscribe, snapshot)
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
