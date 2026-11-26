/** Public metadata only. Runtime grants and executable paths stay in main. */
import type { IpcResult } from './providerRegistry'
export interface ExtensionFileView { path: string; size: number; sha256: string }
export interface ExtensionView {
  id: string
  name: string
  kind: 'skill' | 'tool'
  version: string
  description: string
  source: string
  packageHash: string
  files: ExtensionFileView[]
  entry?: string
  enabled: boolean
  removed: boolean
  firstParty: boolean
  license: string
  requestedPermissions: string[]
  blockedReason?: string
}
export interface ExtensionCatalogView {
  id: string
  name: string
  kind: 'skill' | 'tool'
  version: string
  description: string
  source?: string
  firstParty?: boolean
  license?: string
  requestedPermissions?: string[]
  fileCount?: number
}
export interface ExtensionSelection { skills: string[]; plugins: string[] }
export interface ExtensionsSnapshot {
  registryDir: string
  catalog: ExtensionCatalogView[]
  installed: ExtensionView[]
  selectedForNewRuns: ExtensionSelection
}
export interface ExtensionsApi {
  extensionsSnapshot(): Promise<IpcResult<ExtensionsSnapshot>>
  extensionsInstallCatalog(id: string): Promise<IpcResult<ExtensionView>>
  extensionsImportSkill(): Promise<IpcResult<ExtensionView | null>>
  extensionsSetEnabled(id: string, enabled: boolean): Promise<IpcResult<ExtensionView>>
  extensionsRemove(id: string): Promise<IpcResult<void>>
  extensionsInspect(id: string): Promise<IpcResult<ExtensionView>>
  extensionsSetSelection(selection: ExtensionSelection): Promise<IpcResult<ExtensionSelection>>
}
