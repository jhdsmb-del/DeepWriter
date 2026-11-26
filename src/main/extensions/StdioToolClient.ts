import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { StringDecoder } from 'node:string_decoder'
import * as path from 'node:path'
import { registerChildProcess } from '../childRegistry'
import { ExtensionRegistry, type FrozenExtension } from './ExtensionRegistry'

export interface PluginTool { name: string; description: string; inputSchema: Record<string, unknown> }
export interface PluginCloseResult { pid: number | null; exited: boolean; remainingPids: number[] }
export interface PluginStartInput { nodeExecutable: string; electronAsNode?: boolean; roots: string[]; authorized: boolean; signal?: AbortSignal }
type Waiter = { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }

/** Deliberately a restricted first-party 2025-11-25 stdio client, not an
 * arbitrary executable launcher or an OS sandbox. No inherited credentials. */
export class StdioToolClient {
  private child: ChildProcessWithoutNullStreams | null = null
  private sequence = 0
  private pending = new Map<number, Waiter>()
  private tools: PluginTool[] = []
  private startup: Promise<PluginTool[]> | null = null
  private closing: Promise<PluginCloseResult> | null = null
  private stopping = false
  private exitObserved = false
  private lastPid: number | null = null
  private exitPromise: Promise<void> | null = null
  constructor(private registry: ExtensionRegistry, private pin: FrozenExtension) {}
  get pid(): number | undefined { return this.child?.pid }
  start(input: PluginStartInput): Promise<PluginTool[]> {
    if (!input.authorized) return Promise.reject(new Error('plugin_start_permission_required：安装/启用不等于启动授权'))
    if (input.signal?.aborted || this.stopping) return Promise.reject(new Error('已取消或插件已关闭'))
    if (this.startup) return this.startup
    if (this.child) return Promise.resolve(this.tools)
    this.startup = this.initialize(input).finally(() => { this.startup = null })
    return this.startup
  }
  private async initialize(input: PluginStartInput): Promise<PluginTool[]> {
    if (process.versions.electron && path.resolve(input.nodeExecutable) === path.resolve(process.execPath) && !input.electronAsNode) throw new Error('electron_node_mode_explicit_required：拒绝默认打开GUI')
    if (input.electronAsNode && (!process.versions.electron || path.resolve(input.nodeExecutable) !== path.resolve(process.execPath))) throw new Error('electron_node_runtime_not_current_controlled_host')
    const entry = await this.registry.entry(this.pin)
    if (input.signal?.aborted || this.stopping) throw new Error('已取消')
    const env: NodeJS.ProcessEnv = { DEEPWRITER_PLUGIN_ROOTS_JSON: JSON.stringify(input.roots.map((root) => path.resolve(root))) }
    // Windows loader needs SystemRoot; do not pass PATH, API keys or user env.
    if (process.env.SystemRoot) env.SystemRoot = process.env.SystemRoot
    // Only the current Electron host may deliberately use its audited runtime
    // in Node mode. Never inherit general Electron env or expose this to CLI.
    if (input.electronAsNode) env.ELECTRON_RUN_AS_NODE = '1'
    const child = spawn(input.nodeExecutable, [entry], { cwd: path.dirname(entry), env, shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
    this.child = child; registerChildProcess(child)
    this.lastPid = child.pid ?? null; this.exitObserved = false
    let resolveExit!: () => void
    this.exitPromise = new Promise<void>((resolve) => { resolveExit = resolve })
    const decoder = new StringDecoder('utf8'); let buffer = ''; let diagnosticBytes = 0
    const stop = (): void => { void this.close() }
    input.signal?.addEventListener('abort', stop, { once: true })
    child.once('close', () => { input.signal?.removeEventListener('abort', stop); this.exitObserved = true; resolveExit(); this.fail(new Error('plugin_process_closed')); if (this.child === child) this.child = null; this.tools = [] })
    child.once('error', () => { this.fail(new Error('plugin_process_start_failed')); void this.close() })
    child.stdin.on('error', () => { this.fail(new Error('plugin_stdin_failed')); void this.close() })
    child.stderr.on('data', (chunk: Buffer) => { diagnosticBytes += chunk.length; if (diagnosticBytes > 65536) void this.close() })
    child.stdout.on('data', (chunk: Buffer) => {
      buffer += decoder.write(chunk)
      if (Buffer.byteLength(buffer) > 131072) { this.fail(new Error('plugin_message_limit')); void this.close(); return }
      let newline: number
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1)
        let message: { jsonrpc?: string; id?: number; result?: unknown; error?: unknown }
        try { message = JSON.parse(line) as typeof message } catch { this.fail(new Error('plugin_invalid_jsonrpc')); void this.close(); return }
        if (message.jsonrpc !== '2.0' || !Number.isSafeInteger(message.id)) { this.fail(new Error('plugin_unsolicited_message')); void this.close(); return }
        const waiter = this.pending.get(message.id!); if (!waiter) { this.fail(new Error('plugin_response_identity_mismatch')); void this.close(); return }
        this.pending.delete(message.id!); clearTimeout(waiter.timer)
        if (message.error) waiter.reject(new Error('plugin_rpc_error')); else waiter.resolve(message.result)
      }
    })
    try {
      const handshake = await this.request('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'deepwriter', version: '1' } }) as { protocolVersion?: string; capabilities?: { tools?: unknown } }
      if (handshake.protocolVersion !== '2025-11-25' || !handshake.capabilities?.tools) throw new Error('plugin_protocol_or_capability_mismatch')
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n')
      const list = await this.request('tools/list', {}) as { tools?: PluginTool[]; nextCursor?: unknown }
      if (!Array.isArray(list.tools) || list.tools.length !== 1 || list.nextCursor || list.tools[0].name !== 'count_manuscript' || !list.tools[0].inputSchema || list.tools[0].inputSchema.type !== 'object') throw new Error('plugin_schema_unsupported')
      this.tools = list.tools; return this.tools
    } catch (error) { await this.close(); throw error }
  }
  private request(method: string, params: unknown): Promise<unknown> {
    const child = this.child; if (!child || !child.stdin.writable) return Promise.reject(new Error('plugin_not_started'))
    const id = ++this.sequence; const wire = JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n'
    if (Buffer.byteLength(wire) > 65536) return Promise.reject(new Error('plugin_request_limit'))
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('plugin_request_timeout')); void this.close() }, 5000)
      this.pending.set(id, { resolve, reject, timer })
      child.stdin.write(wire, (error) => { if (error) { const waiter = this.pending.get(id); if (waiter) { this.pending.delete(id); clearTimeout(timer); reject(new Error('plugin_stdin_failed')) } } })
    })
  }
  async call(name: string, args: Record<string, unknown>): Promise<unknown> {
    if (!this.tools.some((tool) => tool.name === name)) throw new Error('plugin_tool_not_declared')
    return this.request('tools/call', { name, arguments: args })
  }
  private fail(error: Error): void { for (const waiter of this.pending.values()) { clearTimeout(waiter.timer); waiter.reject(error) }; this.pending.clear() }
  close(): Promise<PluginCloseResult> {
    if (this.closing) return this.closing
    this.stopping = true
    this.closing = this.finishClose()
    return this.closing
  }
  private async finishClose(): Promise<PluginCloseResult> {
    const child = this.child; const pid = this.lastPid
    this.fail(new Error('plugin_stopped'))
    if (child) { child.stdin.end(); try { child.kill() } catch { /* verified below, not assumed */ } }
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      if (this.exitPromise && !this.exitObserved) await Promise.race([this.exitPromise, new Promise<void>((resolve) => { timer = setTimeout(resolve, 2000) })])
    } finally { if (timer) clearTimeout(timer) }
    let alive = false
    if (pid !== null) { try { process.kill(pid, 0); alive = true } catch (error) { alive = (error as NodeJS.ErrnoException).code !== 'ESRCH' } }
    const exited = pid === null || this.exitObserved && !alive
    return { pid, exited, remainingPids: exited || pid === null ? [] : [pid] }
  }
}
