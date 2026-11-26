import * as path from 'node:path'
import { createHash } from 'node:crypto'
import type { Repository } from './db/repository'
import type { ChatStartPayload } from './chatStart'
import { isReadOnlyAgentPlan } from '../shared/agentPlanPolicy'
import type { AgentPlanApproval } from '../shared/agentPlanPolicy'

export class AgentPlanError extends Error {
  readonly code = 'agent_plan_invalid'
}

const DECISION = 'agent_plan_decision_v1'
export function savedAgentPlan(repo: Repository, runId: string) {
  const row = repo.getRun(runId)
  if (!row || row.status !== 'completed' || !isReadOnlyAgentPlan(JSON.parse(row.config_json))) throw new AgentPlanError('只可选择已完成的只读 Agent 方案')
  const turns = repo.getTurnsByRun(runId)
  const last = turns.filter(turn => turn.role === 'assistant' && turn.content?.trim()).at(-1)
  if (!last || last.tool_calls_json && JSON.parse(last.tool_calls_json).length) throw new AgentPlanError('没有已保存的最终方案；请重新审阅')
  const text = last.content!.trim()
  if (text.length > 20_000) throw new AgentPlanError('方案超过2万字符，不能直接批准；请生成较短方案')
  const evidence = repo.getRunEvidence(runId, DECISION)
  const decision = evidence ? JSON.parse(evidence.json) as { decision: 'approved' | 'rejected'; executionRunId?: string } : null
  return { runId, sessionId: row.session_id, text, hash: createHash('sha256').update(text).digest('hex'), decision: decision?.decision ?? 'pending', executionRunId: decision?.executionRunId }
}

export function canonicalizeAgentPlanApproval(repo: Repository, payload: ChatStartPayload): ChatStartPayload {
  if (!payload.planApproval) return payload
  const plan = savedAgentPlan(repo, payload.planApproval.runId)
  if (payload.mode !== 'agent' || payload.longMode || payload.phase !== 'execute' || payload.planAccess) throw new AgentPlanError('方案批准只用于新的普通 Agent 执行')
  if (payload.sessionId !== plan.sessionId || payload.planApproval.hash !== plan.hash) throw new AgentPlanError('方案身份或内容已变化；请重新查看保存的方案')
  if (plan.decision !== 'pending') throw new AgentPlanError(plan.decision === 'rejected' ? '方案已拒绝，不能批准；请重新发起只读审阅' : `方案已批准；请查看原执行 ${plan.executionRunId ?? ''}`)
  if (payload.planText !== undefined && payload.planText !== plan.text) throw new AgentPlanError('不能用未保存的文本替换待批准方案')
  return { ...payload, planText: plan.text, planApproval: { runId: plan.runId, hash: plan.hash } }
}

/** Approval accepts the saved proposal, never a different directory or newly
 * loaded project instructions hidden behind the same visible plan. */
export function validateAgentPlanExecution(repo: Repository, payload: ChatStartPayload, config: Record<string, unknown>): void {
  if (!payload.planApproval) return
  const source = repo.getRun(payload.planApproval.runId)
  if (!source) throw new AgentPlanError('原方案不存在')
  const original = JSON.parse(source.config_json) as Record<string, unknown>
  const normalized = (value: unknown): string => { const result = path.resolve(String(value ?? '')); return process.platform === 'win32' ? result.toLowerCase() : result }
  if (normalized(original.workDir) !== normalized(config.workDir) || normalized(original.docDir) !== normalized(config.docDir)) throw new AgentPlanError('工作/文档目录已变化，请在当前目录重新只读审阅；未执行原方案')
  const brief = (value: Record<string, unknown>): string[] => Array.isArray(value.frozenSystemMessages)
    ? value.frozenSystemMessages.flatMap((message: { role?: string; content?: string }) => message.role === 'system' && typeof message.content === 'string' && message.content.startsWith('## 项目记忆：作者的写作约定\n') ? [message.content] : []) : []
  if (JSON.stringify(brief(original)) !== JSON.stringify(brief(config))) throw new AgentPlanError('DEEPWRITER.md 项目约定已变化，请重新只读审阅；未执行原方案')
  if (config.planMode === true || config.runMode !== 'agent' || config.longMode === true || config.planText !== payload.planText) throw new AgentPlanError('批准后的执行快照与保存方案不一致')
}

/** Called inside acceptChatStart's write transaction: rejection and approval
 * cannot race across the async preview/configuration preparation. */
export function acceptAgentPlanApproval(repo: Repository, payload: ChatStartPayload, config: Record<string, unknown>): void {
  if (!payload.planApproval) return
  canonicalizeAgentPlanApproval(repo, payload)
  validateAgentPlanExecution(repo, payload, config)
  repo.saveRunEvidence(payload.planApproval.runId, DECISION, JSON.stringify({ decision: 'approved', executionRunId: payload.id, at: Date.now() }))
}

export function rejectAgentPlan(repo: Repository, approval: AgentPlanApproval): void {
  repo.tx(() => {
    const plan = savedAgentPlan(repo, approval.runId)
    if (plan.hash !== approval.hash) throw new AgentPlanError('方案内容已变化，请重新查看')
    if (plan.decision === 'approved') throw new AgentPlanError('方案已批准；停止执行请使用原运行的暂停/取消入口')
    repo.saveRunEvidence(plan.runId, DECISION, JSON.stringify({ decision: 'rejected', at: Date.now() }))
  }, 'immediate')
}
