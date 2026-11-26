import { useEffect, useState } from 'react'
import type { GrillMeOutline, GrillMeState, GrillMeAttachmentStatus } from '../../../shared/grillMe'
import Icon from './Icon'

interface Props {
  state: GrillMeState
  onChange: (state: GrillMeState) => void
  onConfirmed: (state: GrillMeState) => void | Promise<void>
  onCancel: () => void
  startError?: string | null
}

type GrillDecision = 'answer' | 'decide' | 'not_applicable'
interface GrillOption { label: string; value: string; decision: GrillDecision }

function optionList(question: GrillMeState['currentQuestion']): GrillOption[] {
  const raw = (question as unknown as { options?: unknown } | null)?.options
  if (!Array.isArray(raw)) return []
  return raw.flatMap((item): GrillOption[] => {
    if (typeof item === 'string' && item.trim()) return [{ label: item.trim(), value: item.trim(), decision: 'answer' }]
    if (!item || typeof item !== 'object') return []
    const source = item as { label?: unknown; text?: unknown; value?: unknown; decision?: unknown }
    const label = typeof source.label === 'string' ? source.label.trim() : typeof source.text === 'string' ? source.text.trim() : ''
    if (!label) return []
    const value = typeof source.value === 'string' ? source.value : label
    const decision = source.decision === 'decide' || source.decision === 'not_applicable' ? source.decision : 'answer'
    return [{ label, value, decision }]
  }).slice(0, 4)
}

function sourceLabel(source: GrillMeState['slots'][number]['source']): string {
  if (source === 'task') return '原始需求'
  if (source === 'assumption') return '默认值'
  if (source === 'not_applicable') return '不适用'
  return '你的回答'
}

export default function GrillMeWorkbench({ state, onChange, onConfirmed, onCancel, startError }: Props): React.ReactNode {
  const [answer, setAnswer] = useState('')
  const [busy, setBusy] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)
  const [materials, setMaterials] = useState<GrillMeAttachmentStatus[]>([])
  const [supplementFocused, setSupplementFocused] = useState(false)
  const [editing, setEditing] = useState<GrillMeOutline | null>(state.outline)
  const [applicability, setApplicability] = useState<{ scenes: Array<{ sceneId: string; title: string; beats: string[] }> } | null>(null)
  const [applicabilityUnavailable, setApplicabilityUnavailable] = useState(false)
  // The workflow can remount this workbench before an in-flight planning
  // call returns. Polling supplies its durable result afterwards. Only a new
  // authority revision resets the draft; same-revision polls preserve edits.
  useEffect(() => { setEditing(state.outline) }, [state.stateId, state.outlineRevision, state.outlineHash])
  const ds = (window as any).ds
  const materialIdentity = state.attachments?.map(item => item.fileRefId).join('|') ?? ''
  useEffect(() => {
    let alive = true
    setMaterials([])
    if (!state.attachments?.length) return
    void ds.grillAttachmentsStatus(state.sessionId).then((items: GrillMeAttachmentStatus[]) => { if (alive) setMaterials(items) }).catch(() => { if (alive) setMaterials(state.attachments!.map(item => ({ fileRefId: item.fileRefId, name: item.name, available: false }))) })
    return () => { alive = false }
  }, [ds, state.sessionId, state.stateId, materialIdentity])
  useEffect(() => {
    let active = true
    setApplicability(null); setApplicabilityUnavailable(false)
    if (state.status !== 'awaiting_outline_confirmation' || !editing) return
    const timer = setTimeout(() => {
      void ds.grillOutlineApplicability(state.sessionId, editing).then((result: { scenes: Array<{ sceneId: string; title: string; beats: string[] }> }) => { if (active) setApplicability(result) }).catch(() => { if (active) setApplicabilityUnavailable(true) })
    }, 150)
    return () => { active = false; clearTimeout(timer) }
  }, [ds, state.sessionId, state.status, editing])
  const current = state.currentQuestion
  const options = optionList(current)
  const confirmedSlots = state.slots.filter((slot) => slot.answer.trim())
  const planning = state.planning
  const interview = state.interview
  const modelBusy = interview.status === 'running' || planning.status === 'running'
  const outlineTotal = editing?.sections.reduce((sum, section) => sum + Math.max(0, Math.trunc(section.targetChars)), 0) ?? 0
  const isFinalQuestion = current !== null && ((current as unknown as { kind?: unknown }).kind === 'final_check' || /还有什么必须补充/.test(current.text))
  const questionText = isFinalQuestion ? '还有什么必须补充的吗？' : current?.text ?? ''
  const visibleOptions = (options.length > 0 ? options : isFinalQuestion ? [
    { label: '没有了，生成大纲', value: '没有了', decision: 'answer' as const },
    { label: '还有补充', value: '还有补充', decision: 'answer' as const }
  ] : [
    { label: '交给你决定', value: '', decision: 'decide' as const },
    { label: '这项不适用', value: '', decision: 'not_applicable' as const }
  ]).map((option) => isFinalQuestion && /^(没有了?|没了)$/u.test(option.label.trim()) ? { ...option, label: '没有了，生成大纲' } : option)
  const interviewStage = state.status === 'interviewing' || state.status === 'manual_completion'
  const planningStage = state.status === 'outline_ready' || state.status === 'awaiting_outline_confirmation'
  const phaseLabel = interviewStage ? '正在梳理' : state.status === 'outline_ready' ? '准备大纲' : state.status === 'awaiting_outline_confirmation' ? '确认大纲' : state.status === 'confirmed' ? '可以开写' : '正在梳理'
  const statusText = interviewStage && interview.status === 'running'
    ? '正在梳理…'
    : planningStage && (planning.status === 'failed' || planning.status === 'auth_required')
      ? `大纲暂未生成：${planning.error ?? '请检查规划模型后重试'}`
      : interviewStage && (interview.status === 'failed' || interview.status === 'auth_required')
        ? `采访模型暂不可用，问题已保留：${interview.error ?? '可以继续回答'}`
      : ''

  // grill:start/grill:answer return immediately so the workbench never waits
  // behind a provider's first byte. Pull the durable state while that call is
  // in flight; activity events are for the workflow rail, not the interview
  // contract itself.
  useEffect(() => {
    // Keep a light durable-state poll for every non-terminal Grill stage. The
    // workflow rail can stop the run independently of this component, so the
    // workbench must observe that cancellation and leave the writing surface.
    if (state.status === 'confirmed' || state.status === 'cancelled') return undefined
    let live = true
    const sync = (): void => {
      void ds?.grillGet?.(state.sessionId).then((next: GrillMeState | null) => {
        if (!live || !next) return
        if (next.status !== state.status || next.updatedAt > state.updatedAt || (modelBusy && next.interview.status !== state.interview.status)) onChange(next)
      }).catch(() => undefined)
    }
    sync()
    const timer = window.setInterval(sync, 650)
    return () => { live = false; window.clearInterval(timer) }
  }, [ds, modelBusy, onChange, state.interview.status, state.sessionId, state.status, state.updatedAt])
  const call = async <T,>(fn: () => Promise<T>, after?: (value: T) => void | Promise<void>): Promise<void> => {
    setBusy(true)
    setActionError(null)
    try {
      const result = await fn()
      await after?.(result)
    } catch (error) {
      setActionError(error instanceof Error && error.message.trim() ? error.message : '请检查设置后重试')
    } finally { setBusy(false) }
  }
  const update = (next: GrillMeState): void => { setActionError(null); onChange(next); setEditing(next.outline) }
  const answerQuestion = (value: string, decision: GrillDecision): void => {
    if (!current) return
    setSupplementFocused(false)
    void call(() => ds.grillAnswer({ sessionId: state.sessionId, questionId: current.id, value, decision }), (next) => { setAnswer(''); update(next as GrillMeState) })
  }
  const focusSupplement = (): void => {
    setSupplementFocused(true)
    document.querySelector<HTMLTextAreaElement>('[aria-label="自由填写回答"]')?.focus()
  }
  const chooseOption = (option: GrillOption): void => {
    if (isFinalQuestion && /还有补充/.test(option.label)) {
      focusSupplement()
      return
    }
    answerQuestion(option.value, option.decision)
  }
  const changeSection = (sectionId: string, patch: Partial<GrillMeOutline['sections'][number]>): void => {
    if (!editing) return
    setEditing({ ...editing, sections: editing.sections.map((section) => section.id === sectionId ? { ...section, ...patch } : section) })
  }

  return (
    <section className="grill-me-workbench" data-phase={state.status} aria-label="长文写作梳理" aria-busy={busy || modelBusy}>
      <header className="grill-me-compact-head">
        <span className="grill-me-progress"><b>{phaseLabel}</b><small>{confirmedSlots.length > 0 ? `${confirmedSlots.length} 项已确认 · ` : ''}目标 {state.targetChars.toLocaleString()} 字</small></span>
        <button className="grill-me-exit" type="button" title="停止当前梳理并保留已确认内容" onClick={onCancel}><Icon name="close" />退出梳理</button>
      </header>

      {state.attachments && state.attachments.length > 0 && <details className="grill-me-materials" open={materials.some(item => !item.available)}>
        <summary>已选素材 · {state.attachments.length} 份{materials.some(item => !item.available) ? ' · 需重新选择' : ''}</summary>
        <ul>{state.attachments.map(item => {
          const status = materials.find(view => view.fileRefId === item.fileRefId)
          return <li key={item.fileRefId}>
            <span><Icon name="document" />{item.name}</span>
            <button className="btn" type="button" disabled={busy || modelBusy || !status} aria-label={`重新选择素材：${item.name}`} onClick={() => void call(() => ds.grillAttachmentReselect(state.sessionId, item.fileRefId), next => { if (next) update(next as GrillMeState) })}>{status?.available === false ? '重新选择原文件' : '重新选择'}</button>
          </li>
        })}</ul>
      </details>}

      <details className="grill-me-history">
        <summary>已确认信息 {confirmedSlots.length > 0 && <span>{confirmedSlots.length} 项</span>}</summary>
        <div className="grill-me-history-list">
          {confirmedSlots.length > 0 ? confirmedSlots.map((slot) => (
            <div className="grill-me-history-row" key={slot.id}>
              <span>{slot.label}</span><p>{slot.answer}</p><small>{sourceLabel(slot.source)}</small>
            </div>
          )) : <p className="grill-me-empty">还没有确认内容。</p>}
        </div>
      </details>

      {statusText && <p className="grill-me-status-note" role="status" aria-live="polite">{statusText}</p>}
      {startError && <p className="grill-me-status-note grill-me-start-error" role="alert" aria-live="assertive">{startError}</p>}
      {actionError && <p className="grill-me-status-note grill-me-action-error" role="alert" aria-live="assertive">操作未完成：{actionError}。已保留当前进度，可以重试。</p>}

      {(state.status === 'interviewing' || state.status === 'manual_completion') && current && (
        <div className="grill-me-question-area" data-testid="grill-interview-stage">
          <h2 className="grill-me-question">{questionText}</h2>
          <div className="grill-me-options" role="group" aria-label="快速回答">
            {visibleOptions.map((option) => <button className={`grill-me-option${supplementFocused && isFinalQuestion && /还有补充/.test(option.label) ? ' selected' : ''}`} type="button" key={`${option.label}-${option.decision}`} disabled={busy || modelBusy} onClick={() => chooseOption(option)}>{option.label}</button>)}
          </div>
          <label className="grill-me-free-answer">
            <span>或者自己写</span>
            <textarea value={answer} aria-label="自由填写回答" disabled={busy || modelBusy} onChange={(event) => { setAnswer(event.target.value); if (isFinalQuestion && event.target.value.trim()) setSupplementFocused(true) }} placeholder="补充你的要求…" rows={2} />
          </label>
          <div className="grill-me-actions"><button className="btn primary" type="button" disabled={busy || modelBusy || !answer.trim()} onClick={() => answerQuestion(answer, 'answer')}>{isFinalQuestion ? '提交补充，继续梳理' : '确认并继续'}</button></div>
        </div>
      )}

      {state.status === 'assumption_review' && (
        <div className="grill-me-question-area" data-testid="grill-assumption-stage">
          <h2 className="grill-me-question">还有几项没有明确答案，要采用保守默认值吗？</h2>
          <ul className="grill-me-assumptions">{state.assumptions.map((item) => <li key={item}>{item}</li>)}</ul>
          <div className="grill-me-options"><button className="grill-me-option" type="button" disabled={busy} onClick={() => void call(() => ds.grillAssumptionDecision(state.sessionId, true), update)}>接受默认值</button><button className="grill-me-option" type="button" disabled={busy} onClick={() => void call(() => ds.grillAssumptionDecision(state.sessionId, false), update)}>继续补充</button></div>
        </div>
      )}

      {state.status === 'outline_ready' && (
        <div className="grill-me-question-area" data-testid="grill-outline-ready-stage">
          <h2 className="grill-me-question">需求已梳理，生成大纲吧。</h2>
          <p className="grill-me-stage-copy">大纲确认前不会调用正文模型。</p>
          <div className="grill-me-actions"><button className="btn primary" type="button" disabled={busy || planning.status === 'running'} onClick={() => void call(() => ds.grillOutlineGenerate(state.sessionId), update)}>{planning.status === 'failed' || planning.status === 'auth_required' ? '重试生成大纲' : '生成大纲'}</button></div>
        </div>
      )}

      {state.status === 'awaiting_outline_confirmation' && editing && (
        <div className="grill-me-outline" data-testid="grill-outline-stage">
          <label className="grill-me-free-answer"><span>标题</span><input value={editing.title} aria-label="大纲标题" onChange={(event) => setEditing({ ...editing, title: event.target.value })} /></label>
          <label className="grill-me-free-answer"><span>文章主旨</span><textarea value={editing.premise} aria-label="文章主旨" rows={3} onChange={(event) => setEditing({ ...editing, premise: event.target.value })} /></label>
          <div className="grill-me-outline-list">
            {editing.sections.map((section, index) => (
              <details className="grill-me-section" key={section.id}>
                <summary aria-label={`第${index + 1}节：${section.title}，${section.targetChars.toLocaleString()}字；章节编辑`}><span className="grill-me-section-index">{String(index + 1).padStart(2, '0')}</span><span>{section.title}</span><small>{section.targetChars.toLocaleString()} 字</small></summary>
                <div className="grill-me-section-edit">
                  <label className="grill-me-free-answer"><span>章节标题</span><input value={section.title} aria-label={`第${index + 1}节标题`} onChange={(event) => changeSection(section.id, { title: event.target.value })} /></label>
                  <label className="grill-me-free-answer"><span>这一节要发生什么</span><textarea value={section.purpose} aria-label={`第${index + 1}节说明`} rows={2} onChange={(event) => changeSection(section.id, { purpose: event.target.value })} /></label>
                  <label className="grill-me-free-answer"><span>推进点</span><textarea value={section.beats.join('\n')} aria-label={`第${index + 1}节推进点`} rows={2} onChange={(event) => changeSection(section.id, { beats: event.target.value.split(/\r?\n/).map((beat) => beat.trim()).filter(Boolean) })} /></label>
                  <label className="grill-me-section-budget"><span>本节字数</span><input type="number" min={0} value={section.targetChars} aria-label={`第${index + 1}节字数`} onChange={(event) => changeSection(section.id, { targetChars: Math.max(0, Number.parseInt(event.target.value, 10) || 0) })} /></label>
                  <small className="grill-me-source">来源：{section.sourceSlotIds.join('、') || '未标注'}</small>
                </div>
              </details>
            ))}
          </div>
          <p className={`grill-me-budget${outlineTotal === state.targetChars ? ' aligned' : ''}`}>{outlineTotal === state.targetChars ? '章节预算已对齐' : `章节预算还差 ${state.targetChars - outlineTotal} 字`} <span>合计 {outlineTotal.toLocaleString()} / {state.targetChars.toLocaleString()} 字</span></p>
          {applicability && applicability.scenes.length > 0 && <div role="status" data-testid="outline-applicability-warning"><p>有 {applicability.scenes.length} 个场景的推进点暂无法自动绑定可观察事件。建议先细化人物、动作、对象或地点变化；仍确认开始写作时，这些场景可能需要你逐段人工复核。</p><details className="dw-inline-help"><summary>查看需细化的推进点</summary>{applicability.scenes.map(scene => <p key={scene.sceneId}><b>{scene.title}</b>：{scene.beats.join('；')}</p>)}</details><button className="ghost-btn" type="button" disabled={busy || modelBusy} onClick={() => void call(() => ds.grillOutlineGenerate(state.sessionId), update)}>重新规划具体推进点</button></div>}
          {applicabilityUnavailable && <p role="status">场景预检暂不可用；确认后如证据不能自动绑定，仍会要求人工复核。</p>}
          <div className="grill-me-actions"><button className="btn" type="button" disabled={busy || outlineTotal !== state.targetChars} onClick={() => void call(() => ds.grillOutlineUpdate(state.sessionId, editing), update)}>保存修改</button><button className="btn primary" type="button" disabled={busy || outlineTotal !== state.targetChars} onClick={() => void call(async () => { const saved = await ds.grillOutlineUpdate(state.sessionId, editing); return ds.grillOutlineConfirm(state.sessionId, saved.outlineHash) }, (next) => { update(next as GrillMeState); return onConfirmed(next as GrillMeState) })}>确认大纲，开始写作</button></div>
        </div>
      )}

      {state.status === 'confirmed' && (
        <div className="grill-me-question-area" data-testid="grill-confirmed-stage">
          <h2 className="grill-me-question">大纲已确认，可以开始写作。</h2>
          <div className="grill-me-actions"><button className="btn primary" type="button" disabled={busy} onClick={() => void call(async () => state, (next) => onConfirmed(next))}>开始写作</button></div>
        </div>
      )}
    </section>
  )
}
