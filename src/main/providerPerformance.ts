import { randomUUID } from 'node:crypto'
import type { ChunkEvent } from '../shared/types'
import type { ProviderPerformanceSnapshot, ProviderPerformanceUsage } from '../shared/performanceTelemetry'

const count = (value: unknown): number | null => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null
const record = (value: unknown): Record<string, any> => value && typeof value === 'object' ? value as Record<string, any> : {}
export const unknownPerformanceUsage = (): ProviderPerformanceUsage => ({ inputTokens: null, outputTokens: null, cache: { status: 'unknown', inputTokens: null, hitTokens: null, missTokens: null, writeTokens: null, hitRate: null } })

/** Protocol-specific reporting, separate from the legacy billing vocabulary.
 * Anthropic input excludes cache reads/writes; OpenAI input includes them.
 * Sparse streaming usage updates preserve earlier input/cache evidence. */
export function readPerformanceUsage(protocol: string, raw: unknown, previous = unknownPerformanceUsage()): ProviderPerformanceUsage {
  const json = record(raw)
  const u = record(json.response?.usage ?? json.message?.usage ?? json.usage)
  if (!Object.keys(u).length) return previous
  let input = previous.inputTokens
  const output = count(u.output_tokens ?? u.completion_tokens) ?? previous.outputTokens
  let hit = previous.cache.hitTokens
  let miss = previous.cache.missTokens
  let write = previous.cache.writeTokens
  if (protocol === 'anthropic-messages') {
    hit = count(u.cache_read_input_tokens) ?? hit
    write = count(u.cache_creation_input_tokens) ?? write
    // Recover uncached remainder from the prior total on output-only updates.
    const uncached = count(u.input_tokens) ?? (input !== null && hit !== null && write !== null ? input - hit - write : null)
    if (uncached !== null && uncached >= 0 && hit !== null && write !== null) {
      input = uncached + hit + write
      miss = uncached + write
    } else if (count(u.input_tokens) !== null) input = null // incomplete total, not a fake zero-cache input
  } else {
    input = count(u.input_tokens ?? u.prompt_tokens) ?? input
    const details = record(u.input_tokens_details ?? u.prompt_tokens_details)
    hit = count(details.cached_tokens ?? u.prompt_cache_hit_tokens) ?? hit
    write = count(details.cache_write_tokens) ?? write
    const explicitMiss = count(u.prompt_cache_miss_tokens)
    miss = explicitMiss ?? (input !== null && hit !== null && hit <= input ? input - hit : miss)
  }
  const known = input !== null && hit !== null && miss !== null && hit + miss === input && (write === null || write <= miss)
  return { inputTokens: input, outputTokens: output, cache: { status: known ? 'reported' : 'unknown', inputTokens: input, hitTokens: hit, missTokens: miss, writeTokens: write, hitRate: known && input !== null && input > 0 && hit !== null ? hit / input : null } }
}

type Lifecycle =
  | { type: 'started'; innerAttempt: number; startedAt: number }
  | { type: 'first_token'; innerAttempt: number; firstTokenAt: number }
  | { type: 'terminal'; innerAttempt: number; outcome: string; performanceUsage?: ProviderPerformanceUsage }

const weight = (text: string): number => {
  let sum = 0
  for (const ch of text) { const code = ch.codePointAt(0)!; sum += code >= 0x3000 && code <= 0x9fff ? 4 : 1 }
  return sum
}
const high = (code: number): boolean => code >= 0xd800 && code <= 0xdbff
const low = (code: number): boolean => code >= 0xdc00 && code <= 0xdfff
type FieldWeight = { units: number; first: number; last: number; length: number }
const emptyWeight = (): FieldWeight => ({ units: 0, first: NaN, last: NaN, length: 0 })
const appendWeight = (field: FieldWeight, delta: string): void => {
  if (!delta.length) return
  const first = delta.charCodeAt(0)
  // A surrogate pair can straddle SSE fragments. It contributes one "other"
  // code point, not two; CJK weights remain exactly the existing estimator.
  field.units += weight(delta) - (high(field.last) && low(first) ? 1 : 0)
  if (!field.length) field.first = first
  field.last = delta.charCodeAt(delta.length - 1)
  field.length += delta.length
}
type ToolWeight = { tool: NonNullable<ChunkEvent['tool']>; name: string; arguments: string; units: number }
// Process-local only: public events retain precisely their cumulative tool
// snapshots. A clone, replacement or older producer simply uses the scanner.
const toolWeights = new WeakMap<ChunkEvent, ToolWeight>()
export function createToolOutputMeter(): { name(delta: string): void; arguments(delta: string): void; event(event: ChunkEvent): ChunkEvent } {
  const name = emptyWeight(), args = emptyWeight()
  return {
    name(delta) { appendWeight(name, delta) },
    arguments(delta) { appendWeight(args, delta) },
    event(event) {
      if (event.tool) toolWeights.set(event, { tool: event.tool, name: event.tool.name, arguments: event.tool.arguments,
        units: name.units + args.units - (high(name.last) && low(args.first) ? 1 : 0) })
      return event
    }
  }
}

/** One sampler for all wire protocols. No content, key, or tokenizer requests
 * leave this collector. Clock injection makes the sampling interval testable. */
export function createProviderPerformance(
  emit: (snapshot: ProviderPerformanceSnapshot) => void,
  clock = () => performance.now(),
  requestId = randomUUID()
): { lifecycle(event: Lifecycle): void; chunk(event: ChunkEvent): void; close(): void } {
  let started = 0
  let startedAt = 0
  let first: number | null = null
  let attempt = 0
  let revision = 0
  let units = 0
  let timer: ReturnType<typeof setInterval> | undefined
  let active = false
  let samples: Array<{ at: number; units: number }> = []
  const tools = new Map<number, number>()
  const clear = (): void => { clearInterval(timer); timer = undefined }
  const snapshot = (status: ProviderPerformanceSnapshot['status'], usage = unknownPerformanceUsage()): void => {
    const at = Math.max(started, clock())
    const elapsedMs = at - started
    const left = Math.max(started, at - 1000)
    // Keep only output observed in (left, at], not one token per SSE chunk.
    samples = samples.filter(sample => sample.at > left)
    const windowMs = at - left
    const windowOutputTokens = samples.reduce((sum, sample) => sum + sample.units, 0) / 4
    emit({ requestId, attempt, revision: ++revision, status, startedAt, elapsedMs, ttftMs: first === null ? null : first - started,
      estimateMethod: 'visible_cjk_1_other_quarter_v1', estimatedOutputTokens: Math.ceil(units / 4), windowMs, windowOutputTokens,
      estimatedTokensPerSecond: first !== null && windowMs >= 250 ? windowOutputTokens * 1000 / windowMs : null,
      actualTokensPerSecond: usage.outputTokens !== null && elapsedMs > 0 ? usage.outputTokens * 1000 / elapsedMs : null, ...usage })
  }
  return {
    lifecycle(event) {
      if (event.type === 'started') {
        clear(); attempt = event.innerAttempt; started = clock(); startedAt = event.startedAt; first = null; units = 0; samples = []; tools.clear(); active = true
        snapshot('waiting')
        timer = setInterval(() => { if (active) snapshot(first === null ? 'waiting' : 'streaming') }, 250)
        timer.unref?.()
      } else if (event.type === 'terminal' && active && event.innerAttempt === attempt) {
        active = false; clear()
        snapshot(event.outcome === 'success' ? 'completed' : event.outcome === 'cancelled' ? 'cancelled' : 'failed', event.performanceUsage)
      }
    },
    chunk(event) {
      if (!active) return
      let increment = 0
      if (event.type === 'text' || event.type === 'reasoning') increment = weight(event.delta ?? '')
      else if (event.type === 'tool_call' && event.tool) {
        const measured = toolWeights.get(event)
        const next = measured?.tool === event.tool && measured.name === event.tool.name && measured.arguments === event.tool.arguments
          ? measured.units : weight(event.tool.name + event.tool.arguments)
        const previous = tools.get(event.tool.index) ?? 0
        tools.set(event.tool.index, next)
        increment = Math.max(0, next - previous)
      }
      if (increment <= 0) return
      units += increment
      samples.push({ at: clock(), units: increment })
      if (first === null) { first = clock(); snapshot('streaming') }
    },
    close() { clear(); if (active) { active = false; snapshot('failed') } }
  }
}
