import { useCallback, useEffect, useState } from 'react'
import type { PermissionAnswer, PermissionRequestView } from '../../../shared/permissionRequest'
import { useDialogFocus } from '../hooks/useDialogFocus'
import './PermissionDialog.css'

export default function PermissionDialog(): React.ReactNode {
  const [requests, setRequests] = useState<PermissionRequestView[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const current = requests[0]
  useEffect(() => {
    let alive = true, received = false
    const ds = window.ds
    const off = ds.onPermissionRequests((views: PermissionRequestView[]) => { received = true; if (alive) setRequests(views) })
    void ds.permissionRequests().then((views: PermissionRequestView[]) => { if (alive && !received) setRequests(views) }).catch(() => undefined)
    return () => { alive = false; off() }
  }, [])
  useEffect(() => { setBusy(false); setError('') }, [current?.id])
  const answer = useCallback(async (value: PermissionAnswer): Promise<void> => {
    if (!current || busy) return
    setBusy(true)
    try {
      const result = await window.ds.permissionAnswer(current.id, value)
      if (!result.ok) setError('此请求已结束，请等待任务状态同步。')
    } catch { setError('未能提交决定，请重试。') }
    finally { setBusy(false) }
  }, [busy, current])
  const deny = useCallback(() => { void answer('deny') }, [answer])
  const stop = async (): Promise<void> => {
    if (!current?.runId || busy) return
    setBusy(true)
    try {
      const result = await window.ds.activityCancel(current.runId)
      if (!result.ok) setError('未能停止任务，请重试或拒绝当前操作。')
    } catch { setError('未能停止任务，请重试或拒绝当前操作。') }
    finally { setBusy(false) }
  }
  const ref = useDialogFocus<HTMLDivElement>(Boolean(current), deny)
  if (!current) return null
  const name = current.target.split(/[\\/]/).filter(Boolean).at(-1) || current.target
  const verb = current.operation.startsWith('读取') ? '读取' : current.operation.startsWith('新建') ? '新建' : current.operation.startsWith('修改') ? '修改' : '覆盖'
  return <div className="modal-overlay dw-permission-overlay" role="presentation">
    <div ref={ref} tabIndex={-1} className="dw-permission-dialog" role="dialog" aria-modal="true" aria-labelledby="permission-title" aria-describedby="permission-reason">
      <header><h2 id="permission-title">{current.type === 'command' ? '允许运行这条命令？' : `允许${verb}「${name}」？`}</h2><button type="button" className="ghost-btn" aria-label="拒绝并关闭" onClick={deny} disabled={busy}>×</button></header>
      <p id="permission-reason">{current.reason}</p>
      <div className="dw-permission-target"><span>{current.type === 'command' ? '完整命令' : '目标路径'}</span><pre>{current.target}</pre></div>
      {current.workspaceRoot && <details className="dw-permission-scope"><summary>授权范围</summary><p>工作区：{current.workspaceRoot}</p><p>{current.canAllowForRun ? '同类授权仅限当前任务内的此类文件操作，不包含命令、外部路径或覆盖文件。' : '允许一次仅授权上方这个目标与操作。'}</p></details>}
      {error && <p role="alert">{error}</p>}
      <footer>{current.runId && <button type="button" className="ghost-btn" onClick={() => void stop()} disabled={busy}>停止任务</button>}<button type="button" className="btn" onClick={deny} disabled={busy}>拒绝</button>{current.canAllowForRun && <button type="button" className="btn" title="仅当前任务、同一工作区内的此类文件操作；不包含命令、外部目录或覆盖文件" onClick={() => void answer('allow_run')} disabled={busy}>本任务内允许同类操作</button>}<button type="button" className="btn primary" onClick={() => void answer('allow_once')} disabled={busy}>允许一次</button></footer>
      {requests.length > 1 && <small>还有 {requests.length - 1} 项等待确认</small>}
    </div>
  </div>
}
