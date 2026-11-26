import { promises as fs, constants as fsConstants } from 'node:fs'
import * as path from 'node:path'
import { createHash, randomBytes } from 'node:crypto'
import {
  advanceGalgameStudio,
  assertStudioGenerationAllowed,
  createGalgameStudioState,
  nextGalgameStudioStage,
  studioGate,
  validateAssetManifest,
  type GalgameAssetCheck,
  type GalgameAssetKind,
  type GalgameAssetManifest,
  type GalgameAssetIssue,
  type GalgameBackgroundAsset,
  type GalgameCharacterAsset,
  type GalgameSdkEvidence,
  type GalgameSpriteAsset,
  type GalgameStudioSnapshot,
  type GalgameStudioState,
  type GalgameAudioAsset,
  type GalgameProductionHandoff
} from '../shared/galgameStudio'
import { grillMeOutlineHash, type GrillMeOutline, type GrillMeState } from '../shared/grillMe'
import { applyRenpyPatch, buildBranchGraph, parseLintOutput, type BranchGraph, type LintDiagnostic } from './galgame'
import { validateStudioStory } from './galgameProduction'
import { downloadAndInstallManagedSdk, inspectRenpySdk, runRenpyLint, type RenpySdkCandidate, type RenpySdkInspection, type RenpySdkLayout, type SdkCommandRunner, type SdkDownloadOptions, type SdkFetch } from './renpySdk'

const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif'])
const AUDIO_EXTENSIONS = new Set(['.ogg', '.mp3', '.wav', '.webm'])
const MAX_ASSET_BYTES = 200 * 1024 * 1024

export interface StudioResolvedFile {
  realpath: string
  displayName: string
  size?: number
}

export interface GalgameStudioDeps {
  baseDir: string
  resolveAssetRef?: (fileRefId: string, sessionId: string) => Promise<StudioResolvedFile | null>
  getGrillState?: (sessionId: string) => Promise<GrillMeState | null>
  getBranchGraph?: (projectDir: string) => Promise<BranchGraph>
  inspectSdk?: (input: { explicitPath?: string | null; discoveryRoots?: string[] }) => Promise<RenpySdkInspection>
  downloadSdk?: (options: Omit<SdkDownloadOptions, 'userDataDir'>) => Promise<RenpySdkCandidate>
  lint?: (layout: RenpySdkLayout, projectDir: string) => Promise<{ ok: boolean; output: string; exitCode: number | null; command: string; verified: boolean; cancelled?: boolean }>
  /**
   * The service owns the stage gate, isolated candidate project and exclusive
   * publication. The host applies a production patch to that candidate only
   * through the existing Galgame Agent generator and safe patch applier.  No renderer/model credentials cross
   * this boundary.
   */
  runProductionAgent?: (input: {
    sessionId: string
    projectDir: string
    targetFile: string
    sceneSpec: string
  }) => Promise<{ status: 'agent_applied' | 'skeleton_handoff' | 'agent_failed'; message: string }>
}

export interface CreateProjectInput {
  parentDir: string
  name: string
  sessionId: string
}

export interface CreatedProject {
  projectId: string
  projectDir: string
  projectName: string
  mode: 'create'
}

export interface ImportedProject {
  projectId: string
  projectDir: string
  projectName: string
  mode: 'import'
}

export interface StudioAssetInput {
  manifest: GalgameAssetManifest
}

export interface StudioPlanConfirmation {
  outlineHash?: string
  branchHash: string
}

export interface StudioGenerationResult {
  ok: boolean
  generatedFile: string | null
  copiedAssets: Array<{ id: string; target: string; kind: GalgameAssetKind }>
  production: GalgameProductionHandoff
  error?: string
}

export interface StudioLintResult {
  ok: boolean
  verified: boolean
  output: string
  command: string
  exitCode: number | null
  errorCount: number
  warningCount: number
  diagnostics: LintDiagnostic[]
  cancelled?: boolean
}

function randomId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${randomBytes(8).toString('hex')}`
}

function sameSdk(left: GalgameSdkEvidence | null, right: GalgameSdkEvidence): boolean {
  if (!left || left.version !== right.version) return false
  const samePath = (a: string, b: string): boolean => process.platform === 'win32' ? path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase() : path.resolve(a) === path.resolve(b)
  return samePath(left.root, right.root) && samePath(left.pythonPath, right.pythonPath) && samePath(left.renpyScriptPath, right.renpyScriptPath)
}

function safeProjectName(value: string): string {
  const trimmed = value.trim().replace(/[\\/:*?"<>|\u0000]/g, '_').replace(/\s+/g, ' ').replace(/^\.+|\.+$/g, '').trim()
  if (!trimmed || trimmed === '.' || trimmed === '..') throw new Error('项目名不能为空或包含非法路径')
  if (trimmed.length > 80) throw new Error('项目名不能超过 80 个字符')
  return trimmed
}

function safeIdentifier(value: string, fallback: string): string {
  const ascii = value.normalize('NFKD').replace(/[^a-zA-Z0-9_]+/g, '_').replace(/^\d+/, '').replace(/^_+|_+$/g, '')
  return (ascii || fallback).slice(0, 50)
}

function renpyString(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\r?\n/g, ' ')
}

function stableGraph(graph: BranchGraph): unknown {
  return {
    labels: [...graph.labels].map((label) => ({ name: label.name, file: label.file, line: label.line, incoming: [...label.incoming].sort(), outgoing: [...label.outgoing].sort() })).sort((a, b) => `${a.file}:${a.line}:${a.name}`.localeCompare(`${b.file}:${b.line}:${b.name}`)),
    edges: [...graph.edges].map((edge) => ({ from: edge.from, to: edge.to, type: edge.type, file: edge.file, line: edge.line, ...(edge.choice === undefined ? {} : { choice: edge.choice }) })).sort((a, b) => `${a.file}:${a.line}:${a.from}:${a.to}:${a.type}`.localeCompare(`${b.file}:${b.line}:${b.from}:${b.to}:${b.type}`)),
    diagnostics: [...graph.diagnostics].map((diag) => ({ severity: diag.severity, code: diag.code, message: diag.message, file: diag.file, line: diag.line })).sort((a, b) => `${a.file}:${a.line}:${a.code}:${a.message}`.localeCompare(`${b.file}:${b.line}:${b.code}:${b.message}`))
  }
}

export function hashGalgameBranchGraph(graph: BranchGraph): string {
  return createHash('sha256').update(JSON.stringify(stableGraph(graph))).digest('hex')
}

async function realContained(target: string, root: string): Promise<boolean> {
  const rootReal = await fs.realpath(root).catch(() => null)
  const parent = await fs.realpath(path.dirname(target)).catch(() => null)
  if (!rootReal || !parent) return false
  const a = path.resolve(parent, path.basename(target)).toLowerCase()
  const r = path.resolve(rootReal).toLowerCase()
  return a === r || a.startsWith(r + path.sep)
}

async function writeAtomic(file: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true })
  const temp = `${file}.dw-tmp-${randomId('write')}`
  try {
    await fs.writeFile(temp, content, 'utf8')
    await fs.rename(temp, file)
  } finally {
    await fs.rm(temp, { force: true }).catch(() => undefined)
  }
}

async function copyAtomic(source: string, target: string): Promise<void> {
  const stat = await fs.stat(source).catch(() => null)
  if (!stat?.isFile()) throw new Error(`素材文件不存在：${path.basename(source)}`)
  if (stat.size > MAX_ASSET_BYTES) throw new Error(`素材文件过大：${path.basename(source)}`)
  await fs.mkdir(path.dirname(target), { recursive: true })
  const temp = `${target}.dw-tmp-${randomId('asset')}`
  try {
    await fs.copyFile(source, temp)
    await fs.rename(temp, target)
  } finally {
    await fs.rm(temp, { force: true }).catch(() => undefined)
  }
}

export async function createRenpyProject(input: CreateProjectInput): Promise<CreatedProject> {
  const name = safeProjectName(input.name)
  const parent = path.resolve(input.parentDir)
  const parentReal = await fs.realpath(parent).catch(() => null)
  if (!parentReal) throw new Error('项目父目录不存在或未授权')
  const projectDir = path.resolve(parentReal, name)
  if (projectDir.toLowerCase() === parentReal.toLowerCase() || !projectDir.toLowerCase().startsWith(parentReal.toLowerCase() + path.sep)) throw new Error('项目路径越界')
  if (await fs.stat(projectDir).then(() => true).catch(() => false)) throw new Error('项目目录已存在，请换一个项目名')
  await fs.mkdir(path.join(projectDir, 'game', 'script'), { recursive: true })
  await fs.mkdir(path.join(projectDir, 'game', 'images', 'characters'), { recursive: true })
  await fs.mkdir(path.join(projectDir, 'game', 'images', 'backgrounds'), { recursive: true })
  await fs.mkdir(path.join(projectDir, 'game', 'audio'), { recursive: true })
  await writeAtomic(path.join(projectDir, 'game', 'config.rpy'), `define config.name = "${renpyString(name)}"\n`)
  await writeAtomic(path.join(projectDir, 'game', 'script', 'script.rpy'), PROJECT_BOOTSTRAP)
  const projectId = randomId('project')
  return { projectId, projectDir, projectName: name, mode: 'create' }
}

export async function importRenpyProject(projectDirInput: string): Promise<ImportedProject> {
  const projectDir = path.resolve(projectDirInput)
  const root = await fs.realpath(projectDir).catch(() => null)
  if (!root) throw new Error('项目目录不存在')
  const game = path.join(root, 'game')
  const gameStat = await fs.stat(game).catch(() => null)
  if (!gameStat?.isDirectory()) throw new Error('不是 Ren\'Py 项目：缺少 game/ 目录')
  const projectName = path.basename(root) || 'RenPy 项目'
  return { projectId: randomId('project'), projectDir: root, projectName, mode: 'import' }
}

function addIssue(issues: GalgameAssetIssue[], issue: GalgameAssetIssue): void {
  issues.push(issue)
}

function assetEntries(manifest: GalgameAssetManifest): Array<{ kind: GalgameAssetKind; id: string; fileRefId: string; displayName: string | undefined }> {
  return [
    ...manifest.sprites.map((item) => ({ kind: 'sprite' as const, id: item.id, fileRefId: item.fileRefId, displayName: item.displayName })),
    ...manifest.backgrounds.map((item) => ({ kind: 'background' as const, id: item.id, fileRefId: item.fileRefId, displayName: item.displayName })),
    ...manifest.audio.map((item) => ({ kind: 'audio' as const, id: item.id, fileRefId: item.fileRefId, displayName: item.displayName }))
  ]
}

export async function validateGalgameAssetManifest(
  manifest: unknown,
  options: { sessionId: string; resolveFile?: (fileRefId: string, sessionId: string) => Promise<StudioResolvedFile | null> } = { sessionId: '' }
): Promise<GalgameAssetCheck> {
  const base = validateAssetManifest(manifest)
  if (!base.ok || !options.resolveFile || !manifest || typeof manifest !== 'object') return base
  const value = manifest as GalgameAssetManifest
  const issues = [...base.issues]
  const seenReal = new Set<string>()
  for (const entry of assetEntries(value)) {
    if (!entry.fileRefId?.trim()) continue
    const file = await options.resolveFile(entry.fileRefId, options.sessionId).catch(() => null)
    if (!file) {
      addIssue(issues, { code: 'ref_not_authorized', message: `素材 ${entry.id} 未通过已授权文件引用校验`, kind: entry.kind, id: entry.id })
      continue
    }
    const ext = path.extname(file.displayName || file.realpath).toLowerCase()
    const allowed = entry.kind === 'audio' ? AUDIO_EXTENSIONS : IMAGE_EXTENSIONS
    if (!allowed.has(ext)) addIssue(issues, { code: 'unsupported_type', message: `素材 ${entry.id} 类型不受支持：${ext || '无扩展名'}`, kind: entry.kind, id: entry.id })
    const stat = await fs.stat(file.realpath).catch(() => null)
    if (!stat?.isFile()) addIssue(issues, { code: 'file_missing', message: `素材 ${entry.id} 文件不存在`, kind: entry.kind, id: entry.id })
    else if (file.size !== undefined && file.size !== stat.size) addIssue(issues, { code: 'file_changed', message: `素材 ${entry.id} 在选择后发生变化，请重新选择`, kind: entry.kind, id: entry.id })
    const real = await fs.realpath(file.realpath).catch(() => file.realpath)
    const key = process.platform === 'win32' ? real.toLowerCase() : real
    if (seenReal.has(key)) addIssue(issues, { code: 'duplicate_file_ref', message: `素材 ${entry.id} 与其他素材指向同一文件`, kind: entry.kind, id: entry.id })
    seenReal.add(key)
  }
  return { ...base, ok: issues.length === 0, issues }
}

/** Preserve unambiguous existing ASCII names, reserving those names before
 * resolving collisions. Raw identities, not array order, determine suffixes. */
function uniqueNames(entries: Array<{ key: string; base: string }>, reserved: string[] = [], caseInsensitive = false): Map<string, string> {
  const compare = (value: string): string => caseInsensitive ? value.toLowerCase() : value
  const counts = new Map<string, number>()
  const used = new Set(reserved.map(compare))
  const result = new Map<string, string>()
  for (const entry of entries) counts.set(compare(entry.base), (counts.get(compare(entry.base)) ?? 0) + 1)
  for (const entry of entries) {
    if (counts.get(compare(entry.base)) === 1 && !used.has(compare(entry.base))) {
      result.set(entry.key, entry.base)
      used.add(compare(entry.base))
    }
  }
  for (const entry of [...entries].sort((a, b) => a.key < b.key ? -1 : a.key > b.key ? 1 : 0)) {
    if (result.has(entry.key)) continue
    const suffix = createHash('sha256').update(entry.key, 'utf8').digest('hex').slice(0, 12)
    const base = `${entry.base}__${suffix}`
    let name = base
    for (let index = 2; used.has(compare(name)); index++) name = `${base}_${index}`
    result.set(entry.key, name)
    used.add(compare(name))
  }
  return result
}

/** One namespace plan is shared by new definitions, file copies, initial
 * staging and the production Agent. Existing project files are not renamed. */
export function buildGalgameNames(manifest: GalgameAssetManifest, prefix = 'dw'): {
  characters: Map<string, string>; sprites: Map<string, string>; backgrounds: Map<string, string>; assetStems: Map<string, string>
} {
  const characters = uniqueNames(manifest.characters.map(item => ({ key: item.id, base: `${prefix}_${safeIdentifier(item.id, 'character')}` })), [`${prefix}_narrator`])
  const images = uniqueNames([
    ...manifest.sprites.map(item => ({ key: `sprite:${item.id}`, base: `${characters.get(item.characterId)}_${safeIdentifier(item.expression, 'default')}` })),
    ...manifest.backgrounds.map(item => ({ key: `background:${item.id}`, base: `${prefix}_bg_${safeIdentifier(item.id, 'background')}` }))
  ])
  const assetStems = new Map<string, string>()
  for (const items of [manifest.sprites, manifest.backgrounds, manifest.audio]) {
    for (const [id, stem] of uniqueNames(items.map(item => ({ key: item.id, base: safeIdentifier(item.id, 'asset') })), [], true)) assetStems.set(id, stem)
  }
  return { characters, sprites: new Map(manifest.sprites.map(item => [item.id, images.get(`sprite:${item.id}`)!])), backgrounds: new Map(manifest.backgrounds.map(item => [item.id, images.get(`background:${item.id}`)!])), assetStems }
}

type GalgameNames = ReturnType<typeof buildGalgameNames>

const PROJECT_BOOTSTRAP = '# DeepWriter Galgame 项目\nlabel start:\n    "请在 Galgame Studio 中确认素材与大纲后生成剧本。"\n    return\n'
const INSERTION_POINT = '    # DeepWriter Agent insertion point'

type CopiedAsset = { id: string; target: string; kind: GalgameAssetKind }

function buildGeneratedScript(manifest: GalgameAssetManifest, copied: CopiedAsset[], names: GalgameNames, prefix: string): { raw: string; header: string } {
  const lines = ['# Generated candidate; published only after production validation.', '']
  for (const character of manifest.characters) lines.push(`define ${names.characters.get(character.id)!} = Character("${renpyString(character.name)}")`)
  for (const asset of [...manifest.sprites, ...manifest.backgrounds]) {
    const copy = copied.find(item => item.id === asset.id)!
    const image = names.sprites.get(asset.id) ?? names.backgrounds.get(asset.id)!
    lines.push(`image ${image} = "${renpyString(`images/deepwriter_assets_${prefix}/${path.basename(copy.target)}`)}"`)
  }
  const header = lines.join('\n') + '\n\n'
  return { header, raw: header + [`label ${prefix}_start:`, `    scene ${names.backgrounds.get(manifest.backgrounds[0].id)!} with dissolve`, `    show ${names.sprites.get(manifest.sprites[0].id)!} at center with dissolve`, INSERTION_POINT, ''].join('\n') }
}

function buildAgentSceneSpec(manifest: GalgameAssetManifest, outline: GrillMeOutline, branchHash: string, targetFile: string, names: GalgameNames, copied: CopiedAsset[], prefix: string, seed: string, graph: BranchGraph): string {
  return [
    '这是 Studio 完整作品生产，不是单节点扩写。把已确认大纲写成能从入口玩到结局的 Ren\'Py 剧情；不得用大纲说明、事件列表冒充对白。',
    `目标文件：${targetFile}；仅用一次 insert_after，在以下原样整行后插入完整剧情：`, INSERTION_POINT,
    `入口 ${prefix}_start 已有场景/立绘；先 jump ${prefix}_scene_1，再写所有场景 label。`,
    `每个大纲节必须对应 label：${outline.sections.map((_s, i) => `${prefix}_scene_${i + 1}`).join('、')}`,
    `允许新增 label，但名字必须以 ${prefix}_ 开头。引用的 jump 目标必须在本次稿中定义。每个场景与选项路径用 jump 或 return 明确收尾。`,
    '遵循大纲真实意图：单线直接 jump；只有确有选择时才写 menu，至少两个具体选项，必须有不同的可见后果。不要插入只有“继续”的菜单，也不要为了凑路线强加分支。',
    '只用对白/旁白、label、jump、return、menu、scene/show/hide（at left/center/right，with dissolve/fade）、with dissolve/fade、play/stop music/sound。不要 define/default、Python、$、call、if、自定义 transform 或未声明变量。旁白直接用双引号字符串。',
    '人物素材声明不可改。对白使用下列变量；引号与反斜杠正确转义。每节必须有实际剧情，全文要体现角色设定、冲突和结局，不要复述大纲。',
    `分支图确认指纹：${branchHash}\n确认时的现有图（只作创作上下文，不得修改）：${JSON.stringify(graph)}`,
    `确认大纲（含全部节、场景、节拍与篇幅）：${JSON.stringify(outline)}`,
    '角色：' + manifest.characters.map(c => `\n- ${c.name}（${c.id}）：${c.setting}；性格：${c.personality ?? ''}；备注：${c.notes ?? ''}；对白变量：${names.characters.get(c.id)!}`).join(''),
    '立绘：' + manifest.sprites.map(s => `\n- ${s.characterId} / ${s.expression}（素材 ${s.id}）：image ${names.sprites.get(s.id)!}；调用：show ${names.sprites.get(s.id)!}`).join(''),
    '背景：' + manifest.backgrounds.map(b => `\n- ${b.name}（素材 ${b.id}）：image ${names.backgrounds.get(b.id)!}；调用：scene ${names.backgrounds.get(b.id)!}`).join(''),
    '音频：' + manifest.audio.map(a => `\n- ${a.name}（${a.kind}）：audio/deepwriter_assets_${prefix}/${path.basename(copied.find(c => c.id === a.id)!.target)}`).join(''),
    `目标文件当前完整内容：\n${seed}`
  ].join('\n')
}

/** Exclusive publication, never rename over an author's existing file. */
async function publishNewFile(target: string, raw: string): Promise<void> {
  const temporary = `${target}.dw-tmp-${randomId('publish')}`
  try {
    await fs.writeFile(temporary, raw, { encoding: 'utf8', flag: 'wx' })
    await fs.link(temporary, target)
  } finally { await fs.rm(temporary, { force: true }).catch(() => undefined) }
}

function reachableFromStart(graph: BranchGraph, label: string): boolean {
  const visited = new Set<string>(), queue = ['start']
  for (let cursor = 0; cursor < queue.length; cursor++) {
    const next = queue[cursor]
    if (next === label) return true
    if (visited.has(next)) continue
    visited.add(next)
    queue.push(...graph.edges.filter(edge => edge.from === next).map(edge => edge.to))
  }
  return false
}

export class GalgameStudioService {
  private readonly deps: GalgameStudioDeps
  private readonly states = new Map<string, GalgameStudioState>()
  private readonly generatingProjects = new Set<string>()

  constructor(deps: GalgameStudioDeps) {
    this.deps = deps
  }

  private stateFile(studioId: string): string {
    if (!/^[a-zA-Z0-9_-]{1,128}$/.test(studioId)) throw new Error('工作台 id 非法')
    return path.join(path.resolve(this.deps.baseDir), 'galgame-studio', `${studioId}.json`)
  }

  async save(state: GalgameStudioState): Promise<void> {
    this.states.set(state.studioId, state)
    await writeAtomic(this.stateFile(state.studioId), JSON.stringify(state, null, 2))
  }

  async get(studioId: string): Promise<GalgameStudioState | null> {
    const memory = this.states.get(studioId)
    if (memory) return structuredClone(memory)
    try {
      const parsed = JSON.parse(await fs.readFile(this.stateFile(studioId), 'utf8')) as GalgameStudioState
      if (parsed.schemaVersion !== 1 || parsed.studioId !== studioId) return null
      this.states.set(studioId, parsed)
      return structuredClone(parsed)
    } catch {
      return null
    }
  }

  /** Restore the most recently touched Studio for a renderer session. */
  async latestForSession(sessionId: string): Promise<GalgameStudioSnapshot | null> {
    const candidates = new Map<string, GalgameStudioState>()
    for (const state of this.states.values()) {
      if (state.sessionId === sessionId) candidates.set(state.studioId, state)
    }
    const directory = path.join(path.resolve(this.deps.baseDir), 'galgame-studio')
    const names = await fs.readdir(directory).catch(() => [] as string[])
    for (const name of names.slice(0, 1000)) {
      const match = name.match(/^([a-zA-Z0-9_-]{1,128})\.json$/)
      if (!match || candidates.has(match[1])) continue
      const state = await this.get(match[1])
      if (state?.sessionId === sessionId) candidates.set(state.studioId, state)
    }
    const latest = [...candidates.values()].sort((a, b) => b.updatedAt - a.updatedAt)[0]
    return latest ? this.snapshot(latest.studioId) : null
  }

  async create(input: { sessionId: string; project: CreatedProject | ImportedProject }): Promise<GalgameStudioState> {
    const state = createGalgameStudioState({
      studioId: randomId('studio'),
      sessionId: input.sessionId,
      projectId: input.project.projectId,
      projectDir: input.project.projectDir,
      projectMode: input.project.mode,
      projectName: input.project.projectName
    })
    await this.save(state)
    return state
  }

  async inspectSdk(studioId: string, explicitPath?: string | null, discoveryRoots: string[] = []): Promise<RenpySdkInspection> {
    const state = await this.require(studioId)
    const inspection = this.deps.inspectSdk ? await this.deps.inspectSdk({ explicitPath, discoveryRoots }) : await inspectRenpySdk({ userDataDir: this.deps.baseDir, explicitPath, discoveryRoots })
    if (inspection.candidate) {
      await this.save(advanceGalgameStudio(state, { sdkReady: true, sdk: inspection.candidate.evidence, lint: sameSdk(state.sdk, inspection.candidate.evidence) ? state.lint : null, error: null }))
    } else {
      await this.save(advanceGalgameStudio(state, { sdkReady: false, sdk: null, lint: null, error: inspection.message }))
    }
    return inspection
  }

  async downloadSdk(studioId: string, options: { signal?: AbortSignal; onProgress?: SdkDownloadOptions['onProgress']; fetchImpl?: SdkFetch; runCommand?: SdkCommandRunner } = {}): Promise<GalgameSdkEvidence> {
    const state = await this.require(studioId)
    const candidate = this.deps.downloadSdk
      ? await this.deps.downloadSdk(options)
      : await downloadAndInstallManagedSdk({ userDataDir: this.deps.baseDir, ...options })
    await this.save(advanceGalgameStudio(state, { sdkReady: true, sdk: candidate.evidence, lint: sameSdk(state.sdk, candidate.evidence) ? state.lint : null, error: null }))
    return candidate.evidence
  }

  async setAssets(studioId: string, input: StudioAssetInput): Promise<GalgameAssetCheck> {
    const state = await this.require(studioId)
    if (!state.sdkReady) throw new Error('请先检查或安装 Ren\'Py SDK')
    if (!this.deps.resolveAssetRef) {
      return { ok: false, issues: [{ code: 'ref_not_authorized', message: '素材文件授权服务未就绪' }], counts: { characters: 0, sprites: 0, backgrounds: 0, audio: 0 } }
    }
    const check = await validateGalgameAssetManifest(input.manifest, { sessionId: state.sessionId, resolveFile: this.deps.resolveAssetRef })
    if (!check.ok) {
      await this.save(advanceGalgameStudio(state, { assetsReady: false, assets: null, outlineBranchConfirmed: false, lint: null, error: check.issues.map((issue) => issue.message).join('；') }))
      return check
    }
    const changed = JSON.stringify(state.assets) !== JSON.stringify(input.manifest)
    await this.save(advanceGalgameStudio(state, { assetsReady: true, assets: structuredClone(input.manifest), ...(changed ? { outlineBranchConfirmed: false, production: null, lint: null } : {}), error: null }))
    return check
  }

  async confirmOutlineBranch(studioId: string, confirmation: StudioPlanConfirmation): Promise<GalgameStudioState> {
    const state = await this.require(studioId)
    if (!state.sdkReady || !state.assetsReady) throw new Error('SDK 或素材清单尚未就绪')
    const grill = await this.deps.getGrillState?.(state.sessionId)
    if (!grill || grill.sessionId !== state.sessionId || grill.status !== 'confirmed' || !grill.approvedOutline || !grill.outlineHash) throw new Error('Grill Me 大纲尚未确认，禁止进入制作')
    const durableOutlineHash = grillMeOutlineHash(grill.approvedOutline)
    if (durableOutlineHash !== grill.outlineHash) throw new Error('Grill Me durable 大纲 hash 不一致')
    if (confirmation.outlineHash && confirmation.outlineHash !== durableOutlineHash) throw new Error('大纲 hash 已变化，请重新读取并确认')
    const graph = this.deps.getBranchGraph ? await this.deps.getBranchGraph(state.projectDir) : await buildBranchGraph(state.projectDir)
    const currentBranchHash = hashGalgameBranchGraph(graph)
    if (confirmation.branchHash !== currentBranchHash) throw new Error('分支图已变化，请重新扫描并确认')
    const next = advanceGalgameStudio(state, { grillStateId: grill.stateId, grillConfirmed: true, outlineHash: durableOutlineHash, branchHash: currentBranchHash, outlineBranchConfirmed: true, ...(state.outlineHash !== durableOutlineHash ? { production: null, lint: null } : {}), error: null })
    await this.save(next)
    return next
  }

  async generate(studioId: string): Promise<StudioGenerationResult> {
    const state = await this.require(studioId)
    const key = path.resolve(state.projectDir).toLowerCase()
    if (this.generatingProjects.has(key)) throw new Error('本项目正在制作中，请等待当前制作结束')
    this.generatingProjects.add(key)
    try { return await this.generateCandidate(state) } finally { this.generatingProjects.delete(key) }
  }

  private async generateCandidate(state: GalgameStudioState): Promise<StudioGenerationResult> {
    assertStudioGenerationAllowed(state)
    if (!state.assets || !state.outlineHash || !state.branchHash) throw new Error('制作资料不完整')
    if (!this.deps.resolveAssetRef) throw new Error('素材文件授权服务未就绪，禁止写盘')
    const grill = await this.deps.getGrillState?.(state.sessionId)
    if (!grill || grill.sessionId !== state.sessionId || grill.status !== 'confirmed' || !grill.approvedOutline || grill.outlineHash !== state.outlineHash || grillMeOutlineHash(grill.approvedOutline) !== state.outlineHash) throw new Error('Grill Me 大纲未保持确认状态，禁止生成')
    if (!grill.approvedOutline.sections.length) throw new Error('确认大纲没有剧情节，请先补全大纲')
    // A completed retry is a read, not permission to overwrite authored work.
    if (state.generatedFile && state.production?.status === 'agent_applied' && state.production.outlineHash === state.outlineHash && state.production.assetsKey === JSON.stringify(state.assets)) {
      if (!(await fs.stat(state.generatedFile).catch(() => null))?.isFile()) throw new Error('已生成剧本被移动或删除，请重新确认制作计划')
      return { ok: true, generatedFile: state.generatedFile, copiedAssets: [], production: state.production }
    }
    const graph = await (this.deps.getBranchGraph ? this.deps.getBranchGraph(state.projectDir) : buildBranchGraph(state.projectDir))
    if (hashGalgameBranchGraph(graph) !== state.branchHash) {
      await this.save(advanceGalgameStudio(state, { outlineBranchConfirmed: false, lint: null, error: '分支图已变化，请重新扫描并确认' }))
      throw new Error('分支图已变化，请重新扫描并确认')
    }
    const manifest = state.assets
    const check = await validateGalgameAssetManifest(manifest, { sessionId: state.sessionId, resolveFile: this.deps.resolveAssetRef })
    if (!check.ok) throw new Error(check.issues.map(issue => issue.message).join('；'))
    const prefix = `dw_${randomBytes(8).toString('hex')}`
    const names = buildGalgameNames(manifest, prefix)
    const candidateDir = path.join(path.resolve(this.deps.baseDir), 'galgame-studio-candidates', state.studioId, prefix)
    const candidateGame = path.join(candidateDir, 'game')
    const assetDirectory = `deepwriter_assets_${prefix}`
    await fs.mkdir(path.join(candidateGame, 'images', assetDirectory), { recursive: true })
    await fs.mkdir(path.join(candidateGame, 'audio', assetDirectory), { recursive: true })
    const copied: CopiedAsset[] = []
    for (const entry of assetEntries(manifest)) {
      const file = await this.deps.resolveAssetRef(entry.fileRefId, state.sessionId)
      if (!file) throw new Error(`素材 ${entry.id} 的文件引用无效或已过期`)
      const stat = await fs.stat(file.realpath)
      if (file.size !== undefined && file.size !== stat.size) throw new Error(`素材 ${entry.id} 已变化，请重新选择`)
      const ext = path.extname(file.displayName || file.realpath).toLowerCase()
      if (!(entry.kind === 'audio' ? AUDIO_EXTENSIONS : IMAGE_EXTENSIONS).has(ext)) throw new Error(`素材 ${entry.id} 类型不受支持`)
      const target = path.join(candidateGame, entry.kind === 'audio' ? 'audio' : 'images', assetDirectory, `${entry.kind}_${names.assetStems.get(entry.id)!}${ext}`)
      await copyAtomic(file.realpath, target)
      copied.push({ id: entry.id, target, kind: entry.kind })
    }
    const targetFile = `game/deepwriter_${prefix}.rpy`
    const candidateFile = path.join(candidateDir, targetFile)
    const seed = buildGeneratedScript(manifest, copied, names, prefix)
    await writeAtomic(candidateFile, seed.raw)
    const requestedAt = Date.now()
    let production: GalgameProductionHandoff = { status: 'skeleton_handoff', message: '候选骨架已保留；请选择写作模型后重试。项目中的剧本与素材未改动。', requestedAt, completedAt: null }
    try {
      if (this.deps.runProductionAgent) {
        const result = await this.deps.runProductionAgent({ sessionId: state.sessionId, projectDir: candidateDir, targetFile, sceneSpec: buildAgentSceneSpec(manifest, grill.approvedOutline, state.branchHash, targetFile, names, copied, prefix, seed.raw, graph) })
        production = { ...result, requestedAt, completedAt: null }
      }
      if (production.status === 'agent_applied') {
        const raw = await fs.readFile(candidateFile, 'utf8')
        const invalid = validateStudioStory(raw, { header: seed.header, entryLabel: `${prefix}_start`, sceneLabels: grill.approvedOutline.sections.map((_s, i) => `${prefix}_scene_${i + 1}`), characters: [...names.characters.values()], images: [...names.sprites.values(), ...names.backgrounds.values()], audio: manifest.audio.map(a => `audio/${assetDirectory}/${path.basename(copied.find(c => c.id === a.id)!.target)}`) })
        if (invalid) throw new Error(invalid)
        // Recheck frozen inputs after a potentially long model call.
        const latest = await this.require(state.studioId)
        const currentGrill = await this.deps.getGrillState?.(state.sessionId)
        const currentGraph = await (this.deps.getBranchGraph ? this.deps.getBranchGraph(state.projectDir) : buildBranchGraph(state.projectDir))
        if (JSON.stringify(latest.assets) !== JSON.stringify(manifest) || !latest.outlineBranchConfirmed || currentGrill?.status !== 'confirmed' || !currentGrill.approvedOutline || grillMeOutlineHash(currentGrill.approvedOutline) !== state.outlineHash || hashGalgameBranchGraph(currentGraph) !== state.branchHash) throw new Error('制作期间大纲、素材或项目分支发生变化，候选稿已保留，请重新确认后制作')
        const game = path.join(state.projectDir, 'game')
        const generatedFile = path.join(state.projectDir, targetFile)
        if (!(await realContained(generatedFile, game))) throw new Error('生成文件目标路径越界')
        for (const kind of ['images', 'audio']) {
          const assetTarget = path.join(game, kind, assetDirectory)
          await fs.mkdir(path.dirname(assetTarget), { recursive: true })
          if (!(await realContained(assetTarget, game))) throw new Error('素材目标路径越界')
          await fs.mkdir(assetTarget) // exclusive revision namespace; never overwrite imports/assets
        }
        for (const asset of copied) await fs.copyFile(asset.target, path.join(game, path.relative(candidateGame, asset.target)), fsConstants.COPYFILE_EXCL)
        await publishNewFile(generatedFile, raw)
        const entryLabel = `${prefix}_start`
        const entryFile = path.join(game, 'script', 'script.rpy')
        const previousEntry = await fs.readFile(entryFile, 'utf8').catch(() => null)
        let entrypointContent = state.entrypointContent
        // Only the exact bootstrap or our own unchanged prior launcher is ours.
        if ((state.projectMode === 'create' && previousEntry === PROJECT_BOOTSTRAP) || (state.entrypointContent && previousEntry === state.entrypointContent)) {
          const anchor = previousEntry === PROJECT_BOOTSTRAP ? '    "请在 Galgame Studio 中确认素材与大纲后生成剧本。"' : previousEntry!.split(/\r?\n/).find(line => /^    jump /.test(line))!
          const applied = await applyRenpyPatch({ projectDir: state.projectDir, sessionId: state.sessionId, baseSha256: createHash('sha256').update(previousEntry!).digest('hex'), patch: { file: 'game/script/script.rpy', operations: [{ op: 'replace_line', anchor, lines: [`    jump ${entryLabel}`] }] } })
          if (!applied.ok) throw new Error(applied.error ?? '启动入口未能安全更新；已写出的剧情文件仍然保留')
          entrypointContent = previousEntry!.replace(anchor, `    jump ${entryLabel}`)
        }
        const afterGraph = await buildBranchGraph(state.projectDir)
        const integration = reachableFromStart(afterGraph, entryLabel) ? 'connected' : 'required'
        production = { status: 'agent_applied', message: integration === 'connected' ? '剧情已实际写入并接到 start；请运行 Ren\'Py lint 检查。' : `剧情已写入 ${targetFile}；尚未接入主线。请在希望的位置添加 call ${entryLabel}（返回主线）或 jump ${entryLabel}（转入此剧情），再运行 lint。`, requestedAt, completedAt: Date.now(), entryLabel, entryFile: targetFile, integration, outlineHash: state.outlineHash, assetsKey: JSON.stringify(manifest) }
        await this.save(advanceGalgameStudio(latest, { generatedFile, generatedAt: Date.now(), entrypointContent, production, lint: null, error: null }))
        return { ok: true, generatedFile, copiedAssets: copied.map(a => ({ ...a, target: path.join(game, path.relative(candidateGame, a.target)) })), production }
      }
    } catch (error) {
      production = { status: 'agent_failed', message: `候选稿未完成发布：${error instanceof Error ? error.message : '未知错误'}。候选文件：${candidateFile}`, requestedAt, completedAt: null }
    }
    const latest = await this.require(state.studioId)
    await this.save(advanceGalgameStudio(latest, { production, lint: null, error: production.message }))
    return { ok: false, generatedFile: candidateFile, copiedAssets: copied, production, error: production.message }
  }

  async lintStudio(studioId: string): Promise<StudioLintResult> {
    const state = await this.require(studioId)
    const gate = studioGate(state, 'lint/repair')
    if (!gate.ok) throw new Error(gate.error ?? '尚未生成剧本')
    const inspection = await (this.deps.inspectSdk ? this.deps.inspectSdk({ explicitPath: state.sdk?.root ?? null }) : inspectRenpySdk({ userDataDir: this.deps.baseDir, explicitPath: state.sdk?.root ?? null }))
    if (!inspection.candidate) {
      await this.save(advanceGalgameStudio(state, { sdkReady: false, sdk: null, lint: null, error: inspection.message }))
      throw new Error(`SDK 不可用：${inspection.message}`)
    }
    if (!sameSdk(state.sdk, inspection.candidate.evidence)) {
      await this.save(advanceGalgameStudio(state, { sdkReady: true, sdk: inspection.candidate.evidence, lint: null, error: null }))
    }
    const execution = this.deps.lint ? await this.deps.lint(inspection.candidate.layout, state.projectDir) : await runRenpyLint(inspection.candidate.layout, state.projectDir)
    const diagnostics = parseLintOutput(execution.output)
    const errorCount = diagnostics.filter((diagnostic) => diagnostic.severity === 'error').length
    const warningCount = diagnostics.filter((diagnostic) => diagnostic.severity === 'warning').length
    const result: StudioLintResult = { ok: execution.ok && errorCount === 0, verified: execution.verified === true, output: execution.output, command: execution.command, exitCode: execution.exitCode, errorCount, warningCount, diagnostics, cancelled: execution.cancelled }
    const latest = await this.require(studioId)
    if (!latest.sdkReady || !sameSdk(latest.sdk, inspection.candidate.evidence)) throw new Error('检查期间 SDK 已变化，本次旧 SDK 的 lint 结果未写入；请重新检查')
    if (latest.generatedFile !== state.generatedFile || latest.generatedAt !== state.generatedAt || latest.production?.entryLabel !== state.production?.entryLabel) throw new Error('检查期间剧本已变化，本次旧剧本 lint 结果未写入；请重新检查')
    const graph = latest.production?.entryLabel ? await buildBranchGraph(latest.projectDir) : null
    const production = latest.production?.entryLabel && graph ? { ...latest.production, integration: reachableFromStart(graph, latest.production.entryLabel) ? 'connected' as const : 'required' as const } : latest.production
    const next = advanceGalgameStudio(latest, { production, sdkReady: true, sdk: inspection.candidate.evidence, lint: { ok: result.ok, verified: result.verified, output: result.output, errorCount, warningCount, command: result.command, checkedAt: Date.now() }, error: result.ok ? null : `lint 未通过：${errorCount} 个错误` })
    await this.save(next)
    return result
  }

  async snapshot(studioId: string): Promise<GalgameStudioSnapshot> {
    const state = await this.require(studioId)
    const sdk = state.sdkReady && state.sdk ? { status: 'ready' as const, source: state.sdk.source, version: state.sdk.version } : { status: 'missing' as const, message: state.error ?? undefined }
    const graph = state.assetsReady && state.stage !== 'done' ? await (this.deps.getBranchGraph ? this.deps.getBranchGraph(state.projectDir) : buildBranchGraph(state.projectDir)).catch(() => null) : null
    return { state, sdk, branchGraph: graph, assetCheck: state.assets ? validateAssetManifest(state.assets) : null, branchHash: graph ? hashGalgameBranchGraph(graph) : null }
  }

  private async require(studioId: string): Promise<GalgameStudioState> {
    const state = await this.get(studioId)
    if (!state) throw new Error('Galgame Studio 工作台不存在或已过期')
    return state
  }
}

export { nextGalgameStudioStage }
