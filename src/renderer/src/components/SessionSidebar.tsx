import { useMemo, useRef, useState } from 'react'
import { useStore } from '../store'
import type { SessionMeta } from '../../../shared/types'
import Icon from './Icon'
import ConfirmDialog from './ConfirmDialog'

function fmtTime(ts: number): string {
  const d = new Date(ts)
  const now = new Date()
  const sameDay = d.toDateString() === now.toDateString()
  const pad = (n: number): string => String(n).padStart(2, '0')
  const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`
  if (sameDay) return hm
  return `${d.getMonth() + 1}月${d.getDate()}日 ${hm}`
}

function SessionItem({ s, active, draft }: { s: SessionMeta; active: boolean; draft: boolean }): React.ReactNode {
  const switchSession = useStore((st) => st.switchSession)
  const deleteSession = useStore((st) => st.deleteSession)
  const running = useStore((st) => st.running || st.submitting)
  const showToast = useStore((st) => st.showToast)
  const setSessionCollapsed = useStore((st) => st.setSessionCollapsed)
  const [editing, setEditing] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [title, setTitle] = useState(s.title)
  const inputRef = useRef<HTMLInputElement>(null)
  const renameCommitted = useRef(false)

  const saveRename = async (): Promise<void> => {
    if (renameCommitted.current) return
    renameCommitted.current = true
    const t = title.trim()
    setEditing(false)
    if (!t || t === s.title) return
    try {
      const result = await (window as any).ds?.sessionsRename?.(s.id, t)
      if (result?.ok === false) throw new Error('rename rejected')
      await useStore.getState().loadSessions()
      showToast('已重命名会话', 'success')
    } catch {
      showToast('重命名失败', 'error')
    }
  }

  const doExport = async (): Promise<void> => {
    try {
      const res = await (window as any).ds?.sessionsExport?.(s.id)
      const path = typeof res === 'string' ? res : res?.path
      if (path) {
        showToast(`已导出会话：${path}`, 'success')
      } else if (!res?.cancelled && res != null) {
        showToast('导出失败：未返回路径', 'error')
      }
    } catch {
      showToast('导出失败', 'error')
    }
  }

  return (
    <div
      className={`session-item${active ? ' active' : ''}`}
      title={s.title}
    >
        {editing ? (
        <div className="session-item-main">
          <input
            ref={inputRef}
            className="session-rename-input"
            value={title}
            autoFocus
            onChange={(e) => setTitle(e.target.value)}
            onClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                void saveRename()
              }
              if (e.key === 'Escape') {
                e.preventDefault()
                renameCommitted.current = true
                setEditing(false)
                setTitle(s.title)
              }
            }}
            onBlur={() => void saveRename()}
          />
        </div>
        ) : (
          <button className="session-item-main" aria-current={active ? 'true' : undefined} disabled={running} onClick={() => {
            void switchSession(s.id)
            if (window.matchMedia('(max-width: 899px)').matches) setSessionCollapsed(true)
          }}>
            <div className="session-item-title">{s.title || '未命名会话'}</div>
            <div className="session-item-sub">{draft && <span className="session-draft-label">草稿 · </span>}{fmtTime(s.updatedAt)}</div>
          </button>
        )}
      {!editing && (
        <div className="session-actions">
          {s.messageCount > 0 && <button
            className="session-act"
            title="导出"
            aria-label="导出"
            onClick={(e) => {
              e.stopPropagation()
              void doExport()
            }}
          >
            <Icon name="export" size={14} />
          </button>}
          {s.messageCount > 0 && <button
            className="session-act"
            title="重命名"
            aria-label="重命名"
            onClick={(e) => {
              e.stopPropagation()
              setEditing(true)
              renameCommitted.current = false
              setTitle(s.title)
              setTimeout(() => inputRef.current?.select(), 0)
            }}
          >
            <Icon name="edit" size={14} />
          </button>}
          <button
            className="session-del"
            title="删除"
            aria-label="删除"
            disabled={running}
            onClick={(e) => {
              e.stopPropagation()
              setConfirmDelete(true)
            }}
          >
            <Icon name="trash" size={14} />
          </button>
        </div>
      )}
      {confirmDelete && (
        <ConfirmDialog
          title="删除这个会话？"
          description={`“${s.title || '未命名会话'}”的聊天记录和草稿将从本机删除。此操作无法撤销。`}
          confirmLabel="删除会话"
          destructive
          onCancel={() => setConfirmDelete(false)}
          onConfirm={() => {
            setConfirmDelete(false)
            void deleteSession(s.id).then((ok) => showToast(ok ? '会话已删除' : '暂时无法删除，请稍后重试', ok ? 'info' : 'error'))
          }}
        />
      )}
    </div>
  )
}

export default function SessionSidebar(): React.ReactNode {
  const sessions = useStore((s) => s.sessions)
  const [query, setQuery] = useState('')
  const currentSessionId = useStore((s) => s.currentSessionId)
  const newSession = useStore((s) => s.newSession)
  const running = useStore((s) => s.running || s.submitting)
  const composerDrafts = useStore((s) => s.composerDrafts)
  const composerText = useStore((s) => s.composerText)
  const pendingAttachments = useStore((s) => s.pendingAttachments)
  const sessionCollapsed = useStore((s) => s.sessionCollapsed)
  const setSessionCollapsed = useStore((s) => s.setSessionCollapsed)
  const draftViews = useMemo(() => ({
    ...composerDrafts,
    ...(currentSessionId && (composerText || pendingAttachments.length) ? { [currentSessionId]: { text: composerText, attachments: pendingAttachments, updatedAt: Date.now() } } : {})
  }), [composerDrafts, currentSessionId, composerText, pendingAttachments])
  const visibleSessions = useMemo(() => {
    const existing = new Set(sessions.map((session) => session.id))
    const unsent = Object.entries(draftViews).filter(([id, draft]) => !existing.has(id) && (draft.text || draft.attachments.length)).map(([id, draft]): SessionMeta => ({
      id, title: draft.text.trim().split('\n')[0]?.slice(0, 40) || '未发送会话', createdAt: draft.updatedAt, updatedAt: draft.updatedAt, messageCount: 0, model: ''
    }))
    return [...unsent, ...sessions].sort((a, b) => b.updatedAt - a.updatedAt)
  }, [sessions, draftViews])

  const filteredSessions = visibleSessions.filter((session) => session.title.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()))

  return (
      <aside className={`session-sidebar dw-session-sidebar${sessionCollapsed ? ' collapsed' : ''}`} aria-hidden={sessionCollapsed} inert={sessionCollapsed}>
        <div className="dw-session-create">
          <button className="dw-new-session" aria-label="新建会话" title="新建会话 (Ctrl+N)" disabled={running} onClick={() => {
            setQuery('')
            newSession()
            if (window.matchMedia('(max-width: 899px)').matches) setSessionCollapsed(true)
          }}><Icon name="plus" size={18} /><span>新建会话</span><kbd>Ctrl N</kbd></button>
        </div>
        <div className="dw-session-head"><span>最近会话</span><span>{visibleSessions.length || ''}</span></div>
        {visibleSessions.length > 0 && <label className="dw-session-search"><Icon name="search" size={16} /><input type="search" aria-label="搜索会话" placeholder="搜索会话" value={query} onChange={(event) => setQuery(event.target.value)} /></label>}
        <div className="session-list">
          {visibleSessions.length === 0 ? (
            <p className="session-empty">你的会话会保存在这里。</p>
          ) : (
            filteredSessions.length === 0 ? <p className="session-empty" role="status">没有找到匹配的会话</p> : filteredSessions.map((s) => <SessionItem key={s.id} s={s} active={s.id === currentSessionId} draft={Boolean(draftViews[s.id]?.text || draftViews[s.id]?.attachments.length)} />)
          )}
        </div>
      </aside>
  )
}
