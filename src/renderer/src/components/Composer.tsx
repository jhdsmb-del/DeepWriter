import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useStore } from '../store'
import { useComposerAttachments } from '../hooks/useComposerAttachments'
import { COMMAND_TEMPLATES } from '../commands'
import type { CommandTemplate } from '../../../shared/types'
import { deriveWritingRunMode } from '../writingMode'
import Icon from './Icon'
import { useComposerRegistry } from '../hooks/useComposerRegistry'
import { composerWeb } from '../composerWeb'
import ModelReasoningControl from './ModelReasoningControl'
import WorkingDirectoryControl from './WorkingDirectoryControl'
import ContextDialog from './ContextDialog'
import ComposerPerformance from './ComposerPerformance'
import AgentPresetControl from './AgentPresetControl'
import Switch from './Switch'
import AttachmentList from './AttachmentList'
import { ATTACHMENT_PICKER_HINT } from '../../../shared/attachmentPreview'
import { modelFailureNotice, type ModelFailureNotice } from '../modelFailure'
import { useWorkSteering } from '../hooks/useWorkSteering'
import './WorkSteering.css'
import './GoalMode.css'

export default function Composer({ onOpenSettings }: { onOpenSettings?: () => void }): React.ReactNode {
  const text = useStore((state) => state.composerText)
  const setText = useStore((state) => state.setComposerText)
  const submitting = useStore((state) => state.submitting)
  const closing = useStore((state) => state.closing)
  const draftSaveError = useStore((state) => state.draftSaveError)
  const flushDrafts = useStore((state) => state.flushComposerDrafts)
  const currentSessionId = useStore((state) => state.currentSessionId)
  const submissionRef = useRef(false)
  const readOnlyPlan = useStore((state) => state.settings?.planMode === true)
  const webAccessEnabled = useStore((state) => state.settings?.webAccessEnabled !== false)
  const settings = useStore((state) => state.settings)
  const settingsReady = Boolean(settings)
  const { snapshot, refreshSnapshot } = useComposerRegistry(settings)
  const web = composerWeb(snapshot, readOnlyPlan)
  const webActive = webAccessEnabled && web.ready
  const webStatus = !web.ready ? '未联网' : webActive ? '联网' : '联网已关'
  const webAction = !web.ready ? web.hint + '，打开模型设置' : `联网搜索${webActive ? '已开启' : '已关闭'}，打开设置`
  const updateSettings = useStore((state) => state.updateSettings)
  const [webAccessSaving, setWebAccessSaving] = useState(false)
  const [submitError, setSubmitError] = useState<ModelFailureNotice | null>(null)
  useEffect(() => setSubmitError(null), [currentSessionId])
  const [dragging, setDragging] = useState(false)
  const [menuIndex, setMenuIndex] = useState(0)
  const [dismissedCommandText, setDismissedCommandText] = useState<string | null>(null)
  const taRef = useRef<HTMLTextAreaElement>(null)
  const toolsRef = useRef<HTMLDetailsElement>(null)
  const send = useStore((s) => s.send)
  const stop = useStore((s) => s.stop)
  const running = useStore((s) => s.running)
  const steering = useWorkSteering()
  const longMode = useStore((s) => s.longMode)
  const targetChars = useStore((s) => s.targetChars)
  const pendingAttachments = useStore((s) => s.pendingAttachments)
  const { addFiles, addViaDialog, retryAtt, reselectAtt, removeAtt, openFileMenu } = useComposerAttachments()
  const showToast = useStore((s) => s.showToast)
  const mode = useStore((s) => s.mode)
  const workspace = useStore((s) => s.workspace)
  const [ctxOpen, setCtxOpen] = useState(false)
  const closeContext = useCallback(() => setCtxOpen(false), [])
  const startGuidedLongwrite = useStore((s) => s.startGuidedLongwrite)
  const contextMode = useStore((s) => s.contextMode)
  const previewContext = useStore((s) => s.previewContext)
  // mode/workspace 是入口的事实源；longMode 只是兼容旧状态的提示位。
  // 任何一项表明当前在长文工作面，都必须进入 Grill Me，避免状态漂移后直写。
  const guidedLongwrite = deriveWritingRunMode({ workspace, mode, longMode }).longMode
  const goalAvailable = workspace === 'chat' && mode === 'agent' && !guidedLongwrite && !readOnlyPlan
  const [goalEnabled, setGoalEnabled] = useState(false)
  const [autonomousGoal, setAutonomousGoal] = useState(false)
  // Bind the choice before typing creates the first session; changing sessions
  // must clear task authorization, but creating this draft must not erase it.
  const goalSession = useRef(currentSessionId)
  useEffect(() => {
    if (goalSession.current !== currentSessionId) { setGoalEnabled(false); setAutonomousGoal(false); goalSession.current = currentSessionId }
  }, [currentSessionId])
  useEffect(() => { setGoalEnabled(false); setAutonomousGoal(false) }, [workspace, mode, readOnlyPlan])

  const attachmentPreviewKey = pendingAttachments.map((item) => `${item.fileRefId}:${item.size}`).join('|')
  useLayoutEffect(() => {
    if (!taRef.current) return
    taRef.current.style.height = 'auto'
    taRef.current.style.height = `${Math.min(taRef.current.scrollHeight, 240)}px`
  }, [text])
  useEffect(() => {
    const timer = window.setTimeout(() => { void previewContext(text, pendingAttachments) }, 350)
    return () => window.clearTimeout(timer)
  }, [text, attachmentPreviewKey, contextMode, currentSessionId, previewContext])
  const menuOpen = text.startsWith('/') && text !== dismissedCommandText
  const filter = text.slice(1).toLowerCase().trim()
  const filtered = menuOpen
    ? COMMAND_TEMPLATES.filter(
        (c) => !filter || c.id.toLowerCase().includes(filter) || c.name.toLowerCase().includes(filter) || c.desc.toLowerCase().includes(filter)
      )
    : []

  useEffect(() => {
    setMenuIndex(0)
  }, [filter])

  useEffect(() => {
    const closeToolsOutside = (event: PointerEvent): void => {
      const tools = toolsRef.current
      if (tools?.open && !tools.contains(event.target as Node)) tools.open = false
    }
    const closeToolsOnEscape = (event: KeyboardEvent): void => {
      const tools = toolsRef.current
      // Let a nested preset/selector close first; its draft stays mounted.
      if (event.key !== 'Escape' || event.defaultPrevented || !tools?.open || tools.querySelector('[aria-expanded="true"]')) return
      tools.open = false
      tools.querySelector('summary')?.focus()
      event.preventDefault()
    }
    window.addEventListener('pointerdown', closeToolsOutside)
    window.addEventListener('keydown', closeToolsOnEscape)
    return () => {
      window.removeEventListener('pointerdown', closeToolsOutside)
      window.removeEventListener('keydown', closeToolsOnEscape)
    }
  }, [])

  const changeWebAccess = async (enabled: boolean): Promise<void> => {
    setWebAccessSaving(true)
    try { await updateSettings({ webAccessEnabled: enabled }) }
    finally { setWebAccessSaving(false) }
  }
  const openWebAccess = (): void => {
    if (!toolsRef.current) return
    toolsRef.current.open = true
    toolsRef.current.querySelector<HTMLInputElement>('input[type="checkbox"]')?.focus()
  }

  const pick = (c: CommandTemplate): void => {
    setText(c.prompt.replaceAll('{n}', String(targetChars)))
    if (taRef.current) taRef.current.focus()
  }

  const submit = (quickBypass = false): void => {
    const t = text.trim()
    if (!t || running && !steering.canSteer || submitting || submissionRef.current || webAccessSaving || steering.sending) return
    const sessionId = useStore.getState().ensureSessionId()
    const submittedText = text
    setSubmitError(null)
    submissionRef.current = true
    void (async () => {
      try {
        if (running && steering.canSteer) {
          if (pendingAttachments.length) { showToast('运行中补充仅发送文字；请先移除附件，素材草稿会保留', 'error'); return }
          await steering.send(t)
          useStore.getState().clearSubmittedText(sessionId, submittedText)
          return
        }
        if (guidedLongwrite && !quickBypass) {
          if (startGuidedLongwrite(t, pendingAttachments)) useStore.getState().clearSubmittedText(sessionId, submittedText)
          return
        }
        const goalMode = goalAvailable && goalEnabled ? autonomousGoal ? 'autonomous' : 'guided' : undefined
        const result = await send(t, pendingAttachments, undefined, quickBypass, goalMode)
        if (result.ok) {
          setGoalEnabled(false)
          setAutonomousGoal(false)
          useStore.getState().clearSubmittedText(sessionId, submittedText)
        }
        else {
          const notice = modelFailureNotice(undefined, result.error)
          if (notice) setSubmitError(notice)
          else showToast(`${result.error || '发送失败'}，草稿已保留`, 'error')
        }
      } catch (error) {
        showToast(error instanceof Error ? `${error.message}，草稿已保留` : '发送失败，草稿已保留，请重试', 'error')
      } finally {
        submissionRef.current = false
      }
    })()
  }

  return (
    <div
      className={`composer${dragging ? ' dragging' : ''}`}
      onDragOver={(e) => {
        if (e.dataTransfer?.types.includes('Files')) {
          e.preventDefault()
          setDragging(true)
        }
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={(e) => {
        e.preventDefault()
        setDragging(false)
        if (e.dataTransfer.files.length > 0) void addFiles(Array.from(e.dataTransfer.files))
      }}
    >
      {dragging && <div className="attachment-drop-label">添加 ZIP、文档或文本资料</div>}
      <AttachmentList attachments={pendingAttachments} onRetry={retryAtt} onReselect={reselectAtt} onRemove={removeAtt} onContextMenu={openFileMenu} />
      {menuOpen && (
        <div className="command-menu">
          {filtered.length === 0 ? (
            <div className="command-empty">无匹配命令（可用：{COMMAND_TEMPLATES.map((c) => c.id).join(' / ')}）</div>
          ) : (
            filtered.map((c, i) => (
              <div
                key={c.id}
                className={`command-item${i === menuIndex ? ' active' : ''}`}
                onMouseEnter={() => setMenuIndex(i)}
                onClick={() => pick(c)}
              >
                <span className="command-name">{c.name}</span>
                <span className="command-desc">{c.desc}</span>
              </div>
            ))
          )}
        </div>
      )}
      {goalAvailable && !running && <div className="composer-goal-options">
        <div className="composer-goal-controls">
          <label className="composer-goal-choice" title="把需求转成可验收的目标，持续执行并检查结果"><input type="checkbox" checked={goalEnabled} disabled={submitting || closing} onChange={event => { goalSession.current = useStore.getState().ensureSessionId(); setGoalEnabled(event.target.checked); setAutonomousGoal(false) }} /><span>Goal 模式</span></label>
          {goalEnabled && <label className="composer-goal-choice"><input type="checkbox" checked={autonomousGoal} disabled={submitting || closing} onChange={event => setAutonomousGoal(event.target.checked)} aria-describedby={autonomousGoal ? 'goal-autonomy-explanation' : undefined} /><span>不提问，自主执行</span><span className="composer-goal-once">仅本次任务</span></label>}
        </div>
        {goalEnabled && autonomousGoal && <div className="composer-goal-authorization" id="goal-autonomy-explanation"><WorkingDirectoryControl /><span>本次预授权项目文件和已授权命令；联网沿用当前设置，可随时停止。</span></div>}
      </div>}
      <textarea
        ref={taRef}
        value={text}
        disabled={closing}
        aria-label="任务内容"
        placeholder={steering.canSteer ? '给当前任务补充要求…' : goalAvailable && goalEnabled ? '这次要完成什么？' : '发消息，或描述要完成的任务…'}
        rows={2}
        onChange={(e) => {
          setText(e.target.value)
        }}
        onKeyDown={(e) => {
          if (menuOpen && e.key === 'Escape') {
            e.preventDefault()
            setDismissedCommandText(text)
            return
          }
          if (menuOpen && filtered.length > 0) {
            if (e.key === 'ArrowDown') {
              e.preventDefault()
              setMenuIndex((i) => (i + 1) % filtered.length)
              return
            }
            if (e.key === 'ArrowUp') {
              e.preventDefault()
              setMenuIndex((i) => (i - 1 + filtered.length) % filtered.length)
              return
            }
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault()
              pick(filtered[menuIndex])
              return
            }
          }
          if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault()
            submit()
          }
        }}
        onPaste={(e) => {
          const files = e.clipboardData?.files
          if (files && files.length > 0) {
            e.preventDefault()
            void addFiles(Array.from(files))
          }
        }}
      />
      {submitError && <div className="composer-submit-error model-failure" role="alert"><b>{submitError.title}</b><p>{submitError.detail}</p>{submitError.settings && onOpenSettings && <button type="button" className="ghost-btn" onClick={onOpenSettings}>打开模型设置</button>}</div>}
      {draftSaveError && <div className="composer-draft-error" role="status">
        <span>{draftSaveError}</span>
        <button type="button" className="dw-text-btn" onClick={() => void flushDrafts().catch(() => undefined)}>重试保存</button>
      </div>}
      {!!steering.view?.messages.length && (running || steering.view.messages.some(item => item.status === 'pending')) && <details className="composer-steering" data-testid="work-steering-receipts">
        <summary>补充指令 · {steering.view.messages.filter(item => item.status === 'pending').length} 条待处理</summary>
        <ul>{steering.view.messages.filter((item, index) => item.status === 'pending' || index >= steering.view!.messages.length - 6).map(item => <li key={item.requestId}>
          {(item.status === 'applied' || steering.view!.messages.some(message => message.status === 'applied')) && <span>{item.status === 'applied' ? '已加入运行上下文' : '待处理'}</span>}<p>{item.text}</p>
          {item.status === 'pending' && !['running', 'queued'].includes(steering.view!.runStatus) && <span>运行已暂停或结束；补充仍已保存，不会越过批准或恢复决策。</span>}
          <button type="button" className="dw-text-btn" onClick={() => setText(item.text)}>放回输入框</button>
        </li>)}</ul>
      </details>}
      <div className="composer-modebar">
        <div className="composer-tools-left">
          <button type="button" className="modebar-btn modebar-attachment" aria-label="添加附件" title={ATTACHMENT_PICKER_HINT} onClick={() => void addViaDialog()}>
            <Icon name="paperclip" size={19} />
          </button>
          <details ref={toolsRef} className="composer-tools">
            <summary aria-label="更多工具" title="只读审阅、联网搜索、工作目录与自定义指令" data-testid="composer-tools-trigger"><Icon name="more" size={18} /></summary>
            <div className="composer-tools-panel" aria-label="输入区工具">
              <div className="composer-web-control" title={web.hint}>
                <Switch checked={webActive} onChange={(enabled) => void changeWebAccess(enabled)} label={web.ready ? "联网搜索" : web.hint} compact disabled={!web.ready || webAccessSaving} />
              </div>
              {!guidedLongwrite && mode === 'agent' && <Switch checked={readOnlyPlan} onChange={enabled => void updateSettings({ planMode: enabled })} label="只读审阅" compact disabled={!settingsReady || running || submitting} />}
              {!(goalAvailable && goalEnabled && autonomousGoal) && <WorkingDirectoryControl />}
              <AgentPresetControl />
            </div>
          </details>
          <button type="button" className={`modebar-btn composer-web-status${webActive ? ' enabled' : ''}`} aria-label={webAction} title={web.hint} disabled={!settingsReady || webAccessSaving} onClick={web.ready ? openWebAccess : onOpenSettings}><Icon name="globe" size={16} /><span>{webAccessSaving ? '保存中' : webStatus}</span></button>
        </div>
        <div className="composer-actions">
          <ModelReasoningControl snapshot={snapshot} refreshSnapshot={refreshSnapshot} onOpenSettings={onOpenSettings} onOpenContext={() => setCtxOpen(true)} />
          <div className="composer-bar">
            {!running && readOnlyPlan && !guidedLongwrite && mode === 'agent' && <span className="text-muted">只读审阅</span>}
            {running ? (
              <>
              <button type="button" className="btn stop composer-send" aria-label="停止" title="停止当前任务" onClick={stop}>
                <Icon name="stop" size={16} />
              </button>
              {steering.canSteer && <button type="button" className="btn primary composer-send" aria-label="补充指令" title="保存补充，在下一次安全模型调用前处理；不会中断已发出的工具" onClick={() => submit()} disabled={!text.trim() || steering.sending || closing || pendingAttachments.length > 0}>
                <Icon name="arrowUp" size={21} />
              </button>}
              </>
            ) : (
              <button type="button" className="btn primary composer-send" aria-label={submitting ? '提交中' : guidedLongwrite ? '开始梳理' : readOnlyPlan && mode === 'agent' ? '只读审阅' : goalAvailable && goalEnabled ? '开始目标任务' : '发送'} title={submitting ? '提交中…' : guidedLongwrite ? '开始梳理' : readOnlyPlan && mode === 'agent' ? '只读查稿并提出方案，不修改文件' : '发送（Enter）；换行（Shift+Enter）'} onClick={() => submit()} disabled={!text.trim() || submitting || closing || webAccessSaving}>
                <Icon name="arrowUp" size={21} />
              </button>
            )}
          </div>
        </div>
      </div>
      <ComposerPerformance />
      {ctxOpen && <ContextDialog onClose={closeContext} />}
    </div>
  )
}
