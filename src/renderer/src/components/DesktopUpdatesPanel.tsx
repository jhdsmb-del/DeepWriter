import { useState } from 'react'
import { useDesktopUpdates } from '../hooks/useDesktopUpdates'
import { useStore } from '../store'
import Switch from './Switch'

export default function DesktopUpdatesPanel(): React.ReactNode {
  const state = useDesktopUpdates()
  const showToast = useStore(s => s.showToast)
  const [pending, setPending] = useState(false)
  const [confirm, setConfirm] = useState(false)
  if (!state) return <p role="status">正在读取更新状态…</p>
  const working = state.phase === 'checking' || state.phase === 'downloading' || state.phase === 'restarting'
  const action = async (work: () => Promise<unknown>): Promise<void> => {
    setPending(true)
    try { await work() } catch { showToast('操作失败，请稍后重试。', 'error') } finally { setPending(false) }
  }
  return <section className="dw-settings-page dw-updates-page">
    <div className="dw-settings-page-head"><h4>应用更新</h4><p>当前版本 {state.currentVersion} · {state.installKind === 'nsis' ? '安装版' : state.installKind === 'development' ? '开发模式' : '免安装版本'}</p></div>
    <div className="dw-update-status" role="status" aria-live="polite">
      <strong>{state.phase === 'ready' ? `${state.version} 已准备就绪` : state.phase === 'available' ? `新版本 ${state.version}` : state.phase === 'downloading' ? `下载 ${state.version}` : state.phase === 'error' ? '暂时无法获取更新' : '公开稳定版'}</strong>
      <p>{state.message}</p>
      {state.phase === 'downloading' && <progress aria-label="更新下载进度" max={100} value={state.progress ?? undefined} />}
      {state.checkedAt && <small>上次检查：{new Date(state.checkedAt).toLocaleString('zh-CN')}</small>}
    </div>
    <div className="dw-update-actions">
      {!working && state.phase !== 'ready' && <button className="btn" disabled={pending || state.installKind === 'development' || state.installKind === 'unsupported'} onClick={() => void action(() => window.ds.updatesCheck())}>{state.phase === 'error' ? '重试检查与下载' : '检查更新'}</button>}
      {state.phase === 'available' && state.portableUrl && <button className="btn primary" disabled={pending} onClick={() => void action(() => window.ds.updatesOpenPortable())}>下载 {state.version} 便携版</button>}
      {state.phase === 'ready' && !confirm && <button className="btn primary" disabled={pending} onClick={() => setConfirm(true)}>重启并安装…</button>}
    </div>
    {state.phase === 'ready' && confirm && <div className="dw-update-confirm">
      <p>现在重启并安装 {state.version}？草稿会先保存；有任务正在进行时不会重启。</p>
      <div className="dw-update-actions"><button className="btn primary" disabled={pending} onClick={() => void action(async () => { const result = await window.ds.updatesRestart(); if (!result.ok) showToast(result.message, 'error'); setConfirm(false) })}>确认重启并安装</button><button className="btn" disabled={pending} onClick={() => setConfirm(false)}>继续写作</button></div>
    </div>}
    <Switch label="自动检查稳定版" description={state.installKind === 'nsis' ? '启动后及使用期间在后台检查并下载；退出应用不会自动安装。' : '仅通知新版本，下载和替换由你决定。'} checked={state.autoCheck} disabled={pending || state.installKind === 'development' || state.installKind === 'unsupported'} onChange={checked => void action(async () => {
      await window.ds.updatesPreference(checked)
      // Keep the settings draft's canonical baseline in sync with this immediate preference.
      useStore.setState(s => ({ settings: s.settings ? { ...s.settings, autoCheckUpdates: checked } : s.settings }))
    })} />
  </section>
}
