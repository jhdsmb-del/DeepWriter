export type DesktopInstallKind = 'development' | 'nsis' | 'portable' | 'unpacked' | 'unsupported'
export type DesktopUpdatePhase = 'idle' | 'checking' | 'downloading' | 'ready' | 'available' | 'current' | 'error' | 'restarting'
export interface DesktopUpdateState {
  installKind: DesktopInstallKind
  currentVersion: string
  phase: DesktopUpdatePhase
  autoCheck: boolean
  version: string | null
  progress: number | null
  checkedAt: number | null
  message: string
  portableUrl: string | null
}
