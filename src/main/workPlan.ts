import type { DsMessage } from '../shared/types'
import { WORK_PLAN_TOOL, type WorkPlanSnapshot } from '../shared/workPlan'
import type { Repository } from './db/repository'
import type { ToolDef } from './tools'
import { unwrapToolResult } from './toolResultView'

const limit = 20
const textLimit = 160
function stepsFrom(value: unknown): WorkPlanSnapshot['steps'] | null {
  if (!Array.isArray(value) || value.length > limit) return null
  const result: WorkPlanSnapshot['steps'] = []
  const names = new Set<string>()
  for (const entry of value) {
    if (!entry || typeof entry.text !== 'string' || !['pending', 'in_progress', 'done'].includes(entry.status)) return null
    const text = entry.text.trim()
    if (!text || [...text].length > textLimit || /[\r\n\u0000-\u001f\u007f]/u.test(text) || names.has(text)) return null
    names.add(text)
    result.push({ text, status: entry.status })
  }
  return result
}

function asPlan(value: unknown): WorkPlanSnapshot | null {
  if (!value || typeof value !== 'object') return null
  const { steps: raw, blockedOn } = value as { steps?: unknown; blockedOn?: unknown }
  const steps = stepsFrom(raw)
  if (!steps || (!steps.length && blockedOn !== undefined) || (blockedOn !== undefined && (typeof blockedOn !== 'string' || !blockedOn.trim() || [...blockedOn].length > textLimit || /[\u0000-\u001f\u007f]/u.test(blockedOn)))) return null
  return { version: 1, steps, ...(typeof blockedOn === 'string' ? { blockedOn: blockedOn.trim() } : {}) }
}

export const WORK_PLAN_CONTINUE = '工作清单还留有未完成项。继续下一项实际工作，不要仅复述清单或重复已经执行的操作。若只能等待用户或外部条件，请用 blockedOn 记录具体原因并交代停点。'

/** Only a paired, accepted tool invocation is evidence of a current plan.
 * Mixed batches are valid; a failed update leaves the last accepted snapshot in place. */
export function latestActivePlan(messages: DsMessage[]): WorkPlanSnapshot | null {
  let last: WorkPlanSnapshot | null = null
  let calls: DsMessage['tool_calls']
  for (const item of messages) {
    if (item.role !== 'tool') { calls = item.role === 'assistant' ? item.tool_calls : undefined; continue }
    const call = calls?.find(c => c.name === WORK_PLAN_TOOL && c.id === item.tool_call_id)
    if (!call) continue
    try {
      if (JSON.parse(item.content).ok !== true) continue
      const plan = asPlan(JSON.parse(call.arguments))
      if (plan) last = plan
    } catch { /* Old or incomplete receipt. */ }
  }
  return last
}

export const workPlanTool: ToolDef = {
  name: WORK_PLAN_TOOL,
  description: '当前任务有多项交付或依赖时，记录工作清单。每次发送完整清单；用户撤回任务可发空清单，不必伪报已完成。保留已完成、正在做和待做的项。按实际进展更新；清单不代替执行。需要用户回答、授权或外部条件时，用 blockedOn 说明原因并停下；条件解除后更新时省略它。简单问答和单步操作不用。',
  parameters: { type: 'object', additionalProperties: false, required: ['steps'], properties: {
    blockedOn: { type: 'string', maxLength: textLimit, description: '只有确实不能继续时才填写所缺的条件' },
    steps: { type: 'array', minItems: 0, maxItems: limit, items: { type: 'object', additionalProperties: false,
      required: ['text', 'status'], properties: { text: { type: 'string', maxLength: textLimit },
        status: { type: 'string', enum: ['pending', 'in_progress', 'done'] } } } }
  } },
  async execute(args) {
    const plan = asPlan(args)
    if (!plan) return { ok: false, message: '请提交最多 20 个不同的步骤，每项最多 160 字、单行，并指定 pending、in_progress 或 done。等待原因请用一句话描述。上次清单保持不变。' }
    return { ok: true, message: '工作清单已更新', workPlan: plan }
  }
}

export function getRunWorkPlan(repo: Pick<Repository, 'workPlanReceipts'>, runId: string): WorkPlanSnapshot | null {
  for (const row of repo.workPlanReceipts(runId)) {
    const { payload } = unwrapToolResult(row.result_json)
    if (payload?.ok !== true) continue
    const value = payload.workPlan as Partial<WorkPlanSnapshot> | undefined
    const plan = value?.version === 1 && asPlan(value)
    if (plan) return plan.steps.length ? plan : null
  }
  return null
}

// Latest accepted snapshot wins. Remove only superseded standalone bookkeeping
// exchanges; never remove user's words, assistant prose, errors or mixed tool calls.
export function compactWorkPlanHistory(messages: DsMessage[]): DsMessage[] {
  let seen = false
  const remove = new Set<number>()
  for (let i = messages.length - 1; i > 0; i--) {
    const result = messages[i], author = messages[i - 1]
    if (result.role !== 'tool' || author.role !== 'assistant' || author.tool_calls?.length !== 1) continue
    const call = author.tool_calls[0]
    if (call.name !== WORK_PLAN_TOOL || !call.id || result.tool_call_id !== call.id || messages[i + 1]?.role === 'tool') continue
    try {
      if (JSON.parse(result.content).ok !== true || !asPlan(JSON.parse(call.arguments))) continue
    } catch { continue }
    if (seen && !author.content.trim()) { remove.add(i); remove.add(i - 1) }
    seen = true
  }
  return remove.size ? messages.filter((_, i) => !remove.has(i)) : messages
}
