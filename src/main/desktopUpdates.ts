import type { DesktopInstallKind, DesktopUpdateState } from '../shared/desktopUpdates'
import { getStableRelease, isNewerVersion } from '../shared/publicRelease'

/** Only an installer-created marker beside this executable identifies NSIS.
 * app-update.yml also exists in fresh win-unpacked and is not installation evidence. */
export function desktopInstallKind(input: { packaged: boolean; platform: string; portable: boolean; marker: string | null }): DesktopInstallKind {
  if (!input.packaged) return 'development'
  if (input.platform !== 'win32') return 'unsupported'
  if (input.portable) return 'portable'
  return input.marker?.trim() === 'nsis' ? 'nsis' : 'unpacked'
}

export interface DesktopUpdateBackend {
  on(event: string, listener: (...args: any[]) => void): unknown
  checkForUpdates(): Promise<{ updateInfo: { version: string } } | null>
  downloadUpdate(): Promise<unknown>
  quitAndInstall(isSilent: boolean, isForceRunAfter: boolean): void
}
interface Dependencies {
  kind: DesktopInstallKind
  version: string
  autoCheck: boolean
  backend?: DesktopUpdateBackend
  publish(state: DesktopUpdateState): void
  busy(): boolean
  /** Reserves the IPC admission barrier synchronously, then schedules graceful shutdown. */
  prepareRestart(): boolean
  stableRelease?: typeof getStableRelease
}

/** Downloads are independent of writing; installation is never an exit side effect. */
export class DesktopUpdates {
  private state: DesktopUpdateState
  private checking: Promise<DesktopUpdateState> | null = null
  private timer?: ReturnType<typeof setTimeout>
  private interval?: ReturnType<typeof setInterval>
  constructor(private readonly deps: Dependencies) {
    this.state = {
      installKind: deps.kind, currentVersion: deps.version, autoCheck: deps.autoCheck,
      phase: 'idle', version: null, progress: null, checkedAt: null, portableUrl: null,
      message: deps.kind === 'development' ? '开发模式不检查更新。' : deps.kind === 'nsis' ? '更新会在后台下载，由你决定何时重启。' : '此版本不支持原地更新；可检查并下载最新便携版。'
    }
    deps.backend?.on('download-progress', (progress: { percent: number }) => {
      if (this.state.phase === 'downloading') this.set({ progress: Number.isFinite(progress.percent) ? Math.min(100, Math.max(0, progress.percent)) : null })
    })
    // electron-updater also emits errors while rejecting check/download promises.
    // Listening prevents an unhandled EventEmitter error; the operation reports once.
    deps.backend?.on('error', () => {})
  }
  snapshot(): DesktopUpdateState { return { ...this.state } }
  private set(patch: Partial<DesktopUpdateState>): DesktopUpdateState {
    this.state = { ...this.state, ...patch }; this.deps.publish(this.snapshot()); return this.snapshot()
  }
  start(): void {
    if (this.deps.kind === 'development' || this.deps.kind === 'unsupported') return
    this.timer = setTimeout(() => { if (this.state.autoCheck) void this.check() }, 20_000)
    this.interval = setInterval(() => { if (this.state.autoCheck) void this.check() }, 6 * 60 * 60 * 1000)
    this.timer.unref?.(); this.interval.unref?.()
  }
  stop(): void { clearTimeout(this.timer); clearInterval(this.interval) }
  preference(autoCheck: boolean): DesktopUpdateState { return this.set({ autoCheck }) }
  check(): Promise<DesktopUpdateState> {
    if (this.checking) return this.checking
    if (this.state.phase === 'ready' || this.state.phase === 'restarting' || this.deps.kind === 'development' || this.deps.kind === 'unsupported') return Promise.resolve(this.snapshot())
    this.checking = this.performCheck().finally(() => { this.checking = null })
    return this.checking
  }
  private async performCheck(): Promise<DesktopUpdateState> {
    this.set({ phase: 'checking', message: '正在检查公开稳定版…', progress: null })
    try {
      if (this.deps.kind === 'nsis') {
        const backend = this.deps.backend
        if (!backend) throw new Error('missing updater')
        const result = await backend.checkForUpdates()
        if (!result) throw new Error('update feed unavailable')
        const version = result.updateInfo.version
        if (!isNewerVersion(version, this.deps.version)) return this.set({ phase: 'current', checkedAt: Date.now(), version: null, message: '已是最新稳定版。' })
        this.set({ phase: 'downloading', checkedAt: Date.now(), version, progress: 0, message: `正在后台下载 ${version}，可以继续写作。` })
        await backend.downloadUpdate()
        return this.set({ phase: 'ready', progress: 100, message: `${version} 已下载。完成写作后，可重启并安装。` })
      }
      const release = await (this.deps.stableRelease ?? getStableRelease)()
      if (!isNewerVersion(release.version, this.deps.version)) return this.set({ phase: 'current', checkedAt: Date.now(), version: null, portableUrl: null, message: '已是最新稳定版。' })
      if (!release.portableUrl) throw new Error('portable asset missing')
      return this.set({ phase: 'available', version: release.version, checkedAt: Date.now(), portableUrl: release.portableUrl, message: `发现 ${release.version}。下载新的便携版后手动替换程序；不会覆盖当前程序。` })
    } catch {
      return this.set({ phase: 'error', progress: null, message: '更新检查或下载失败。请检查网络后重试；当前版本仍可继续使用。' })
    }
  }
  restart(): { ok: boolean; message: string } {
    if (this.state.phase !== 'ready' || this.deps.kind !== 'nsis') return { ok: false, message: '尚无已下载的安装更新。' }
    if (this.deps.busy()) return { ok: false, message: '仍有任务或操作正在进行，请完成后再重启。' }
    if (!this.deps.prepareRestart()) return { ok: false, message: '应用正在退出，请稍后重试。' }
    this.set({ phase: 'restarting', message: '正在保存草稿并准备重启…' })
    return { ok: true, message: '正在准备重启。' }
  }
  restartCancelled(message: string): void { this.set({ phase: 'ready', message }) }
  /** Called only by the sole shutdown coordinator after all safety barriers. */
  installPrepared(): void { this.deps.backend?.quitAndInstall(false, true) }
}
