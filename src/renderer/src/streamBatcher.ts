import type { ChunkEvent } from '../../shared/types'

export interface ChatStreamEvent { id: string; ev: ChunkEvent }

/** Only adjacent text/reasoning deltas may merge; all boundaries flush first. */
export function createStreamBatcher(
  deliver: (event: ChatStreamEvent) => void,
  schedule: (flush: () => void) => () => void = (flush) => {
    const timer = setTimeout(flush, 16)
    return () => clearTimeout(timer)
  }
) {
  let pending: ChatStreamEvent | null = null
  let cancel: (() => void) | null = null
  const flush = (): void => {
    cancel?.()
    cancel = null
    const next = pending
    pending = null
    if (next) deliver(next)
  }
  return {
    push(event: ChatStreamEvent): void {
      if (event.ev.type !== 'text' && event.ev.type !== 'reasoning') { flush(); deliver(event); return }
      if (pending && (pending.id !== event.id || pending.ev.type !== event.ev.type)) flush()
      if (pending) pending = { id: event.id, ev: { ...event.ev, delta: (pending.ev.delta ?? '') + (event.ev.delta ?? '') } }
      else pending = { id: event.id, ev: { ...event.ev } }
      if (!cancel) cancel = schedule(flush)
    },
    flush,
    cancel(): void { cancel?.(); cancel = null; pending = null }
  }
}
