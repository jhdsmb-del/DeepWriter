// Keep React.lazy and intent prefetch on exactly the same import promise.
// Failed prefetches can be retried when the user actually opens the panel.
let settings: ReturnType<typeof importSettings> | undefined
let inspector: ReturnType<typeof importInspector> | undefined
const importSettings = () => import('./components/SettingsModal')
const importInspector = () => import('./components/RunInspector/RunInspector')

export const loadSettingsPanel = () => settings ??= importSettings().catch(error => { settings = undefined; throw error })
export const loadInspectorPanel = () => inspector ??= importInspector().catch(error => { inspector = undefined; throw error })
export const prefetchSettingsPanel = (): void => { void loadSettingsPanel().catch(() => undefined) }
export const prefetchInspectorPanel = (): void => { void loadInspectorPanel().catch(() => undefined) }
