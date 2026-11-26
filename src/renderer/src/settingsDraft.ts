import type { Settings } from '../../shared/types'
import type { SettingsPatch } from './store'

/** A dialog saves the fields the user edited, preserving newer main settings. */
export function changedSettings(baseline: Settings, draft: SettingsPatch): SettingsPatch {
  const patch: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(draft)) {
    if (key === 'galgame' && value && typeof value === 'object') {
      const changed = Object.fromEntries(Object.entries(value).filter(([field, next]) => JSON.stringify(next) !== JSON.stringify((baseline.galgame as unknown as Record<string, unknown>)[field])))
      if (Object.keys(changed).length) patch.galgame = changed
    } else if (JSON.stringify(value) !== JSON.stringify((baseline as unknown as Record<string, unknown>)[key])) {
      patch[key] = value
    }
  }
  return patch as SettingsPatch
}
