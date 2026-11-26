import * as fs from 'node:fs'
import * as path from 'node:path'
import { execFileSync } from 'node:child_process'
import type { ElectronApplication } from '@playwright/test'

export function verifiedMainWindowUrl(raw: string): boolean {
  try {
    const url = new URL(raw)
    return url.protocol === 'file:' && /\/index\.html$/u.test(url.pathname) && !url.searchParams.has('window')
  } catch { return false }
}

/** Keep automation connections open while the real window-close coordinator
 * drains renderer IPC. Forced cleanup is always a failed acceptance result. */
export async function closeElectronGracefully(application: ElectronApplication, options: { profile: string; diagnosticsDir?: string; timeoutMs?: number }): Promise<void> {
  const child = application.process()
  const started = Date.now()
  let timer: ReturnType<typeof setTimeout> | undefined
  let onExit: ((code: number | null, signal: NodeJS.Signals | null) => void) | undefined
  try {
    const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
      if (child.exitCode !== null || child.signalCode !== null) { resolve({ code: child.exitCode, signal: child.signalCode }); return }
      onExit = (code, signal) => resolve({ code, signal })
      child.once('exit', onExit)
    })
    if (child.exitCode === null && child.signalCode === null) {
      const windows = await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map(window => ({ id: window.id, url: window.webContents.getURL() })))
      if (options.diagnosticsDir) {
        fs.mkdirSync(options.diagnosticsDir, { recursive: true })
        fs.writeFileSync(path.join(options.diagnosticsDir, `shutdown-windows-${child.pid}.json`), JSON.stringify(windows, null, 2) + '\n')
      }
      const mainWindowId = windows.find(window => verifiedMainWindowUrl(window.url))?.id ?? null
      // Do not call Playwright app.close() yet: it closes its Node connection
      // immediately after app.quit(), while the coordinator still awaits IPC.
      void application.evaluate(({ app, BrowserWindow }, verifiedId) => {
        const main = verifiedId === null ? null : BrowserWindow.fromId(verifiedId)
        if (main) main.close()
        else app.quit()
      }, mainWindowId).catch(() => undefined) // A natural exit can dispose this RPC's context.
    }
    const outcome = await Promise.race([exited, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('Electron did not exit naturally within the shutdown deadline')), options.timeoutMs ?? 15_000)
    })])
    if (outcome.code !== 0 || outcome.signal !== null) throw new Error('Electron exited abnormally during shutdown acceptance')
    await application.close().catch(() => undefined) // Dispose only after actual process exit.
    console.log(`[closeApp] natural exit in ${Date.now() - started}ms`)
  } catch (error) {
    let events: string[] = []
    try {
      const trace = JSON.parse(fs.readFileSync(path.join(options.profile, 'shutdown-trace-progress.json'), 'utf8')) as Array<{ event: string }>
      events = trace.map((entry) => entry.event).slice(-30)
    } catch { /* A startup failure may precede shutdown tracing. */ }
    const diagnostic = { pid: child.pid, elapsedMs: Date.now() - started, events, forcedCleanup: child.exitCode === null && child.signalCode === null }
    console.error(`[closeApp] FAIL ${JSON.stringify(diagnostic)}`)
    if (options.diagnosticsDir) {
      fs.mkdirSync(options.diagnosticsDir, { recursive: true })
      fs.writeFileSync(path.join(options.diagnosticsDir, `shutdown-${child.pid}.json`), JSON.stringify(diagnostic, null, 2) + '\n')
    }
    if (diagnostic.forcedCleanup && child.pid !== undefined) {
      try {
        if (process.platform === 'win32') execFileSync('taskkill', ['/F', '/T', '/PID', String(child.pid)], { stdio: 'ignore' })
        else child.kill('SIGKILL')
      } catch { /* The owned child may have exited while recording diagnostics. */ }
    }
    throw error
  } finally {
    clearTimeout(timer)
    if (onExit) child.removeListener('exit', onExit)
  }
}
