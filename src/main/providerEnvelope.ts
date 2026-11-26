import { createHash } from 'node:crypto'
import type { DsMessage } from '../shared/types'

/** Canonical identity of the exact ordered provider envelope.  Every sender
 * and durable Working Set binding must use this byte/role-aware encoding. */
export function providerEnvelopeHash(messages: readonly DsMessage[]): string {
  return createHash('sha256')
    .update(messages.map((message) => `${message.role.length}:${message.role}${Buffer.byteLength(message.content ?? '', 'utf8')}:${message.content ?? ''}`).join('|'), 'utf8')
    .digest('hex')
}
