import { promises as fs } from 'node:fs'
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
import { buildBranchGraph, parseLintOutput, type BranchGraph, type LintDiagnostic } from './galgame'
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
   * The one production boundary.  The service owns the stage gate and
   * scaffold; the host wires this callback to the existing Galgame Agent
   * patch generator + safe patch applier.  No renderer/model credentials cross
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
    edges: [...graph.edges].map((edge) => ({ from: edge.from, to: edge.to, type: edge.type, file: edge.file, line: edge.line })).sort((a, b) => `${a.file}:${a.line}:${a.from}:${a.to}:${a.type}`.localeCompare(`${b.file}:${b.line}:${b.from}:${b.to}:${b.type}`)),
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
  await writeAtomic(path.join(projectDir, 'game', 'script', 'script.rpy'), '# DeepWriter Galgame 项目\nlabel start:\n    "请在 Galgame Studio 中确认素材与大纲后生成剧本。"\n    return\n')
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
export function buildGalgameNames(manifest: GalgameAssetManifest): {
  characters: Map<string, string>; sprites: Map<string, string>; backgrounds: Map<string, string>; assetStems: Map<string, string>
} {
  const characters = uniqueNames(manifest.characters.map(item => ({ key: item.id, base: `dw_${safeIdentifier(item.id, 'character')}` })), ['dw_narrator'])
  const images = uniqueNames([
    ...manifest.sprites.map(item => ({ key: `sprite:${item.id}`, base: `${characters.get(item.characterId)}_${safeIdentifier(item.expression, 'default')}` })),
    ...manifest.backgrounds.map(item => ({ key: `background:${item.id}`, base: `dw_bg_${safeIdentifier(item.id, 'background')}` }))
  ])
  const assetStems = new Map<string, string>()
  for (const items of [manifest.sprites, manifest.backgrounds, manifest.audio]) {
    for (const [id, stem] of uniqueNames(items.map(item => ({ key: item.id, base: safeIdentifier(item.id, 'asset') })), [], true)) assetStems.set(id, stem)
  }
  return { characters, sprites: new Map(manifest.sprites.map(item => [item.id, images.get(`sprite:${item.id}`)!])), backgrounds: new Map(manifest.backgrounds.map(item => [item.id, images.get(`background:${item.id}`)!])), assetStems }
}

type GalgameNames = ReturnType<typeof buildGalgameNames>

function buildGeneratedScript(manifest: GalgameAssetManifest, outline: GrillMeOutline, copied: Array<{ id: string; target: string; kind: GalgameAssetKind }>, names: GalgameNames): string {
  const characters = manifest.characters
  const sprites = manifest.sprites
  const backgrounds = manifest.backgrounds
  const lines: string[] = [
    '# This file is generated by DeepWriter Galgame Studio.',
    '# Asset paths are project-relative and were copied after FileRef validation.',
    ''
  ]
  characters.forEach((character) => {
    const id = names.characters.get(character.id)!
    lines.push(`define ${id} = Character("${renpyString(character.name)}")`)
  })
  lines.push('define dw_narrator = Character(None)')
  lines.push('')
  for (const sprite of sprites) {
    const copiedAsset = copied.find((item) => item.id === sprite.id)
    if (!copiedAsset) continue
    const characterId = names.characters.get(sprite.characterId)
    if (!characterId) continue
    const imageId = names.sprites.get(sprite.id)!
    const relativePath = `images/characters/${path.basename(copiedAsset.target)}`
    lines.push(`image ${imageId} = "${renpyString(relativePath)}"`)
  }
  for (const background of backgrounds) {
    const copiedAsset = copied.find((item) => item.id === background.id)
    if (!copiedAsset) continue
    const imageId = names.backgrounds.get(background.id)!
    const relativePath = `images/backgrounds/${path.basename(copiedAsset.target)}`
    lines.push(`image ${imageId} = "${renpyString(relativePath)}"`)
  }
  lines.push('', 'label dw_start:')
  // This stable, unique anchor is the handoff point for the existing
  // Galgame Agent patch generator.  The scaffold is deliberately useful on
  // its own, but is not described as AI-produced until that patch is applied.
  lines.push('    # DeepWriter Agent insertion point')
  if (backgrounds[0]) lines.push(`    scene ${names.backgrounds.get(backgrounds[0].id)!} with dissolve`)
  if (sprites[0]) lines.push(`    show ${names.sprites.get(sprites[0].id)!} at center with dissolve`)
  lines.push(`    dw_narrator "${renpyString(outline.premise || outline.title || '故事开始了。')}"`)
  const sections = outline.sections.length > 0 ? outline.sections : [{ id: 'section_1', title: outline.title || '序章', purpose: outline.premise || '', targetChars: 0, beats: [], sourceSlotIds: [] }]
  sections.forEach((section, index) => {
    const label = `dw_scene_${index + 1}`
    lines.push('', `label ${label}:`)
    lines.push(`    # ${renpyString(section.title || `第 ${index + 1} 节`)}`)
    if (section.purpose.trim()) lines.push(`    dw_narrator "${renpyString(section.purpose)}"`)
    const beats = section.beats.filter((beat) => beat.trim()).slice(0, 20)
    beats.forEach((beat) => lines.push(`    dw_narrator "${renpyString(beat)}"`))
    if (index < sections.length - 1) {
      lines.push('    menu:', `        "继续":`, `            jump dw_scene_${index + 2}`)
    } else {
      lines.push('    return')
    }
  })
  return `${lines.join('\n')}\n`
}

function buildAgentSceneSpec(
  manifest: GalgameAssetManifest,
  outline: GrillMeOutline,
  branchHash: string,
  targetFile: string,
  names: GalgameNames,
  copied: Array<{ id: string; target: string; kind: GalgameAssetKind }>
): string {
  const characterContext = manifest.characters
    .map((character) => `- ${character.name}（${character.id}）：${character.setting}；对白变量：${names.characters.get(character.id)!}`)
    .join('\n')
  const spriteContext = manifest.sprites
    .map((sprite) => `- ${sprite.characterId} / ${sprite.expression}（素材 ${sprite.id}）：${sprite.displayName ?? sprite.fileRefId}；image ${names.sprites.get(sprite.id)!}；调用：show ${names.sprites.get(sprite.id)!}`)
    .join('\n')
  const backgroundContext = manifest.backgrounds
    .map((background) => `- ${background.name}（素材 ${background.id}）：${background.displayName ?? background.fileRefId}；image ${names.backgrounds.get(background.id)!}；调用：scene ${names.backgrounds.get(background.id)!}`)
    .join('\n')
  const audioContext = manifest.audio.map(audio => `- ${audio.name}（素材 ${audio.id}）：audio/${path.basename(copied.find(item => item.id === audio.id)!.target)}`).join('\n')
  const outlineContext = outline.sections
    .map((section, index) => `${index + 1}. ${section.title}：${section.purpose}\n   ${section.beats.slice(0, 20).join('；')}`)
    .join('\n')
  return [
    '这是已通过 Grill Me 多轮澄清并由用户确认的大纲与分支图，请为 Galgame 生产一个可运行的 Ren\'Py 剧情节点。',
    `目标文件必须是 ${targetFile}，只在其中的 `,
    '    # DeepWriter Agent insertion point',
    '这一行之后插入剧情节点；不要修改或新增 define/default 声明。',
    `分支图确认指纹：${branchHash}`,
    `标题：${outline.title}`,
    `前提：${outline.premise}`,
    `角色设定：\n${characterContext}`,
    `立绘与表情：\n${spriteContext}`,
    `背景：\n${backgroundContext}`,
    `音频实际路径：\n${audioContext || '无'}`,
    `已生成 label：dw_start、${outline.sections.map((_section, index) => `dw_scene_${index + 1}`).join('、') || 'dw_scene_1'}`,
    `大纲：\n${outlineContext}`,
    '请让插入内容体现已确认的角色、情绪、场景和分支意图；仅输出既有角色和已存在图片/标签可用的对白、旁白、scene/show/menu/jump 等 Ren\'Py 节点。'
  ].join('\n')
}

export class GalgameStudioService {
  private readonly deps: GalgameStudioDeps
  private readonly states = new Map<string, GalgameStudioState>()

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
      await this.save(advanceGalgameStudio(state, { assetsReady: false, assets: null, error: check.issues.map((issue) => issue.message).join('；') }))
      return check
    }
    await this.save(advanceGalgameStudio(state, { assetsReady: true, assets: structuredClone(input.manifest), error: null }))
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
    const next = advanceGalgameStudio(state, { grillStateId: grill.stateId, grillConfirmed: true, outlineHash: durableOutlineHash, branchHash: currentBranchHash, outlineBranchConfirmed: true, error: null })
    await this.save(next)
    return next
  }

  async generate(studioId: string): Promise<StudioGenerationResult> {
    const state = await this.require(studioId)
    assertStudioGenerationAllowed(state)
    if (!state.assets || !state.outlineHash || !state.branchHash) throw new Error('制作资料不完整')
    if (!this.deps.resolveAssetRef) throw new Error('素材文件授权服务未就绪，禁止写盘')
    const grill = await this.deps.getGrillState?.(state.sessionId)
    if (!grill || grill.status !== 'confirmed' || !grill.approvedOutline || grill.outlineHash !== state.outlineHash) throw new Error('Grill Me 大纲未保持确认状态，禁止生成')
    const manifest = state.assets
    const names = buildGalgameNames(manifest)
    const copied: Array<{ id: string; target: string; kind: GalgameAssetKind }> = []
    const copyOne = async (id: string, fileRefId: string, kind: GalgameAssetKind, directory: string, fallbackExt: string, displayName?: string): Promise<void> => {
      const file = await this.deps.resolveAssetRef?.(fileRefId, state.sessionId)
      if (!file) throw new Error(`素材 ${id} 的文件引用无效或已过期，请重新选择`)
      const ext = path.extname(file.displayName || file.realpath).toLowerCase() || fallbackExt
      const allowed = kind === 'audio' ? AUDIO_EXTENSIONS : IMAGE_EXTENSIONS
      if (!allowed.has(ext)) throw new Error(`素材 ${id} 类型不受支持：${ext}`)
      const target = path.join(state.projectDir, 'game', directory, `${names.assetStems.get(id)!}${ext}`)
      if (!(await realContained(target, path.join(state.projectDir, 'game')))) throw new Error(`素材 ${id} 目标路径越界`)
      await copyAtomic(file.realpath, target)
      copied.push({ id, target, kind })
    }
    for (const sprite of manifest.sprites) await copyOne(sprite.id, sprite.fileRefId, 'sprite', 'images/characters', '.png', sprite.displayName)
    for (const background of manifest.backgrounds) await copyOne(background.id, background.fileRefId, 'background', 'images/backgrounds', '.png', background.displayName)
    for (const audio of manifest.audio) await copyOne(audio.id, audio.fileRefId, 'audio', 'audio', '.ogg', audio.displayName)
    const generatedFile = path.join(state.projectDir, 'game', 'deepwriter_generated.rpy')
    if (!(await realContained(generatedFile, path.join(state.projectDir, 'game')))) throw new Error('生成文件路径越界')
    await writeAtomic(generatedFile, buildGeneratedScript(manifest, grill.approvedOutline, copied, names))
    const requestedAt = Date.now()
    const targetFile = path.relative(state.projectDir, generatedFile).replace(/\\/g, '/')
    let production: GalgameProductionHandoff
    if (!this.deps.runProductionAgent) {
      production = {
        status: 'skeleton_handoff',
        message: '可运行骨架已创建，等待移交 Galgame Agent 生成剧情节点。',
        requestedAt,
        completedAt: null
      }
    } else {
      try {
        const result = await this.deps.runProductionAgent({
          sessionId: state.sessionId,
          projectDir: state.projectDir,
          targetFile,
          sceneSpec: buildAgentSceneSpec(manifest, grill.approvedOutline, state.branchHash, targetFile, names, copied)
        })
        production = {
          status: result.status,
          message: result.message,
          requestedAt,
          completedAt: result.status === 'agent_failed' ? null : Date.now()
        }
      } catch (error) {
        production = {
          status: 'agent_failed',
          message: `Galgame Agent 交接失败：${error instanceof Error ? error.message : '未知错误'}`,
          requestedAt,
          completedAt: null
        }
      }
    }
    const next = advanceGalgameStudio(state, {
      generatedFile,
      generatedAt: Date.now(),
      production,
      lint: null,
      error: production.status === 'agent_failed' ? production.message : null
    })
    await this.save(next)
    return {
      ok: production.status === 'agent_applied',
      generatedFile,
      copiedAssets: copied,
      production,
      error: production.status === 'agent_applied' ? undefined : production.message
    }
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
    const next = advanceGalgameStudio(latest, { sdkReady: true, sdk: inspection.candidate.evidence, lint: { ok: result.ok, verified: result.verified, output: result.output, errorCount, warningCount, command: result.command, checkedAt: Date.now() }, error: result.ok ? null : `lint 未通过：${errorCount} 个错误` })
    await this.save(next)
    return result
  }

  async snapshot(studioId: string): Promise<GalgameStudioSnapshot> {
    const state = await this.require(studioId)
    const sdk = state.sdkReady && state.sdk ? { status: 'ready' as const, source: state.sdk.source, version: state.sdk.version } : { status: 'missing' as const, message: state.error ?? undefined }
    const graph = await (this.deps.getBranchGraph ? this.deps.getBranchGraph(state.projectDir) : buildBranchGraph(state.projectDir)).catch(() => null)
    return { state, sdk, assetCheck: state.assets ? validateAssetManifest(state.assets) : null, branchHash: graph ? hashGalgameBranchGraph(graph) : null }
  }

  private async require(studioId: string): Promise<GalgameStudioState> {
    const state = await this.get(studioId)
    if (!state) throw new Error('Galgame Studio 工作台不存在或已过期')
    return state
  }
}

export { nextGalgameStudioStage }
