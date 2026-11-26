import { estimateTokens, type DsMessage } from '../shared/types'

const positive = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) > 0

/** Use accepted run/model limits only; never today's settings or a guessed
 * model-name window. Multiple frozen bounds can narrow, never enlarge. */
export function frozenToolReadWindow(config: Record<string, unknown>, profileId?: string, manifestWindow?: number): number | null {
  const windows: number[] = []
  if (positive(manifestWindow)) windows.push(manifestWindow)
  const policy = config.contextPolicy as { contextWindowTokens?: unknown } | undefined
  if (positive(policy?.contextWindowTokens)) windows.push(policy.contextWindowTokens)
  const cli = config.cliProvider as { config?: { contextWindow?: unknown } } | undefined
  if (positive(cli?.config?.contextWindow)) windows.push(cli.config.contextWindow)
  if (profileId) {
    const profiles = config.providerProfileSnapshots as Record<string, { profileId?: string; contextBudget?: { contextWindowTokens?: unknown }; model?: { contextWindow?: unknown } }> | undefined
    for (const name of ['default', 'planning', 'draft']) {
      const profile = profiles?.[name]
      if (profile?.profileId !== profileId) continue
      for (const window of [profile.contextBudget?.contextWindowTokens, profile.model?.contextWindow]) if (positive(window)) windows.push(window)
    }
  }
  return windows.length ? Math.min(...windows) : null
}

/** Budget for the next turn's tool *body*, in JSON-escaped string characters.
 * The final outgoing envelope already includes schemas, selected history and
 * live tool items. Reserve the generated assistant, next output, and bounded
 * per-result receipts before allocating body space. One escaped UTF-16 unit
 * takes at most three UTF-8 bytes; this deliberately avoids a 4 chars/token
 * guess for Chinese/JSON. The existing pre-request context gate stays final. */
export function deriveToolReadBudgetChars(input: { windowTokens: number | null; bodyJson: string | null; maxOutputTokens: number; assistant: DsMessage; toolCount: number; observedInputTokens?: number | null }): number {
  if (!positive(input.windowTokens) || !input.bodyJson || !positive(input.maxOutputTokens)) return 0
  let outputReserve = input.maxOutputTokens
  try {
    const body = JSON.parse(input.bodyJson)
    for (const key of ['max_tokens', 'max_completion_tokens', 'max_output_tokens']) if (positive(body?.[key])) outputReserve = Math.max(outputReserve, body[key])
  } catch { return 0 }
  const receipts = 256 + 384 * Math.max(1, input.toolCount)
  const inputTokens = Math.max(estimateTokens(input.bodyJson), positive(input.observedInputTokens) ? input.observedInputTokens : 0)
  const remaining = input.windowTokens - outputReserve - inputTokens - estimateTokens(JSON.stringify(input.assistant)) - receipts
  return Math.max(0, Math.floor(remaining / 3))
}
