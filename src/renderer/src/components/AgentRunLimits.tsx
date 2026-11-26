import { normalizeAgentRunBudget, unlimitedAgentRunBudget, type AgentRunBudgetSettings } from '../../../shared/agentRunBudget'
import { useState } from 'react'
import SelectControl from './SelectControl'

const LABELS = { maxCalls: '模型调用次数', maxTurns: '任务轮数', maxTokens: '总 token 用量', maxWallClockMs: '运行时间' }

export function agentRunBudgetError(value: AgentRunBudgetSettings | undefined): string | null {
  try { normalizeAgentRunBudget(value); return null } catch (error) {
    let message = (error as Error).message
    for (const [key, label] of Object.entries(LABELS)) message = message.replaceAll(key, label)
    return message
  }
}

export default function AgentRunLimits({ value, onChange }: { value?: AgentRunBudgetSettings; onChange: (next: AgentRunBudgetSettings) => void }): React.ReactNode {
  const budget = value ?? unlimitedAgentRunBudget()
  // Keep old millisecond-precision values legible without rounding them or
  // changing units beneath the user while they edit a new minute value.
  const [timeUnit] = useState(() => value?.maxWallClockMs != null && value.maxWallClockMs % 60000 !== 0 ? 1 : 60000)
  const configured = Object.values(budget).filter(item => item !== null).length
  const error = agentRunBudgetError(budget)
  const costCurrency = budget.maxCost?.currency ?? ''
  const currencies = [
    { value: '', label: '按报价币种', description: '绑定首次可信报价的币种' },
    { value: 'CNY', label: 'CNY 人民币' },
    { value: 'USD', label: 'USD 美元' },
    ...(!['', 'CNY', 'USD'].includes(costCurrency) ? [{ value: costCurrency, label: costCurrency }] : [])
  ]
  return <section className="dw-agent-run-limits" aria-label="Agent 运行限制" data-testid="agent-run-limits">
    <div className="dw-run-limits-head">
      <h5>Agent 运行限制</h5>
      {configured > 0 && <button type="button" className="ghost-btn" onClick={() => onChange(unlimitedAgentRunBudget())}>关闭全部限制</button>}
    </div>
    <details>
      <summary>{configured ? `已设置 ${configured} 项限制` : '未设置限制'}</summary>
      <p className="dw-field-note">留空即不限，仅影响新建的 Agent 任务。</p>
      <div className="dw-run-limits-grid">
        {(['maxCalls', 'maxTurns', 'maxTokens', 'maxWallClockMs'] as const).map(key => <label className="field" key={key}>
          <span>{LABELS[key]}</span>
          <div className="dw-number-field">
            <input type="number" min={key === 'maxWallClockMs' ? 1 / timeUnit : 1} step={key === 'maxWallClockMs' ? 'any' : 1}
              aria-label={LABELS[key]} placeholder="不限"
              value={budget[key] === null ? '' : key === 'maxWallClockMs' ? budget[key] / timeUnit : budget[key]}
              onChange={event => onChange({ ...budget, [key]: event.target.value === '' ? null : key === 'maxWallClockMs' ? Math.round(Number(event.target.value) * timeUnit) : Number(event.target.value) })} />
            <span>{key === 'maxWallClockMs' ? timeUnit === 60000 ? '分钟' : '毫秒' : key === 'maxTokens' ? 'tokens' : key === 'maxCalls' ? '次' : '轮'}</span>
          </div>
          {key === 'maxTurns' && <p className="dw-field-note">一次模型工作循环计一轮，网络重试不另计轮数。</p>}
        </label>)}
        <div className="field dw-run-limits-cost">
          <label htmlFor="agent-run-cost">费用上限</label>
          <div className="dw-run-limits-cost-input">
            <input id="agent-run-cost" type="number" min={0} step="any" placeholder="不限" value={budget.maxCost?.amount ?? ''}
              onChange={event => onChange({ ...budget, maxCost: event.target.value === '' ? null : { amount: Number(event.target.value), currency: budget.maxCost?.currency ?? null, unknownPolicy: 'deny' } })} />
            <SelectControl value={costCurrency} options={currencies} disabled={!budget.maxCost} ariaLabel="费用上限币种"
              onChange={currency => { if (budget.maxCost) onChange({ ...budget, maxCost: { ...budget.maxCost, currency: currency || null } }) }} />
          </div>
          {budget.maxCost && <p className="dw-field-note">无法计价时停止，不做币种换算。填 0 表示不允许产生费用。</p>}
        </div>
      </div>
      {error && <p className="dw-run-limits-error" role="alert">{error}</p>}
    </details>
  </section>
}
