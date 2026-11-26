import { useEffect } from 'react'
import type { Settings } from '../../../shared/types'
import { useProviderRegistry } from './useProviderRegistry'

/** Both composer controls must describe the very same selected profile. */
export function useComposerRegistry(settings: Settings | null) {
  const registry = useProviderRegistry()
  useEffect(() => {
    if (settings) void registry.refreshSnapshot()
    // A directory, budget or web toggle cannot change the selected profile.
    // Legacy model/reasoning edits still require a fresh authoritative read.
  }, [registry.refreshSnapshot, settings?.model, settings?.thinkingEnabled, settings?.reasoningEffort])
  return registry
}
