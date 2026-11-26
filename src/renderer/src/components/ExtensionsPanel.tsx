import { useCallback, useEffect, useState } from 'react'
import type { ExtensionCatalogView, ExtensionView, ExtensionsSnapshot, ExtensionsApi } from '../../../shared/extensions'
import type { IpcResult } from '../../../shared/providerRegistry'

const permissionNames: Record<string, string> = {
  instructions: '技能指令', 'frozen-resource-read': '读取已冻结的技能资源',
  'node-process-start': '启动独立工具进程', 'read-frozen-work-and-doc-roots': '只读本次任务的授权目录'
}
export default function ExtensionsPanel(): React.ReactNode {
  const ds = (window as unknown as { ds: ExtensionsApi }).ds
  const [snapshot, setSnapshot] = useState<ExtensionsSnapshot | null>(null)
  const [kind, setKind] = useState<'skill' | 'tool'>('skill')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [inspected, setInspected] = useState<ExtensionView | null>(null)
  const [removeId, setRemoveId] = useState<string | null>(null)
  const refresh = useCallback(async (): Promise<void> => {
    const result = await ds.extensionsSnapshot()
    if (!result.ok) throw new Error('extensions_snapshot_failed')
    setSnapshot(result.data)
  }, [ds])
  useEffect(() => { let alive = true; void ds.extensionsSnapshot().then(result => {
    if (!alive) return
    if (result.ok) setSnapshot(result.data)
    else setError('扩展列表读取失败，请重试。')
  }).catch(() => { if (alive) setError('扩展列表读取失败，请重试。') })
  return () => { alive = false }
  }, [ds])
  const run = async <T,>(action: () => Promise<IpcResult<T>>, success: string): Promise<T | undefined> => {
    if (busy) return
    setBusy(true); setError(''); setNotice('')
    try {
      const result = await action()
      if (!result.ok) { setError('操作未完成。请检查扩展是否仍可用、类型与选择数量，再重试。'); return }
      await refresh()
      setNotice(success)
      return result.data
    } catch { setError('操作未完成，原有选择已保留。请重试。') }
    finally { setBusy(false) }
  }
  const select = (record: ExtensionView, checked: boolean): void => {
    if (!snapshot) return
    const key = record.kind === 'skill' ? 'skills' : 'plugins'
    const selection = snapshot.selectedForNewRuns
    const ids = checked ? [...selection[key], record.id] : selection[key].filter(id => id !== record.id)
    void run(() => ds.extensionsSetSelection({ ...selection, [key]: ids }), '新任务选择已保存；运行中的任务保持原有冻结版本。')
  }
  const installed = (snapshot?.installed ?? []).filter(record => record.kind === kind && !record.removed)
  const catalog = (snapshot?.catalog ?? []).filter(record => record.kind === kind)
  const metadata = (record: ExtensionView | ExtensionCatalogView): React.ReactNode => <>
    <strong>{record.name}</strong><small>{record.id} · {record.version}{record.firstParty ? ' · 第一方' : ''}</small>
  </>
  return <div className="dw-extensions" data-testid="extensions-panel" aria-busy={busy}>
    <div className="dw-extensions-tabs" role="tablist" aria-label="扩展类型">
      {(['skill', 'tool'] as const).map(value => <button key={value} role="tab" aria-selected={kind === value} onClick={() => { setKind(value); setInspected(null); setRemoveId(null) }}>{value === 'skill' ? '技能' : '插件'}</button>)}
    </div>
    {error && <p className="dw-model-reasoning-help" role="alert">{error} <button className="ghost-btn" disabled={busy} onClick={() => void run(async () => { await refresh(); return { ok: true, data: undefined } }, '')}>刷新</button></p>}
    {notice && <p role="status" className="dw-muted">{notice}</p>}
    <section aria-label="已安装扩展">
      <div className="dw-provider-line"><h5>已安装</h5>{kind === 'skill' && <button className="ghost-btn" disabled={busy} onClick={() => void run(() => ds.extensionsImportSkill(), '导入已结束。新技能默认关闭，请查看详情后启用。').then(record => { if (record === null) setNotice('已取消导入，未安装新技能。') })}>导入本地技能</button>}</div>
      {snapshot && installed.length === 0 && <p className="dw-muted">尚未安装{kind === 'skill' ? '技能' : '插件'}。</p>}
      {installed.map(record => <div key={record.id} className="dw-extension-row">
        <div className="dw-extension-identity">{metadata(record)}</div>
        <div className="dw-extension-actions">
          <button className="ghost-btn" disabled={busy} onClick={() => void run(() => ds.extensionsInspect(record.id), '').then(item => { if (item) setInspected(item) })} aria-label={`查看 ${record.name} 详情`}>详情</button>
          <button className="ghost-btn" disabled={busy} aria-pressed={record.enabled} onClick={() => void run(() => ds.extensionsSetEnabled(record.id, !record.enabled), record.enabled ? '已停用并撤销工具执行许可。' : '已启用；插件仍需每次任务单独授权启动。')}>{record.enabled ? '停用' : '启用'}</button>
          <button className="ghost-btn danger" disabled={busy} onClick={() => setRemoveId(record.id)}>移除</button>
        </div>
        <label className="dw-extension-select"><input type="checkbox" aria-label={`新任务使用 ${record.name}`} disabled={busy || !record.enabled || Boolean(record.blockedReason)} checked={snapshot?.selectedForNewRuns[record.kind === 'skill' ? 'skills' : 'plugins'].includes(record.id) ?? false} onChange={event => select(record, event.target.checked)} />新任务使用{record.kind === 'tool' ? '（启动仍需授权）' : ''}</label>
        {record.blockedReason && <p role="alert" className="dw-model-reasoning-help">此扩展被阻止，不能用于新任务。</p>}
        {removeId === record.id && <div className="dw-extension-remove" role="group" aria-label={`确认移除 ${record.name}`}><span>移除并停用此扩展？</span><button className="ghost-btn danger" disabled={busy} onClick={() => void run(() => ds.extensionsRemove(record.id), '已移除并撤销执行许可；旧任务的技能冻结内容仍保留。').then(() => { setRemoveId(null); setInspected(null) })}>确认移除</button><button className="ghost-btn" onClick={() => setRemoveId(null)}>取消</button></div>}
      </div>)}
    </section>
    {inspected && <section className="dw-extension-details" aria-label="扩展详情">
      <div className="dw-provider-line"><h5>{inspected.name}</h5><button className="ghost-btn" onClick={() => setInspected(null)}>收起详情</button></div>
      <p>{inspected.description}</p>
      <dl><dt>来源</dt><dd>{inspected.source}</dd><dt>版本 / 许可</dt><dd>{inspected.version} / {inspected.license}</dd><dt>内容校验</dt><dd className="dw-extension-hash">{inspected.packageHash}</dd><dt>声明权限</dt><dd>{inspected.requestedPermissions.map(permission => permissionNames[permission] ?? permission).join('、') || '无'}</dd></dl>
      <details><summary>文件清单（{inspected.files.length}）</summary>{inspected.files.map(file => <p key={file.path} className="dw-extension-hash">{file.path} · {file.size} B<br />{file.sha256}</p>)}</details>
    </section>}
    <section aria-label="第一方扩展目录"><h5>第一方目录</h5>{catalog.map(record => <div key={record.id} className="dw-extension-row"><div className="dw-extension-identity">{metadata(record)}<p>{record.description}</p></div><button className="ghost-btn" disabled={busy || snapshot?.installed.some(item => item.id === record.id && !item.removed)} onClick={() => void run(() => ds.extensionsInstallCatalog(record.id), '已安装，默认关闭。请查看来源与权限后启用。')}>{snapshot?.installed.some(item => item.id === record.id && !item.removed) ? '已安装' : '安装'}</button></div>)}</section>
    <details className="dw-provider-block"><summary>使用与安全</summary><p className="dw-muted">技能选择会冻结到新任务的指令与资源版本。插件选择不等于启动许可，每次运行仍需明确授权；停用或移除会撤销工具执行许可。本轮仅支持第一方工具和本地技能指令，不执行第三方安装脚本。</p></details>
  </div>
}
