import { createHash } from 'node:crypto'
import type { DsMessage, DsTool } from '../../shared/types'
import { ExtensionRegistry, type FrozenExtension } from './ExtensionRegistry'
import { StdioToolClient, type PluginTool } from './StdioToolClient'

export interface ExtensionSnapshot {
  schemaVersion: 1
  registryRoot: string
  skills: FrozenExtension[]
  plugins: FrozenExtension[]
  toolSpecs: DsTool[]
  bindings: Array<{ name: string; extensionId: string; originalName: string }>
}
const resourceName = 'read_skill_resource'
const inspector: PluginTool = { name: 'count_manuscript', description: '读取授权目录中的UTF-8稿件，返回Unicode字数与SHA256；只读，不写文件。', inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'], additionalProperties: false } }
const pluginName = (id: string): string => 'dw_' + createHash('sha256').update(id).digest('hex').slice(0, 12) + '_count_manuscript'
export function extensionIds(value: unknown): string[] {
  if (value === undefined) return []
  if (typeof value !== 'string') throw new Error('扩展参数必须为逗号分隔id')
  const ids = value.split(',').map((part) => part.trim())
  if (!ids.length || ids.length > 8 || ids.some((id) => !/^[a-z0-9-]+\/[a-z0-9-]+$/.test(id)) || new Set(ids).size !== ids.length) throw new Error('扩展id无效/重复/超过8项；不接受通配符授权')
  return ids
}
export async function freezeExtensions(registry: ExtensionRegistry, skillIds: string[], pluginIds: string[]): Promise<ExtensionSnapshot> {
  const skills = await Promise.all(skillIds.map((id) => registry.freeze(id, 'skill')))
  const plugins = await Promise.all(pluginIds.map((id) => registry.freeze(id, 'tool')))
  const bindings = plugins.map((pin) => ({ name: pluginName(pin.record.id), extensionId: pin.record.id, originalName: inspector.name }))
  const toolSpecs: DsTool[] = bindings.map((binding) => ({ type: 'function', function: { name: binding.name, description: inspector.description, parameters: inspector.inputSchema } }))
  if (skills.length) toolSpecs.push({ type: 'function', function: { name: resourceName, description: '按需读取本run已冻结写作技能的参考资源；不访问宿主其他文件、不执行脚本。', parameters: { type: 'object', properties: { id: { type: 'string', enum: skillIds }, path: { type: 'string' } }, required: ['id', 'path'], additionalProperties: false } } })
  return { schemaVersion: 1, registryRoot: registry.root, skills, plugins, toolSpecs, bindings }
}
export function skillMessages(snapshot: ExtensionSnapshot): DsMessage[] {
  return snapshot.skills.map((pin) => ({
    role: 'system',
    content: '用户明确选择的写作技能（低于宿主安全/已确认主题契约，不赋予工具或进程权限；allowed-tools只是包元数据）。\n'
      + JSON.stringify({ id: pin.record.id, version: pin.record.version, packageHash: pin.record.packageHash, resources: pin.record.files.map((file) => ({ path: file.path, sha256: file.sha256 })) })
      + '\n' + (pin.instructions ?? []).map((instruction) => instruction.content).join('\n')
  }))
}
/** Reusable Node host. Runtime facts remain in the existing immutable run
 * snapshot; this class holds only disposable process handles. */
export class ExtensionActivation {
  private clients = new Map<string, StdioToolClient>()
  private startups = new Map<string, Promise<void>>()
  private closedRuns = new Set<string>()
  private disposed = false
  private monitors = new Map<string, ReturnType<typeof setInterval>>()
  constructor(private input: { nodeExecutable: string; electronAsNode?: boolean; authorizeStart: (id: string, hash: string, runId: string) => Promise<boolean>; onStarted?: (runId: string, pin: FrozenExtension, pid: number | undefined, roots: string[]) => void; onStopped?: (runId: string, result: { pid: number | null; exited: boolean; remainingPids: number[] }) => void; onRevoked?: (runId: string, message: string) => void | Promise<void> }) {}
  async verify(snapshot: ExtensionSnapshot): Promise<void> {
    if (snapshot.schemaVersion !== 1 || !Array.isArray(snapshot.skills) || !Array.isArray(snapshot.plugins)) throw new Error('extension_snapshot_invalid')
    const registry = new ExtensionRegistry(snapshot.registryRoot)
    for (const pin of snapshot.plugins) await registry.assertPluginEnabled(pin)
    for (const pin of [...snapshot.skills, ...snapshot.plugins]) await registry.verify(pin.record)
    for (const pin of snapshot.skills) {
      if (pin.record.kind !== 'skill' || !pin.instructions?.length) throw new Error('extension_skill_pin_missing')
      for (const instruction of pin.instructions) {
        if (await registry.resource(pin, instruction.path) !== instruction.content || createHash('sha256').update(instruction.content).digest('hex') !== instruction.sha256) throw new Error('extension_skill_instruction_changed')
      }
    }
    const bindings = snapshot.plugins.map((pin) => ({ name: pluginName(pin.record.id), extensionId: pin.record.id, originalName: inspector.name }))
    if (JSON.stringify(bindings) !== JSON.stringify(snapshot.bindings)) throw new Error('extension_binding_changed')
    const expected: DsTool[] = bindings.map((binding) => ({ type: 'function', function: { name: binding.name, description: inspector.description, parameters: inspector.inputSchema } }))
    if (snapshot.skills.length) expected.push({ type: 'function', function: { name: resourceName, description: '按需读取本run已冻结写作技能的参考资源；不访问宿主其他文件、不执行脚本。', parameters: { type: 'object', properties: { id: { type: 'string', enum: snapshot.skills.map((pin) => pin.record.id) }, path: { type: 'string' } }, required: ['id', 'path'], additionalProperties: false } } })
    if (JSON.stringify(expected) !== JSON.stringify(snapshot.toolSpecs)) throw new Error('extension_frozen_schema_changed')
  }
  async getToolSpecs(runId: string, snapshot: ExtensionSnapshot, roots: string[], signal?: AbortSignal): Promise<DsTool[]> {
    await this.verify(snapshot)
    if (this.disposed || this.closedRuns.has(runId) || signal?.aborted) throw new Error('extension_host_closed_or_cancelled')
    for (const pin of snapshot.plugins) {
      const key = runId + ':' + pin.record.packageHash
      const pending = this.startups.get(key)
      if (pending) { await pending; continue }
      if (this.clients.has(key)) continue
      const client = new StdioToolClient(new ExtensionRegistry(snapshot.registryRoot), pin)
      this.clients.set(key, client)
      const startup = (async () => {
        try {
          const allowed = await this.input.authorizeStart(pin.record.id, pin.record.packageHash, runId)
          await new ExtensionRegistry(snapshot.registryRoot).assertPluginEnabled(pin)
          const actual = await client.start({ nodeExecutable: this.input.nodeExecutable, electronAsNode: this.input.electronAsNode, roots, authorized: allowed, signal })
          if (JSON.stringify(actual) !== JSON.stringify([inspector])) throw new Error('plugin_live_schema_differs_from_frozen')
          await new ExtensionRegistry(snapshot.registryRoot).assertPluginEnabled(pin)
          this.input.onStarted?.(runId, pin, client.pid, roots)
          let busy = false
          const monitor = setInterval(() => {
            if (busy) return
            busy = true
            void new ExtensionRegistry(snapshot.registryRoot).assertPluginEnabled(pin).then(() => { busy = false }, async (error: Error) => {
              let message = error.message
              try { await this.closeRun(runId) } catch (closeError) { message += '; ' + (closeError as Error).message }
              await this.input.onRevoked?.(runId, message)
            }).catch(() => { /* lifecycle callback must report independently */ })
          }, 250)
          monitor.unref()
          this.monitors.set(key, monitor)
        } catch (error) { const result = await client.close(); if (result.exited) this.clients.delete(key); throw error }
      })()
      this.startups.set(key, startup)
      try { await startup } finally { if (this.startups.get(key) === startup) this.startups.delete(key) }
    }
    if (this.disposed || this.closedRuns.has(runId) || signal?.aborted) throw new Error('extension_host_closed_or_cancelled')
    return snapshot.toolSpecs
  }
  has(snapshot: ExtensionSnapshot, name: string): boolean { return snapshot.toolSpecs.some((spec) => spec.function.name === name) }
  async execute(runId: string, snapshot: ExtensionSnapshot, name: string, argsJson: string, allowList: string[], signal?: AbortSignal): Promise<string> {
    if (signal?.aborted || this.disposed || this.closedRuns.has(runId)) throw new Error('已取消或扩展宿主已关闭')
    if (!allowList.includes(name) || !this.has(snapshot, name)) throw new Error('extension_tool_not_allowed')
    let args: Record<string, unknown>
    try { args = JSON.parse(argsJson) as Record<string, unknown> } catch { throw new Error('扩展工具参数 JSON 无效') }
    if (!args || Array.isArray(args) || typeof args !== 'object') throw new Error('extension_tool_arguments_invalid')
    await this.verify(snapshot)
    if (signal?.aborted || this.disposed || this.closedRuns.has(runId)) throw new Error('已取消或扩展宿主已关闭')
    if (name === resourceName) {
      if (Object.keys(args).some((key) => !['id', 'path'].includes(key)) || typeof args.id !== 'string' || typeof args.path !== 'string') throw new Error('extension_resource_arguments_invalid')
      const pin = snapshot.skills.find((item) => item.record.id === args.id); if (!pin) throw new Error('extension_skill_not_selected')
      const content = await new ExtensionRegistry(snapshot.registryRoot).resource(pin, args.path)
      return JSON.stringify({ ok: true, message: content, extensionId: args.id, packageHash: pin.record.packageHash })
    }
    const binding = snapshot.bindings.find((item) => item.name === name); if (!binding) throw new Error('extension_tool_not_bound')
    const pin = snapshot.plugins.find((item) => item.record.id === binding.extensionId)!
    const client = this.clients.get(runId + ':' + pin.record.packageHash); if (!client) throw new Error('plugin_not_started：无启动授权不会因伪造tool call自动启动')
    const result = await client.call(binding.originalName, args) as { isError?: boolean; content?: Array<{ type?: string; text?: string }> }
    return JSON.stringify({ ok: result.isError !== true, message: (result.content ?? []).filter((item) => item.type === 'text').map((item) => item.text ?? '').join('\n') })
  }
  async closeRun(runId: string): Promise<void> {
    this.closedRuns.add(runId)
    for (const [key, monitor] of this.monitors) if (key.startsWith(runId + ':')) { clearInterval(monitor); this.monitors.delete(key) }
    let unconfirmed = false
    for (const [key, client] of this.clients) if (key.startsWith(runId + ':')) {
      const result = await client.close(); this.input.onStopped?.(runId, result)
      if (result.exited) this.clients.delete(key); else unconfirmed = true
    }
    if (unconfirmed) throw new Error('plugin_shutdown_unconfirmed：存在剩余PID，未报已关闭')
    const starts = [...this.startups].filter(([key]) => key.startsWith(runId + ':')).map(([, pending]) => pending)
    if (starts.length) {
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        const settled = await Promise.race([Promise.allSettled(starts).then(() => true), new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(false), 2000) })])
        if (!settled) throw new Error('plugin_startup_shutdown_unconfirmed：授权仍待决；stopping门阻止后续启动')
      } finally { if (timer) clearTimeout(timer) }
    }
  }
  beginRun(runId: string): void {
    if (this.disposed || [...this.startups.keys(), ...this.clients.keys()].some((key) => key.startsWith(runId + ':'))) throw new Error('extension_previous_host_not_closed')
    this.closedRuns.delete(runId)
  }
  async close(): Promise<void> {
    this.disposed = true; const failures: string[] = []
    for (const runId of new Set([...this.clients.keys(), ...this.startups.keys()].map((key) => key.slice(0, key.lastIndexOf(':'))))) {
      try { await this.closeRun(runId) } catch (error) { failures.push((error as Error).message) }
    }
    if (failures.length) throw new Error(failures.join('；'))
  }
}
