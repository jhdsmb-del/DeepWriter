import { useStore } from '../store'
import { performanceLabels } from '../composerPerformance'

export default function ComposerPerformance(): React.ReactNode {
  const performance = useStore(state => state.composerPerformance)
  const running = useStore(state => state.running)
  const activeRunId = useStore(state => state.runningId ?? state.activeRunId)
  const snapshot = performance?.snapshot.scope?.runId === activeRunId ? performance?.snapshot : undefined
  if (!snapshot && !running) return null
  const labels = performanceLabels(snapshot)
  return <div className="composer-performance" aria-label="本次请求速度与缓存" data-testid="composer-performance">
    <span title={labels.speedTitle}>{labels.speed}</span>
    <span title="仅显示本次请求中接口报告的缓存用量；未报告不等于零命中">{labels.cache}</span>
  </div>
}
