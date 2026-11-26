import { randomUUID } from 'node:crypto'

interface DraftWindow {
  id: number
  isDestroyed(): boolean
  send(channel: string, payload: unknown): void
}

/** A reply can release only its own main window's current shutdown barrier. */
export function createDraftFlushBarrier(timeoutMs = 2000) {
  const pending = new Map<string, { senderId: number; finish: (ok: boolean) => void }>()
  return {
    request(window: DraftWindow): Promise<boolean> {
      if (window.isDestroyed()) return Promise.resolve(true)
      return new Promise((resolve) => {
        const token = randomUUID()
        const timer = setTimeout(() => finish(false), timeoutMs)
        const finish = (ok: boolean): void => { clearTimeout(timer); pending.delete(token); resolve(ok) }
        pending.set(token, { senderId: window.id, finish })
        try { window.send('composer:flushRequested', { token }) } catch { finish(false) }
      })
    },
    acknowledge(senderId: number, token: string, ok: boolean): boolean {
      const request = pending.get(token)
      if (!request || request.senderId !== senderId) return false
      request.finish(ok)
      return true
    }
  }
}
