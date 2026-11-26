import { createHash } from 'node:crypto'
import type { ChatParams } from '../shared/types'
import { canonicalJoin } from './providerSecurity'

/** Older official OpenAI models use this stable routing hint. Newer models
 * route automatically. Never send vendor-specific fields to a proxy/alias,
 * add a prewarm request, or change cache retention/write pricing. */
export function providerPromptCacheKey(params: ChatParams, protocol: string): string | undefined {
  if (!params.provider || !['openai-chat', 'openai-responses'].includes(protocol)) return undefined
  let target: URL
  try { target = new URL(canonicalJoin(params.baseUrl ?? '', params.provider.chatPath)) } catch { return undefined }
  if (target.origin !== 'https://api.openai.com' || target.username || target.password || target.search || target.hash) return undefined
  if (target.pathname !== (protocol === 'openai-chat' ? '/v1/chat/completions' : '/v1/responses')) return undefined
  if (!/^(?:gpt-(?:4o|4\.1|5(?:\.[0-5])?)(?:-|$)|o[134](?:-|$))/.test(params.model)) return undefined
  const first = params.messages[0]
  if (first?.role !== 'system' || !first.content) return undefined
  // Reuse across turns/runs with the same frozen prefix. Dynamic conversation,
  // run IDs, timestamps and all credentials are deliberately excluded.
  const prefix = JSON.stringify({ model: params.model, system: first.content, tools: params.tools ?? [] })
  return `dw-prefix-${createHash('sha256').update(prefix).digest('hex').slice(0, 48)}`
}
