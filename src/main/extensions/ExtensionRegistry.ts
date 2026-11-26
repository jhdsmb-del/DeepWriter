import { createHash, randomUUID } from 'node:crypto'
import { promises as fs, constants as fsConstants, lstatSync, realpathSync } from 'node:fs'
import * as path from 'node:path'
import { BUILTIN_EXTENSIONS, type BuiltinExtension } from './builtinCatalog'

export interface ExtensionFile { path: string; size: number; sha256: string }
export interface ExtensionRecord { id: string; name: string; kind: 'skill' | 'tool'; version: string; description: string; source: string; packageHash: string; files: ExtensionFile[]; entry?: string; enabled: boolean; removed: boolean; firstParty: boolean; license: string; requestedPermissions: string[]; blockedReason?: string }
export interface ExtensionSelection { skills: string[]; plugins: string[] }
interface RegistryData { schemaVersion: 1; revision: number; extensions: ExtensionRecord[]; selectedForNewRuns?: ExtensionSelection }
export interface FrozenExtension { record: ExtensionRecord; instructions?: Array<{ path: string; content: string; sha256: string }> }
const hash = (text: string | Buffer): string => createHash('sha256').update(text).digest('hex')
const errorCode = (error: unknown): string | undefined => (error as NodeJS.ErrnoException).code
const NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const ID = /^[a-z0-9]+(?:-[a-z0-9]+)*\/[a-z0-9]+(?:-[a-z0-9]+)*$/
function checkedSelection(value: ExtensionSelection): ExtensionSelection {
  if (!value || !Array.isArray(value.skills) || !Array.isArray(value.plugins)
    || value.skills.length > 8 || value.plugins.length > 8
    || [...value.skills, ...value.plugins].some((id) => typeof id !== 'string' || id.length > 129 || !ID.test(id))
    || new Set([...value.skills, ...value.plugins]).size !== value.skills.length + value.plugins.length) throw new Error('extension_selection_invalid')
  return { skills: [...value.skills], plugins: [...value.plugins] }
}
function unselect(data: RegistryData, id: string): void {
  if (data.selectedForNewRuns) data.selectedForNewRuns = {
    skills: data.selectedForNewRuns.skills.filter((item) => item !== id),
    plugins: data.selectedForNewRuns.plugins.filter((item) => item !== id)
  }
}
function safeRelative(value: string): void {
  if (!value || value.includes('\\') || value.includes(':') || value.includes('\0') || path.posix.isAbsolute(value) || value.split('/').some((part) => !part || part === '.' || part === '..' || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part) || /[. ]$/.test(part))) throw new Error('extension_path_invalid')
}
const samePath = (a: string, b: string): boolean => process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b
function canonicalRoot(root: string): string {
  let ancestor = root
  for (;;) {
    try { return path.resolve(realpathSync.native(ancestor), path.relative(ancestor, root)) } catch (error) {
      const parent = path.dirname(ancestor)
      if (errorCode(error) !== 'ENOENT' || parent === ancestor) throw error
      // A dangling link exists even though realpath reports ENOENT. Do not
      // confuse that replacement with an ordinary, not-yet-created tail.
      let exists = true
      try { lstatSync(ancestor) } catch (probe) { if (errorCode(probe) !== 'ENOENT') throw probe; exists = false }
      if (exists) throw error
      ancestor = parent
    }
  }
}
async function removeStaging(root: string, target: string): Promise<void> {
  if (path.dirname(path.resolve(target)) !== root || !/^staging-[a-f0-9-]+$/.test(path.basename(target))) throw new Error('extension_cleanup_scope_invalid')
  await fs.rm(target, { recursive: true, force: true })
}
function skillMetadata(text: string): { name: string; description: string } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text)
  if (!match) throw new Error('SKILL.md 缺少 YAML frontmatter')
  const field = (name: string): string => {
    const rows = match[1].split(/\r?\n/); const index = rows.findIndex((row) => row.startsWith(name + ':'))
    if (index < 0) throw new Error(`SKILL.md 缺少 ${name}`)
    let value = rows[index].slice(name.length + 1).trim()
    // Support the common block-scalar description without executing YAML tags.
    if (/^[>|][-+]?$/u.test(rows[index].slice(name.length + 1).trim())) {
      const block: string[] = []
      for (const row of rows.slice(index + 1)) { if (!/^\s+/.test(row)) break; block.push(row.trim()) }
      value = block.join(' ')
    }
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1)
    return value
  }
  const name = field('name'); const description = field('description')
  if (!NAME.test(name) || name.length > 64 || !description || description.length > 1024) throw new Error('SKILL.md 元数据无效')
  return { name, description }
}
async function readPackage(root: string): Promise<Record<string, string>> {
  const files: Record<string, string> = {}; let bytes = 0; const names = new Set<string>()
  const walk = async (relative: string, depth: number): Promise<void> => {
    if (depth > 5) throw new Error('extension_depth_limit')
    for (const entry of await fs.readdir(path.join(root, relative), { withFileTypes: true })) {
      const key = relative ? relative + '/' + entry.name : entry.name; safeRelative(key)
      if (entry.isSymbolicLink()) throw new Error('extension_symlink_rejected')
      const full = path.join(root, key); const real = await fs.realpath(full)
      if (path.relative(root, real).startsWith('..') || path.isAbsolute(path.relative(root, real))) throw new Error('extension_path_escape')
      if (entry.isDirectory()) { if (['node_modules', '.git', 'hooks', 'bin'].includes(entry.name)) throw new Error('不支持可执行组件/依赖目录'); await walk(key, depth + 1) }
      else if (entry.isFile()) {
        if (names.has(key.toLowerCase())) throw new Error('extension_case_collision'); names.add(key.toLowerCase())
        const stat = await fs.stat(full); if (stat.size > 128000 || names.size > 128) throw new Error('extension_size_limit')
        const buffer = await fs.readFile(full); bytes += buffer.length; if (bytes > 2000000) throw new Error('extension_total_size_limit')
        files[key] = new TextDecoder('utf-8', { fatal: true }).decode(buffer)
      } else throw new Error('extension_file_type_rejected')
    }
  }
  await walk('', 0); return files
}
function localDefinition(files: Record<string, string>): BuiltinExtension {
  if (files['package.json'] || files['.mcp.json'] || files['hooks.json']) throw new Error('第三方工具/安装脚本默认blocked；本地只支持技能指令子集')
  let skillPath = 'SKILL.md'; let version = 'local'; let extensionName: string | undefined
  if (files['.claude-plugin/plugin.json']) {
    let manifest: Record<string, unknown>
    try { manifest = JSON.parse(files['.claude-plugin/plugin.json']) as Record<string, unknown> } catch { throw new Error('插件 manifest JSON 无效（不显示源内容）') }
    if (!manifest || Object.keys(manifest).some((key) => !['name', 'version', 'description', 'skills'].includes(key))) throw new Error('Claude插件包含不支持/未知组件；拒绝安装')
    const skills = typeof manifest.skills === 'string' ? [manifest.skills] : manifest.skills
    if (!Array.isArray(skills) || skills.length !== 1 || typeof skills[0] !== 'string') throw new Error('Claude子集只支持明确单技能目录')
    const directory = skills[0].replace(/^\.\//, '').replace(/\/$/, ''); safeRelative(directory)
    skillPath = `${directory}/SKILL.md`; extensionName = String(manifest.name); version = String(manifest.version ?? 'local')
  }
  const text = files[skillPath]; if (!text) throw new Error('未找到支持的 SKILL.md')
  const meta = skillMetadata(text); const name = extensionName ?? meta.name
  if (!NAME.test(name)) throw new Error('extension_name_invalid')
  for (const key of Object.keys(files)) {
    if (key !== skillPath && key !== '.claude-plugin/plugin.json' && !/(?:^|\/)(?:references|assets)\//.test(key) && !/^(LICENSE|README)(?:\.[A-Za-z]+)?$/.test(key)) throw new Error(`不支持的包内容：${key}；scripts不会自动执行`)
  }
  return { id: `local/${name}`, name, kind: 'skill', version, description: meta.description, files }
}

export class ExtensionRegistry {
  readonly root: string
  private readonly configuredRoot: string
  constructor(root: string) {
    this.configuredRoot = path.resolve(root)
    // Pin the existing ancestor's real identity, including Windows short names
    // and initial aliases, while allowing the registry directory to be absent.
    this.root = canonicalRoot(this.configuredRoot)
  }
  private assertRootIdentity(): void {
    // Never adopt a later alias/registry replacement, even with identical bytes.
    try {
      if (!samePath(canonicalRoot(this.configuredRoot), this.root) || !samePath(canonicalRoot(this.root), this.root)) throw new Error('extension_registry_root_changed')
    } catch (error) { if (errorCode(error) === 'ENOENT') throw new Error('extension_registry_root_changed'); throw error }
  }
  catalog(): Array<Omit<BuiltinExtension, 'files'> & { fileCount: number }> { return BUILTIN_EXTENSIONS.map(({ files, ...item }) => ({ ...item, fileCount: Object.keys(files).length })) }
  async localCatalog(directory: string): Promise<Array<{ id: string; name: string; kind: 'skill'; source: string; version: string; description: string; catalogHash: string }>> {
    const root = await fs.realpath(path.resolve(directory)); const file = path.join(root, '.claude-plugin', 'marketplace.json')
    if ((await fs.stat(file)).size > 65536 || !samePath(await fs.realpath(file), file)) throw new Error('extension_catalog_size_or_path_invalid')
    const bytes = await fs.readFile(file); let value: Record<string, unknown>
    try { value = JSON.parse(bytes.toString('utf8')) as Record<string, unknown> } catch { throw new Error('Claude catalog JSON无效（不显示源内容）') }
    if (!value || Object.keys(value).some((key) => !['name', 'owner', 'plugins'].includes(key)) || typeof value.name !== 'string' || !Array.isArray(value.plugins) || value.plugins.length > 64) throw new Error('Claude catalog未知组件/结构；只支持本地静态目录子集')
    return Promise.all(value.plugins.map(async (raw: unknown) => {
      const item = raw as Record<string, unknown>
      if (!item || Object.keys(item).some((key) => !['name', 'source', 'description', 'version'].includes(key)) || typeof item.name !== 'string' || !NAME.test(item.name) || typeof item.source !== 'string') throw new Error('Claude catalog条目未知组件/远程来源被拒绝')
      const relative = item.source.replace(/^\.\//, '').replace(/\/$/, ''); safeRelative(relative)
      const source = path.join(root, relative); if (!samePath(await fs.realpath(source), source)) throw new Error('extension_catalog_source_changed')
      const definition = localDefinition(await readPackage(source))
      return { id: definition.id, name: item.name, kind: 'skill' as const, source, version: definition.version, description: definition.description, catalogHash: hash(bytes) }
    }))
  }
  private async data(): Promise<RegistryData> {
    this.assertRootIdentity()
    try {
      const file = path.join(this.root, 'registry.json'); const stat = await fs.stat(file); if (stat.size > 2000000) throw new Error('extension_registry_size_limit')
      const value = JSON.parse(await fs.readFile(file, 'utf8')) as RegistryData
      if (value.schemaVersion !== 1 || !Number.isInteger(value.revision) || !Array.isArray(value.extensions)) throw new Error('extension_registry_invalid')
      if (value.selectedForNewRuns !== undefined) checkedSelection(value.selectedForNewRuns)
      return value
    } catch (error) { if (errorCode(error) === 'ENOENT') return { schemaVersion: 1, revision: 0, extensions: [] }; if (error instanceof SyntaxError) throw new Error('扩展注册表 JSON 无效（不显示源内容）'); throw error }
  }
  private async replaceRegistry(temporary: string): Promise<void> {
    const target = path.join(this.root, 'registry.json')
    const backoff = [10, 20, 40, 80, 160]
    for (let attempt = 0; ; attempt++) {
      this.assertRootIdentity()
      try { await fs.rename(temporary, target); return } catch (error) {
        // Windows can report EPERM while a revocation monitor briefly reads
        // the destination. Keep the writer lock and staged bytes throughout;
        // never unlink the durable target or repeat the mutation itself.
        if (process.platform !== 'win32' || !['EPERM', 'EACCES', 'EBUSY'].includes(errorCode(error) ?? '') || attempt >= backoff.length) throw error
        // Node conflates sharing and permission failures. Reject obvious
        // read-only/missing files now; persistent denial still throws above.
        try { await fs.access(temporary, fsConstants.W_OK); await fs.access(target, fsConstants.W_OK) } catch { throw error }
        await new Promise<void>((resolve) => setTimeout(resolve, backoff[attempt]))
      }
    }
  }
  private async mutate<T>(work: (data: RegistryData) => Promise<T>): Promise<T> {
    this.assertRootIdentity()
    await fs.mkdir(this.root, { recursive: true }); this.assertRootIdentity()
    const lock = path.join(this.root, 'registry.lock'); const token = `${process.pid}:${randomUUID()}`
    let handle
    for (let attempt = 0; attempt < 2; attempt++) {
      try { handle = await fs.open(lock, 'wx'); await handle.writeFile(token); break } catch (error) {
        if (errorCode(error) !== 'EEXIST') throw error
        const previous = await fs.readFile(lock, 'utf8'); const pid = Number(previous.split(':')[0])
        if (!Number.isSafeInteger(pid) || pid < 1) throw new Error('扩展注册表锁损坏；拒绝并发修改')
        try { process.kill(pid, 0); throw new Error('扩展注册表正被另一个进程修改；请重试') } catch (probe) { if (errorCode(probe) !== 'ESRCH') throw probe }
        if (await fs.readFile(lock, 'utf8') !== previous) throw new Error('扩展注册表锁已变化；请重试')
        this.assertRootIdentity()
        await fs.unlink(lock)
      }
    }
    if (!handle) throw new Error('无法获取扩展注册表锁')
    try {
      const data = await this.data(); const result = await work(data); data.revision++
      this.assertRootIdentity()
      const temporary = path.join(this.root, `.registry-${randomUUID()}.tmp`)
      try { await fs.writeFile(temporary, JSON.stringify(data, null, 2), { flag: 'wx' }); await this.replaceRegistry(temporary) } finally { this.assertRootIdentity(); await fs.unlink(temporary).catch(() => undefined) }
      return result
    } finally {
      await handle.close(); this.assertRootIdentity()
      if (await fs.readFile(lock, 'utf8') === token) { this.assertRootIdentity(); await fs.unlink(lock) }
    }
  }
  async list(kind?: ExtensionRecord['kind']): Promise<ExtensionRecord[]> { return (await this.data()).extensions.filter((item) => !item.removed && (!kind || item.kind === kind)) }
  async selection(): Promise<ExtensionSelection> { return checkedSelection((await this.data()).selectedForNewRuns ?? { skills: [], plugins: [] }) }
  async setSelection(input: ExtensionSelection): Promise<ExtensionSelection> {
    const selected = checkedSelection(input)
    return this.mutate(async (data) => {
      for (const [kind, ids] of [['skill', selected.skills], ['tool', selected.plugins]] as const) {
        for (const id of ids) {
          const record = data.extensions.find((item) => item.id === id && !item.removed)
          if (!record || !record.enabled || record.kind !== kind) throw new Error('选择的扩展未安装/未启用或类型不匹配')
          await this.verify(record)
          if (kind === 'tool' && !record.firstParty) throw new Error('第三方进程blocked：没有OS沙箱')
        }
      }
      data.selectedForNewRuns = selected
      return checkedSelection(selected)
    })
  }
  async inspect(id: string): Promise<ExtensionRecord> {
    const item = (await this.data()).extensions.find((entry) => entry.id === id && !entry.removed); if (!item) throw new Error('扩展未安装'); return item
  }
  async install(source: string, kind: ExtensionRecord['kind']): Promise<ExtensionRecord> {
    const builtin = source.startsWith('builtin:') ? BUILTIN_EXTENSIONS.find((entry) => entry.id === source.slice(8)) : undefined
    if (source.startsWith('builtin:') && !builtin) throw new Error('未知内置扩展')
    const definition = builtin ?? localDefinition(await readPackage(await fs.realpath(path.resolve(source))))
    if (definition.kind !== kind || !ID.test(definition.id)) throw new Error('扩展类型/标识不匹配')
    const files = Object.entries(definition.files).sort(([a], [b]) => a.localeCompare(b)).map(([file, text]) => { safeRelative(file); return { path: file, size: Buffer.byteLength(text), sha256: hash(text) } })
    const packageHash = hash(JSON.stringify({ id: definition.id, kind, version: definition.version, files }))
    const licenseLine = Object.values(definition.files).find((text) => text.startsWith('---'))?.match(/^license:\s*(.+)$/m)?.[1]?.trim()
    const record: ExtensionRecord = { id: definition.id, name: definition.name, kind, version: definition.version, description: definition.description, source: builtin ? source : path.resolve(source), packageHash, files, ...(definition.entry ? { entry: definition.entry } : {}), enabled: false, removed: false, firstParty: Boolean(builtin), license: builtin ? 'MIT' : licenseLine?.slice(0, 1024) ?? '未声明', requestedPermissions: kind === 'skill' ? ['instructions', 'frozen-resource-read'] : ['node-process-start', 'read-frozen-work-and-doc-roots'] }
    return this.mutate(async (data) => {
      const destination = this.packageDir(record); const temporary = path.join(this.root, `staging-${randomUUID()}`)
      try {
        await fs.mkdir(temporary)
        for (const [file, text] of Object.entries(definition.files)) { const target = path.join(temporary, file); await fs.mkdir(path.dirname(target), { recursive: true }); await fs.writeFile(target, text, { flag: 'wx' }) }
        await fs.writeFile(path.join(temporary, 'receipt.json'), JSON.stringify(record), { flag: 'wx' })
        await fs.mkdir(path.dirname(destination), { recursive: true })
        try { await fs.rename(temporary, destination) } catch (error) { if (!['EEXIST', 'ENOTEMPTY', 'EPERM'].includes(errorCode(error) ?? '')) throw error; await this.verify(record) }
      } finally { this.assertRootIdentity(); await removeStaging(this.root, temporary) }
      const previous = data.extensions.findIndex((item) => item.id === record.id)
      if (previous >= 0) data.extensions[previous] = record; else data.extensions.push(record)
      unselect(data, record.id)
      return record
    })
  }
  private packageDir(record: ExtensionRecord): string {
    if (!ID.test(record.id) || !/^[a-f0-9]{64}$/.test(record.packageHash)) throw new Error('extension_identity_invalid')
    return path.join(this.root, 'packages', ...record.id.split('/'), record.packageHash)
  }
  async verify(record: ExtensionRecord): Promise<void> {
    this.assertRootIdentity()
    const root = this.packageDir(record); const realRoot = await fs.realpath(root)
    if (!samePath(realRoot, root)) throw new Error('extension_package_root_changed')
    if (!Array.isArray(record.files) || !record.files.length || record.files.length > 128) throw new Error('extension_inventory_invalid')
    for (const file of record.files) {
      safeRelative(file.path); const target = path.join(root, file.path); const stat = await fs.lstat(target)
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== file.size || !samePath(await fs.realpath(target), target) || hash(await fs.readFile(target)) !== file.sha256) throw new Error('extension_content_changed')
    }
    const expected = hash(JSON.stringify({ id: record.id, kind: record.kind, version: record.version, files: record.files }))
    if (expected !== record.packageHash) throw new Error('extension_inventory_changed')
  }
  async setEnabled(id: string, enabled: boolean, remove = false): Promise<ExtensionRecord> {
    return this.mutate(async (data) => {
      const record = data.extensions.find((item) => item.id === id && !item.removed); if (!record) throw new Error('扩展未安装')
      if (enabled) { await this.verify(record); if (record.kind === 'tool' && !record.firstParty) throw new Error('第三方进程blocked：没有OS沙箱，禁止启动') }
      record.enabled = enabled; if (remove) record.removed = true
      if (!enabled || remove) unselect(data, id)
      // Immutable versions deliberately remain for existing frozen runs.
      return { ...record }
    })
  }
  async freeze(id: string, kind: ExtensionRecord['kind']): Promise<FrozenExtension> {
    const record = await this.inspect(id); if (!record.enabled || record.kind !== kind) throw new Error('扩展未启用或类型不匹配')
    await this.verify(record)
    return { record: { ...record }, ...(kind === 'skill' ? { instructions: await Promise.all(record.files.filter((file) => file.path === 'SKILL.md' || file.path.endsWith('/SKILL.md')).map(async (file) => ({ path: file.path, sha256: file.sha256, content: await fs.readFile(path.join(this.packageDir(record), file.path), 'utf8') }))) } : {}) }
  }
  async resource(pin: FrozenExtension, relative: string): Promise<string> {
    safeRelative(relative); const file = pin.record.files.find((item) => item.path === relative)
    if (!file) throw new Error('引用不属于冻结资源inventory'); await this.verify(pin.record)
    return fs.readFile(path.join(this.packageDir(pin.record), relative), 'utf8')
  }
  async entry(pin: FrozenExtension): Promise<string> {
    await this.assertPluginEnabled(pin)
    if (pin.record.kind !== 'tool' || !pin.record.firstParty || !pin.record.entry) throw new Error('工具宿主blocked；没有OS沙箱')
    const trusted = BUILTIN_EXTENSIONS.find((item) => item.id === pin.record.id && item.entry === pin.record.entry)
    const file = pin.record.files.find((item) => item.path === pin.record.entry)
    if (!trusted || !file || hash(trusted.files[pin.record.entry]) !== file.sha256) throw new Error('工具入口不属于已审核第一方源')
    await this.verify(pin.record); return path.join(this.packageDir(pin.record), pin.record.entry)
  }
  async assertPluginEnabled(pin: FrozenExtension): Promise<void> {
    const current = (await this.data()).extensions.find((item) => item.id === pin.record.id)
    // Keeping immutable bytes for recovery never keeps executable permission.
    if (pin.record.kind !== 'tool' || !current || !current.enabled || current.removed || current.packageHash !== pin.record.packageHash) throw new Error('plugin_permission_revoked：当前版本已停用/卸载/升级')
  }
}
