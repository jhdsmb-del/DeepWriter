import { TOOL_NAMES } from '../toolLabels'
import { lazy, memo, Suspense, useMemo, useState } from 'react'
import { useStore, type StudioUiMessage, type UiToolEvent } from '../store'
import type { UndoFileEditResult } from '../../../shared/editUndo'
import type { FileDiff, UiMessage } from '../../../shared/types'
import { isTerminalPhase } from '../../../shared/activity'
import { codePointLength, takeCodePoints } from '../../../shared/textMetrics'
const Markdown = lazy(() => import('./Markdown'))
import ActivityCard from './activity/ActivityCard'
import WorkPlanProgress from './activity/WorkPlanProgress'
import FileSources from './FileSources'
import LongWriteStatus from './LongWriteStatus'
import Icon from './Icon'
import { messageRunId, modelFailureNotice } from '../modelFailure'


const DEFAULT_TOOL = '工具调用'

const LONG_LIMIT = 20000
const LONG_CHUNK = 20000

function fmtDuration(ms?: number): string {
  if (ms == null) return ''
  if (ms < 1000) return `${ms}ms`
  return `${(ms / 1000).toFixed(1)}s`
}

function ThinkingBlock({ text }: { text: string }): React.ReactNode {
  const [open, setOpen] = useState(false)
  if (!text) return null
  return (
    <div className="thinking-block">
      <button className="thinking-toggle" aria-expanded={open} onClick={() => setOpen(!open)}>
        {open ? '▾' : '▸'} 思考过程
      </button>
      {open && <div className="thinking-body">{text}</div>}
    </div>
  )
}

function DiffView({ diff }: { diff: FileDiff }): React.ReactNode {
  const lines = diff.content.split('\n')
  return (
    <div className="diff-block">
      <div className="diff-head">
        <span className="diff-stats">
          <b className="diff-add-count">+{diff.added}</b> / <b className="diff-del-count">-{diff.removed}</b>
        </span>
        <span className="diff-file" title={diff.path}>
          {diff.path}
        </span>
      </div>
      <pre className="diff-body">
        {lines.map((ln, i) => {
          const cls = ln.startsWith('+') ? 'diff-add' : ln.startsWith('-') ? 'diff-del' : 'diff-ctx'
          return (
            <div key={i} className={`diff-line ${cls}`}>
              {ln || ' '}
            </div>
          )
        })}
      </pre>
    </div>
  )
}

function ToolCard({ t }: { t: UiToolEvent }): React.ReactNode {
  const [open, setOpen] = useState(false)
  const [rolling, setRolling] = useState(false)
  const [undoing, setUndoing] = useState(false)
  const [undoError, setUndoError] = useState<string | null>(null)
  const currentSessionId = useStore((s) => s.currentSessionId)
  const showToast = useStore((s) => s.showToast)
  const name = TOOL_NAMES[t.name] ?? DEFAULT_TOOL
  const receipt = t.editReceipt
  const isEdit = t.name === 'edit_file'
  const failed = t.status === 'error' || t.resultOk === false
  const undone = t.editUndo?.status === 'undone'
  const title = undone ? `已撤销：${t.result?.split('：')[0] || '这次改稿'}` : isEdit && t.result ? t.result : name

  const undoEdit = async (): Promise<void> => {
    const ref = t.editUndo
    if (!ref || ref.status !== 'available' || undoing) return
    setUndoing(true)
    setUndoError(null)
    try {
      const result: UndoFileEditResult = await (window as any).ds.undoFileEdit({ sessionId: ref.sessionId, runId: ref.runId, toolCallId: ref.toolCallId })
      if (!result.ok) { setUndoError(result.message); return }
      useStore.setState(state => state.currentSessionId !== ref.sessionId ? {} : {
        messages: state.messages.map(message => ({ ...message, toolEvents: message.toolEvents.map(event =>
          event.id === ref.toolCallId && event.editUndo?.runId === ref.runId
            ? { ...event, editUndo: { ...ref, status: 'undone' as const } } : event) }))
      })
    } catch (error) {
      setUndoError(error instanceof Error ? error.message : '撤销未完成，请重试')
    } finally { setUndoing(false) }
  }

  const rollback = async (): Promise<void> => {
    if (!t.diff?.backupId) return
    setRolling(true)
    try {
      const res = await (window as any).ds?.checkpointRestore?.({ backupId: t.diff.backupId, sessionId: currentSessionId })
      const ok = res?.ok !== false
      const path = typeof res === 'string' ? res : res?.path
      if (ok) {
        showToast(`已回滚 ${path ?? t.diff.path}，请刷新会话（重新加载）查看文件`, 'success')
      } else {
        showToast(`回滚失败：${res?.message ?? '未知错误'}`, 'error')
      }
    } catch (err) {
      showToast(`回滚失败：${err instanceof Error ? err.message : '未知错误'}`, 'error')
    } finally {
      setRolling(false)
    }
  }

  return (
    <div className={`tool-card ${t.status}${failed ? ' failed' : ''}${undone ? ' undone' : ''}`}>
      <button type="button" className="tool-card-header" aria-expanded={open} onClick={() => setOpen(!open)}>
        <span className={`tool-dot ${t.status}`} />
        <span className={receipt ? 'tool-edit-title' : 'tool-card-name'}>{title}</span>
        {!isEdit && t.argsPreview && <span className="tool-card-args-preview">{t.argsPreview}</span>}
        <span className="tool-card-meta">
          {t.diff && (
            <span className="diff-badge">
              <b className="diff-add-count">+{t.diff.added}</b> <b className="diff-del-count">-{t.diff.removed}</b>
            </span>
          )}
          {t.exitCode != null && (
            <span className={`tool-card-exit${t.exitCode !== 0 ? ' tool-exit-bad' : ''}`}>exit {t.exitCode}</span>
          )}
          {t.durationMs != null && <span>{fmtDuration(t.durationMs)}</span>}
          {t.status === 'running' && <span className="status live">执行中…</span>}
          <span className="tool-card-arrow">{open ? '▾' : '▸'}</span>
        </span>
      </button>
      {open && !isEdit && t.argsPreview && <div className="tool-card-args">{t.argsPreview}</div>}
      {open && receipt && <div className="tool-edit-excerpt" aria-label="修改前后">
        <div className="edit-before"><span aria-hidden="true">−</span><del aria-label="修改前">{receipt.before}</del></div>
        <div className="edit-after"><span aria-hidden="true">+</span><ins aria-label="修改后">{receipt.after || '（删除）'}</ins></div>
      </div>}
      {open && receipt && t.editUndo && <div className="edit-undo-actions">
        {undone ? <span role="status"><Icon name="check" size={16} />已撤销这次改稿</span>
          : t.editUndo.status === 'available' ? <button type="button" className="ghost-btn" disabled={undoing} onClick={() => void undoEdit()}>{undoing ? '正在撤销…' : '撤销这次改稿'}</button>
            : <span>这次改稿暂不能安全撤销。</span>}
        {undoError && <p role="alert">{undoError}</p>}
      </div>}
      {open && !receipt && !t.sourceCount && t.result != null && (
        <div className="tool-card-result">
          <pre>{t.result}</pre>
        </div>
      )}
      {open && !isEdit && t.diff && (
        <div className="tool-card-diff">
          <DiffView diff={t.diff} />
          <div className="diff-actions">
            <button className="ghost-btn danger" disabled={rolling} onClick={() => void rollback()}>
            {rolling ? '回滚中…' : '回滚该文件'}
            </button>
            <span className="muted small">回滚将把文件恢复到写入前的快照</span>
          </div>
        </div>
      )}
    </div>
  )
}

function ToolCards({ msg }: { msg: UiMessage }): React.ReactNode {
  if (msg.toolEvents.length === 0) return null
  return (
    <div className="tool-cards">
      {msg.toolEvents.map((t, i) => (
        <ToolCard key={t.id || i} t={t as UiToolEvent} />
      ))}
    </div>
  )
}

function PlanCard({ msg }: { msg: UiMessage }): React.ReactNode {
  const approvePlan = useStore((s) => s.approvePlan)
  const rejectPlan = useStore((s) => s.rejectPlan)
  if (msg.plan === 'pending') {
    return (
      <div className="plan-card">
        <div className="plan-card-text">{msg.planApproval ? '只读审阅已完成，批准后按正常权限执行' : '模型已产出执行计划，批准后将进入执行阶段'}</div>
        <div className="plan-actions">
          <button className="btn primary" onClick={() => approvePlan(msg.content, msg.id)}>
            批准执行
          </button>
          <button className="ghost-btn danger" onClick={() => void rejectPlan(msg.id)}>
            拒绝
          </button>
        </div>
      </div>
    )
  }
  if (msg.plan === 'approved') {
    return <div className="plan-tag approved">已批准执行</div>
  }
  if (msg.plan === 'rejected') {
    return <div className="plan-tag rejected">已拒绝</div>
  }
  return null
}

const MessageBubble = memo(function MessageBubble({ msg, onOpenSettings }: { msg: StudioUiMessage; onOpenSettings?: () => void }): React.ReactNode {
  const sessionId = useStore(s => s.currentSessionId)
  const [copied, setCopied] = useState(false)
  const [renderLimit, setRenderLimit] = useState<number | null>(null)
  const showToast = useStore((s) => s.showToast)
  const runId = messageRunId(msg.id)
  const activeRun = useStore((s) => (s.activeRunId === runId ? (s.runs[runId] ?? null) : null))
  const runForMsg = useStore((s) => s.runs[runId])
  const recoverableForMsg = useStore((s) => s.recoverableRuns.find((run) => run.runId === runId) ?? null)
  const inspectorOpen = useStore((s) => s.inspectorRunId === runId)
  const openRunInspector = useStore((s) => s.openRunInspector)
  const pinMessage = useStore((s) => s.pinMessage)
  const loadMessageEdits = useStore((s) => s.loadMessageEdits)
  const resumeRun = useStore((s) => s.resumeRun)
  const abandonRun = useStore((s) => s.abandonRun)

  const copy = async (content: string): Promise<void> => {
    await navigator.clipboard.writeText(content)
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  const contentChars = useMemo(() => codePointLength(msg.content), [msg.content])
  const isLong = contentChars > LONG_LIMIT
  const limit = renderLimit ?? LONG_LIMIT
  const shown = isLong && contentChars > limit ? takeCodePoints(msg.content, limit) : msg.content
  const fullyShown = !isLong || contentChars <= limit
  const actionableRun = runForMsg ?? recoverableForMsg
  const failure = modelFailureNotice(recoverableForMsg?.errorCode, msg.error || recoverableForMsg?.errorMessage || runForMsg?.terminal?.error || (['paused', 'recovery_required'].includes(runForMsg?.status ?? '') ? runForMsg?.currentDetail : undefined))
  const waiting = actionableRun && ['waiting_user', 'recovery_required', 'paused'].includes(actionableRun.status)
  const streaming = !waiting && (msg.status === 'thinking' || msg.status === 'streaming' || msg.status === 'tool')
  const isLongWrite = msg.runConfig?.longMode === true
  const longStatusVisible = isLongWrite && (streaming || Boolean(runForMsg) || Boolean(recoverableForMsg))
  const pausedRun = Boolean(!isLongWrite && actionableRun && !streaming && ['waiting_user', 'recovery_required'].includes(actionableRun.status))

  const continuePausedRun = async (): Promise<void> => {
    const detail = await (window as any).ds?.runsGet?.(runId) as { errorCode?: string; config?: { completionContract?: { tokenBudget?: unknown } } } | null
    if (detail?.errorCode !== 'completion_budget_exhausted' && detail?.errorCode !== 'run_provider_call_cap') {
      const ok = await resumeRun(runId)
      showToast(ok ? '已继续处理该任务' : '无法继续，请打开任务详情查看原因', ok ? 'success' : 'error')
      return
    }
    openRunInspector(runId, 'activity')
  }

  if (msg.role === 'user') {
    return (
      <div className="msg user">
        <div className="msg-bubble">{msg.content}</div>
        {['done', 'stopped'].includes(msg.status) && <button className="ghost-btn dw-pin-message" aria-label="固定消息" title="固定消息" onClick={() => void pinMessage(msg)}><Icon name="pin" size={14} /></button>}
      </div>
    )
  }

  const target = isLongWrite ? msg.runConfig?.targetChars : undefined
  const statusLabel = failure ? '' : waiting ? '等待你的决定' : longStatusVisible
    ? ''
    : msg.status === 'thinking'
        ? '思考中…'
      : msg.status === 'streaming'
        ? isLongWrite && msg.rounds > 0
          ? `自动生成中（第 ${msg.rounds + 1} 段${target ? `，目标 ${target.toLocaleString()} 字` : ''}）…`
          : '生成中…'
        : msg.status === 'tool'
          ? '调用工具…'
          : msg.status === 'stopped'
            ? '已停止'
            : msg.status === 'error'
              ? `错误：${msg.error ?? '未知错误'}`
              : isLongWrite && msg.rounds > 0
                ? `完成（${msg.rounds + 1} 段拼接${target ? `，目标 ${target.toLocaleString()} 字` : ''}）`
                : msg.plan === 'pending'
                  ? '等待批准计划'
                  : ''

  return (
    <div className="msg assistant">
      <div className="msg-meta">
        {statusLabel && (!activeRun || waiting || isLongWrite || msg.status === 'error') && <span className={`status ${streaming ? 'live' : ''}`}>{statusLabel}</span>}
        <span className="msg-actions">
          {msg.content && (
            <button className="ghost-btn" aria-label={copied ? '已复制回复' : '复制回复'} title={copied ? '已复制' : '复制回复'} onClick={() => void copy(msg.content)}>
              <Icon name={copied ? 'check' : 'copy'} size={14} />
            </button>
          )}
          {!streaming && msg.content && ['done', 'stopped'].includes(msg.status) && <button className="ghost-btn" aria-label="固定消息" title="固定消息" onClick={() => void pinMessage(msg)}><Icon name="pin" size={14} /></button>}
          {!streaming && (runForMsg || recoverableForMsg || msg.status === 'error') && (
            <button className="ghost-btn" aria-label="查看任务详情" title="查看任务详情" aria-haspopup="dialog" aria-expanded={inspectorOpen} onClick={() => openRunInspector(runId)}>
              <Icon name="more" size={14} />
            </button>
          )}
        </span>
      </div>
      {pausedRun && (
        <div className="ri-completion-actions" data-testid="waiting-user-actions">
          <button className="btn primary" onClick={() => void continuePausedRun()}>继续处理</button>
          <button className="ghost-btn danger" onClick={() => void abandonRun(runId).then((ok) => showToast(ok ? '任务已停止' : '停止失败', ok ? 'info' : 'error'))}>停止任务</button>
        </div>
      )}
      {isLongWrite && longStatusVisible && <LongWriteStatus message={msg} runId={runId} />}
      {!isLongWrite && activeRun && streaming && <ActivityCard runId={runId} />}
      {!isLongWrite && (runForMsg || recoverableForMsg) && <WorkPlanProgress runId={runId} />}
      {failure ? <div className="error-banner model-failure" role="alert"><b>{failure.title}</b><p>{failure.detail}</p>{failure.settings && onOpenSettings && <button type="button" className="ghost-btn" onClick={onOpenSettings}>打开模型设置</button>}<button type="button" className="ghost-btn" onClick={() => openRunInspector(runId)}>查看任务详情</button></div> : msg.status === 'error' && msg.error && <div className="error-banner">{msg.error}</div>}
      <div className="msg-bubble">
        {msg.content ? (
          <Suspense fallback={<div className="markdown-pending">{shown}</div>}><Markdown content={shown} fileScope={sessionId ? { sessionId, messageId: msg.id, revision: msg.status + ':' + msg.toolEvents.map(t => t.id + t.status).join(',') } : undefined} /></Suspense>
        ) : (
          <span className="placeholder-text">
            {failure ? '' : streaming ? (!activeRun ? '思考中…' : '') : waiting ? '' : '没有收到回复'}
          </span>
        )}
      </div>
      <FileSources message={msg} />
      {(msg.reasoning || msg.toolEvents.length > 0 || msg.editHistory) && <details className="message-process" onToggle={(event) => { if (event.currentTarget.open && msg.editHistory?.status === 'idle') void loadMessageEdits(msg.id) }}>
        <summary>查看过程</summary><ThinkingBlock text={msg.reasoning} /><ToolCards msg={msg} />
        {msg.editHistory?.status === 'loading' && <p role="status">正在读取改稿记录…</p>}
        {msg.editHistory?.status === 'error' && <button className="ghost-btn" onClick={() => void loadMessageEdits(msg.id)}>改稿记录读取失败，重试</button>}
        {msg.editHistory?.status === 'loaded' && msg.toolEvents.length === 0 && <p>没有可回看的改稿回执。</p>}
        {msg.editHistory?.status === 'loaded' && msg.editHistory.nextOffset !== null && <button className="ghost-btn" onClick={() => void loadMessageEdits(msg.id)}>继续查看改稿</button>}
      </details>}
      {isLong && (
        <div className="long-render-bar">
          <span className="long-render-info">
            内容较长：已显示 {Math.min(limit, contentChars).toLocaleString()} / {contentChars.toLocaleString()} 字
          </span>
          <div className="long-render-actions">
            <button
              className="ghost-btn"
              disabled={fullyShown}
              onClick={() => setRenderLimit((prev) => Math.min(contentChars, (prev ?? LONG_LIMIT) + LONG_CHUNK))}
            >
              继续渲染（+20000）
            </button>
            <button className="ghost-btn" disabled={fullyShown} onClick={() => setRenderLimit(Number.POSITIVE_INFINITY)}>
              全部渲染
            </button>
            <button className="ghost-btn" onClick={() => void copy(msg.content).then(() => showToast('已复制全文到剪贴板', 'success'))}>
              复制全文
            </button>
          </div>
        </div>
      )}
      <PlanCard msg={msg} />
    </div>
  )
})

export default MessageBubble
