import { lazy, Suspense, useEffect } from 'react'
import { useStore } from '../store'
import { WorkspaceHeader } from './WorkspaceLayout'

const LongformWorkflowShell = lazy(() => import('./LongformWorkflowShell'))
const StylePanel = lazy(() => import('./StylePanel'))
const GalgameStudio = lazy(() => import('./GalgameStudio'))

export default function SidePanel(): React.ReactNode {
  const workspace = useStore((s) => s.workspace)
  const currentSessionId = useStore((s) => s.currentSessionId)
  const ensureSessionId = useStore((s) => s.ensureSessionId)
  useEffect(() => {
    if (workspace === 'galgame' && !currentSessionId) ensureSessionId()
  }, [workspace, currentSessionId, ensureSessionId])
  return (
    <aside className="side-panel">
      <Suspense fallback={<p className="muted" role="status">正在加载工作台…</p>}>
        {workspace === 'novel' && <div className="dw-workspace-flow"><LongformWorkflowShell /></div>}
        {workspace === 'style' && <div className="dw-workspace-flow">
          <WorkspaceHeader title="风格参考" />
          <StylePanel />
        </div>}
        {workspace === 'galgame' && <div className="dw-workspace-flow">
          {currentSessionId
            ? <GalgameStudio key={currentSessionId} sessionId={currentSessionId} />
            : <p className="muted" role="status">正在准备 Galgame 工作台…</p>}
        </div>}
      </Suspense>
    </aside>
  )
}
