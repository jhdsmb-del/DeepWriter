import { LONG_TARGET_PRESETS, normalizeLongTarget } from '../writingMode'
import { useEffect, useMemo, useRef, useState } from 'react'
import type { GrillMeState } from '../../../shared/grillMe'
import type { ContextPreviewV1, RollingSummaryV1 } from '../../../shared/contextV2'
import type { NarrativeSemanticReviewDecision, NarrativeStateDelta } from '../../../shared/types'
import type { LongformWorkflowSnapshot, LongformWorkflowStage, LongformWorkflowStageStatus } from '../../../shared/longformWorkflow'
import { isTerminalPhase, type RunPhase, type RunViewState } from '../../../shared/activity'
import { useStore, type NarrativeReviewPrompt } from '../store'
import NovelPanel from './NovelPanel'
import GrillMeWorkbench from './GrillMeWorkbench'
import ActivityCard from './activity/ActivityCard'
import Icon from './Icon'

type WorkflowStage = 'clarify' | 'recall' | 'outline' | 'write' | 'review'

function grillLaunchErrorMessage(error: unknown): string {
  const source = error !== null && typeof error === 'object' ? error as { code?: unknown; message?: unknown } : null
  const knownSyncFailure = source?.code === 'longform_payload_undefined' || typeof source?.message === 'string' && source.message.includes('[longform_payload_undefined]')
  return knownSyncFailure ? '长文工作流同步失败，当前进度已保留，请重试。' : '梳理暂未启动，当前进度已保留，请稍后重试。'
}

const WORKFLOW_STEPS: Array<{ id: WorkflowStage; label: string; hint: string }> = [
  { id: 'clarify', label: '需求梳理', hint: '确认目标、边界和素材' },
  { id: 'outline', label: '大纲确认', hint: '确认章节与推进点' },
  { id: 'recall', label: '素材回顾', hint: '检查当前回顾与证据' },
  { id: 'write', label: '分场写作', hint: '按场景持续生成' },
  { id: 'review', label: '审校交付', hint: '复核语义、修订与交付' }
]

const AUTHORITY_STAGE_LABEL: Record<LongformWorkflowStage, string> = {
  requirements: '需求梳理',
  outline: '大纲确认',
  scene_direction: '场景设计',
  recall: '素材回顾',
  draft: '分场写作',
  critique: '审校',
  revision: '修订',
  semantic_review: '语义复核',
  commit: '提交场景',
  reorientation: '重新定位',
  export: '导出交付'
}

const AUTHORITY_FOCUS: Record<LongformWorkflowStage, WorkflowStage> = {
  requirements: 'clarify',
  outline: 'outline',
  scene_direction: 'outline',
  recall: 'recall',
  draft: 'write',
  critique: 'review',
  revision: 'review',
  semantic_review: 'review',
  commit: 'review',
  reorientation: 'recall',
  export: 'review'
}

const AUTHORITY_STATUS_LABEL: Record<LongformWorkflowStageStatus, string> = {
  locked: '尚未开放',
  ready: '等待开始',
  running: '正在处理',
  waiting_user: '等待你的决定',
  blocked: '需要处理',
  completed: '已完成',
  needs_recovery: '需要恢复',
  cancelled: '已停止'
}

type WorkflowSyncState = 'loading' | 'ready' | 'unavailable' | 'waiting'

type LongformWorkflowBridge = {
  longformWorkflowCreate?: (input: { workflowId: string; sessionId: string; storyId?: string; projectId?: string; branchId?: string }) => Promise<unknown> | unknown
  longformWorkflowGet?: (workflowId: string) => Promise<unknown> | unknown
  longformWorkflowSubscribe?: (workflowId: string) => Promise<unknown> | unknown
  longformWorkflowUnsubscribe?: (workflowId: string) => void
  onLongformWorkflow?: (listener: (snapshot: unknown) => void) => (() => void) | void
}

function workflowIdForSession(sessionId: string): string {
  // The main process uses the session id as the durable workflow key when it
  // mirrors Grill state. Keeping this mapping explicit avoids a second,
  // renderer-only workflow projection that would never receive events.
  return sessionId
}

const PHASE_LABEL: Partial<Record<RunPhase, string>> = {
  queued: '正在排队',
  understanding: '正在理解任务',
  planning: '正在制定计划',
  reading: '正在读取素材',
  thinking: '正在组织内容',
  executing_tool: '正在执行工具',
  writing: '正在生成正文',
  validating: '正在检查结果',
  waiting_permission: '等待你的确认',
  paused: '已暂缓',
  stopping: '正在停止',
  cancel_requested: '正在取消',
  recovery_required: '需要恢复决定',
  completed: '已完成',
  failed: '遇到问题',
  cancelled: '已停止'
}

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

function formatChars(value: number | null | undefined): string {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? `${Math.trunc(value).toLocaleString('zh-CN')} 字` : '等待同步'
}

function formatDate(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return '时间等待同步'
  return new Intl.DateTimeFormat('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).format(new Date(value))
}

function reviewDecisionAllowed(review: NarrativeReviewPrompt, decision: NarrativeSemanticReviewDecision): boolean {
  return (review.effectiveAllowedDecisions ?? review.allowedDecisions)?.[decision]?.allowed === true
}

function reviewReasonText(code: string, message: string): string {
  return REVIEW_REASON_LABELS[code] ?? (message || '需要人工确认的语义证据')
}

function currentRun(runs: Record<string, RunViewState>, sessionId: string | null, runningId: string | null, activeRunId: string | null): RunViewState | null {
  if (!sessionId) return null
  const preferred = [runningId, activeRunId].filter((id): id is string => Boolean(id)).map((id) => runs[id]).find((run) => Boolean(run) && run.sessionId === sessionId && !isTerminalPhase(run.status))
  if (preferred) return preferred
  return Object.values(runs)
    .filter((run) => (!sessionId || run.sessionId === sessionId) && !isTerminalPhase(run.status))
    .sort((a, b) => b.startedAt - a.startedAt)[0] ?? null
}

function completedChars(run: RunViewState | null): number | null {
  if (!run) return null
  const values = Object.values(run.artifactsById)
    .map((artifact) => artifact.completedChars)
    .filter((value): value is number => typeof value === 'number' && Number.isFinite(value))
  return values.length > 0 ? Math.max(...values) : null
}

function isLongformWorkflowSnapshot(value: unknown): value is LongformWorkflowSnapshot {
  if (!value || typeof value !== 'object') return false
  const snapshot = value as Partial<LongformWorkflowSnapshot>
  return snapshot.kind === 'longform-workflow' && typeof snapshot.workflowId === 'string' && typeof snapshot.stage === 'string' && typeof snapshot.stageStatus === 'string'
}

function focusFromAuthority(snapshot: LongformWorkflowSnapshot | null): WorkflowStage | null {
  if (!snapshot) return null
  return AUTHORITY_FOCUS[snapshot.stage] ?? null
}

function statusLabel(grill: GrillMeState | null, run: RunViewState | null, review: NarrativeReviewPrompt | null, snapshot: LongformWorkflowSnapshot | null): string {
  if (snapshot) return `${AUTHORITY_STAGE_LABEL[snapshot.stage]} · ${AUTHORITY_STATUS_LABEL[snapshot.stageStatus]}`
  if (review) return '等待语义复核'
  if (run) return run.currentTitle?.trim() || PHASE_LABEL[run.status] || '运行状态同步中'
  if (!grill) return '等待开始'
  if (grill.status === 'interviewing' || grill.status === 'manual_completion') return '正在梳理需求'
  if (grill.status === 'assumption_review') return '等待默认值确认'
  if (grill.status === 'outline_ready') return '可以生成大纲'
  if (grill.status === 'awaiting_outline_confirmation') return '等待确认大纲'
  if (grill.status === 'confirmed') return '大纲已确认，等待开始写作'
  return '状态同步中'
}

function WorkflowHeader({ stage, grill, run, review, snapshot, syncState }: { stage: WorkflowStage | null; grill: GrillMeState | null; run: RunViewState | null; review: NarrativeReviewPrompt | null; snapshot: LongformWorkflowSnapshot | null; syncState: WorkflowSyncState }): React.ReactNode {
  const title = grill?.outline?.title?.trim() || grill?.originalTask.slice(0, 36).trim() || '长文写作'
  return (
    <header className="dw-longform-header">
      <div className="dw-longform-header-copy">
        <h1>{title}</h1>
        <p>{statusLabel(grill, run, review, snapshot)}</p>
      </div>
      {!snapshot && <span className={`dw-longform-sync-state ${syncState}`} role="status">{syncState === 'unavailable' ? '同步不可用' : '等待同步'}</span>}
    </header>
  )
}

function WorkflowStepper({ current, selected, onSelect }: { current: WorkflowStage | null; selected: WorkflowStage; onSelect: (stage: WorkflowStage) => void }): React.ReactNode {
  return (
    <nav className="dw-longform-stepper" aria-label="长文业务阶段">
      <ol>
        {WORKFLOW_STEPS.map((step, index) => {
          const active = current === step.id
          const chosen = selected === step.id
          return (
            <li key={step.id} className={`${active ? 'current ' : ''}${chosen ? 'selected' : ''}`}>
              <button type="button" aria-current={active ? 'step' : undefined} aria-label={`${step.label}：${step.hint}`} aria-pressed={chosen} title={step.hint} onClick={() => onSelect(step.id)}>
                <span className="dw-longform-step-index" aria-hidden="true">{index + 1}</span><span className="dw-longform-step-copy"><span className="dw-longform-step-label">{step.label}</span><span className="dw-longform-step-hint">{step.hint}</span></span>
              </button>
            </li>
          )
        })}
      </ol>
    </nav>
  )
}

function ContractStrip(): React.ReactNode {
  const targetChars = useStore((state) => state.targetChars)
  const setTargetChars = useStore((state) => state.setTargetChars)
  const settings = useStore((state) => state.settings)
  const story = useStore((state) => state.story)
  const [draft, setDraft] = useState(String(targetChars))
  useEffect(() => setDraft(String(targetChars)), [targetChars])
  const commit = (): void => {
    const value = normalizeLongTarget(Number(draft))
    setTargetChars(value)
    setDraft(String(value))
  }
  return (
    <details className="dw-longform-contract">
      <summary><span><Icon name="document" />篇幅与写作要求</span><span>{targetChars.toLocaleString('zh-CN')} 字</span></summary>
      <div className="dw-longform-contract-body">
        <label><span>目标篇幅</span><input type="number" min={2000} max={2000000} step={1} value={draft} data-testid="long-target-input" aria-label="长文目标篇幅" onChange={(event) => setDraft(event.currentTarget.value)} onBlur={commit} onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); commit() } }} /><em>字</em></label>
        <div className="dw-target-presets" aria-label="常用篇幅">
          {LONG_TARGET_PRESETS.map((value) => <button key={value} type="button" onClick={() => { setTargetChars(value); setDraft(String(value)) }}>{value.toLocaleString('zh-CN')} 字</button>)}
        </div>
        <dl>
          <div><dt>体裁</dt><dd>{story.enabled ? story.genre || '剧情约束已启用' : '按当前任务判断'}</dd></div>
          <div><dt>主题锁定</dt><dd>{settings?.themeLockMode === 'off' ? '关闭' : settings?.themeLockMode === 'guided' ? '引导' : '锁定'}</dd></div>
          <div><dt>表达自由</dt><dd>{settings?.expressionFreedom === 'controlled' ? '受控' : settings?.expressionFreedom === 'high' ? '高' : '平衡'}</dd></div>
          <div><dt>必须保留</dt><dd>{settings?.strongConstraintMustKeep?.trim() ? '已填写' : '等待同步'}</dd></div>
        </dl>
        <p className="dw-field-note">运行中修改只影响下一次写作。</p>
      </div>
    </details>
  )
}

function OutlineSummary({ grill }: { grill: GrillMeState | null }): React.ReactNode {
  const outline = grill?.approvedOutline ?? grill?.outline
  if (!outline) return <p className="dw-longform-wait" role="status" aria-live="polite">大纲尚未同步，请先完成需求梳理。</p>
  return (
    <div className="dw-outline-summary">
      <div className="dw-outline-summary-head"><div><b>{outline.title || '未命名大纲'}</b><p>{outline.premise || '主旨等待同步'}</p></div><span>{formatChars(outline.targetChars)}</span></div>
      <ol>
        {outline.sections.map((section) => <li key={section.id}><div><b>{section.title || '未命名章节'}</b><small>{section.purpose || '章节说明等待同步'}</small></div><span>{formatChars(section.targetChars)}</span></li>)}
      </ol>
    </div>
  )
}

function RecallSummary({ summary, preview, loading, onOpenEvidence }: { summary: RollingSummaryV1 | null; preview: ContextPreviewV1 | null; loading: boolean; onOpenEvidence: () => void }): React.ReactNode {
  const settings = useStore((state) => state.settings)
  const sessionId = useStore((state) => state.currentSessionId)
  const evidenceCount = preview ? preview.decisions.filter((item) => item.included).length : summary ? summary.items.length : null
  const hardConstraintCount = settings && sessionId
    ? [settings.strongConstraintMustKeep, settings.strongConstraintAvoid].flatMap((value) => (value ?? '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean)).length
    : null
  const evidenceText = evidenceCount === null ? '等待同步' : `${evidenceCount} 条依据`
  const constraintText = hardConstraintCount === null ? '等待同步' : `${hardConstraintCount} 条硬约束`
  return (
    <details className="dw-longform-recall dw-recall-disclosure">
      <summary><b>上下文详情</b><span role="status" aria-live="polite">{loading ? '本场带入正在同步 · 硬约束正在同步' : `本场带入 ${evidenceText} · ${constraintText}`}</span></summary>
      <div className="dw-longform-section-head"><button type="button" className="dw-longform-link" aria-haspopup="dialog" onClick={onOpenEvidence}>查看证据</button></div>
    </details>
  )
}

function sourceKindLabel(kind: string): string {
  const labels: Record<string, string> = {
    message: '消息',
    story_bible: '故事设定',
    artifact: '产物',
    run_evidence: '运行证据',
    pin: '固定内容',
    required: '必需内容',
    recent: '最近内容',
    duplicate: '重复内容',
    mode_excluded: '当前模式未纳入',
    below_score: '相关性不足',
    budget: '超出预算',
    superseded: '已被更新内容替代',
    unconfirmed: '尚未确认',
    source_invalid: '来源不可用'
  }
  return labels[kind] ?? (kind || '来源')
}

function EvidenceDrawer({ open, onClose, summary, preview, pins }: { open: boolean; onClose: () => void; summary: RollingSummaryV1 | null; preview: ContextPreviewV1 | null; pins: ReturnType<typeof useStore.getState>['contextPins'] }): React.ReactNode {
  const closeRef = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    if (!open) return undefined
    closeRef.current?.focus()
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') { event.preventDefault(); onClose() }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose, open])
  if (!open) return null
  const summarySources = (summary?.items ?? []).flatMap((item) => item.sources.map((source) => ({ label: item.text, source })))
  return (
    <div className="dw-longform-drawer-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose() }}>
      <aside className="dw-longform-evidence-drawer" role="dialog" aria-modal="true" aria-labelledby="dw-evidence-title">
        <header><div><h2 id="dw-evidence-title">回顾与证据</h2></div><button ref={closeRef} type="button" className="dw-icon-btn" aria-label="关闭回顾与证据" title="关闭回顾与证据" onClick={onClose}><Icon name="close" /></button></header>
        <div className="dw-longform-drawer-body">
          <section><h3>摘要来源</h3>{summarySources.length > 0 ? <ul className="dw-evidence-list">{summarySources.slice(0, 20).map(({ label, source }, index) => <li key={`${source.id}-${index}`}><b>{label}</b><span>{sourceKindLabel(source.kind)} · {source.id}</span><code>{source.hash ? `内容校验值 ${source.hash.slice(0, 16)}…` : '内容校验值等待同步'}</code></li>)}</ul> : <p className="dw-longform-wait">摘要来源等待同步。</p>}</section>
          <section><h3>本次选择与省略原因</h3>{preview?.decisions?.length ? <ul className="dw-evidence-list">{preview.decisions.slice(0, 20).map((item) => <li key={item.itemId}><b>{item.included ? '已纳入' : '未纳入'} · {item.source.displayLabel}</b><span>{sourceKindLabel(item.selectionReason)}</span><code>{item.source.contentHash ? `内容校验值 ${item.source.contentHash.slice(0, 16)}…` : '内容校验值等待同步'}</code></li>)}</ul> : <p className="dw-longform-wait">上下文选择等待同步。</p>}</section>
          <section><h3>固定内容</h3>{pins.length > 0 ? <ul className="dw-evidence-list">{pins.map((pin) => <li key={pin.pinId}><b>{pin.displayLabel}</b><span>{pin.kind === 'fact' ? '固定事实' : '固定消息'} · 修订 {pin.revision}</span><code>{pin.sourceHash ? `${pin.sourceHash.slice(0, 16)}…` : '哈希等待同步'}</code></li>)}</ul> : <p className="dw-longform-wait">当前没有固定内容。</p>}</section>
        </div>
      </aside>
    </div>
  )
}

function CurrentRunSummary({ run, onOpenActivity }: { run: RunViewState; onOpenActivity: () => void }): React.ReactNode {
  const chars = completedChars(run)
  return (
    <div className="dw-current-run" role="status" aria-live="polite">
      <div className="dw-current-run-head"><span className={`dw-current-run-dot ${run.status}`} aria-hidden="true" /><div><b>{run.currentTitle?.trim() || PHASE_LABEL[run.status] || '任务状态同步中'}</b><span>{run.currentDetail?.trim() || '详细进度等待同步'}</span></div><button type="button" className="dw-longform-link" onClick={onOpenActivity}>查看活动</button></div>
      <p className="dw-current-run-progress">已生成 {formatChars(chars)}</p>
    </div>
  )
}

function Critique({ review }: { review: NarrativeReviewPrompt | null }): React.ReactNode {
  const required = [
    { label: '场景契约', value: review ? (review.contract.title || review.contract.objective ? '已载入' : '等待同步') : '等待同步' },
    { label: '语义状态', value: review ? (review.proposedDelta ? '待人工复核' : '无拟写入状态') : '等待同步' },
    { label: '来源证据', value: review ? (review.candidate.acceptedSegments.length > 0 ? '已绑定' : '等待同步') : '等待同步' }
  ]
  const optional = ['风格一致性', '节奏与段落', '重复表达']
  return (
    <section className="dw-longform-critique" aria-labelledby="dw-critique-title">
      <div className="dw-longform-section-head"><div><span className="dw-longform-eyebrow">交付前检查</span><h2 id="dw-critique-title">审校清单</h2></div><span className="dw-longform-muted-label">必查 / 可选</span></div>
      <div className="dw-critique-columns"><div><h3>必查</h3><ul>{required.map((item) => <li key={item.label}><span>{item.label}</span><small>{item.value}</small></li>)}</ul></div><div><h3>可选</h3><ul>{optional.map((label) => <li key={label}><span>{label}</span><small>等待同步</small></li>)}</ul></div></div>
    </section>
  )
}

function RevisionPanel({ review }: { review: NarrativeReviewPrompt | null }): React.ReactNode {
  const candidate = review?.candidate
  return (
    <section className="dw-longform-revision" aria-labelledby="dw-revision-title">
      <div className="dw-longform-section-head"><div><span className="dw-longform-eyebrow">修订</span><h2 id="dw-revision-title">候选修订</h2></div><span className="dw-longform-muted-label">内容校验</span></div>
      {!candidate ? <p className="dw-longform-wait">当前没有候选修订；内容等待同步。</p> : <div className="dw-revision-card"><dl><div><dt>候选段落</dt><dd>{candidate.segmentId || '等待同步'}</dd></div><div><dt>候选字数</dt><dd>{formatChars(candidate.charCount)}</dd></div><div><dt>已接受前缀</dt><dd>{formatChars(review?.acceptedCharsBefore)}</dd></div><div><dt>复核版本</dt><dd>{review?.revision ?? '等待同步'}</dd></div></dl>{candidate.content ? <pre aria-label="候选修订正文">{candidate.content}</pre> : <p className="dw-longform-wait">候选正文不可读；只保留内容校验值与段落身份。</p>}<code>{candidate.contentHash ? `内容校验值 ${candidate.contentHash.slice(0, 20)}…` : '内容校验值等待同步'}</code></div>}
    </section>
  )
}

function ReviewDecisionPanel({ review, onDefer, onRefresh }: { review: NarrativeReviewPrompt; onDefer: () => void; onRefresh: () => void }): React.ReactNode {
  const decide = useStore((state) => state.decideNarrativeReview)
  const showToast = useStore((state) => state.showToast)
  const [deltaText, setDeltaText] = useState(review.proposedDelta ? JSON.stringify(review.proposedDelta, null, 2) : '')
  const [busy, setBusy] = useState(false)
  useEffect(() => setDeltaText(review.proposedDelta ? JSON.stringify(review.proposedDelta, null, 2) : ''), [review.packetHash, review.proposedDelta])
  const runDecision = async (decision: NarrativeSemanticReviewDecision, delta?: NarrativeStateDelta | null): Promise<void> => {
    setBusy(true)
    try {
      const ok = await decide(decision, delta)
      showToast(ok ? `${REVIEW_DECISION_LABELS[decision]}：已记录` : '复核决策失败，请重新打开证据', ok ? 'success' : 'error')
      if (!ok) onRefresh()
    } finally { setBusy(false) }
  }
  const acceptDelta = (): void => {
    let delta: NarrativeStateDelta
    try { delta = JSON.parse(deltaText) as NarrativeStateDelta } catch { showToast('请先提供合法的结构化状态 JSON', 'error'); return }
    void runDecision('accept_delta', delta)
  }
  const blockingReasons = review.reasons.filter((reason) => reason.severity === 'blocking')
  return (
    <section className="dw-longform-semantic-review" role="alert" aria-labelledby="dw-semantic-review-title">
      <div className="dw-longform-section-head"><div><span className="dw-longform-eyebrow">需要你的决定</span><h2 id="dw-semantic-review-title">语义复核</h2></div><button type="button" className="dw-longform-link" onClick={onDefer}>稍后处理</button></div>
      <p className="dw-semantic-lead">候选正文尚未接纳。检查场景契约、缺失或冲突要求与拟议状态后，流程才会继续。</p>
      <div className="dw-semantic-summary"><span>场景</span><b>{review.contract.title || review.sceneId || '等待同步'}</b><span>候选</span><b>待你确认</b></div>
      <div className="dw-semantic-grid"><div><h3>缺失要求</h3><p>{review.missingBeatIds.length > 0 ? '有待补齐的要求' : '没有明确缺口'}</p></div><div><h3>冲突要求</h3><p>{review.conflictBeatIds.length > 0 ? '检测到冲突要求' : '没有检测到冲突'}</p></div></div>
      {blockingReasons.length > 0 && <ul className="dw-semantic-reasons">{blockingReasons.map((reason, index) => <li key={`${reason.code}-${index}`}>{reviewReasonText(reason.code, reason.message)}</li>)}</ul>}
      <details className="dw-semantic-evidence"><summary>查看候选与契约证据</summary><div><p><b>本轮目标：</b>{review.contract.objective || '等待同步'}</p><p><b>内容校验值：</b><code>{review.candidate.contentHash || '等待同步'}</code></p><RevisionPanel review={review} /></div></details>
      {review.proposedDelta && reviewDecisionAllowed(review, 'accept_delta') && <label className="dw-semantic-delta"><span>拟议结构化状态（可修正）</span><textarea value={deltaText} onChange={(event) => setDeltaText(event.currentTarget.value)} rows={6} spellCheck={false} aria-label="修正后的结构化状态" /></label>}
      <div className="dw-semantic-actions">
        {reviewDecisionAllowed(review, 'accept_delta') && <button type="button" className="btn primary" disabled={busy} onClick={acceptDelta}>{REVIEW_DECISION_LABELS.accept_delta}</button>}
        {reviewDecisionAllowed(review, 'accept_prose_no_state') && <button type="button" className="btn" disabled={busy} onClick={() => void runDecision('accept_prose_no_state', null)}>{REVIEW_DECISION_LABELS.accept_prose_no_state}</button>}
        {reviewDecisionAllowed(review, 'accept_unknown') && <button type="button" className="btn" disabled={busy} onClick={() => void runDecision('accept_unknown')}>{REVIEW_DECISION_LABELS.accept_unknown}</button>}
        {reviewDecisionAllowed(review, 'reject_rewrite') && <button type="button" className="btn" disabled={busy} onClick={() => void runDecision('reject_rewrite')}>{REVIEW_DECISION_LABELS.reject_rewrite}</button>}
        {reviewDecisionAllowed(review, 'abandon') && <button type="button" className="btn danger" disabled={busy} onClick={() => void runDecision('abandon')}>{REVIEW_DECISION_LABELS.abandon}</button>}
      </div>
    </section>
  )
}

function RecoveryBanner({ onOpenReview }: { onOpenReview: (runId: string) => void }): React.ReactNode {
  const currentSessionId = useStore((state) => state.currentSessionId)
  const recoverableRuns = useStore((state) => state.recoverableRuns)
  const narrativeReview = useStore((state) => state.narrativeReview)
  const resumeRun = useStore((state) => state.resumeRun)
  const rebaseStoryRun = useStore((state) => state.rebaseStoryRun)
  const abandonRun = useStore((state) => state.abandonRun)
  const openRunInspector = useStore((state) => state.openRunInspector)
  const showToast = useStore((state) => state.showToast)
  const list = recoverableRuns.filter((run) => !currentSessionId || run.sessionId === currentSessionId)
  if (list.length === 0) return null
  return (
    <section className="dw-longform-recovery" aria-live="polite" aria-label="待处理的长文任务">
      <div className="dw-longform-recovery-head"><span className="dw-status-dot" /><div><b>{list.length} 个任务需要处理</b><small>进度已保留；未决定前不会静默继续。</small></div></div>
      <ul>{list.slice(0, 4).map((run) => {
        const review = narrativeReview?.runId === run.runId
        return <li key={run.runId}><div><b>{review ? '等待语义复核' : run.errorMessage || PHASE_LABEL[run.phase as RunPhase] || '恢复状态同步中'}</b><small>{formatDate(run.updatedAt)} · {run.runId.slice(0, 8)}</small></div><div className="dw-longform-recovery-actions">{review ? <button type="button" className="dw-text-btn" onClick={() => onOpenReview(run.runId)}>打开复核</button> : run.errorCode === 'story_ledger_epoch_invalidated' ? <button type="button" className="dw-text-btn" onClick={() => void rebaseStoryRun(run.runId).then((ok) => showToast(ok ? '已准备安全故事线分支' : '无法准备安全故事线分支', ok ? 'success' : 'error'))}>新建安全分支</button> : <button type="button" className="dw-text-btn" onClick={() => { if (run.errorCode === 'run_provider_call_cap') openRunInspector(run.runId, 'activity'); else void resumeRun(run.runId).then((ok) => showToast(ok ? '已继续处理该任务' : '无法继续，请查看任务详情', ok ? 'success' : 'error')) }}>继续</button>}<button type="button" className="dw-text-btn" onClick={() => openRunInspector(run.runId)}>查看</button><button type="button" className="dw-text-btn danger" onClick={() => void abandonRun(run.runId).then((ok) => showToast(ok ? '已停止该任务' : '停止失败', ok ? 'info' : 'error'))}>停止</button></div></li>
      })}</ul>
    </section>
  )
}

function ActivityDrawer({ run, open, onToggle }: { run: RunViewState | null; open: boolean; onToggle: (open: boolean) => void }): React.ReactNode {
  const scrollRef = useRef<HTMLDivElement>(null)
  const shouldStick = useRef(true)
  useEffect(() => {
    const element = scrollRef.current
    if (!element || !shouldStick.current) return
    element.scrollTop = element.scrollHeight
  }, [run?.lastSeq, run?.currentDetail, open])
  if (!run && !open) return <button type="button" className="dw-longform-activity-trigger" aria-expanded="false" onClick={() => onToggle(true)}><Icon name="tasks" />活动</button>
  return (
    <aside className={`dw-longform-activity${open ? ' open' : ''}`} aria-label="长文活动抽屉">
      <header><h2>活动</h2><button type="button" className="dw-icon-btn" aria-label={open ? '关闭活动抽屉' : '打开活动抽屉'} title={open ? '关闭活动抽屉' : '打开活动抽屉'} aria-expanded={open} onClick={() => onToggle(!open)}><Icon name={open ? 'close' : 'open'} /></button></header>
      {open && <div ref={scrollRef} className="dw-longform-activity-body" onScroll={(event) => { const element = event.currentTarget; shouldStick.current = element.scrollHeight - element.scrollTop - element.clientHeight < 48 }}>{run ? <ActivityCard runId={run.runId} /> : <p className="dw-longform-wait">当前没有活动任务。</p>}</div>}
    </aside>
  )
}

function CurrentWorkPanel({ stage, currentStage, grill, setGrill, grillError, setGrillError, run, review, pendingReview, onOpenActivity, onOpenReview, onDeferReview, onRefresh }: { stage: WorkflowStage; currentStage: WorkflowStage | null; grill: GrillMeState | null; setGrill: (state: GrillMeState | null) => void; grillError: string | null; setGrillError: (value: string | null) => void; run: RunViewState | null; review: NarrativeReviewPrompt | null; pendingReview: NarrativeReviewPrompt | null; onOpenActivity: () => void; onOpenReview: () => void; onDeferReview: () => void; onRefresh: () => void }): React.ReactNode {
  const send = useStore((state) => state.send)
  const showToast = useStore((state) => state.showToast)
  const currentSessionId = useStore((state) => state.currentSessionId)
  const titleRef = useRef<HTMLHeadingElement>(null)
  useEffect(() => { titleRef.current?.focus() }, [currentStage])
  const isCurrent = currentStage === null ? stage === 'clarify' : stage === currentStage
  const startErrorText = grillError ? /^(长文工作流同步失败|梳理暂未启动)/u.test(grillError) ? grillError : `正文启动失败：${grillError}。大纲仍保留，可以修正设置后重试。` : null
  const onConfirmed = async (state: GrillMeState): Promise<void> => {
    const result = await send(state.originalTask, state.attachments ?? [], state)
    if (result.ok) { setGrillError(null); setGrill(null) } else { const text = result.error?.trim() || result.reason || '未返回具体原因'; setGrillError(text); showToast(`正文启动失败：${text}`, 'error') }
  }
  const onCancel = (): void => {
    if (grill) void (window as any).ds?.grillCancel?.(grill.sessionId)
    setGrillError(null)
    setGrill(null)
  }
  return (
    <section className="dw-longform-current" aria-labelledby="dw-current-work-title" aria-live="polite">
      <div className="dw-longform-section-head"><h2 id="dw-current-work-title" ref={titleRef} tabIndex={-1}>{stage === 'clarify' && !grill && !run ? '先写下你的构想' : `${isCurrent ? '' : '查看：'}${WORKFLOW_STEPS.find((item) => item.id === stage)?.label}`}</h2></div>
      {!isCurrent ? <div className="dw-longform-stage-peek">{stage === 'outline' && <OutlineSummary grill={grill} />}{stage === 'recall' && <p className="dw-longform-wait">从下方“上下文详情”查看回顾与证据。</p>}{stage === 'write' && (run ? <CurrentRunSummary run={run} onOpenActivity={onOpenActivity} /> : <p className="dw-longform-wait">正文尚未开始；确认大纲后可从这里启动。</p>)}{stage === 'review' && (review ? <ReviewDecisionPanel review={review} onDefer={onDeferReview} onRefresh={onRefresh} /> : pendingReview ? <button type="button" className="btn primary" onClick={onOpenReview}>打开复核</button> : <Critique review={review} />)}</div> : stage === 'clarify' ? (
        grill ? <GrillMeWorkbench state={grill} startError={startErrorText} onChange={(next) => { if (next.status !== 'confirmed') setGrillError(null); setGrill(next) }} onCancel={onCancel} onConfirmed={onConfirmed} /> : <NovelPanel />
      ) : stage === 'recall' ? (
        run ? <CurrentRunSummary run={run} onOpenActivity={onOpenActivity} /> : <p className="dw-longform-wait">回顾阶段暂无进行中的任务，证据抽屉会保留已确认的回顾摘要。</p>
      ) : stage === 'outline' ? (
        grill && (grill.status === 'outline_ready' || grill.status === 'awaiting_outline_confirmation' || (grill.status === 'confirmed' && !run)) ? <GrillMeWorkbench state={grill} startError={startErrorText} onChange={(next) => { if (next.status !== 'confirmed') setGrillError(null); setGrill(next) }} onCancel={onCancel} onConfirmed={onConfirmed} /> : <OutlineSummary grill={grill} />
      ) : stage === 'write' ? (
        run ? <CurrentRunSummary run={run} onOpenActivity={onOpenActivity} /> : grill ? <GrillMeWorkbench state={grill} startError={startErrorText} onChange={(next) => setGrill(next)} onCancel={onCancel} onConfirmed={onConfirmed} /> : <p className="dw-longform-wait">正文工作面等待同步。</p>
      ) : review ? (
        <ReviewDecisionPanel review={review} onDefer={onDeferReview} onRefresh={onRefresh} />
      ) : pendingReview ? (
        <div className="dw-longform-pending-review"><b>有一项复核需要你的决定</b><p>候选正文已保留；打开后可查看契约、证据和可用操作。</p><button type="button" className="btn primary" onClick={onOpenReview}>打开复核</button></div>
      ) : (
        <Critique review={review} />
      )}
      {currentSessionId && grill && grill.sessionId !== currentSessionId ? <p className="dw-longform-wait">梳理状态属于另一个会话，正在同步当前会话。</p> : null}
    </section>
  )
}

export default function LongformWorkflowShell(): React.ReactNode {
  const currentSessionId = useStore((state) => state.currentSessionId)
  const runs = useStore((state) => state.runs)
  const runningId = useStore((state) => state.runningId)
  const activeRunId = useStore((state) => state.activeRunId)
  const narrativeReview = useStore((state) => state.narrativeReview)
  const contextPreview = useStore((state) => state.contextPreview)
  const contextPins = useStore((state) => state.contextPins)
  const loadRecoverable = useStore((state) => state.loadRecoverable)
  const [grill, setGrill] = useState<GrillMeState | null>(null)
  const [grillError, setGrillError] = useState<string | null>(null)
  const [summary, setSummary] = useState<RollingSummaryV1 | null>(null)
  const [summaryLoading, setSummaryLoading] = useState(false)
  const [evidenceOpen, setEvidenceOpen] = useState(false)
  const [reviewOpen, setReviewOpen] = useState(Boolean(narrativeReview))
  const [activityOpen, setActivityOpen] = useState(false)
  const [selectedStage, setSelectedStage] = useState<WorkflowStage>('clarify')
  const [workflowSnapshot, setWorkflowSnapshot] = useState<LongformWorkflowSnapshot | null>(null)
  const [workflowSyncState, setWorkflowSyncState] = useState<WorkflowSyncState>('loading')
  const grillLaunchRequest = useStore((state) => state.grillLaunchRequest)
  const clearGrillLaunchRequest = useStore((state) => state.clearGrillLaunchRequest)
  const restoreGrillSession = useStore((state) => state.restoreGrillSession)
  const active = useMemo(() => currentRun(runs, currentSessionId, runningId, activeRunId), [activeRunId, currentSessionId, runningId, runs])
  const currentStage = focusFromAuthority(workflowSnapshot)
  useEffect(() => { if (currentStage) setSelectedStage(currentStage) }, [currentStage])
  useEffect(() => { if (narrativeReview) setReviewOpen(true) }, [narrativeReview])
  useEffect(() => {
    if (!currentSessionId) { setWorkflowSnapshot(null); setWorkflowSyncState('unavailable'); return undefined }
    let alive = true
    const bridge = (window as any).ds as LongformWorkflowBridge | undefined
    const workflowId = workflowIdForSession(currentSessionId)
    const getter = bridge?.longformWorkflowGet
    if (!getter) { setWorkflowSnapshot(null); setWorkflowSyncState('unavailable'); return undefined }
    setWorkflowSnapshot(null)
    setWorkflowSyncState('loading')
    const apply = (raw: unknown): void => {
      if (!alive) return
      setWorkflowSnapshot(isLongformWorkflowSnapshot(raw) ? raw : null)
      setWorkflowSyncState(isLongformWorkflowSnapshot(raw) ? 'ready' : 'waiting')
    }
    const read = async (): Promise<void> => {
      try {
        // Creation is idempotent for the session key. If another path already
        // created the durable record, still read it rather than leaving the UI
        // in a permanent waiting state on a create race/conflict.
        try { await bridge?.longformWorkflowCreate?.({ workflowId, sessionId: currentSessionId, storyId: `story_${currentSessionId}`, projectId: `project_${currentSessionId}`, branchId: 'main' }) } catch { /* read remains authoritative */ }
        apply(await getter(workflowId))
      } catch { if (alive) { setWorkflowSnapshot(null); setWorkflowSyncState('waiting') } }
    }
    void read()
    const timer = window.setInterval(() => { void read() }, 3000)
    const unsubscribe = bridge?.onLongformWorkflow?.((next) => {
      if (isLongformWorkflowSnapshot(next) && next.workflowId === workflowId) apply(next)
    })
    if (bridge?.longformWorkflowSubscribe) void Promise.resolve(bridge.longformWorkflowSubscribe(workflowId)).then(apply).catch(() => undefined)
    return () => { alive = false; window.clearInterval(timer); if (typeof unsubscribe === 'function') unsubscribe(); bridge?.longformWorkflowUnsubscribe?.(workflowId) }
  }, [currentSessionId])
  useEffect(() => {
    if (!currentSessionId) { setSummary(null); return undefined }
    let alive = true
    setSummaryLoading(true)
    const ds = (window as any).ds
    void ds?.contextGetSummary?.(currentSessionId).then((next: RollingSummaryV1 | null) => { if (alive) setSummary(next ?? null) }).catch(() => { if (alive) setSummary(null) }).finally(() => { if (alive) setSummaryLoading(false) })
    return () => { alive = false }
  }, [currentSessionId])
  useEffect(() => {
    if (grill && grill.sessionId !== currentSessionId) { setGrill(null); setGrillError(null); return undefined }
    if (grill || !currentSessionId) return undefined
    let alive = true
    const ds = (window as any).ds
    void ds?.grillLatestUnconsumed?.(currentSessionId).then(async (next: GrillMeState | null) => { if (!alive || !next || next.sessionId !== currentSessionId || next.status === 'cancelled') return; await restoreGrillSession(next); if (alive) setGrill(next) }).catch(() => undefined)
    return () => { alive = false }
  }, [currentSessionId, grill, restoreGrillSession])
  useEffect(() => {
    const request = grillLaunchRequest
    if (!request || request.sessionId !== currentSessionId) return undefined
    let alive = true
    const ds = (window as any).ds
    void ds?.grillStart?.({ sessionId: request.sessionId, originalTask: request.task, targetChars: request.targetChars, genre: request.genre, kind: request.kind, attachments: request.attachments }).then((next: GrillMeState | null) => { if (!alive || !next || useStore.getState().currentSessionId !== request.sessionId) return; setGrill(next); setGrillError(null); clearGrillLaunchRequest(request.requestId) }).catch((error: unknown) => { if (alive) { setGrillError(grillLaunchErrorMessage(error)); clearGrillLaunchRequest(request.requestId) } })
    return () => { alive = false }
  }, [clearGrillLaunchRequest, grillLaunchRequest, currentSessionId])
  useEffect(() => { if (active) setActivityOpen(true) }, [active?.runId])
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape' || event.defaultPrevented) return
      if (evidenceOpen) { event.preventDefault(); setEvidenceOpen(false); return }
      if (reviewOpen && narrativeReview) { event.preventDefault(); setReviewOpen(false); return }
      if (!active || isTerminalPhase(active.status) || active.status === 'paused') return
      const pause = (window as any).ds?.activityPause
      if (typeof pause !== 'function') return
      event.preventDefault()
      void pause(active.runId).then((result: { ok?: boolean; error?: string }) => useStore.getState().showToast(result?.ok ? '已请求暂缓，等待活动状态同步' : `暂缓未完成：${result?.error || '等待同步'}`, result?.ok ? 'info' : 'error')).catch(() => useStore.getState().showToast('暂缓未完成：等待同步', 'error'))
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [active, evidenceOpen, narrativeReview, reviewOpen])
  const openReview = (runId: string): void => { if (narrativeReview?.runId === runId) setReviewOpen(true); else useStore.getState().openRunInspector(runId) }
  return (
    <div className="longform-workflow-shell" data-testid="longform-workflow-shell">
       <WorkflowHeader stage={currentStage} grill={grill} run={active} review={narrativeReview} snapshot={workflowSnapshot} syncState={workflowSyncState} />
      <WorkflowStepper current={currentStage} selected={selectedStage} onSelect={setSelectedStage} />
      <RecoveryBanner onOpenReview={openReview} />
       <ContractStrip />
      <div className="dw-longform-main-grid">
        <main className="dw-longform-main-column">
          <CurrentWorkPanel stage={selectedStage} currentStage={currentStage} grill={grill} setGrill={setGrill} grillError={grillError} setGrillError={setGrillError} run={active} review={reviewOpen ? narrativeReview : null} pendingReview={narrativeReview} onOpenReview={() => setReviewOpen(true)} onDeferReview={() => setReviewOpen(false)} onRefresh={() => void loadRecoverable()} onOpenActivity={() => setActivityOpen(true)} />
          <RecallSummary summary={summary} preview={contextPreview} loading={summaryLoading} onOpenEvidence={() => setEvidenceOpen(true)} />
        </main>
        <ActivityDrawer run={active} open={activityOpen} onToggle={setActivityOpen} />
      </div>
      <EvidenceDrawer open={evidenceOpen} onClose={() => setEvidenceOpen(false)} summary={summary} preview={contextPreview} pins={contextPins} />
    </div>
  )
}
