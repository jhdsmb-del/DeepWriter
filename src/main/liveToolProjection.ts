import { WEB_TOOL_NAMES } from '../shared/agentToolPolicy'
import { WORK_FILE_TOOL_NAMES } from '../shared/workFileTools'
import { estimateTokens, type DsMessage } from '../shared/types'

const READ_TOOLS = new Set(['read_file', 'list_files', 'search_files', ...WORK_FILE_TOOL_NAMES, ...WEB_TOOL_NAMES])
const RECENT_TOOL_BATCHES = 2
const EXCERPT_EDGE = 1800
const LONG_RESULT_CODE_POINTS = 4096

function successfulRead(name: string, content: string): { message: string; details?: Record<string, any> } | null {
  try {
    const receipt = JSON.parse(content)
    if (receipt?.ok !== true || typeof receipt.message !== 'string') return null
    if (name === 'read_files') {
      const details = JSON.parse(receipt.message)
      if (!Array.isArray(details?.files) || !details.files.length || details.files.some((item: { ok?: unknown }) => item?.ok !== true)) return null
      return { message: receipt.message, details }
    }
    if (name === 'find_files') {
      const details = JSON.parse(receipt.message)
      if (!details?.coverage || details.coverage.unreadable !== 0 || details.coverage.unprintable_paths !== 0) return null
      return { message: receipt.message, details }
    }
    return { message: receipt.message }
  } catch { return null }
}

function continuedPage(message: string): boolean {
  // Only generated page headers, not a cursor-looking string in file body.
  const lines = message.split('\n')
  const header = message.startsWith('文件 ') ? lines[0] : /^(?:ZIP条目 |DOCX |XLSX |PPTX |PDF |EPUB )/.test(message) ? lines.slice(0, 2).join('\n') : ''
  return /(?:续读|续列)[^\n]*cursor=(?:p1|d1|o1|z1|zl1):/.test(header) ||
    /\n目录尚未列完，续列 cursor=zl1:/.test(message)
}

/** A successful last read with an explicit next locator needs body space in
 * the following request. Reserve it before selection can refill with history;
 * no floor is added to an exhausted window or to the reader's real allowance. */
export function continuedReadReserveTokens(messages: DsMessage[], availableInputTokens: number): number {
  let index = messages.length - 1
  if (messages[index]?.role !== 'tool' || availableInputTokens <= 0) return 0
  const results: DsMessage[] = []
  while (index >= 0 && messages[index].role === 'tool') results.unshift(messages[index--])
  const calls = messages[index]?.tool_calls
  if (messages[index]?.role !== 'assistant' || !calls?.length || calls.length !== results.length) return 0
  let continued = false
  for (const result of results) {
    const call = calls.find(call => call.id === result.tool_call_id)
    if (!call || !READ_TOOLS.has(call.name)) return 0
    const receipt = successfulRead(call.name, result.content)
    if (!receipt) return 0
    if (call.name === 'read_file') continued ||= continuedPage(receipt.message)
    else if (call.name === 'read_files') continued ||= Number.isSafeInteger(receipt.details?.next_index) || Boolean(receipt.details?.files.some((item: { message?: unknown }) => typeof item.message === 'string' && continuedPage(item.message)))
    else if (call.name === 'find_files') continued ||= typeof receipt.details?.next_after_path === 'string'
  }
  return continued ? Math.min(2048, Math.floor(availableInputTokens / 2)) : 0
}

export interface LiveToolProjection {
  /** These are the exact message objects in the projected provider envelope. */
  excerpts: ReadonlySet<DsMessage>
  estimatedSavedTokens: number
  /** Complete read-only batches omitted only from the automatic wire view. */
  dropped?: DsMessage[]
}

/** Fit a growing Agent tool loop without replaying full older reads. Keep
 * the newest two batches, all writes/errors and every call/result pair intact.
 * Durable turns are never edited; the model receives an explicit omission
 * notice and can request a source again when its contents are needed. */
export function fitOlderReadBatches(messages: DsMessage[], budgetTokens: number): { messages: DsMessage[]; projection: LiveToolProjection } | null {
  const tokens = (items: DsMessage[]): number => items.reduce((sum, item) => sum + estimateTokens(JSON.stringify(item)), 0)
  if (tokens(messages) <= budgetTokens) return null
  const batches: Array<{ messages: DsMessage[]; calls: string[] }> = []
  for (let index = 0; index < messages.length; index++) {
    const assistant = messages[index]
    if (assistant.role !== 'assistant' || !assistant.tool_calls?.length || assistant.tool_calls.some(call => !READ_TOOLS.has(call.name))) continue
    const expected = new Set(assistant.tool_calls.map(call => call.id))
    const group = [assistant]
    for (let next = index + 1; next < messages.length && messages[next].role === 'tool'; next++) {
      const item = messages[next]
      if (!item.tool_call_id || !expected.delete(item.tool_call_id)) break
      const call = assistant.tool_calls.find(call => call.id === item.tool_call_id)
      if (!call || !successfulRead(call.name, item.content)) break
      group.push(item)
    }
    if (!expected.size && group.length === assistant.tool_calls.length + 1) batches.push({ messages: group, calls: assistant.tool_calls.map(call => `${call.id}/${call.name}`) })
  }
  const dropped = new Set<DsMessage>()
  const calls: string[] = []
  let result = messages
  for (const batch of batches.slice(0, -RECENT_TOOL_BATCHES)) {
    for (const item of batch.messages) dropped.add(item)
    calls.push(...batch.calls)
    const notice: DsMessage = { role: 'assistant', content: `较早的 ${calls.length} 次只读工具结果已从本轮上下文省略，原记录仍保留；需要原文时请重新读取。工具记录：${calls.slice(-16).join('、')}` }
    const kept = messages.filter(item => !dropped.has(item))
    const firstAssistant = kept.findIndex(item => item.role === 'assistant')
    result = [...kept.slice(0, Math.max(0, firstAssistant)), notice, ...kept.slice(Math.max(0, firstAssistant))]
    if (tokens(result) <= budgetTokens) break
  }
  if (!dropped.size) return null
  return { messages: result, projection: { excerpts: new Set(), dropped: [...dropped], estimatedSavedTokens: Math.max(0, tokens(messages) - tokens(result)) } }
}

function readExcerpt(content: string, name: string): string {
  // Structured batch/coverage receipts must remain parseable and must never
  // lose per-item failures through a text excerpt. Successful old batches can
  // instead be omitted atomically by fitOlderReadBatches.
  if (name === 'read_files' || name === 'find_files') return content
  if (content.length <= LONG_RESULT_CODE_POINTS) return content
  try {
    const payload = JSON.parse(content) as { ok?: unknown; message?: unknown; exitCode?: unknown; backupId?: unknown } | null
    // Leave errors, artifacts, extension formats and any write receipts intact.
    if (payload?.ok !== true || typeof payload.message !== 'string' || payload.exitCode !== null || payload.backupId !== null) return content
    const chars = Array.from(payload.message)
    if (chars.length <= LONG_RESULT_CODE_POINTS) return content
    const omitted = chars.length - EXCERPT_EDGE * 2
    return JSON.stringify({ ...payload, message: chars.slice(0, EXCERPT_EDGE).join('') +
      `\n…（较早的读取结果：中间省略 ${omitted} 字，需要时可重新读取）…\n` + chars.slice(-EXCERPT_EDGE).join('') })
  } catch {
    return content
  }
}

/** Project a read-only excerpt onto the wire, never onto stored turns.
 * Only a complete assistant/tool batch has a reliable name-to-result mapping. */
export function projectOlderReadResults(messages: DsMessage[]): { messages: DsMessage[]; projection: LiveToolProjection } | null {
  let projected: DsMessage[] | undefined
  let newerBatches = 0
  let estimatedSavedTokens = 0
  const excerpts = new Set<DsMessage>()
  for (let i = messages.length - 1; i >= 0; i--) {
    const assistant = messages[i]
    if (assistant.role !== 'assistant' || !assistant.tool_calls?.length) continue
    if (++newerBatches <= RECENT_TOOL_BATCHES) continue

    const calls = new Map(assistant.tool_calls.map(call => [call.id, call.name]))
    if (calls.size !== assistant.tool_calls.length || calls.has('')) continue
    const batch: Array<{ index: number; name: string }> = []
    for (let j = i + 1; j < messages.length && messages[j].role === 'tool'; j++) {
      const id = messages[j].tool_call_id
      const name = id ? calls.get(id) : undefined
      if (!id || !name) { batch.length = 0; break }
      calls.delete(id)
      batch.push({ index: j, name })
    }
    if (calls.size || batch.length !== assistant.tool_calls.length) continue

    for (const { index, name } of batch) {
      if (!READ_TOOLS.has(name)) continue
      const message = messages[index]
      const content = readExcerpt(message.content, name)
      if (content === message.content) continue
      const saved = estimateTokens(message.content) - estimateTokens(content)
      if (saved <= 0) continue
      projected ??= messages.slice()
      const excerpt = { ...message, content }
      projected[index] = excerpt
      excerpts.add(excerpt)
      estimatedSavedTokens += saved
    }
  }
  return projected ? { messages: projected, projection: { excerpts, estimatedSavedTokens } } : null
}
