import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react'
import { useStore } from './store'
import ChatMessages from './components/ChatMessages'
import Composer from './components/Composer'
import SidePanel from './components/SidePanel'
import SessionSidebar from './components/SessionSidebar'
import { loadSettingsPanel, loadInspectorPanel, prefetchSettingsPanel } from './panelModules'
const SettingsModal = lazy(loadSettingsPanel)
const RunInspector = lazy(loadInspectorPanel)
import { AgentTaskCenter } from './components/TaskCenter'
import Icon from './components/Icon'
import { useDialogFocus } from './hooks/useDialogFocus'
import { usePresence } from './hooks/usePresence'
import type { NarrativeSemanticReviewDecision, NarrativeStateDelta } from '../../shared/types'
import type { NarrativeReviewPrompt } from './store'
import { modelFailureNotice } from './modelFailure'
import PermissionDialog from './components/PermissionDialog'
import { useDesktopUpdates } from './hooks/useDesktopUpdates'
import './desktopUpdates.css'

const REVIEW_DECISION_LABELS: Record<NarrativeSemanticReviewDecision, string> = {
  accept_delta: '接受修正状态',
  accept_unknown: '接受正文，保留未知',
  accept_prose_no_state: '接受正文，不写入状态',
  reject_rewrite: '拒绝候选并重写',
  abandon: '放弃该运行'
}

const REVIEW_REASON_LABELS: Record<string, string> = {
  beat_uncertain: '有一处语义无法确定',
  beat_evidence_invalid: '正文证据与场景要求不一致',
  missing_required_beat: '场景要求的动作或结果尚未出现',
  beat_contradicted: '正文与场景要求发生冲突'
}

function reviewDecisionAllowed(review: NarrativeReviewPrompt, decision: NarrativeSemanticReviewDecision): boolean {
  return (review.effectiveAllowedDecisions ?? review.allowedDecisions)?.[decision]?.allowed === true
}

function reviewReasonText(code: string, message: string): string {
  return REVIEW_REASON_LABELS[code] ?? (message || '需要人工确认的语义证据')
}

function narrativeDeltaSummary(delta: NarrativeStateDelta | null): string {
  if (!delta || !Array.isArray(delta.changes) || delta.changes.length === 0) return '没有拟写入的结构化世界状态。'
  const labels = delta.changes.map((change) => {
    const kind = typeof change.kind === 'string' ? change.kind : '叙事状态'
    if (kind === 'object_state') return '物件状态'
    if (kind === 'timeline_event') return '时间线事件'
    if (kind === 'character_state') return '角色状态'
    if (kind === 'relationship') return '关系状态'
    return '叙事状态'
  })
  return `拟写入 ${delta.changes.length} 项状态：${[...new Set(labels)].join('、')}。`
}

export default function App(): React.ReactNode {
  const init = useStore((s) => s.init)
  const newSession = useStore((s) => s.newSession)
  const running = useStore((s) => s.running)
  const submitting = useStore((s) => s.submitting)
  const stop = useStore((s) => s.stop)
  const toast = useStore((s) => s.toast)
  const workspace = useStore((s) => s.workspace)
  const emptyConversation = useStore((s) => s.messages.length === 0)
  const settingsReady = useStore((s) => s.settings !== null)
  const mode = useStore((s) => s.mode)
  const setMode = useStore((s) => s.setMode)
  const setWorkspace = useStore((s) => s.setWorkspace)
  const sessionCollapsed = useStore((s) => s.sessionCollapsed)
  const toggleSessionCollapsed = useStore((s) => s.toggleSessionCollapsed)
  const setSessionCollapsed = useStore((s) => s.setSessionCollapsed)
  const recoverableRuns = useStore((s) => s.recoverableRuns)
  const resumeRun = useStore((s) => s.resumeRun)
  const rebaseStoryRun = useStore((s) => s.rebaseStoryRun)
  const abandonRun = useStore((s) => s.abandonRun)
  const showToast = useStore((s) => s.showToast)
  const openRunInspector = useStore((s) => s.openRunInspector)
  const inspectorRunId = useStore((s) => s.inspectorRunId)
  const recoveryPrompt = useStore((s) => s.recoveryPrompt)
  const decideRecovery = useStore((s) => s.decideRecovery)
  const closeRecoveryPrompt = useStore((s) => s.closeRecoveryPrompt)
  const narrativeReview = useStore((s) => s.narrativeReview)
  const decideNarrativeReview = useStore((s) => s.decideNarrativeReview)
  const closeNarrativeReview = useStore((s) => s.closeNarrativeReview)
  const unknownCostPrompt = useStore((s) => s.unknownCostPrompt)
  const decideUnknownCost = useStore((s) => s.decideUnknownCost)
  const closeUnknownCost = useCallback(() => decideUnknownCost('cancel'), [decideUnknownCost])
  const unknownCostDialogRef = useDialogFocus<HTMLDivElement>(Boolean(unknownCostPrompt), closeUnknownCost)
  const [showSettings, setShowSettings] = useState(false)
  const updates = useDesktopUpdates()
  const [settingsInitialSection, setSettingsInitialSection] = useState<'updates' | undefined>()
  const closeSettings = useCallback(() => setShowSettings(false), [])
  const settingsPresent = usePresence(showSettings)
  const workspaceRef = useRef<HTMLElement>(null)
  useEffect(() => {
    const preference = window.matchMedia('(prefers-reduced-motion: reduce)')
    if (preference.matches) return
    const animation = workspaceRef.current?.animate(
      [{ opacity: 0.75, transform: 'translateY(4px)' }, { opacity: 1, transform: 'translateY(0)' }],
      { duration: 180, easing: 'cubic-bezier(.22, 1, .36, 1)' }
    )
    const cancel = (): void => { if (preference.matches) animation?.cancel() }
    preference.addEventListener('change', cancel)
    return () => { animation?.cancel(); preference.removeEventListener('change', cancel) }
  }, [workspace])
  const [reviewDeltaText, setReviewDeltaText] = useState('')
  const recoveryDialogRef = useDialogFocus<HTMLDivElement>(Boolean(recoveryPrompt), closeRecoveryPrompt)
  const narrativeReviewDialogRef = useDialogFocus<HTMLDivElement>(Boolean(narrativeReview), closeNarrativeReview)
  useEffect(() => {
    if (!narrativeReview) return
    setReviewDeltaText(narrativeReview.proposedDelta ? JSON.stringify(narrativeReview.proposedDelta, null, 2) : '')
  }, [narrativeReview?.packetHash])
  const decideReviewWithDelta = (): void => {
    let delta: unknown
    try {
      delta = JSON.parse(reviewDeltaText)
    } catch {
      showToast('请先提供合法的结构化状态 JSON', 'error')
      return
    }
    void decideNarrativeReview('accept_delta', delta as any).then((ok) => showToast(ok ? '已接受修正状态，任务继续' : '复核决策失败，请重新打开证据', ok ? 'success' : 'error'))
  }
  const continueWaitingRun = (run: (typeof recoverableRuns)[number]): void => {
    if (run.config.goalMode === 'guided' || run.config.goalMode === 'autonomous') { openRunInspector(run.runId, 'activity'); return }
    if (run.errorCode === 'run_cost_unknown_price') {
      showToast('该任务已冻结缺失价格；补价不会修改历史预算。请停止该任务，再新建并确认费用。', 'info')
      setShowSettings(true)
      return
    }
    if (run.errorCode === 'story_ledger_epoch_invalidated') {
      void rebaseStoryRun(run.runId).then((ok) => showToast(ok ? '已准备安全分支，请提交下一条创作任务' : '无法准备安全故事线分支', ok ? 'success' : 'error'))
      return
    }
    if (run.errorCode !== 'completion_budget_exhausted' && run.errorCode !== 'run_provider_call_cap') {
      void resumeRun(run.runId).then((ok) => showToast(ok ? '已继续处理该任务' : '无法继续，请打开任务详情查看原因', ok ? 'success' : 'error'))
      return
    }
    // Budget amendments use the RunInspector's inline control.  A native
    // prompt is unavailable in packaged Electron and cannot be audited.
    openRunInspector(run.runId, 'activity')
  }


  useEffect(() => {
    void init()
  }, [init])

  useEffect(() => {
    if (!settingsReady) return
    // Fetch/parse the common settings surface after the first usable frame,
    // rather than adding its entire dependency tree to the click handler.
    const idle = window.requestIdleCallback(prefetchSettingsPanel)
    return () => window.cancelIdleCallback(idle)
  }, [settingsReady])

  useEffect(() => {
    const narrow = window.matchMedia('(max-width: 899px)')
    const collapseOnNarrow = (event: MediaQueryListEvent | MediaQueryList): void => {
      if (event.matches) setSessionCollapsed(true)
    }
    collapseOnNarrow(narrow)
    narrow.addEventListener('change', collapseOnNarrow)
    return () => narrow.removeEventListener('change', collapseOnNarrow)
  }, [setSessionCollapsed])

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'n') {
        e.preventDefault()
        if (!running && !submitting) newSession()
      } else if ((e.ctrlKey || e.metaKey) && e.key === ',') {
        e.preventDefault()
        setShowSettings(true)
      } else if (e.altKey && e.key === 'Enter') {
        e.preventDefault()
        if (running) stop()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [newSession, running, submitting, stop])

  return (
    <div className="app dw-shell">
      <header className="topbar dw-topbar">
        <div className="dw-topbar-start">
          <button className="dw-icon-btn" aria-label={sessionCollapsed ? '展开会话栏' : '收起会话栏'} title={sessionCollapsed ? '展开会话栏' : '收起会话栏'} onClick={toggleSessionCollapsed}>
            <Icon name="sidebar" />
          </button>
          <div className="dw-title-group">
            <span className="dw-product">DeepWriter</span><span className="dw-product-context">写作工作室</span>
          </div>
        </div>
        <nav className="dw-global-nav" aria-label="全局一级导航">
          <button aria-current={workspace === 'chat' && mode === 'agent' ? 'page' : undefined} onClick={() => setMode('agent')}><Icon name="chat" />Agent</button>
          <button aria-current={workspace === 'novel' ? 'page' : undefined} onClick={() => setMode('longwrite')}><Icon name="document" />长文</button>
          <button aria-current={workspace === 'runs' ? 'page' : undefined} onClick={() => setWorkspace('runs')}><Icon name="tasks" />任务中心</button>
          <details className="dw-creative-tools">
            <summary><Icon name="tools" />创作工具<Icon name="chevronDown" size={14} /></summary>
            <div className="dw-creative-menu">
              <button aria-current={workspace === 'style' ? 'page' : undefined} onClick={(event) => { setMode('style'); event.currentTarget.closest('details')?.removeAttribute('open') }}>风格参考</button>
              <button aria-current={workspace === 'galgame' ? 'page' : undefined} onClick={(event) => { setMode('galgame'); event.currentTarget.closest('details')?.removeAttribute('open') }}>Galgame</button>
            </div>
          </details>
        </nav>
        <div className="dw-topbar-actions">
          {(updates?.phase === 'ready' || updates?.phase === 'available') && <button className="dw-text-btn dw-update-indicator" title={updates.message} onClick={() => { setSettingsInitialSection('updates'); setShowSettings(true) }}>有可用更新</button>}
          {(running || submitting || recoverableRuns.length > 0) && <span className={`dw-run-status${running ? ' running' : ''}`}>
            <span className="dw-status-dot" />
            {submitting ? '提交中' : running ? '运行中' : recoverableRuns.length > 0 ? '待处理' : '就绪'}
          </span>}
          {running && <button className="dw-icon-btn" aria-label="打开悬浮进度窗" title={running ? '显示或隐藏悬浮进度窗' : '运行任务后可打开悬浮进度窗'} disabled={!running} onClick={() => void (window as any).ds?.floatToggle?.()}>
            <Icon name="float" />
          </button>}
          <button className="dw-icon-btn" aria-label="设置" title="设置 (Ctrl+,)" onPointerEnter={prefetchSettingsPanel} onFocus={prefetchSettingsPanel} onClick={() => setShowSettings(true)}>
            <Icon name="settings" />
          </button>
        </div>
      </header>

      {workspace !== 'novel' && recoverableRuns.length > 0 && (
        <div className="recover-banner dw-recover-banner">
          <span className="dw-recover-label"><span className="dw-status-dot" />{recoverableRuns.length} 个任务等待处理</span>
          <div className="dw-recover-items">
            {recoverableRuns.map((run) => {
              const failure = modelFailureNotice(run.errorCode, run.errorMessage)
              return (
              <span key={run.runId} className="recover-item">
                <button className="dw-recover-name" title={failure?.detail} onClick={() => openRunInspector(run.runId)}>{failure?.title ?? `${run.runId.slice(0, 8)} · ${run.status === 'waiting_user' ? '等待你的决定' : '可恢复'}`}</button>
                {failure?.settings && <button className="dw-text-btn" onClick={() => setShowSettings(true)}>模型设置</button>}
                {run.config.goalMode ? <button className="dw-text-btn" onClick={() => openRunInspector(run.runId, 'activity')}>{run.config.goalMode === 'autonomous' ? '查看并重新授权' : '处理目标'}</button> : run.errorCode === 'story_ledger_epoch_invalidated' ? (
                  <>
                    <button className="dw-text-btn" onClick={() => continueWaitingRun(run)}>基于安全故事线新建分支</button>
                    <button className="dw-text-btn" onClick={() => openRunInspector(run.runId)}>查看</button>
                  </>
                ) : run.status === 'waiting_user' || run.errorCode === 'run_provider_call_cap' || (run.status === 'recovery_required' && run.errorCode?.startsWith('completion_')) ? (
                  <>
                    <button className="dw-text-btn" onClick={() => continueWaitingRun(run)}>{run.errorCode === 'run_cost_unknown_price' ? '配置价格后新建' : '继续'}</button>
                    <button className="dw-text-btn" onClick={() => openRunInspector(run.runId)}>查看</button>
                  </>
                ) : (
                  <button className="dw-text-btn" onClick={() => void resumeRun(run.runId).then((ok) => showToast(ok ? '已恢复运行' : '恢复失败', ok ? 'success' : 'error'))}>恢复</button>
                )}
                <button className="dw-text-btn danger" onClick={() => void abandonRun(run.runId).then((ok) => showToast(ok ? '已停止该任务' : '停止失败', ok ? 'info' : 'error'))}>停止</button>
              </span>
            )})}
          </div>
        </div>
      )}

      <div className="layout dw-layout">
        <SessionSidebar />
        {!sessionCollapsed && <button className="dw-sidebar-scrim" aria-label="关闭会话栏" onClick={() => setSessionCollapsed(true)} />}
        <main ref={workspaceRef} className={`chat-area dw-workspace workspace-${workspace}${workspace === 'chat' && emptyConversation ? ' is-new-conversation' : ''}`}>
          {workspace === 'chat' ? (
            <ChatMessages onOpenSettings={() => setShowSettings(true)} />
          ) : workspace === 'runs' ? (
            <div className="dw-workspace-canvas dw-task-center-canvas"><AgentTaskCenter /></div>
          ) : (
            <div className="dw-workspace-canvas">
              <SidePanel />
            </div>
          )}
          {workspace !== 'novel' && workspace !== 'runs' && (
            <div className="dw-composer-dock">
              <Composer onOpenSettings={() => setShowSettings(true)} />
            </div>
          )}
        </main>
      </div>
      {settingsPresent && <div className={`dw-dialog-presence${showSettings ? '' : ' is-exiting'}`} inert={!showSettings} aria-hidden={!showSettings || undefined}><Suspense fallback={<div role="status" className="toast">正在加载设置…</div>}><SettingsModal onClose={closeSettings} initialSection={settingsInitialSection} /></Suspense></div>}
      {unknownCostPrompt && (
        <div className="modal-overlay dw-dialog-overlay" role="presentation">
          <div ref={unknownCostDialogRef} tabIndex={-1} className="modal dw-dialog dw-recovery-modal" role="dialog" aria-modal="true" aria-labelledby="dw-unknown-cost-title" aria-describedby="dw-unknown-cost-description">
            <div className="modal-head"><h3 id="dw-unknown-cost-title">本次任务费用无法估算</h3><button className="dw-settings-close" aria-label="取消费用确认" onClick={closeUnknownCost}><Icon name="close" /></button></div>
            <div className="modal-body">
              <p id="dw-unknown-cost-description">所选模型缺少完整参考价，金额上限不能保证。可以先去配置价格，或主动确认本次任务仅按调用数和 token 上限继续。</p>
              <p>本次模型调用次数{unknownCostPrompt.maxCalls === null ? '不限' : `最多 ${unknownCostPrompt.maxCalls} 次`}、{unknownCostPrompt.maxTokens.toLocaleString()} tokens。账单中未知费用仍显示未知，不记为 0；此确认不授权下一次任务。</p>
              <div className="dw-recovery-actions">
                <button className="btn" onClick={closeUnknownCost}>取消，保留草稿</button>
                <button className="btn" onClick={() => { decideUnknownCost('settings'); setShowSettings(true) }}>去配置价格</button>
                <button className="btn primary" onClick={() => decideUnknownCost('accept')}>确认本次仅按调用数和 token 上限继续</button>
              </div>
            </div>
          </div>
        </div>
      )}
      {recoveryPrompt && (
        <div className="modal-overlay dw-dialog-overlay" role="presentation">
          <div ref={recoveryDialogRef} tabIndex={-1} className="modal dw-dialog dw-recovery-modal" role="dialog" aria-modal="true" aria-labelledby="dw-recovery-title">
            <div className="modal-head">
              <h3 id="dw-recovery-title">确认工具执行结果</h3>
              <button className="dw-settings-close" aria-label="暂不处理" onClick={closeRecoveryPrompt}><Icon name="close" /></button>
            </div>
            <div className="modal-body">
              <p className="dw-recovery-lead">{recoveryPrompt.message}</p>
              <div className="dw-recovery-calls">
                {recoveryPrompt.pendingToolCalls.map((call) => (
                  <details key={call.toolCallId}>
                    <summary><code>{call.name}</code><span>结果未知</span></summary>
                    <pre>{call.argsJson}</pre>
                  </details>
                ))}
              </div>
              <div className="dw-recovery-warning"><b>需要人工判断</b><span>请检查文件、命令或外部系统的实际状态，不确定时先暂不处理。</span></div>
              <div className="dw-recovery-actions">
                <button className="dw-decision primary" onClick={() => void decideRecovery('confirm_applied').then((ok) => showToast(ok ? '已确认执行完成，任务继续' : '恢复决策失败', ok ? 'success' : 'error'))}><b>已经执行</b><span>保留现状，继续后续步骤</span></button>
                <button className="dw-decision" onClick={() => void decideRecovery('retry_not_applied').then((ok) => showToast(ok ? '已确认未执行，正在安全重试' : '该工具不可直接重试', ok ? 'success' : 'error'))}><b>没有执行</b><span>确认无副作用后重新执行</span></button>
                <button className="dw-decision" onClick={() => void decideRecovery('rollback_then_retry').then((ok) => showToast(ok ? '已回滚并重试' : '回滚或重试失败', ok ? 'success' : 'error'))}><b>回滚并重试</b><span>恢复检查点后重新执行</span></button>
                <button className="dw-decision danger" onClick={() => void decideRecovery('abandon').then((ok) => showToast(ok ? '已放弃该运行' : '放弃失败', ok ? 'info' : 'error'))}><b>放弃任务</b><span>停止运行，不再自动继续</span></button>
              </div>
            </div>
          </div>
        </div>
      )}
      {workspace !== 'novel' && narrativeReview && (
        <div className="modal-overlay dw-dialog-overlay" role="presentation">
          <div ref={narrativeReviewDialogRef} tabIndex={-1} className="modal dw-dialog dw-recovery-modal" role="dialog" aria-modal="true" aria-labelledby="dw-narrative-review-title">
            <div className="modal-head">
              <h3 id="dw-narrative-review-title">复核场景语义与叙事状态</h3>
              <button className="dw-settings-close" aria-label="暂不处理" onClick={closeNarrativeReview}><Icon name="close" /></button>
            </div>
            <div className="modal-body">
              <p className="dw-recovery-lead">正文候选尚未接纳。请检查候选、冻结契约、缺失或冲突要求与拟议状态；未明确决定前不会继续调用模型接口。</p>
              <div className="dw-recovery-warning"><b>候选 {narrativeReview.candidate.segmentId}</b><span>内容校验值 {narrativeReview.candidate.contentHash.slice(0, 16)}… · 修订第 {narrativeReview.revision} 版</span></div>
              <details open>
                <summary>候选正文（尚未写入 accepted）</summary>
                <pre className="dw-recovery-pre">{narrativeReview.candidate.content ?? '候选正文不可读（内容校验值仍会校验）'}</pre>
              </details>
              <details>
                <summary>冻结契约与缺口</summary>
                <div className="dw-review-summary">
                  <p><b>场景：</b>{narrativeReview.contract.title || narrativeReview.sceneId}</p>
                  <p><b>本轮目标：</b>{narrativeReview.contract.objective || '按冻结契约完成当前场景'}</p>
                  <p><b>缺少的要求：</b>{narrativeReview.missingBeatIds.length > 0 ? narrativeReview.missingBeatIds.join('、') : '没有明确缺口'}</p>
                  <p><b>冲突的要求：</b>{narrativeReview.conflictBeatIds.length > 0 ? narrativeReview.conflictBeatIds.join('、') : '没有检测到冲突'}</p>
                  {narrativeReview.reasons.length > 0 && (
                    <ul>
                      {narrativeReview.reasons.map((reason, index) => <li key={`${reason.code}-${index}`}>{reviewReasonText(reason.code, reason.message)}</li>)}
                    </ul>
                  )}
                  <details>
                    <summary>高级：查看原始证据 JSON</summary>
                    <pre className="dw-recovery-pre">{JSON.stringify({ contract: { id: narrativeReview.contractId, sceneId: narrativeReview.sceneId, title: narrativeReview.contract.title, objective: narrativeReview.contract.objective, frozenHash: narrativeReview.contractHash }, missingBeatIds: narrativeReview.missingBeatIds, conflictBeatIds: narrativeReview.conflictBeatIds, reasons: narrativeReview.reasons }, null, 2)}</pre>
                  </details>
                </div>
              </details>
              <details open>
                <summary>拟议叙事状态（可修正）</summary>
                <p className="dw-review-summary">{narrativeDeltaSummary(narrativeReview.proposedDelta)}</p>
                <details>
                  <summary>高级：编辑结构化状态（JSON）</summary>
                  <textarea className="dw-review-delta" value={reviewDeltaText} onChange={(event) => setReviewDeltaText(event.target.value)} rows={10} spellCheck={false} aria-label="修正后的结构化状态" placeholder="仅在需要精确修改状态时粘贴结构化状态 JSON" />
                </details>
              </details>
              <div className="dw-recovery-actions">
                {reviewDecisionAllowed(narrativeReview, 'accept_delta') && (
                  <button className="dw-decision primary" onClick={decideReviewWithDelta}><b>{REVIEW_DECISION_LABELS.accept_delta}</b><span>按当前候选与契约校验并提交状态</span></button>
                )}
                {reviewDecisionAllowed(narrativeReview, 'accept_prose_no_state') && (
                  <button className="dw-decision primary" onClick={() => void decideNarrativeReview('accept_prose_no_state', null, '用户确认该文学性要求已由正文表达，不产生结构化世界状态')
                    .then((ok) => showToast(ok ? '已接受正文，不写入结构化状态' : '复核决策失败，请重新打开证据', ok ? 'success' : 'error'))}>
                    <b>{REVIEW_DECISION_LABELS.accept_prose_no_state}</b><span>适用于氛围、心理和关系趋势等文学性要求</span>
                  </button>
                )}
                {reviewDecisionAllowed(narrativeReview, 'accept_unknown') && (
                  <button className="dw-decision" onClick={() => void decideNarrativeReview('accept_unknown').then((ok) => showToast(ok ? '已接受正文，未绑定角色保留为 unknown' : '复核决策失败，请重新打开证据', ok ? 'success' : 'error'))}><b>{REVIEW_DECISION_LABELS.accept_unknown}</b><span>不猜测缺失行动者或接收者，继续运行</span></button>
                )}
                {reviewDecisionAllowed(narrativeReview, 'reject_rewrite') && (
                  <button className="dw-decision" onClick={() => void decideNarrativeReview('reject_rewrite').then((ok) => showToast(ok ? '已撤回候选，正在重写' : '没有可用重写预算或决策失败', ok ? 'success' : 'error'))}><b>{REVIEW_DECISION_LABELS.reject_rewrite}</b><span>仅在预算可用时调用模型接口</span></button>
                )}
                {reviewDecisionAllowed(narrativeReview, 'abandon') && (
                  <button className="dw-decision danger" onClick={() => void decideNarrativeReview('abandon').then((ok) => showToast(ok ? '已放弃该运行' : '放弃失败', ok ? 'info' : 'error'))}><b>{REVIEW_DECISION_LABELS.abandon}</b><span>停止任务并保留决策审计</span></button>
                )}
              </div>
            </div>
          </div>
        </div>
      )}
      {inspectorRunId && <Suspense fallback={<div className="toast info" role="status">正在加载任务详情…</div>}><RunInspector /></Suspense>}
      <PermissionDialog />
      {toast && <div className={`toast ${toast.kind}`} key={toast.id}>{toast.text}</div>}
    </div>
  )
}
