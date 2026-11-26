import { promises as fs } from 'node:fs'
import * as path from 'node:path'
import { spawn, type ChildProcess } from 'node:child_process'
import { spawnTracked } from './childRegistry'
import { resolveRenpySdkLayout, validateRenpySdkLayout, runRenpyLint, type RenpySdkLayout, type SdkCommandRunner } from './renpySdk'
import type { GalgameStudioState, GalgameStudioPlaytestResult } from '../shared/galgameStudio'

export interface GalgameStudioPlaytestDeps {
  getStudio: (studioId: string) => Promise<GalgameStudioState | null>
  isAuthorizedDir: (projectDir: string) => Promise<boolean>
  confirmExecution: (project: { projectDir: string; projectName: string; sdkVersion?: string }) => Promise<boolean>
  // Main-process-only seams for isolated process/lifecycle tests.
  resolveSdk?: typeof resolveRenpySdkLayout
  validateSdk?: typeof validateRenpySdkLayout
  lint?: typeof runRenpyLint
  spawnProcess?: typeof spawnTracked
  startupObservationMs?: number
  stopTimeoutMs?: number
}

interface PlaytestRecord {
  child: ChildProcess | null
  result: GalgameStudioPlaytestResult
  stopRequested: boolean
  settled: Promise<void>
}

interface PreparationChild { child: ChildProcess; settled: Promise<void> }

const stopped = (message?: string): GalgameStudioPlaytestResult => ({ status: 'stopped', ...(message ? { message } : {}) })
const failed = (message: string): GalgameStudioPlaytestResult => ({ status: 'failed', message })
const keyFor = (value: string): string => process.platform === 'win32' ? value.toLowerCase() : value
function eligibleProject(state: GalgameStudioState): boolean {
  if (state.production?.integration === 'required') return false
  // Existing imported works can be tried as-is after a fresh real lint. This
  // does not complete any of the Studio's new-story production stages.
  if (state.projectMode === 'import' && !state.generatedFile) return true
  return state.stage === 'done' && Boolean(state.generatedFile) && state.production?.status === 'agent_applied' && state.lint?.ok === true && state.lint.verified
}
async function waitAtMost(work: Promise<void>, ms: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try { await Promise.race([work, new Promise<void>(resolve => { timer = setTimeout(resolve, ms) })]) }
  finally { clearTimeout(timer) }
}

/** Both Ren'Py 7 and 8 accept basedir + run. Invoke the bundled interpreter
 * directly, not the launcher executable (which can exit before the game does).
 * A relative SDK entrypoint also avoids Python 2 Windows argv encoding issues. */
export async function renpyPlaytestCommand(layout: RenpySdkLayout, projectDir: string): Promise<{ command: string; args: string[]; cwd: string }> {
  const guiPython = path.join(path.dirname(layout.pythonPath), 'pythonw.exe')
  // SDK's GUI interpreter avoids a stray console. Crucially, SW_HIDE must not
  // be used here: SDL inherits it and can render an entirely invisible game.
  const command = process.platform === 'win32' && (await fs.stat(guiPython).catch(() => null))?.isFile() ? guiPython : layout.pythonPath
  return {
    command,
    args: [path.relative(layout.root, layout.renpyScriptPath).replace(/\\/g, '/'), projectDir, 'run'],
    cwd: layout.root
  }
}

/** Terminate only this service's child tree; never stop unrelated agent jobs. */
async function terminateOwnedTree(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null || !child.pid) return
  if (process.platform === 'win32') {
    await new Promise<void>(resolve => {
      const killer = spawn(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe'), ['/PID', String(child.pid), '/T', '/F'], { shell: false, windowsHide: true, stdio: 'ignore' })
      killer.once('error', () => resolve())
      killer.once('close', () => resolve())
    })
  } else {
    try { process.kill(-child.pid, 'SIGKILL') } catch { try { child.kill('SIGKILL') } catch { /* already exited */ } }
  }
}

/** Runtime truth is an owned process, not a persisted Studio/UI flag. A real
 * project path is the unit of ownership, including multiple Studio imports. */
export class GalgameStudioPlaytestService {
  private readonly records = new Map<string, PlaytestRecord>()
  private readonly studioProjects = new Map<string, string>()
  private readonly operations = new Map<string, Promise<unknown>>()
  private readonly stops = new Map<string, Promise<GalgameStudioPlaytestResult>>()
  private readonly attempts = new Map<string, AbortController>()
  private readonly preparations = new Map<string, Set<PreparationChild>>()
  private readonly epochs = new Map<string, number>()
  private readonly consent = new Set<string>()
  private readonly consentRequests = new Map<string, Promise<boolean>>()
  private readonly earlyResults = new Map<string, GalgameStudioPlaytestResult>()
  private closing = false

  constructor(private readonly deps: GalgameStudioPlaytestDeps) {}

  /** The same explicit project trust decision guards lint, repair and playtest.
   * Reading/importing a directory does not implicitly grant code execution. */
  async confirmProjectExecution(projectDir: string, projectName?: string, sdkVersion?: string): Promise<boolean> {
    if (this.closing) return false
    const root = await fs.realpath(projectDir)
    if (!(await this.deps.isAuthorizedDir(root))) throw new Error('项目目录未授权，请通过目录选择器重新选择。')
    const key = keyFor(root)
    if (this.consent.has(key)) return true
    const pending = this.consentRequests.get(key)
    if (pending) return pending
    const request = (async () => {
      const approved = await this.deps.confirmExecution({ projectDir: root, projectName: projectName || path.basename(root), sdkVersion })
      if (!approved || this.closing || !(await this.deps.isAuthorizedDir(root)) || keyFor(await fs.realpath(projectDir)) !== key) return false
      this.consent.add(key)
      return true
    })()
    this.consentRequests.set(key, request)
    try { return await request } finally { this.consentRequests.delete(key) }
  }

  /** SDK probes and lint are cancellable owned trees too. Keep timed-out
   * children tracked until exit, rather than treating a kill request as proof. */
  private commandRunner(key: string, signal: AbortSignal, timeoutMs: number): SdkCommandRunner {
    return async (command, args, cwd) => {
      if (signal.aborted || this.closing) return { code: null, output: '', cancelled: true }
      const child = spawnTracked(command, args, { cwd, shell: false, windowsHide: true, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] })
      let settle!: () => void
      const owned = { child, settled: new Promise<void>(resolve => { settle = resolve }) }
      const children = this.preparations.get(key) ?? new Set<PreparationChild>()
      children.add(owned)
      this.preparations.set(key, children)
      let output = ''
      let code: number | null = null
      let cancelled = false
      const append = (chunk: Buffer): void => { output = (output + chunk.toString('utf8')).slice(-256 * 1024) }
      child.stdout?.on('data', append)
      child.stderr?.on('data', append)
      const kill = (): void => { cancelled = true; void terminateOwnedTree(child) }
      signal.addEventListener('abort', kill, { once: true })
      child.once('error', error => { output = error.message; children.delete(owned); settle() })
      child.once('close', exitCode => { code = exitCode; children.delete(owned); settle() })
      const timeout = setTimeout(kill, timeoutMs)
      try {
        await waitAtMost(owned.settled, timeoutMs + (this.deps.stopTimeoutMs ?? 5000))
        if (children.has(owned)) { cancelled = true; output += '\nSDK 进程未确认退出。' }
        return { code, output, cancelled }
      } finally { clearTimeout(timeout); signal.removeEventListener('abort', kill) }
    }
  }

  private async project(studioId: string): Promise<{ state: GalgameStudioState; root: string; key: string }> {
    const state = await this.deps.getStudio(studioId)
    if (!state) throw new Error('Galgame Studio 工作台不存在，请重新打开项目。')
    const root = await fs.realpath(state.projectDir).catch(() => null)
    if (!root || !(await fs.stat(root)).isDirectory()) throw new Error('项目目录不存在，请重新选择项目。')
    return { state, root, key: keyFor(root) }
  }

  private serial<T>(key: string, action: () => Promise<T>): Promise<T> {
    const next = (this.operations.get(key) ?? Promise.resolve()).catch(() => undefined).then(action)
    this.operations.set(key, next)
    void next.finally(() => { if (this.operations.get(key) === next) this.operations.delete(key) }).catch(() => undefined)
    return next
  }

  async start(studioId: string): Promise<GalgameStudioPlaytestResult> {
    try {
      const project = await this.project(studioId)
      this.studioProjects.set(studioId, project.key)
      const epoch = this.epochs.get(project.key) ?? 0
      return await this.serial(project.key, async () => {
        await this.stops.get(project.key)
        return (this.epochs.get(project.key) ?? 0) === epoch ? this.startProject(studioId, project.key) : stopped('已取消启动试玩。')
      })
    } catch (error) {
      const result = failed(error instanceof Error ? error.message : '无法启动试玩。')
      this.earlyResults.set(studioId, result)
      return result
    }
  }

  private async startProject(studioId: string, key: string): Promise<GalgameStudioPlaytestResult> {
    if (this.closing) return stopped('应用正在退出，未启动试玩。')
    const existing = this.records.get(key)
    if (existing?.child) return { ...existing.result }
    if (this.preparations.get(key)?.size) return failed('上次 SDK 检查进程尚未退出，请先停止试玩。')
    const controller = new AbortController()
    this.attempts.set(key, controller)
    const cancelled = (): boolean => this.closing || controller.signal.aborted
    const finish = (result: GalgameStudioPlaytestResult): GalgameStudioPlaytestResult => {
      this.records.set(key, { child: null, result, stopRequested: false, settled: Promise.resolve() })
      return { ...result }
    }
    try {
      const { state, root, key: currentKey } = await this.project(studioId)
      if (currentKey !== key || !(await this.deps.isAuthorizedDir(root))) return finish(failed('项目目录未授权，请通过目录选择器重新选择。'))
      if (!state.sdkReady || !state.sdk) return finish(failed('请先选择并检查真实的 Ren’Py SDK。'))
      if (!eligibleProject(state)) return finish(failed(state.production?.integration === 'required' ? '生成剧情尚未接入项目主线，请接好入口并重新检查。' : '请先完成剧本并通过真实 SDK 检查，再开始试玩。'))
      const game = await fs.realpath(path.join(root, 'game')).catch(() => null)
      if (!game || !(await fs.stat(game)).isDirectory() || !keyFor(game).startsWith(key + path.sep)) return finish(failed('项目 game/ 目录不存在或指向项目外部。'))
      // No discovery or fallback here: only the SDK already selected in Studio.
      const layout = await (this.deps.resolveSdk ?? resolveRenpySdkLayout)(state.sdk.root)
      const identity = await Promise.all([layout.root, layout.pythonPath, layout.renpyScriptPath, state.sdk.root, state.sdk.pythonPath, state.sdk.renpyScriptPath].map(file => fs.realpath(file)))
      if (identity.slice(0, 3).some((file, index) => keyFor(file) !== keyFor(identity[index + 3]))) return finish(failed('SDK 路径已变化，请重新选择并检查 SDK。'))
      if (cancelled()) return finish(stopped('已取消启动试玩。'))
      const approved = await this.confirmProjectExecution(root, state.projectName, state.sdk.version)
      if (!approved || cancelled()) return finish(stopped('已取消启动试玩。'))
      const candidate = await (this.deps.validateSdk ?? validateRenpySdkLayout)(layout, { source: state.sdk.source, runCommand: this.commandRunner(key, controller.signal, 30_000) })
      if (cancelled()) return finish(stopped('已取消启动试玩。'))
      if (candidate.version !== state.sdk.version) return finish(failed('SDK 版本已变化，请重新检查项目。'))
      // lint executes project Python too, so even this recheck follows consent.
      const lint = await (this.deps.lint ?? runRenpyLint)(layout, root, { signal: controller.signal, runCommand: this.commandRunner(key, controller.signal, 120_000) })
      if (cancelled()) return finish(stopped('已取消启动试玩。'))
      if (!lint.ok || !lint.verified) return finish(failed('项目当前未通过真实 SDK 检查，请修复后重新检查。'))
      const latest = await this.deps.getStudio(studioId)
      if (!latest?.sdkReady || !latest.sdk || latest.sdk.root !== state.sdk.root || latest.sdk.version !== state.sdk.version || latest.sdk.pythonPath !== state.sdk.pythonPath || latest.sdk.renpyScriptPath !== state.sdk.renpyScriptPath || !eligibleProject(latest) || latest.generatedFile !== state.generatedFile || latest.generatedAt !== state.generatedAt || keyFor(await fs.realpath(latest.projectDir)) !== key || !(await this.deps.isAuthorizedDir(root))) return finish(failed('项目或 SDK 状态已变化，请重新检查后试玩。'))
      if (cancelled()) return finish(stopped('已取消启动试玩。'))
      const command = await renpyPlaytestCommand(layout, root)
      if (cancelled()) return finish(stopped('已取消启动试玩。'))
      const child = (this.deps.spawnProcess ?? spawnTracked)(command.command, command.args, { cwd: command.cwd, shell: false, windowsHide: false, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] })
      // Drain output without returning arbitrary project output over IPC.
      child.stdout?.resume()
      child.stderr?.resume()
      let settle!: () => void
      const record: PlaytestRecord = { child, result: { status: 'running' }, stopRequested: false, settled: new Promise(resolve => { settle = resolve }) }
      this.records.set(key, record)
      child.once('error', () => {
        record.child = null
        record.result = failed('试玩进程无法启动，请重新检查 SDK 和项目。')
        settle()
      })
      child.once('exit', (code, signal) => {
        record.child = null
        record.result = record.stopRequested || code === 0 ? stopped() : failed(`试玩进程异常退出（${signal ? `信号 ${signal}` : `退出码 ${code ?? '未知'}`}），请检查项目日志。`)
        settle()
      })
      // spawn alone can succeed even when the interpreter immediately fails.
      await waitAtMost(record.settled, this.deps.startupObservationMs ?? 1200)
      return { ...record.result }
    } catch (error) {
      return finish(cancelled() ? stopped('已取消启动试玩。') : failed(error instanceof Error ? error.message : '试玩启动失败。'))
    } finally {
      if (this.attempts.get(key) === controller) this.attempts.delete(key)
    }
  }

  async status(studioId: string): Promise<GalgameStudioPlaytestResult> {
    try {
      const key = this.studioProjects.get(studioId) ?? (await this.project(studioId)).key
      return { ...(this.records.get(key)?.result ?? this.earlyResults.get(studioId) ?? stopped()) }
    } catch { return this.earlyResults.get(studioId) ?? failed('Galgame Studio 工作台或项目不存在。') }
  }

  async stop(studioId: string): Promise<GalgameStudioPlaytestResult> {
    try {
      const key = this.studioProjects.get(studioId) ?? (await this.project(studioId)).key
      this.epochs.set(key, (this.epochs.get(key) ?? 0) + 1)
      this.attempts.get(key)?.abort()
      // Do not wait for a native confirmation dialog or an in-flight SDK probe.
      // The cancelled start checks its token before it can execute project code.
      if (!this.records.get(key)?.child && !this.preparations.get(key)?.size) {
        this.records.set(key, { child: null, result: stopped(), stopRequested: false, settled: Promise.resolve() })
        return stopped()
      }
      // Preparation is independent of the start queue, so Stop never waits for
      // a probe/lint timeout before sending the tree termination request.
      const existing = this.stops.get(key)
      if (existing) return await existing
      const stopping = this.stopProject(key)
      this.stops.set(key, stopping)
      try { return await stopping } finally { if (this.stops.get(key) === stopping) this.stops.delete(key) }
    } catch { return failed('Galgame Studio 工作台或项目不存在。') }
  }

  private async stopProject(key: string): Promise<GalgameStudioPlaytestResult> {
    const preparing = [...(this.preparations.get(key) ?? [])]
    const timeout = this.deps.stopTimeoutMs ?? 5000
    await Promise.all(preparing.map(owned => waitAtMost(terminateOwnedTree(owned.child).then(() => owned.settled), timeout)))
    if (this.preparations.get(key)?.size) return failed('SDK 检查进程尚未确认退出，请再次停止试玩。')
    const record = this.records.get(key)
    if (!record?.child) {
      if (record) record.result = stopped()
      return stopped()
    }
    record.stopRequested = true
    // A failed termination retains ownership, so Stop can be retried and quit
    // still reaches the common childRegistry shutdown coordinator.
    await waitAtMost(terminateOwnedTree(record.child).then(() => record.settled), timeout)
    if (record.child) record.result = failed('试玩进程尚未确认退出，请再次停止试玩。')
    return { ...record.result }
  }

  async shutdown(): Promise<void> {
    this.closing = true
    for (const controller of this.attempts.values()) controller.abort()
    await Promise.all([...new Set([...this.records.keys(), ...this.preparations.keys()])].map(key => this.stopProject(key)))
  }
}
