import { estimateTokens, type DsMessage } from '../../shared/types'
import { WORK_PLAN_TOOL } from '../../shared/workPlan'
import { latestActivePlan, WORK_PLAN_CONTINUE } from '../workPlan'
import type { TurnRecord } from './types'

export const AGENT_OUTPUT_PART = 'agent_output_part_v1'
export const AGENT_OUTPUT_CONTINUE = '上一次回复达到模型单次输出长度，前段已保留。从断点直接接着回答，不要重述开头。'
export const AGENT_TOOL_REISSUE = '上一轮工具调用在参数传完前被截断，没有执行。若仍需要该操作，请重新给出完整参数；不要重做已经成功的工具操作。'

// No run-wide counter. Ask again after genuine work, not after a restated
// progress message or another identical read. Compare actual paired receipts.
export function progressSinceReminder(messages: DsMessage[]): boolean {
  const at = messages.findLastIndex(m => m.role === 'system' && m.content === WORK_PLAN_CONTINUE)
  if (at < 0 || messages.slice(at + 1).some(m => m.role === 'user')) return true
  const previous = latestActivePlan(messages.slice(0, at))
  if (JSON.stringify(previous) !== JSON.stringify(latestActivePlan(messages))) return true
  const receipts = new Set<string>()
  let calls: DsMessage['tool_calls']
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i]
    if (m.role !== 'tool') { calls = m.role === 'assistant' ? m.tool_calls : undefined; continue }
    const call = calls?.find(c => c.id === m.tool_call_id)
    if (!call || call.name === WORK_PLAN_TOOL) continue
    try { if (JSON.parse(m.content).ok !== true) continue } catch { continue }
    const key = JSON.stringify([call.name,call.arguments,m.content])
    if (i > at && !receipts.has(key)) return true
    receipts.add(key)
  }
  return false
}

// Keep only the current output chain small on the wire. Tool observations,
// preceding user turns and saved assistant text are never shortened on disk.
export function projectAgentOutputTail(turns: TurnRecord[], inputTokens: number): TurnRecord[] {
  const tail = turns.at(-1)
  if (tail?.role !== 'system' || tail.content !== AGENT_OUTPUT_CONTINUE) return turns
  let start = turns.length - 1
  while (start >= 1 && turns[start].role === 'system' && turns[start].content === AGENT_OUTPUT_CONTINUE &&
    turns[start - 1].role === 'assistant' && turns[start - 1].planState === AGENT_OUTPUT_PART) start -= 2
  const chunks = turns.slice(start + 1).filter(t => t.role === 'assistant')
  if (!chunks.length) return turns
  const budget = Math.max(32, Math.floor(inputTokens / 3))
  // estimateTokens assigns at least 1/4 token per code point (at most
  // two UTF-16 units). Don't copy a 100-iteration answer just to take its tail.
  const parts: string[] = []
  let units = budget * 8, omitted = false
  for (let i = chunks.length - 1; i >= 0; --i) {
    const part = chunks[i].content
    if (part.length > units) {
      let begin = part.length - units
      if (begin && /[\\uDC00-\\uDFFF]/u.test(part[begin] ?? '')) begin++
      parts.push(part.slice(begin)); omitted = true; break
    }
    parts.push(part); units -= part.length
  }
  const text = parts.reverse().join('')
  if (!omitted && estimateTokens(text) <= budget && chunks.length < 4) return turns
  const chars = Array.from(text)
  let lo = 0, hi = chars.length
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2)
    if (estimateTokens(chars.slice(-mid).join('')) <= budget) lo = mid
    else hi = mid - 1
  }
  const content = !omitted && lo === chars.length ? text : '[前段已存入本任务答复，这里接最后一段]\n' + (lo ? chars.slice(-lo).join('') : '')
  return [...turns.slice(0, start + 1), { ...chunks.at(-1)!, content, reasoningContent: undefined }, tail]
}
