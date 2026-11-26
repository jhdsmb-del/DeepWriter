import type { ProviderRegistrySnapshot } from '../../shared/providerRegistry'

// Renderer-local, read-only metadata. Secrets never appear in this snapshot.
// Composer and settings share one value and one in-flight IPC read, rather
// than rebuilding the provider/model catalog whenever a surface mounts.
let snapshot: ProviderRegistrySnapshot | null = null
let pending: Promise<ProviderRegistrySnapshot | null> | null = null
let revision = 0
let listening = false
const subscribers = new Set<() => void>()

export const getProviderRegistrySnapshot = (): ProviderRegistrySnapshot | null => snapshot

export function refreshProviderRegistry(): Promise<ProviderRegistrySnapshot | null> {
  if (pending) return pending
  const ticket = revision
  const request = (async (): Promise<ProviderRegistrySnapshot | null> => {
    try {
      const result = await window.ds?.providerSnapshot?.()
      // A mutation invalidates reads started before it. Their consumers also
      // wait for the newer request, instead of receiving an obsolete profile.
      if (ticket !== revision) return pending ?? snapshot
      if (result?.ok) {
        snapshot = result.data
        for (const subscriber of subscribers) subscriber()
      }
    } catch { /* Retain the last usable catalog; a later read can retry. */ }
    return snapshot
  })()
  pending = request
  void request.finally(() => { if (pending === request) pending = null })
  return request
}

export function invalidateProviderRegistry(): Promise<ProviderRegistrySnapshot | null> {
  revision++
  pending = null
  return refreshProviderRegistry()
}

export const ensureProviderRegistry = (): Promise<ProviderRegistrySnapshot | null> => pending ?? (snapshot ? Promise.resolve(snapshot) : refreshProviderRegistry())

export function subscribeProviderRegistry(subscriber: () => void): () => void {
  subscribers.add(subscriber)
  if (!listening) {
    listening = true
    // One listener for this renderer's lifetime also catches changes while
    // the composer is temporarily unmounted in the task/longform workspace.
    const invalidate = (): void => { void invalidateProviderRegistry() }
    window.addEventListener('deepwriter:provider-registry-changed', invalidate)
    window.addEventListener('focus', invalidate)
  }
  return () => { subscribers.delete(subscriber) }
}
