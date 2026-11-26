import { useEffect, useSyncExternalStore } from 'react'
import { ensureProviderRegistry, getProviderRegistrySnapshot, refreshProviderRegistry, subscribeProviderRegistry } from '../providerRegistryResource'

export function useProviderRegistry() {
  const snapshot = useSyncExternalStore(subscribeProviderRegistry, getProviderRegistrySnapshot)
  useEffect(() => { void ensureProviderRegistry() }, [])
  return { snapshot, refreshSnapshot: refreshProviderRegistry }
}
