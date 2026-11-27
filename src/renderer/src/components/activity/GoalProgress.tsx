import { memo, useEffect, useState } from 'react'
import { useStore } from '../../store'
import { useGoal } from '../../goalSubscriptions'

const STATUS = { planning: '正在明确目标', active: '正在执行', reviewing: '候选成果，正在验收', completed: '已验收完成', blocked: '等待处理', stopped: '已停止', failed: '执行失败' }

/** One flat projection of the durable goal, shared by transcript and inspector. */
export default memo(function GoalProgress({ runId, detail = false }: { runId: string; detail?: boolean }): React.ReactNode {
  const goal = useGoal(runId)
  const recovery = useStore(state => state.recoverableRuns.find(run => run.runId === runId))
  const sessionId = useStore(state => state.currentSessionId)
  const resumeRun = useStore(state => state.resumeRun)
  const abandonRun = useStore(state => state.abandonRun)
  const openRunInspector = useStore(state => state.openRunInspector)
  const showToast = useStore(state => state.showToast)
  const [answer, setAnswer] = useState('')
  const [authorization, setAuthorization] = useState<{ runId: string; enabled: boolean } | null>(null)
  const authorized = authorization?.runId === runId && authorization.enabled
  const setAuthorized = (enabled: boolean): void => setAuthorization({ runId, enabled })
  const [budget, setBudget] = useState('')
  const [removeLimit, setRemoveLimit] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => { setAnswer(''); setAuthorization(null); setBudget(''); setRemoveLimit(false); setError(null) }, [runId])
  useEffect(() => { setAuthorization(null); setRemoveLimit(false) }, [recovery?.status])
  if (!goal) return null
  const autonomous = goal.mode === 'autonomous'
  const waiting = Boolean(recovery && ['waiting_user', 'recovery_required', 'paused'].includes(recovery.status))
  const needsAnswer = waiting && (goal.blockedOn?.kind === 'clarification' || goal.blockedOn?.kind === 'missing_input')
  const budgetBlocked = recovery?.errorCode === 'completion_budget_exhausted'
  const callLimitBlocked = recovery?.errorCode === 'run_provider_call_cap'
  const currentBudget = Number((recovery?.config.completionContract as { tokenBudget?: number } | undefined)?.tokenBudget ?? 0)
  const nextBudget = Number(budget)
  const budgetValid = !budgetBlocked || Number.isInteger(nextBudget) && nextBudget > currentBudget && nextBudget <= 2_000_000
  const canContinue = !busy && (!autonomous || authorized) && (!needsAnswer || Boolean(answer.trim())) && budgetValid && (!callLimitBlocked || removeLimit)
  const done = goal.outcomes.filter(outcome => outcome.status === 'done').length
  const continueGoal = async (): Promise<void> => {
    if (!canContinue) return
    setBusy(true); setError(null)
    try {
      if (needsAnswer) {
        const owner = recovery?.sessionId ?? sessionId
        // A failed resume must not enqueue the same accepted answer twice.
        const pending = await window.ds.runsSteering(runId, owner)
        if (!pending.messages.some((message: { status: string; text: string }) => message.status === 'pending' && message.text === answer.trim())) {
          await window.ds.runsSteer({ runId, sessionId: owner, requestId: crypto.randomUUID(), text: answer.trim() })
        }
      }
      const ok = await resumeRun(runId, budgetBlocked ? nextBudget : undefined, callLimitBlocked && removeLimit ? true : undefined, autonomous ? true : undefined)
      if (!ok) throw new Error('无法继续，请查看任务状态后重试。')
      setAnswer(''); setAuthorized(false); setRemoveLimit(false)
    } catch (reason) { setError(reason instanceof Error ? reason.message : '提交失败，请重试。') }
    finally { setBusy(false) }
  }
  return <section className={`goal-progress${detail ? ' ri-section' : ''}`} aria-label="目标进度" data-testid="goal-progress">
    <header><b>Goal · {STATUS[goal.status]}</b><span>{autonomous ? '自主执行' : '确认后推进'}{goal.outcomes.length ? ` · ${done}/${goal.outcomes.length} 项已验收` : ''}</span>{!detail && <button type="button" className="dw-text-btn" onClick={() => openRunInspector(runId, 'activity')}>查看目标详情</button>}</header>
    {detail && <p className="goal-original">{goal.objective}</p>}
    {goal.progress && <p>{goal.progress}</p>}
    {goal.outcomes.length > 0 && <ol className="goal-outcomes">{goal.outcomes.map(outcome => <li key={outcome.id}>
      <span className={`goal-check ${outcome.status}`} role="img" aria-label={outcome.status === 'done' ? '已验收' : '待验收'}>{outcome.status === 'done' ? '✓' : '○'}</span>
      <div><b>{outcome.description}</b><details><summary>验收方式{outcome.evidence.length ? `与 ${outcome.evidence.length} 条证据` : ''}</summary><p>{outcome.check}</p>{outcome.evidence.length > 0 && <ul>{outcome.evidence.map((evidence, index) => <li key={index}><b>{evidence.reason}</b><p>{evidence.quote}</p><span>{evidence.reference}</span></li>)}</ul>}</details></div>
    </li>)}</ol>}
    {goal.blockedOn && <div className="goal-blocker"><b>{goal.blockedOn.reason}</b><p>{goal.blockedOn.nextAction}</p>{goal.blockedOn.recommendation && <p>建议：{goal.blockedOn.recommendation}</p>}</div>}
    {waiting && <div className="goal-recovery">
      {needsAnswer && <label className="goal-answer"><span>补充目标信息</span><textarea value={answer} onChange={event => setAnswer(event.target.value)} rows={2} disabled={busy} /></label>}
      {budgetBlocked && <label className="goal-answer"><span>新的总 token 预算（当前 {currentBudget.toLocaleString()}）</span><input type="number" min={currentBudget + 1} max={2_000_000} step={1} value={budget} onChange={event => setBudget(event.target.value)} disabled={busy} /></label>}
      {callLimitBlocked && <label className="composer-goal-choice"><input type="checkbox" checked={removeLimit} disabled={busy} onChange={event => setRemoveLimit(event.target.checked)} /><span>解除本任务的调用次数限制，保留原费用和 token 预算</span></label>}
      {autonomous && <><label className="composer-goal-choice"><input type="checkbox" checked={authorized} disabled={busy} onChange={event => setAuthorized(event.target.checked)} /><span>重新授权此任务的项目工具</span></label><p>恢复后，项目文件和已授权命令由 Agent 自行处理；联网沿用当前设置。你仍可随时停止。</p></>}
      {error && <p role="alert">{error}</p>}
      <div className="goal-recovery-actions"><button type="button" className="btn primary" disabled={!canContinue} onClick={() => void continueGoal()}>{busy ? '提交中…' : autonomous ? '恢复并授权' : needsAnswer ? '提交并继续' : '继续处理'}</button><button type="button" className="dw-text-btn danger" disabled={busy} onClick={() => void abandonRun(runId).then(ok => showToast(ok ? '任务已停止' : '停止失败', ok ? 'info' : 'error'))}>停止任务</button></div>
    </div>}
  </section>
})
