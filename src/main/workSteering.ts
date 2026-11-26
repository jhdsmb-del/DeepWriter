import type { Repository, TurnRow } from './db/repository'
import { isWorkSteeringConfig, workSteeringTurnPrefix, WORK_STEERING_MAX_CHARS, type WorkSteeringInput, type WorkSteeringMessage, type WorkSteeringView } from '../shared/workSteering'

const prefix = 'work_steering_v1:'
const turnIdFor = (runId: string, requestId: string): string => workSteeringTurnPrefix(runId) + requestId
type Port = Pick<Repository, 'tx' | 'getRun' | 'getRunSteeringRows' | 'saveRunEvidence' | 'getTurnsByRun' | 'appendTurn' | 'getToolCallsByRun' | 'getSessionMessages' | 'appendSessionMessage' | 'moveActiveAssistantAfterSteering'>
const validId = (id: unknown): id is string => typeof id === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(id)
function runFor(repo: Port, runId: string, sessionId: string) {
  if (!validId(runId) || !validId(sessionId)) throw new Error('steering_invalid_identity：运行或会话标识无效')
  const run = repo.getRun(runId)
  if (!run || run.session_id !== sessionId) throw new Error('steering_run_not_found：此会话中找不到指定运行')
  let config: Record<string, unknown>
  try { config = JSON.parse(run.config_json) } catch { throw new Error('steering_config_invalid：运行配置不可验证') }
  if (!config || !isWorkSteeringConfig(config)) throw new Error('steering_work_agent_only：仅普通工作 Agent 接受运行中补充，长文和只读方案不适用')
  return run
}
function read(repo: Port, runId: string, sessionId: string): WorkSteeringMessage[] {
  const messages = repo.getRunSteeringRows(runId).map(row => {
    let item: WorkSteeringMessage
    try { item = JSON.parse(row.json) } catch { throw new Error('steering_queue_corrupt：补充指令队列不可验证，未消费') }
    if (item.schemaVersion !== 1 || item.runId !== runId || item.sessionId !== sessionId || !validId(item.requestId) || row.kind !== prefix + item.requestId ||
      !Number.isSafeInteger(item.sequence) || item.sequence < 1 || !Number.isSafeInteger(item.createdAt) || typeof item.text !== 'string' || !item.text.trim() || item.text.length > WORK_STEERING_MAX_CHARS ||
      !['pending', 'applied'].includes(item.status) || item.status === 'applied' && (item.turnId !== turnIdFor(runId, item.requestId) || !Number.isSafeInteger(item.appliedAt))) throw new Error('steering_queue_corrupt：补充指令队列身份或状态不可验证，未消费')
    return item
  }).sort((a, b) => a.sequence - b.sequence)
  if (new Set(messages.map(item => item.sequence)).size !== messages.length) throw new Error('steering_queue_corrupt：补充指令序号重复，未消费')
  return messages
}
export function workSteeringView(repo: Port, runId: string, sessionId: string): WorkSteeringView {
  const run = runFor(repo, runId, sessionId)
  return { runId, sessionId, runStatus: run.status, messages: read(repo, runId, sessionId) }
}

/** No execution lock: another process may submit while the owning host streams.
 * SQLite's immediate transaction serializes submissions and idempotent retries. */
export function queueWorkSteering(repo: Port, input: WorkSteeringInput): WorkSteeringMessage {
  if (!validId(input.requestId) || typeof input.text !== 'string' || !input.text.trim() || input.text.length > WORK_STEERING_MAX_CHARS || input.text.includes('\0') || /[\uD800-\uDFFF]/u.test(input.text)) throw new Error('steering_invalid_input：补充须为 1–8000 字符的完整文本')
  let result!: WorkSteeringMessage
  repo.tx(() => {
    const run = runFor(repo, input.runId, input.sessionId), previous = read(repo, input.runId, input.sessionId)
    const existing = previous.find(item => item.requestId === input.requestId)
    if (existing) {
      if (existing.text !== input.text) throw new Error('steering_request_conflict：同一请求标识已用于另一条指令')
      result = existing; return
    }
    if (!['queued', 'running', 'recoverable', 'waiting_user', 'recovery_required', 'cancelling', 'cancel_requested'].includes(run.status)) throw new Error('steering_run_finished：运行已结束，未发送；请在新任务中补充')
    result = { ...input, schemaVersion: 1, sequence: (previous.at(-1)?.sequence ?? 0) + 1, status: 'pending', createdAt: Date.now() }
    repo.saveRunEvidence(input.runId, prefix + input.requestId, JSON.stringify(result))
    const messages = repo.getSessionMessages(input.sessionId)
    repo.appendSessionMessage({ msg_id: 'm_' + turnIdFor(input.runId, input.requestId), session_id: input.sessionId, seq: Math.max(0, ...messages.map(item => item.seq)) + 1,
      role: 'user', content: input.text, status: 'thinking', created_at: result.createdAt })
    repo.moveActiveAssistantAfterSteering(input.runId, input.sessionId)
  }, 'immediate')
  return result
}

/** Only the owning engine calls this after the complete tool-result batch.
 * The durable user turn and dequeue commit together. A crash cannot lose the
 * instruction or append it twice. No tool is executed or acknowledged here. */
export function consumeWorkSteering(repo: Port, runId: string, sessionId: string): TurnRow[] {
  const turns: TurnRow[] = []
  repo.tx(() => {
    const run = runFor(repo, runId, sessionId)
    if (!['running', 'queued'].includes(run.status)) return
    if (repo.getToolCallsByRun(runId).some(tool => ['requested', 'running', 'side_effect_unknown'].includes(tool.status))) return
    const item = read(repo, runId, sessionId).find(message => message.status === 'pending')
    if (!item) return
    const history = repo.getTurnsByRun(runId), turnId = turnIdFor(runId, item.requestId)
    if (history.some(turn => turn.turn_id === turnId)) throw new Error('steering_queue_corrupt：待处理指令已存在于上下文，未重复追加')
    const canonical = repo.getSessionMessages(sessionId).find(message => message.msg_id === 'm_' + turnId)
    if (!canonical || canonical.role !== 'user' || canonical.content !== item.text || canonical.status !== 'thinking') throw new Error('steering_queue_corrupt：补充指令与会话记录不一致，未消费')
    const turn: TurnRow = { turn_id: turnId, run_id: runId, turn_seq: Math.max(0, ...history.map(row => row.turn_seq)) + 1,
      role: 'user', content: item.text, reasoning_content: null, tool_calls_json: null, tool_result_json: null, plan_state: null, created_at: Date.now() }
    repo.appendTurn(turn)
    // Only admitted input becomes accepted conversation history. Pending
    // instructions for a stopped run must not silently steer a later run.
    repo.appendSessionMessage({ ...canonical, status: 'done' })
    repo.saveRunEvidence(runId, prefix + item.requestId, JSON.stringify({ ...item, status: 'applied', turnId, appliedAt: turn.created_at }))
    turns.push(turn)
  }, 'immediate')
  return turns
}
