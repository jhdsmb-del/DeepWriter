import FileActionLink from '../FileActionLink'
import { TOOL_NAMES } from '../../toolLabels'
import { memo, useEffect, useState, type CSSProperties } from 'react'
import { useStore } from '../../store'
import type { ArtifactActivity, RunPhase, RunUsageView, RunViewState, ToolActivity } from '../../../../shared/activity'
import type { BillingMetric, ProviderAttemptRecord, RunBillingView } from '../../../../shared/billing'
import type { ManuscriptDraftInfo } from '../../../../shared/manuscriptDraft'
import ActivityTimeline from '../activity/ActivityTimeline'
import WorkPlanProgress from '../activity/WorkPlanProgress'
import GoalProgress from '../activity/GoalProgress'
import ToolOutputView from './ToolOutputView'
import Icon from '../Icon'
import { useDialogFocus } from '../../hooks/useDialogFocus'
import ConfirmDialog from '../ConfirmDialog'
import ManuscriptReader, { useManuscriptIndex } from '../ManuscriptReader'

const PHASE_LABEL: Record<RunPhase, string> = {
  queued: '排队中',
  understanding: '理解任务',
  planning: '制定计划',
  reading: '读取上下文',
  thinking: '思考中',
  executing_tool: '执行工具',
  writing: '生成正文',
  validating: '校验中',
  waiting_permission: '等待确认',
  paused: '已暂停',
  stopping: '正在停止',
  cancel_requested: '取消请求已提交',
  recovery_required: '需人工恢复',
  completed: '已完成',
  failed: '失败',
  cancelled: '已取消'
}


const WRITE_TOOLS = new Set(['write_file', 'edit_file'])

function fmtMs(ms: number): string {
  if (ms < 1000) return ms < 100 ? '不到 1 秒' : '约 1 秒'
  const s = Math.round(ms / 1000)
  const m = Math.floor(s / 60)
  if (m > 0) return `${m} 分 ${s % 60} 秒`
  return `${s} 秒`
}

function fmtClock(ts: number): string {
  const d = new Date(ts)
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

function runStats(run: RunViewState): { toolCount: number; modified: number; elapsed: number; failedTools: ToolActivity[] } {
  const tools = Object.values(run.toolsById)
  const failedTools = tools.filter((t) => t.status === 'failed' || (t.exitCode != null && t.exitCode !== 0))
  const modified = tools.filter((t) => t.status === 'done' && WRITE_TOOLS.has(t.toolName)).length
  const lastStep = run.steps[run.steps.length - 1]
  const elapsed = run.terminal
    ? (lastStep?.elapsedMs ?? Math.max(0, Date.now() - run.startedAt))
    : Math.max(0, Date.now() - run.startedAt)
  return { toolCount: tools.length, modified, elapsed, failedTools }
}

function TerminalSummary({ run }: { run: RunViewState }): React.ReactNode {
  const t = run.terminal
  if (!t) {
    const waiting = ['paused', 'waiting_permission', 'recovery_required'].includes(run.status)
    return (
      <div className={`ri-terminal ${waiting ? 'waiting' : 'running'}`}>
        <span className={`phase-dot ${waiting ? 'waiting' : 'running'}`} />
        <span className="ri-terminal-title">{waiting ? PHASE_LABEL[run.status] : '运行中'}</span>
        {!waiting && <span className="ri-terminal-msg">{PHASE_LABEL[run.status] ?? run.status}</span>}
      </div>
    )
  }
  const { elapsed, failedTools } = runStats(run)
  if (t.state === 'failed') {
    return (
      <div className="ri-terminal failed">
        <div className="ri-terminal-line">
          <span className="phase-dot failed" />
          <span className="ri-terminal-title">任务失败</span>
          <span className="ri-terminal-time">{fmtMs(elapsed)}</span>
        </div>
        {failedTools.length > 0 && (
          <div className="ri-terminal-error">
            <span className="ri-terminal-code">退出码</span>
            <span className="ri-terminal-msg">
              {failedTools
                .map((ft) => `${TOOL_NAMES[ft.toolName] ?? ft.toolName} ${ft.exitCode != null ? `exit ${ft.exitCode}` : '异常'}`)
                .join('、')}
            </span>
          </div>
        )}
        {t.error && (
          <div className="ri-terminal-error">
            <span className="ri-terminal-code">错误信息</span>
            <span className="ri-terminal-msg">{t.error}</span>
          </div>
        )}
      </div>
    )
  }
  if (t.state === 'cancelled') {
    return (
      <div className="ri-terminal cancelled">
        <span className="phase-dot cancelled" />
        <span className="ri-terminal-title">任务已取消</span>
        <span className="ri-terminal-time">{fmtMs(elapsed)}</span>
      </div>
    )
  }
  return (
    <div className="ri-terminal completed">
      <span className="phase-dot completed" />
      <span className="ri-terminal-title">任务完成</span>
      <span className="ri-terminal-time">{fmtMs(elapsed)}</span>
      {t.summary && !['完成', '任务完成'].includes(t.summary.trim()) && <span className="ri-terminal-msg">{t.summary}</span>}
    </div>
  )
}

function StatsRow({ run, stats }: { run: RunViewState; stats: { toolCount: number; modified: number; elapsed: number } }): React.ReactNode {
  const parts = [
    `${fmtClock(run.startedAt)} 开始`,
    `历时 ${fmtMs(stats.elapsed)}`
  ]
  if (stats.toolCount > 0) parts.push(`${stats.toolCount} 次工具调用`)
  if (stats.modified > 0) parts.push(`修改 ${stats.modified} 个文件`)
  return (
    <p className="ri-stats">{parts.join('，')}</p>
  )
}

function ToolItem({ tool }: { tool: ToolActivity }): React.ReactNode {
  const [open, setOpen] = useState(false)
  const name = TOOL_NAMES[tool.toolName] ?? tool.toolName
  const failed = tool.status === 'failed' || (tool.exitCode != null && tool.exitCode !== 0)
  return (
    <div className={`ri-tool${failed ? ' failed' : ''}`}>
      <button type="button" className="ri-tool-head" aria-expanded={open} onClick={() => setOpen(!open)}>
        <span className={`step-icon ${failed ? 'err' : 'ok'}`}>{failed ? '✗' : '✓'}</span>
        <span className="ri-tool-name">{name}</span>
        {tool.status === 'running' && <span className="status live">执行中…</span>}
        {tool.status === 'requested' && <span className="ri-tool-state">等待执行</span>}
        <span className="ri-tool-meta">
          {tool.exitCode != null && (
            <span className={`step-exit${tool.exitCode !== 0 ? ' bad' : ''}`}>exit {tool.exitCode}</span>
          )}
          {tool.durationMs != null && <span>{fmtMs(tool.durationMs)}</span>}
          <span className="tool-card-arrow">{open ? '▾' : '▸'}</span>
        </span>
      </button>
      {open && <ToolOutputView tool={tool} />}
    </div>
  )
}

function ArtifactItem({ artifact, runId }: { artifact: ArtifactActivity; runId: string }): React.ReactNode {
  const showToast = useStore((state) => state.showToast)
  const done = artifact.completedChars ?? 0
  const hasTarget = artifact.targetChars != null && artifact.targetChars > 0
  const pct = hasTarget ? Math.min(100, Math.round((done / (artifact.targetChars ?? 1)) * 100)) : null
  const items = artifact.completedItems != null ? ` · ${artifact.completedItems}/${artifact.totalItems ?? 0} 项` : ''
  const openArtifact = (): void => {
    if (!artifact.relativePath) return
    void window.ds.chatFileAction({ kind: 'artifact', runId, artifactId: artifact.artifactId }, 'open')
      .then((result: { ok: boolean; message?: string }) => { if (!result.ok) showToast(result.message || '稿件不存在或内容校验失败', 'error') })
      .catch(() => showToast('打开稿件失败', 'error'))
  }
  return (
    <div className="ri-artifact">
      <div className="ri-artifact-head">
        <span className="ri-artifact-name">{artifact.displayName}</span>
        <span className="ri-artifact-meta">
          {hasTarget
            ? `${done.toLocaleString()} / ${(artifact.targetChars ?? 0).toLocaleString()} 字（${pct}%）${items}`
            : `已生成 ${done.toLocaleString()} 字${items}`}
          {artifact.status === 'failed' && <span className="ri-artifact-failed">失败</span>}
        </span>
      </div>
      {artifact.relativePath && (
        <div className="ri-artifact-path-row">
          <FileActionLink anchor={{ kind: 'artifact', runId, artifactId: artifact.artifactId }} className="ri-artifact-path" title={artifact.relativePath}>
            {artifact.relativePath}
          </FileActionLink>
          <button className="ri-artifact-open" onClick={openArtifact}>
            打开
          </button>
        </div>
      )}
    </div>
  )
}

function UsageSection({ usage }: { usage: RunUsageView }): React.ReactNode {
  const parts: string[] = []
  if (usage.inputTokens != null) parts.push(`输入 ${usage.inputTokens.toLocaleString()}`)
  if (usage.outputTokens != null) parts.push(`输出 ${usage.outputTokens.toLocaleString()}`)
  if (usage.cacheHitTokens != null) parts.push(`缓存命中 ${usage.cacheHitTokens.toLocaleString()}`)
  if (usage.cacheMissTokens != null) parts.push(`缓存未命中 ${usage.cacheMissTokens.toLocaleString()}`)
  if (usage.reasoningTokens != null) parts.push(`推理 ${usage.reasoningTokens.toLocaleString()}`)
  if (usage.cost != null) parts.push(`费用 ¥${usage.cost.toFixed(4)}`)
  if (parts.length === 0) return null
  return (
    <section className="ri-section">
      <h4>用量明细</h4>
      <div className="ri-usage">
        <span className={`usage-source ${usage.source}`}>{usage.source === 'actual' ? '实际' : '估算'}</span>
        <span>{parts.join(' · ')}</span>
      </div>
    </section>
  )
}

function billingMetric(metric: BillingMetric | undefined, formatter: (value: number) => string): string {
  if (!metric) return '未知'
  if (metric.value !== null) return formatter(metric.value)
  if (metric.knownAttempts > 0) return `已知部分 ${formatter(metric.knownValue)}，另有 ${metric.unknownAttempts} 次未知`
  return '未知'
}

function exactMs(value: number): string {
  return value >= 1000 ? `${(value / 1000).toFixed(2)} 秒` : `${Math.round(value)} ms`
}

function tokenCount(value: number): string {
  return Math.round(value).toLocaleString()
}

function money(value: number, currency: string | null): string {
  const digits = Math.abs(value) < 0.01 ? 6 : 4
  if (currency === 'CNY' || currency === 'RMB') return `¥${value.toFixed(digits)}`
  if (currency === 'USD') return `$${value.toFixed(digits)}`
  return `${currency ?? ''} ${value.toFixed(digits)}`.trim()
}

function spendGroup(attempts: ProviderAttemptRecord[]): { knownCost: number; unknownCost: number; outputTokens: number | null } {
  const priced = attempts.filter((attempt) => attempt.costStatus !== 'unknown' && attempt.costAmount !== null)
  const outputs = attempts.map((attempt) => attempt.outputTokens).filter((value): value is number => value !== null)
  return {
    knownCost: priced.reduce((sum, attempt) => sum + (attempt.costAmount ?? 0), 0),
    unknownCost: attempts.length - priced.length,
    outputTokens: outputs.length === attempts.length && attempts.length > 0 ? outputs.reduce((sum, value) => sum + value, 0) : null
  }
}

const OUTCOME_LABEL: Record<ProviderAttemptRecord['outcome'], string> = {
  in_flight: '进行中',
  success: '成功',
  http_error: 'HTTP 错误',
  transport_error: '传输错误',
  timeout: '超时',
  cancelled: '已取消',
  interrupted: '重启中断'
}

function attemptCell(value: number | null, formatter: (value: number) => string = tokenCount): string {
  return value === null ? '未知' : formatter(value)
}

function AttemptRow({ attempt }: { attempt: ProviderAttemptRecord }): React.ReactNode {
  const ttft = attempt.firstTokenAt === null ? null : Math.max(0, attempt.firstTokenAt - attempt.startedAt)
  const duration = attempt.endedAt === null ? null : Math.max(0, attempt.endedAt - attempt.startedAt)
  const cache = attempt.cacheHitTokens === null || attempt.cacheMissTokens === null
    ? '未知'
    : tokenCount(attempt.cacheHitTokens + attempt.cacheMissTokens)
  const cost = attempt.costAmount === null || attempt.costStatus === 'unknown'
    ? '未知'
    : `${attempt.costStatus === 'actual' ? '实际' : '估算'} ${attempt.costCurrency ?? ''} ${attempt.costAmount.toFixed(6)}`.trim()
  return (
    <tr>
      <td>{attempt.actor}{attempt.subtype ? ` · ${attempt.subtype}` : ''}</td>
      <td title={[attempt.adapterId, ...(attempt.appliedMappings ?? []), ...(attempt.omittedControls ?? [])].filter(Boolean).join(' · ')}><span title={attempt.endpointOrigin}>{attempt.providerId}</span><small>{attempt.modelId}{attempt.profileId ? ` · ${attempt.profileId}` : ' · 旧版兼容配置'}</small></td>
      <td title={attempt.logicalCallId}>{attempt.logicalCallId.slice(0, 8)}</td>
      <td>{attempt.attemptNo}</td>
      <td>{OUTCOME_LABEL[attempt.outcome]}{attempt.httpStatus !== null ? ` (${attempt.httpStatus})` : ''}</td>
      <td>{fmtClock(attempt.startedAt)}</td>
      <td>{attemptCell(ttft, exactMs)}</td>
      <td>{attemptCell(duration, exactMs)}</td>
      <td>{attemptCell(attempt.inputTokens)}</td>
      <td>{attemptCell(attempt.outputTokens)}</td>
      <td>{cache}</td>
      <td>{attemptCell(attempt.reasoningTokens)}</td>
      <td title={attempt.priceSnapshotId ?? undefined}>{cost}</td>
    </tr>
  )
}

function BillingPanel({ runId }: { runId: string }): React.ReactNode {
  const [billing, setBilling] = useState<RunBillingView | null>(null)
  const [loading, setLoading] = useState(true)
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    let live = true
    const ds = (window as any).ds
    const load = (): void => {
      if (!ds?.runsGetBilling) {
        if (live) { setLoading(false); setFailed(true) }
        return
      }
      void ds.runsGetBilling(runId).then((next: RunBillingView | null) => {
        if (!live) return
        setBilling((previous) => !next || (previous && next.revision < previous.revision) ? previous : next)
        setFailed(!next)
      }).catch(() => { if (live) setFailed(true) }).finally(() => { if (live) setLoading(false) })
    }
    load()
    const unsubscribe = ds?.onBillingUpdated?.((update: { runId: string; revision: number }) => {
      if (update.runId === runId) load()
    })
    return () => { live = false; unsubscribe?.() }
  }, [runId])
  if (loading) return <div className="run-inspector-empty">正在读取持久化账单…</div>
  if (failed || !billing) return <div className="run-inspector-empty">未找到该任务的账单。缺失字段不会按 0 显示。</div>
  const providerSummary = billing.providers.length > 0
    ? billing.providers.map((item) => {
      const profileIds = [...new Set(billing.attempts.filter((attempt) => attempt.providerId === item.providerId && attempt.modelId === item.modelId).map((attempt) => attempt.profileId).filter(Boolean))]
      return `${item.providerId} / ${item.modelId}${profileIds.length > 0 ? ` / ${profileIds.join(', ')}` : ' / 旧版兼容配置'}（${item.attempts} 次）`
    }).join('；')
    : '未知'
  const cost = billing.cost.amount === null
    ? billing.cost.knownAmount > 0
      ? `未知（已知部分 ${billing.cost.currency ?? ''} ${billing.cost.knownAmount.toFixed(6)}，另有 ${billing.cost.unknownAttempts} 次未知）`
      : '未知'
    : `${billing.cost.status === 'actual' ? '实际' : '估算'} ${billing.cost.currency ?? ''} ${billing.cost.amount.toFixed(6)}`.trim()
  const generation = spendGroup(billing.attempts.filter((attempt) => attempt.actor === 'writer'))
  const quality = spendGroup(billing.attempts.filter((attempt) => attempt.actor === 'critic' || attempt.actor === 'editor'))
  const knownSpend = generation.knownCost + quality.knownCost
  const spendRows = [
    { label: '生成与任务编排', detail: `${billing.callCounts.writer} 次模型调用`, calls: billing.callCounts.writer, ...generation },
    { label: '审校与修订', detail: `${billing.callCounts.critic + billing.callCounts.editor} 次模型调用`, calls: billing.callCounts.critic + billing.callCounts.editor, ...quality }
  ]
  const elapsed = billing.timing.runDurationMs === null ? '未知' : fmtMs(billing.timing.runDurationMs)
  return (
    <div className="run-inspector-body ri-billing" data-testid="run-billing-panel">
      <section className="ri-billing-overview" aria-label="账单摘要">
        <div className={`ri-billing-total ${billing.cost.status}`}>
          <small>{billing.finalized ? '本次任务总费用' : '当前累计费用'}</small>
          <strong>{billing.cost.amount === null ? '费用未知' : money(billing.cost.amount, billing.cost.currency)}</strong>
          <span>{billing.cost.status === 'actual' ? '实际账单' : billing.cost.status === 'estimated' ? '按价格快照估算' : billing.cost.knownAmount > 0 ? `已知部分 ${money(billing.cost.knownAmount, billing.cost.currency)}` : 'Provider 未返回完整计价信息'}</span>
        </div>
        <div className="ri-billing-kpi"><small>生成内容</small><strong>{billingMetric(billing.tokens.output, tokenCount)}</strong><span>输出 token</span></div>
        <div className="ri-billing-kpi"><small>完成用时</small><strong>{elapsed}</strong><span>{billing.timing.outputTokensPerSecond === null ? '速度未知' : `${billing.timing.outputTokensPerSecond.toFixed(1)} token/秒`}</span></div>
      </section>

      <section className="ri-section ri-spend-section">
        <h4>费用花到哪了</h4>
        <div className="ri-spend-list">
          {spendRows.map((row) => {
            const share = knownSpend > 0 ? Math.round((row.knownCost / knownSpend) * 100) : 0
            return (
              <div className="ri-spend-row" key={row.label}>
                <div><b>{row.label}</b><small>{row.detail}{row.outputTokens === null ? '' : ` · 输出 ${tokenCount(row.outputTokens)}`}</small></div>
                <div className="ri-spend-track" aria-hidden="true"><i style={{ width: `${share}%` }} /></div>
                <strong>{row.calls === 0 ? '未使用' : row.unknownCost > 0 ? row.knownCost > 0 ? `${money(row.knownCost, billing.cost.currency)} + 未知` : '费用未知' : money(row.knownCost, billing.cost.currency)}</strong>
              </div>
            )
          })}
          <div className="ri-spend-row local"><div><b>工具执行</b><small>{billing.callCounts.tool} 次 · 文件、命令等在本机运行</small></div><div className="ri-spend-track" aria-hidden="true"><i /></div><strong>不单独计费</strong></div>
        </div>
        {billing.cost.status === 'unknown' && <p className="ri-cost-note">费用图条仅包含已知部分。</p>}
      </section>

      <section className="ri-section">
        <h4>Token 去向</h4>
        <div className="ri-token-strip">
          <span><small>输入</small><b>{billingMetric(billing.tokens.input, tokenCount)}</b></span>
          <span><small>生成文本</small><b>{billingMetric(billing.tokens.output, tokenCount)}</b></span>
          <span><small>模型推理</small><b>{billingMetric(billing.tokens.reasoning, tokenCount)}</b></span>
          <span><small>缓存命中</small><b>{billingMetric(billing.tokens.cacheHit, tokenCount)}</b></span>
          <span><small>缓存未命中</small><b>{billingMetric(billing.tokens.cacheMiss, tokenCount)}</b></span>
        </div>
      </section>

      <section className="ri-section">
        <h4>时间花到哪了</h4>
        <div className="ri-stage-flow" aria-label="工作流阶段耗时">
          {(billing.timing.stages ?? []).length > 0 ? billing.timing.stages.map((stage, index) => {
            const width = billing.timing.runDurationMs && stage.durationMs !== null ? Math.max(3, Math.round((stage.durationMs / billing.timing.runDurationMs) * 100)) : 0
            return <span key={`${stage.phase}:${stage.startedAt}:${index}`} style={{ '--stage-width': `${width}%` } as CSSProperties}><i /><b>{PHASE_LABEL[stage.phase as RunPhase] ?? stage.phase}</b><small>{stage.durationMs === null ? '未知' : fmtMs(stage.durationMs)}</small></span>
          }) : <span><i /><b>阶段耗时</b><small>未知</small></span>}
        </div>
      </section>

      <details className="ri-audit-details">
        <summary>查看审计明细</summary>
        <section className="ri-section">
          <h4>运行身份</h4>
          <dl className="ri-billing-grid">
            <div><dt>状态</dt><dd>{billing.finalized ? `已结算 · ${billing.status}` : `运行中 · ${billing.status}`}</dd></div>
            <div><dt>runId</dt><dd title={billing.runId}>{billing.runId}</dd></div>
            <div><dt>Provider / Model</dt><dd>{providerSummary}</dd></div>
            <div><dt>开始 / 结束</dt><dd>{billing.startedAt === null ? '未知' : fmtClock(billing.startedAt)} / {billing.endedAt === null ? '未知' : fmtClock(billing.endedAt)}</dd></div>
          </dl>
        </section>
        <section className="ri-section">
          <h4>调用与性能</h4>
          <div className="ri-billing-cards">
            <span><b>{billing.callCounts.attempts}</b><small>Provider 尝试</small></span>
            <span><b>{billing.callCounts.logicalCalls}</b><small>逻辑调用</small></span>
            <span><b>{billing.callCounts.writer}</b><small>生成/编排</small></span>
            <span><b>{billing.callCounts.critic}</b><small>审校</small></span>
            <span><b>{billing.callCounts.editor}</b><small>修订</small></span>
            <span><b>{billing.callCounts.tool}</b><small>本地工具</small></span>
          </div>
          <dl className="ri-billing-grid">
            <div><dt>首字延迟</dt><dd>{billingMetric(billing.timing.ttftMs, exactMs)}</dd></div>
            <div><dt>模型调用总耗时</dt><dd>{billingMetric(billing.timing.attemptDurationMs, exactMs)}</dd></div>
            <div><dt>任务总耗时</dt><dd>{billing.timing.runDurationMs === null ? '未知' : exactMs(billing.timing.runDurationMs)}</dd></div>
            <div><dt>输出速度</dt><dd>{billing.timing.outputTokensPerSecond === null ? '未知' : `${billing.timing.outputTokensPerSecond.toFixed(2)} token/秒`}</dd></div>
          </dl>
        </section>
        <p className={`ri-cost-status ${billing.cost.status}`}>{cost}</p>
      <section className="ri-section" data-testid="context-request-ledger">
        <h4>上下文请求 <span>{billing.context?.requests?.length ?? 0}</span></h4>
        {(billing.context?.requests ?? []).length === 0 ? <div className="ri-empty">旧运行没有 v2 上下文清单；不会用当前模式补写。</div> : (
          <div className="ri-context-requests">
            {(billing.context?.requests ?? []).map((request) => {
              const included = request.decisions.filter((entry) => entry.included)
              const omitted = request.decisions.filter((entry) => !entry.included)
              return (
                <details key={request.manifestId} className="ri-context-request">
                  <summary>
                    <b>{request.stageId} · {request.mode}</b>
                    <span>估算 {request.selectedInputEstimate ?? '未知'} / 完整 {request.fullBaselineEstimate ?? '未知'}</span>
                    <span>Provider input {request.actualInputTokens ?? '未知'} · cache {request.actualCachedInputTokens ?? '未知'}</span>
                  </summary>
                  <p>预计节省：{request.estimatedSavedTokens ?? '未知'}{request.estimatedSavingsRatio != null ? `（${Math.round(request.estimatedSavingsRatio * 100)}%）` : ''}；实际节省：未知（Provider 未提供可比完整基线时不推断）。</p>
                  <p>摘要：{request.summaryRef ? `v${request.summaryRef.version}` : '未使用'}；检索：{request.retrieval?.retrieverVersion ?? '未使用'}；估算器：{request.estimatorVersion ?? '未知'}</p>
                  <div className="ri-context-decision-columns">
                    <div><h5>纳入 {included.length}</h5>{included.map((entry) => <span key={entry.itemId}>{entry.source.displayLabel}<small>{entry.selectionReason}</small></span>)}</div>
                    <div><h5>忽略 {omitted.length}</h5>{omitted.map((entry) => <span key={entry.itemId}>{entry.source.displayLabel}<small>{entry.selectionReason}</small></span>)}</div>
                  </div>
                </details>
              )
            })}
          </div>
        )}
      </section>
      <section className="ri-section">
        <h4>Provider attempt 明细 <span>{billing.attempts.length}</span></h4>
        {billing.attempts.length === 0 ? <div className="ri-empty">暂无已进入 provider boundary 的调用。</div> : (
          <div className="ri-attempt-table-wrap"><table className="ri-attempt-table">
            <thead><tr><th>角色</th><th>Provider / Model</th><th>Logical call</th><th>Attempt</th><th>Outcome</th><th>Started</th><th>TTFT</th><th>Duration</th><th>Input</th><th>Output</th><th>Cache</th><th>Reasoning</th><th>Cost</th></tr></thead>
            <tbody>{billing.attempts.map((attempt) => <AttemptRow key={attempt.attemptId} attempt={attempt} />)}</tbody>
          </table></div>
        )}
      </section>
      </details>
    </div>
  )
}

/** 只展示应用自己记录的检查事实，不转述模型推理。 */
function ConstraintProgress({ run }: { run: RunViewState }): React.ReactNode {
  const steps = run.steps.filter((step) =>
    [
      '检查是否偏题', '正在纠正偏移', '偏移已纠正', '约束检查通过', '约束修复已暂停',
      '正文生成完成', '审校当前片段', '审校完成', '局部修订中', '局部修订完成', '文字审校已暂停', '局部修订已暂停', '局部修订需要确认'
    ].includes(step.title)
  )
  if (steps.length === 0) return null
  return (
    <section className="ri-section ri-constraint-progress" data-testid="strong-constraint-progress" aria-label="强约束检查记录">
      <h4>写作审校</h4>
      <ul>
        {steps.slice(-6).map((step) => (
          <li key={step.seq}>
            <span>{step.title}</span>
            {step.detail && <small>{step.detail}</small>}
          </li>
        ))}
      </ul>
    </section>
  )
}

const COMPLETION_SUBTYPE_LABEL: Record<string, string> = {
  contract_created: '完成契约已创建',
  validator_result: '校验结果',
  continuation_required: '需要继续写作',
  completion_blocked: '完成校验阻塞',
  completion_accepted: '完成校验通过',
  continuation_paused: '已暂停，等待你的决定'
}

/**
 * Packaged Electron does not provide a reliable window.prompt.  Keep budget
 * amendments in one visible, auditable control so the user can review the
 * exact new total before the durable resume IPC is called.
 */
function BudgetContinueControl({ runId, currentBudget }: { runId: string; currentBudget: number }): React.ReactNode {
  const resumeRun = useStore((st) => st.resumeRun)
  const showToast = useStore((st) => st.showToast)
  const [value, setValue] = useState(String(Math.max(currentBudget + 20000, currentBudget > 0 ? currentBudget * 2 : 20000)))
  const [submitting, setSubmitting] = useState(false)
  const submit = (): void => {
    const next = Number(value.trim())
    if (!Number.isInteger(next) || next <= currentBudget || next < 1 || next > 2_000_000) {
      showToast(`新预算必须是 1–2000000 之间且高于当前 ${currentBudget || '未设定'} 的整数`, 'error')
      return
    }
    setSubmitting(true)
    void resumeRun(runId, next).then((ok) => {
      setSubmitting(false)
      showToast(ok ? '已按新预算继续写作' : '无法继续，请检查任务状态或停止任务', ok ? 'success' : 'error')
    })
  }
  return (
    <div className="ri-budget-continue" data-testid="budget-continue-control">
      <label htmlFor={`budget-continue-${runId}`}>新的总 token 预算</label>
      <input
        id={`budget-continue-${runId}`}
        data-testid="budget-continue-input"
        type="number"
        min={Math.max(1, currentBudget + 1)}
        max={2_000_000}
        step={1}
        value={value}
        onChange={(event) => setValue(event.currentTarget.value)}
        disabled={submitting}
      />
      <button type="button" className="btn primary" data-testid="budget-continue-confirm" onClick={submit} disabled={submitting}>
        {submitting ? '提交中…' : '确认继续写作'}
      </button>
    </div>
  )
}

/** R4.4 Gate 3：completion 客观进度（只展示结构化事实与数字，不展示模型自述） */
function CompletionProgressView({ runId }: { runId: string }): React.ReactNode {
  const cp = useStore((st) => st.completionProgress[runId])
  const recoverable = useStore((st) => st.recoverableRuns.find((item) => item.runId === runId))
  const resumeRun = useStore((st) => st.resumeRun)
  const abandonRun = useStore((st) => st.abandonRun)
  const closeRunInspector = useStore((st) => st.closeRunInspector)
  const showToast = useStore((st) => st.showToast)
  const currentBudget = Number((recoverable?.config?.completionContract as { tokenBudget?: unknown } | undefined)?.tokenBudget ?? 0)
  if (recoverable?.config.goalMode) return null
  if (!cp || cp.subtype === 'contract_created') {
    if (!recoverable?.errorCode?.startsWith('completion_')) return null
    const budgetBlocked = recoverable.errorCode === 'completion_budget_exhausted'
    return (
      <section className="ri-section" data-testid="completion-progress">
        <h4>完成校验</h4>
        <div className="ri-completion">
          <span className="completion-state waiting_user">已暂停，等待你的决定</span>
          <p className="ri-paused-message">{recoverable.errorMessage ?? (budgetBlocked ? '预算已耗尽，请调整预算或目标后重新发起。' : '任务未达到完成条件，你可以再尝试一轮、调整后重发或停止。')}</p>
          <div className="ri-completion-actions">
            {!budgetBlocked && <button className="btn primary" onClick={() => void resumeRun(runId).then((ok) => showToast(ok ? '正在再尝试一轮' : '无法继续，请检查任务状态', ok ? 'success' : 'error'))}>再尝试一轮</button>}
            {budgetBlocked ? <BudgetContinueControl runId={runId} currentBudget={currentBudget} /> : <button className="ghost-btn" onClick={() => { closeRunInspector(); showToast('请在“设置 → 完成与预算”调整后重新发起；旧运行快照不会被静默改写。', 'info') }}>调整后重发</button>}
            <button className="ghost-btn danger" onClick={() => void abandonRun(runId).then((ok) => { if (ok) closeRunInspector(); showToast(ok ? '任务已停止' : '停止失败', ok ? 'info' : 'error') })}>停止任务</button>
          </div>
        </div>
      </section>
    )
  }
  const label = COMPLETION_SUBTYPE_LABEL[cp.subtype] ?? cp.subtype
  const chars = cp.targetChars !== undefined ? `${cp.measuredChars ?? 0} / ${cp.targetChars} 字` : cp.measuredChars !== undefined ? `${cp.measuredChars} 字` : ''
  const validators = cp.validatorTotal !== undefined ? `校验 ${cp.validatorPassed ?? 0} / ${cp.validatorTotal}` : ''
  return (
    <section className="ri-section" data-testid="completion-progress">
      <h4>完成校验</h4>
      <div className="ri-completion">
        <span className={`completion-state ${cp.state}`}>{label}</span>
        {chars && <span>{chars}</span>}
        {validators && <span>{validators}</span>}
        {cp.remainingWork.length > 0 && (
          <ul className="ri-completion-work">
            {cp.remainingWork.map((w: { code: string; message: string }, i: number) => (
              <li key={i}>
                [{w.code}] {w.message}
              </li>
            ))}
          </ul>
        )}
        {cp.blockedReason && <span className="completion-blocked">阻塞原因：{cp.blockedReason}</span>}
        {cp.pausedMessage && <p className="ri-paused-message">{cp.pausedMessage}</p>}
        {cp.state === 'waiting_user' && (
          <div className="ri-completion-actions">
            {cp.blockedReason !== 'budget_exhausted' && (
              <button className="btn primary" onClick={() => void resumeRun(runId).then((ok) => showToast(ok ? '正在再尝试一轮' : '无法继续，请检查任务状态', ok ? 'success' : 'error'))}>再尝试一轮</button>
            )}
            {cp.blockedReason === 'budget_exhausted' ? <BudgetContinueControl runId={runId} currentBudget={currentBudget} /> : <button className="ghost-btn" onClick={() => { closeRunInspector(); showToast('请在“设置 → 完成与预算”调整后重新发起；旧运行快照不会被静默改写。', 'info') }}>调整后重发</button>}
            <button className="ghost-btn danger" onClick={() => void abandonRun(runId).then((ok) => { if (ok) closeRunInspector(); showToast(ok ? '任务已停止' : '停止失败', ok ? 'info' : 'error') })}>停止任务</button>
          </div>
        )}
      </div>
    </section>
  )
}

function StoryEpochRecovery({ runId }: { runId: string }): React.ReactNode {
  const recoverable = useStore((st) => st.recoverableRuns.find((item) => item.runId === runId))
  const rebaseStoryRun = useStore((st) => st.rebaseStoryRun)
  const showToast = useStore((st) => st.showToast)
  if (recoverable?.errorCode !== 'story_ledger_epoch_invalidated') return null
  return (
    <section className="ri-section" data-testid="story-epoch-recovery">
      <h4>故事线有效期已失效</h4>
      <p className="ri-paused-message">{recoverable.errorMessage ?? '撤回使该运行使用的旧故事线失效，不能继续提交。'}</p>
      <div className="ri-completion-actions">
        <button className="btn primary" onClick={() => void rebaseStoryRun(runId).then((ok) => showToast(ok ? '已准备安全分支，请提交下一条创作任务' : '无法准备安全故事线分支', ok ? 'success' : 'error'))}>基于当前安全故事线新建分支</button>
      </div>
    </section>
  )
}

function WorkflowOverview({ run }: { run: RunViewState }): React.ReactNode {
  const sequence: RunPhase[] = []
  const seen = new Set<RunPhase>()
  const push = (phase: RunPhase): void => {
    if (seen.has(phase)) return
    seen.add(phase)
    sequence.push(phase)
  }
  push('queued')
  for (const step of run.steps) push(step.phase)
  push(run.status)
  const current = run.terminal ? null : run.status
  return (
    <section className="ri-workflow-overview" aria-label="任务流程图" data-testid="workflow-overview">
      <div className="ri-workflow-now">
        <small>{run.terminal ? '最终状态' : '现在正在做'}</small>
        <strong>{PHASE_LABEL[run.status] ?? run.status}</strong>
        {run.currentDetail && <span>{run.currentDetail}</span>}
      </div>
      <ol className="ri-flow-map">
        {sequence.map((phase, index) => {
          const active = phase === current
          const complete = run.terminal || (!active && sequence.indexOf(run.status) > index)
          return <li key={phase} className={active ? 'current' : complete ? 'complete' : ''}><i>{complete ? '✓' : index + 1}</i><span>{PHASE_LABEL[phase] ?? phase}</span></li>
        })}
      </ol>
    </section>
  )
}

function ProviderCallLimitRecovery({ runId }: { runId: string }): React.ReactNode {
  const recoverable = useStore((state) => state.recoverableRuns.find((item) => item.runId === runId))
  const resumeRun = useStore((state) => state.resumeRun)
  const showToast = useStore((state) => state.showToast)
  const [submitting, setSubmitting] = useState(false)
  if (recoverable?.config.goalMode || recoverable?.errorCode !== 'run_provider_call_cap') return null
  return <section className="ri-section" data-testid="provider-call-limit-recovery">
    <h4>调用次数已用尽</h4>
    <p>已用次数保留，费用和 token 预算不变。</p>
    <button type="button" className="btn primary" disabled={submitting} onClick={() => {
      setSubmitting(true)
      void resumeRun(runId, undefined, true).then((ok) => {
        setSubmitting(false)
        showToast(ok ? '已解除此任务的调用次数限制，正在继续' : '无法继续，请检查任务状态', ok ? 'success' : 'error')
      })
    }}>{submitting ? '提交中…' : '解除调用次数限制并继续'}</button>
  </section>
}

function ManuscriptDraftControl({ runId }: { runId: string }): React.ReactNode {
  const status = useStore(state => state.runs[runId]?.status)
  const recoverableStatus = useStore(state => state.recoverableRuns.find(run => run.runId === runId)?.status)
  const showToast = useStore(state => state.showToast)
  const open = useStore(state => state.openRunInspector)
  const [info, setInfo] = useState<ManuscriptDraftInfo | null>(null)
  const [saving, setSaving] = useState(false)
  useEffect(() => {
    let stale = false
    setInfo(null)
    void (window as any).ds?.runsGet?.(runId).then((detail: { manuscriptDraft?: ManuscriptDraftInfo | null } | null) => {
      if (!stale) setInfo(detail?.manuscriptDraft ?? null)
    }).catch(() => undefined)
    return () => { stale = true }
  }, [runId, status, recoverableStatus])
  if (!info) return null
  return <section className="ri-manuscript-draft" data-testid="manuscript-draft-control">
    <h4>已收稿 {info.acceptedChars.toLocaleString()} 字</h4>
    <button type="button" className="dw-text-btn" onClick={() => open(runId, 'manuscript')}>阅读已收稿</button>
    <button type="button" className="btn primary" disabled={saving} onClick={() => {
      setSaving(true)
      void (window as any).ds.runsSaveDraft(runId).then((result: import('../../../../shared/manuscriptDraft').ManuscriptDraftSaveResult) => {
        if (!result.cancelled) showToast(`草稿已另存：${result.path}`, 'success')
      }).catch((error: unknown) => showToast(error instanceof Error ? error.message : '草稿保存失败', 'error')).finally(() => setSaving(false))
    }}>{saving ? '正在另存…' : '另存草稿'}</button>
  </section>
}

function RunBody({ run }: { run: RunViewState }): React.ReactNode {
  const stats = runStats(run)
  const tools = Object.values(run.toolsById)
  const artifacts = Object.values(run.artifactsById)
  return (
    <div className="run-inspector-body">
      <TerminalSummary run={run} />
      <StatsRow run={run} stats={stats} />
      <WorkflowOverview run={run} />
      <GoalProgress key={run.runId} runId={run.runId} detail />
      <WorkPlanProgress runId={run.runId} detail />
      <ConstraintProgress run={run} />
      <StoryEpochRecovery runId={run.runId} />
      <CompletionProgressView runId={run.runId} />
      <section className="ri-section">
        <h4>活动记录</h4>
        {run.steps.length === 0 ? (
          <div className="ri-empty">暂无步骤</div>
        ) : (
          <ActivityTimeline steps={run.steps} toolsById={run.toolsById} limit={run.steps.length} />
        )}
      </section>
      {tools.length > 0 && (
        <section className="ri-section">
          <h4>工具详情 <span>{tools.length}</span></h4>
          {tools.map((t) => <ToolItem key={t.toolCallId} tool={t} />)}
        </section>
      )}
      {artifacts.length > 0 && (
        <section className="ri-section">
          <h4>产物 <span>{artifacts.length}</span></h4>
          {artifacts.map((a) => <ArtifactItem key={a.artifactId} artifact={a} runId={run.runId} />)}
        </section>
      )}
      <UsageSection usage={run.usage} />
    </div>
  )
}

function RunInspectorInner(): React.ReactNode {
  const runId = useStore((s) => s.inspectorRunId)
  const run = useStore((s) => (s.inspectorRunId ? (s.runs[s.inspectorRunId] ?? null) : null))
  const tab = useStore((s) => s.inspectorTab)
  const setTab = useStore((s) => s.openRunInspector)
  const resyncRun = useStore((s) => s.resyncRun)
  const closeRunInspector = useStore((s) => s.closeRunInspector)
  const deleteRun = useStore((s) => s.deleteRun)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const manuscript = useManuscriptIndex(runId)
  const returnToWriting = (): void => {
    const sessionId = manuscript.view?.sessionId
    const state = useStore.getState()
    if (sessionId && state.currentSessionId !== sessionId && (state.running || state.submitting)) {
      state.showToast('另一个会话正在写作，请结束后再切换。', 'info')
      return
    }
    closeRunInspector()
    if (sessionId && state.currentSessionId !== sessionId) void state.switchSession(sessionId).then(() => useStore.getState().setMode('longwrite'))
    else state.setMode('longwrite')
  }
  const dialogRef = useDialogFocus<HTMLDivElement>(Boolean(runId), closeRunInspector)
  useEffect(() => {
    if (runId) void resyncRun(runId)
  }, [runId, resyncRun])
  if (!runId) return null
  return (
    <div className="modal-overlay dw-dialog-overlay">
      <div ref={dialogRef} tabIndex={-1} className={`run-inspector dw-dialog${tab === 'manuscript' ? ' dw-manuscript-open' : ''}`} role="dialog" aria-modal="true" aria-labelledby="dw-run-inspector-title">
        <div className="run-inspector-head">
          <div className="run-inspector-title-block">
            <div className="run-inspector-title" id="dw-run-inspector-title">任务详情</div>
            <div className="run-inspector-sub">
              {run ? (PHASE_LABEL[run.status] ?? run.status) : '任务记录'} · {runId.slice(0, 8)}
            </div>
          </div>
          <div className="run-inspector-head-actions">
            {run?.terminal ? <button className="dw-text-btn danger" onClick={() => setConfirmDelete(true)}><Icon name="trash" />删除工作流</button> : null}
            <button className="dw-settings-close" aria-label="关闭任务详情" title="关闭任务详情" onClick={closeRunInspector}><Icon name="close" /></button>
          </div>
        </div>
        <div className="ri-tabs" role="tablist" aria-label="任务详情视图">
          <button role="tab" aria-selected={tab === 'activity'} onClick={() => setTab(runId, 'activity')}><Icon name="tasks" />活动</button>
          {(manuscript.view || tab === 'manuscript') && <button role="tab" aria-selected={tab === 'manuscript'} onClick={() => setTab(runId, 'manuscript')}><Icon name="document" />稿件</button>}
          <button role="tab" aria-selected={tab === 'billing'} onClick={() => setTab(runId, 'billing')}><Icon name="receipt" />账单</button>
        </div>
        {tab === 'manuscript' ? manuscript.view ? <ManuscriptReader key={runId} index={manuscript.view} onReturn={returnToWriting} /> : <div className="dw-manuscript-empty" role="status">{manuscript.loading ? '正在读取目录…' : manuscript.error ?? '这个任务还没有长文稿件。'}</div> : tab === 'billing'
          ? <BillingPanel key={runId} runId={runId} />
          : <><ManuscriptDraftControl runId={runId} /><ProviderCallLimitRecovery runId={runId} />{run ? <RunBody run={run} /> : <div className="run-inspector-body"><GoalProgress key={runId} runId={runId} detail /><WorkPlanProgress runId={runId} detail /><div className="run-inspector-empty">未找到该任务的活动记录。</div></div>}</>}
        {confirmDelete ? <ConfirmDialog
          title="删除这个工作流？"
          description="流程、账单与运行证据将从本机删除；当前故事线修订默认保留。若本轮内容有误，可选择同时撤回故事修订。"
          confirmLabel="仅删除执行记录"
          secondaryLabel="删除并撤回故事修订"
          destructive
          onCancel={() => setConfirmDelete(false)}
          onConfirm={() => { setConfirmDelete(false); void deleteRun(runId, 'preserve') }}
          onSecondary={() => { setConfirmDelete(false); void deleteRun(runId, 'retract') }}
        /> : null}
      </div>
    </div>
  )
}

export default memo(RunInspectorInner)
