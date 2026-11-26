import { randomUUID } from 'node:crypto'
import type { PermissionAnswer, PermissionRequestView } from '../shared/permissionRequest'

export function createPermissionRequestController(publish: (owner: number, views: PermissionRequestView[]) => void) {
  const pending = new Map<string, { owner: number; view: PermissionRequestView; finish: (answer: PermissionAnswer) => void }>()
  const list = (owner: number): PermissionRequestView[] => [...pending.values()].filter(item => item.owner === owner).map(item => item.view)
  const answer = (owner: number, id: string, value: PermissionAnswer): boolean => {
    const item = pending.get(id)
    if (!item || item.owner !== owner || value === 'allow_run' && !item.view.canAllowForRun) return false
    item.finish(value)
    return true
  }
  return {
    list,
    answer,
    cancelOwner(owner: number): void {
      for (const item of [...pending.values()]) if (item.owner === owner) item.finish('deny')
    },
    request(owner: number, input: Omit<PermissionRequestView, 'id'>, signal?: AbortSignal): Promise<PermissionAnswer> {
      if (signal?.aborted) return Promise.resolve('deny')
      return new Promise(resolve => {
        const id = randomUUID()
        const cancel = (): void => finish('deny')
        const finish = (value: PermissionAnswer): void => {
          if (!pending.delete(id)) return
          signal?.removeEventListener('abort', cancel)
          publish(owner, list(owner))
          resolve(value)
        }
        pending.set(id, { owner, view: { ...input, id }, finish })
        signal?.addEventListener('abort', cancel, { once: true })
        publish(owner, list(owner))
      })
    }
  }
}
