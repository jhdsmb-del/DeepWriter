import type { DsMessage } from '../shared/types'

/** Remove the single user turn already supplied by the context assembler.
 * A later genuine user message with identical text remains a distinct turn. */
export function withoutCanonicalUser(messages: DsMessage[], content: string | null | undefined): DsMessage[] {
  if (content === null || content === undefined) return messages
  const index = messages.findIndex(message => message.role === 'user' && message.content === content)
  return index < 0 ? messages : messages.filter((_, position) => position !== index)
}
