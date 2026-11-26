import { createHash, randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import * as path from 'node:path'
import type { DsMessage, DsTool } from '../../shared/types'
import type { ExtensionsSnapshot, ExtensionSelection, ExtensionView } from '../../shared/extensions'
import type { IpcResult } from '../../shared/providerRegistry'
import type { AgentRunEngine } from '../jobs/AgentRunEngine'
import { allowListFromConfig } from '../runKernelAdapter'
import { ExtensionRegistry } from './ExtensionRegistry'
import { ExtensionActivation, freezeExtensions, skillMessages, type ExtensionSnapshot } from './ExtensionActivation'

export interface DesktopPluginGrant {
  id: string; packageHash: string; runId: string; roots: string[]; signal: AbortSignal
}
interface DesktopExtensionPorts {
  registryDir: string
  nodeExecutable: string
  electronAsNode?: boolean
  chooseSkillDirectory: () => Promise<string | null>
  authorizeStart: (input: DesktopPluginGrant) => Promise<boolean>
  writeEvidence: (runId: string, kind: string, json: string) => void
}
const frozen = (config: Record<string, unknown>): ExtensionSnapshot | undefined => config.extensionsFrozen as ExtensionSnapshot | undefined
const samePath = (a: string, b: string): boolean => process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b

/** The preload/UI contract is an IpcResult, not a raw metadata object. Do not
 * serialize arbitrary filesystem/JSON/parser exception text into renderer. */
export async function desktopExtensionResult<T>(work: () => Promise<T>): Promise<IpcResult<T>> {
  try { return { ok: true, data: await work() } } catch {
    return { ok: false, error: { code: 'extension_rejected', message: '扩展操作未完成。请检查安装来源、启用状态、类型及权限；未知组件和第三方工具进程被拒绝。', retryable: true } }
  }
}

/** Desktop composition only: durable versions/selection are in the shared
 * registry, run facts in the existing snapshot, handles in ExtensionActivation.
 * No independent run loop or renderer-supplied process grant. */
export class DesktopExtensionService {
  readonly registry: ExtensionRegistry
  private activation: ExtensionActivation
  private engine: AgentRunEngine | null = null
  private configForRun: ((runId: string) => Record<string, unknown>) | null = null
  private controllers = new Map<string, AbortController>()
  private steps = new Map<string, Promise<void>>()
  private closingRuns = new Map<string, Promise<void>>()
  private usedRuns = new Set<string>()
  private pluginRuns = new Set<string>()
  private stopping = false
  constructor(private ports: DesktopExtensionPorts) {
    this.registry = new ExtensionRegistry(ports.registryDir)
    this.activation = new ExtensionActivation({
      nodeExecutable: ports.nodeExecutable, electronAsNode: ports.electronAsNode,
      authorizeStart: async (id, packageHash, runId) => {
        const controller = this.controllers.get(runId)
        if (!controller || controller.signal.aborted || this.stopping) return false
        const roots = await this.rootsForRun(this.config(runId))
        // Abort the native dialog AND the pending promise. A late response may
        // never outlive stop/pause/shutdown and become an executable grant.
        const signal = controller.signal
        let abort!: () => void
        const cancelled = new Promise<boolean>((resolve) => { abort = () => resolve(false); signal.addEventListener('abort', abort, { once: true }) })
        let allowed = false
        try {
          allowed = await Promise.race([ports.authorizeStart({ id, packageHash, runId, roots, signal }), cancelled])
          allowed = allowed && !signal.aborted && !this.stopping
        } finally { signal.removeEventListener('abort', abort) }
        this.evidence(runId, 'extension_start_grant', { id, packageHash, decision: allowed ? 'allow' : 'deny', roots, actor: 'desktop_dialog' })
        return allowed
      },
      onStarted: (runId, pin, pid, roots) => this.evidence(runId, 'extension_host_started', { id: pin.record.id, packageHash: pin.record.packageHash, pid, roots, protocolVersion: '2025-11-25' }),
      onStopped: (runId, result) => this.evidence(runId, 'extension_host_stopped', result),
      onRevoked: async (runId, message) => {
        this.controllers.get(runId)?.abort()
        this.evidence(runId, 'extension_permission_revoked', { message })
        // The shared engine owns pause persistence. Read-only RPC interruption
        // can be settling when revocation arrives; never retry a provider call.
        for (let attempt = 0; attempt < 40; attempt++) {
          try { await this.engine?.pause(runId); return } catch (error) {
            if ((error as { code?: string }).code !== 'pause_tool_in_flight') throw error
            await new Promise((resolve) => setTimeout(resolve, 25))
          }
        }
        this.evidence(runId, 'extension_pause_unconfirmed', { reason: 'pause_tool_in_flight' })
      }
    })
  }
  private evidence(runId: string, kind: string, data: object): void { this.ports.writeEvidence(runId, `${kind}_${randomUUID()}`, JSON.stringify({ ...data, at: Date.now() })) }
  private config(runId: string): Record<string, unknown> {
    if (!this.configForRun) throw new Error('扩展运行接线尚未就绪')
    return this.configForRun(runId)
  }
  async snapshot(): Promise<ExtensionsSnapshot> {
    return {
      registryDir: this.registry.root,
      catalog: this.registry.catalog().map((item) => ({ ...item, source: 'builtin:' + item.id, firstParty: true, license: 'MIT', requestedPermissions: item.kind === 'skill' ? ['instructions', 'frozen-resource-read'] : ['node-process-start', 'read-frozen-work-and-doc-roots'] })),
      installed: await this.registry.list(), selectedForNewRuns: await this.registry.selection()
    }
  }
  async installCatalog(id: string): Promise<ExtensionView> {
    const item = this.registry.catalog().find((entry) => entry.id === id)
    if (!item) throw new Error('未知内置扩展')
    return this.registry.install('builtin:' + id, item.kind)
  }
  async importSkill(): Promise<ExtensionView | null> {
    const directory = await this.ports.chooseSkillDirectory()
    return directory === null ? null : this.registry.install(directory, 'skill')
  }
  async setEnabled(id: string, enabled: boolean): Promise<ExtensionView> {
    const result = await this.registry.setEnabled(id, enabled)
    if (!enabled) await this.revokeAffected(id)
    return result
  }
  async remove(id: string): Promise<void> { await this.registry.setEnabled(id, false, true); await this.revokeAffected(id) }
  inspect(id: string): Promise<ExtensionView> { return this.registry.inspect(id) }
  setSelection(selection: ExtensionSelection): Promise<ExtensionSelection> { return this.registry.setSelection(selection) }

  async freezeForNewRun(config: Record<string, unknown>): Promise<void> {
    if (config.extensionsFrozen !== undefined) throw new Error('extension_snapshot_already_frozen')
    const selected = await this.registry.selection()
    if (!selected.skills.length && !selected.plugins.length) return
    const snapshot = await freezeExtensions(this.registry, selected.skills, selected.plugins)
    const roots = snapshot.plugins.length ? await this.configuredRoots(config) : []
    if (snapshot.plugins.length && !roots.length) throw new Error('插件需要明确且现存的工作/文档目录；未获得目录授权')
    config.extensionsFrozen = snapshot
    config.extensionsRoots = roots
    const messages = [...(config.frozenSystemMessages as DsMessage[] ?? []), ...skillMessages(snapshot)]
    config.frozenSystemMessages = messages
    // The preview/accepted prefix hash is computed after this exact frozen body.
    config.promptHash = createHash('sha256').update(JSON.stringify({ prior: config.promptHash, messages })).digest('hex')
    const policy = config.toolPolicy as { allowList?: string[] } | undefined
    if (!policy || !Array.isArray(policy.allowList)) throw new Error('extension_frozen_allowlist_missing')
    // Explicit selection permits only these exact audited extension schemas;
    // a skill's allowed-tools metadata never grants any builtin capability.
    if (config.planMode !== true) policy.allowList = [...new Set([...policy.allowList, ...snapshot.toolSpecs.map((tool) => tool.function.name)])]
  }
  private async configuredRoots(config: Record<string, unknown>): Promise<string[]> {
    const roots: string[] = []
    for (const value of [config.workDir, config.docDir]) {
      if (typeof value !== 'string' || !value) continue
      if (!path.isAbsolute(value)) throw new Error('extension_root_must_be_explicit_absolute')
      try {
        const real = await fs.realpath(value)
        if (!(await fs.stat(real)).isDirectory()) throw new Error('extension_root_not_directory')
        if (!roots.some((root) => samePath(root, real))) roots.push(real)
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    }
    return roots
  }
  private async rootsForRun(config: Record<string, unknown>): Promise<string[]> {
    const snapshot = frozen(config)
    if (!snapshot?.plugins.length) return []
    const roots = config.extensionsRoots
    const configured = await this.configuredRoots(config)
    if (!Array.isArray(roots) || !roots.length || roots.length > 2 || roots.some((root) => typeof root !== 'string' || !configured.some((value) => samePath(root, value)))) throw new Error('extension_frozen_roots_changed')
    return roots as string[]
  }
  async getToolSpecs(runId: string): Promise<DsTool[]> {
    const config = this.config(runId); const snapshot = frozen(config)
    if (!snapshot || config.planMode === true) return []
    const allowList = allowListFromConfig(config) ?? []
    if (snapshot.bindings.some((binding) => !allowList.includes(binding.name))) throw new Error('extension_tool_not_allowed_by_frozen_policy')
    const roots = await this.rootsForRun(config)
    try {
      const specs = await this.activation.getToolSpecs(runId, snapshot, roots, this.controllers.get(runId)?.signal)
      return specs.filter((tool) => allowList.includes(tool.function.name))
    } catch (error) {
      // During native-dialog cancellation let the original adapter yield its
      // normal aborted stream, so the engine owns cancelled/paused projection.
      // No actual request crosses an already-aborted provider signal.
      if (this.engine?.abortSignal(runId)?.aborted) return []
      throw error
    }
  }
  has(config: Record<string, unknown>, name: string): boolean { const snapshot = frozen(config); return Boolean(snapshot && this.activation.has(snapshot, name)) }
  async execute(runId: string, name: string, argsJson: string): Promise<string> {
    const config = this.config(runId); const snapshot = frozen(config)
    if (!snapshot || config.planMode === true) throw new Error('extension_tool_not_selected_or_plan_mode')
    await this.rootsForRun(config)
    return this.activation.execute(runId, snapshot, name, argsJson, allowListFromConfig(config) ?? [], this.controllers.get(runId)?.signal)
  }
  /** Preserve the existing engine instance and every orchestration caller.
   * Only selected-extension runs acquire/close disposable hosts. */
  attachEngine(engine: AgentRunEngine, configForRun: (runId: string) => Record<string, unknown>): void {
    if (this.engine) throw new Error('extension_engine_already_attached')
    this.engine = engine; this.configForRun = configForRun
    const step = engine.step.bind(engine), pause = engine.pause.bind(engine), cancel = engine.cancel.bind(engine), restore = engine.restore.bind(engine)
    engine.step = (runId) => {
      if (!frozen(this.config(runId))) return step(runId)
      const pending = this.steps.get(runId); if (pending) return pending
      const controller = new AbortController(); this.controllers.set(runId, controller); this.usedRuns.add(runId)
      if (frozen(this.config(runId))?.plugins.length) this.pluginRuns.add(runId)
      const engineSignal = engine.abortSignal(runId)
      const abort = (): void => controller.abort()
      engineSignal?.addEventListener('abort', abort, { once: true })
      if (engineSignal?.aborted) controller.abort()
      const task = (async () => {
        try {
          if (this.stopping || controller.signal.aborted) throw new Error('extension_host_closed_or_cancelled')
          await this.activation.verify(frozen(this.config(runId))!)
          await this.rootsForRun(this.config(runId))
          if (this.stopping || controller.signal.aborted) throw new Error('extension_host_closed_or_cancelled')
          this.activation.beginRun(runId)
          await step(runId)
        } finally {
          engineSignal?.removeEventListener('abort', abort)
          await this.closeRun(runId)
        }
      })().finally(() => { this.steps.delete(runId) })
      this.steps.set(runId, task); return task
    }
    engine.pause = async (runId) => {
      try { await pause(runId) } finally { if (this.usedRuns.has(runId)) await this.closeRun(runId) }
    }
    engine.cancel = async (runId) => {
      // The original engine must commit its cancel intent before the dialog
      // is aborted. Otherwise a fast denial could race it into failed.
      try { await cancel(runId) } finally { if (this.usedRuns.has(runId)) await this.closeRun(runId) }
    }
    engine.restore = async (runId) => {
      const snapshot = frozen(this.config(runId))
      if (snapshot) { await this.activation.verify(snapshot); await this.rootsForRun(this.config(runId)) }
      await restore(runId)
    }
  }
  private closeRun(runId: string): Promise<void> {
    this.controllers.get(runId)?.abort()
    const pending = this.closingRuns.get(runId); if (pending) return pending
    const task = this.activation.closeRun(runId).then(() => { this.pluginRuns.delete(runId) }).finally(() => { this.controllers.delete(runId); this.closingRuns.delete(runId) })
    this.closingRuns.set(runId, task); return task
  }
  private async revokeAffected(id: string): Promise<void> {
    for (const runId of this.controllers.keys()) {
      const snapshot = frozen(this.config(runId))
      if (!snapshot?.plugins.some((pin) => pin.record.id === id)) continue
      await this.closeRun(runId)
      this.evidence(runId, 'extension_permission_revoked', { id, source: 'desktop_lifecycle_change' })
      await this.engine?.pause(runId)
    }
  }
  get hasActiveHosts(): boolean { return this.pluginRuns.size > 0 }
  async close(): Promise<void> {
    this.stopping = true
    const failures: string[] = []
    for (const runId of this.controllers.keys()) {
      try { await this.engine?.pause(runId) } catch (error) { failures.push((error as Error).message) }
    }
    for (const controller of this.controllers.values()) controller.abort()
    await this.activation.close()
    this.pluginRuns.clear()
    if (failures.length) throw new Error(failures.join('；'))
  }
}
