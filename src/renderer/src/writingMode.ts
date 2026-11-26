export type WorkspaceKey = 'chat' | 'novel' | 'style' | 'galgame' | 'runs'
export type ComposerMode = 'agent' | 'longwrite' | 'style' | 'galgame'

export interface WritingUiModeState {
  workspace: WorkspaceKey
  mode: ComposerMode
  longMode: boolean
}

export interface WritingRunMode {
  workspace: WorkspaceKey
  mode: ComposerMode
  longMode: boolean
}

export function transitionComposerMode(state: WritingUiModeState, mode: ComposerMode): WritingUiModeState {
  if (mode === 'longwrite') return { workspace: 'novel', mode, longMode: true }
  if (mode === 'style') return { workspace: 'style', mode, longMode: false }
  if (mode === 'galgame') return { workspace: 'galgame', mode, longMode: false }
  return { workspace: 'chat', mode: 'agent', longMode: false }
}

export function transitionWorkspace(state: WritingUiModeState, workspace: WorkspaceKey): WritingUiModeState {
  if (workspace === 'novel') return { workspace, mode: 'longwrite', longMode: true }
  if (workspace === 'style') return { workspace, mode: 'style', longMode: false }
  if (workspace === 'galgame') return { workspace, mode: 'galgame', longMode: false }
  return { ...state, workspace }
}

export function transitionLongMode(state: WritingUiModeState, enabled: boolean): WritingUiModeState {
  if (enabled) return { workspace: 'novel', mode: 'longwrite', longMode: true }
  if (state.mode === 'longwrite' || state.workspace === 'novel') return { workspace: 'chat', mode: 'agent', longMode: false }
  return { ...state, longMode: false }
}

export function deriveWritingRunMode(state: WritingUiModeState): WritingRunMode {
  const exactLongwrite = state.longMode || state.mode === 'longwrite' || state.workspace === 'novel'
  if (exactLongwrite) return { workspace: 'novel', mode: 'longwrite', longMode: true }
  return { workspace: state.workspace, mode: state.mode, longMode: false }
}

export const LONG_TARGET_PRESETS = [8000, 20000, 50000, 100000] as const
export const LONG_TARGET_MAX = 2000000

export function normalizeLongTarget(value: number): number {
  return Number.isFinite(value) ? Math.min(LONG_TARGET_MAX, Math.max(2000, Math.trunc(value))) : 2000
}
