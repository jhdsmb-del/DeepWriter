import { collectScriptFiles, buildBranchGraph, type BranchGraph, type BranchDiagnostic } from './renpyRoutes'
export { buildBranchGraph, type BranchGraph, type BranchDiagnostic, type BranchLabel, type BranchEdge } from './renpyRoutes'
import { promises as fs } from 'fs'
import * as path from 'path'
import { createHash } from 'crypto'
import { streamChat } from './deepseek'
import { getCheckpointStore, makeDiff } from './checkpoint'
import { resolveRenpySdkLayout, validateRenpySdkLayout, runRenpyLint } from './renpySdk'
import type { ChatParams, RenpyCharacter, RenpyLintResult, RenpyProjectInfo } from '../shared/types'
import type { EffectiveProfile } from '../shared/providerRegistry'
import { injectUserPresetSystemMessage } from '../shared/userPresetPrompt'
import { creativeApiFromEffectiveProfile, isCreativeAuthError } from './creativeModel'

const EMPTY: RenpyProjectInfo = {
  root: '',
  scriptDir: '',
  scriptFiles: [],
  characters: [],
  affinityVars: [],
  labels: [],
  gameName: null
}

async function readAllText(files: string[]): Promise<string> {
  let all = ''
  for (const f of files) {
    try {
      const st = await fs.stat(f)
      if (st.size > 5 * 1024 * 1024) continue
      all += (await fs.readFile(f, 'utf-8')) + '\n'
    } catch {
      void 0
    }
  }
  return all
}

export async function scanRenpyProject(projectDir: string): Promise<RenpyProjectInfo> {
  const result: RenpyProjectInfo = { ...EMPTY, root: projectDir }
  const filtered = await collectScriptFiles(projectDir)
  const resolvedScriptDir = filtered.length > 0 ? path.dirname(filtered[0]) : path.join(projectDir, 'game')
  const all = await readAllText(filtered)

  const nameMatch = /config\.name\s*=\s*["']([^"']+)/.exec(all)
  const gameName = nameMatch ? nameMatch[1] : null

  const characters: RenpyCharacter[] = []
  const charRe = /define\s+([a-zA-Z_]\w*)\s*=\s*Character\s*\(\s*["']([^"']*)/g
  let cm: RegExpExecArray | null
  while ((cm = charRe.exec(all))) {
    characters.push({ varName: cm[1], displayName: cm[2] || cm[0].slice(0, 40) })
  }

  const affinityVars: string[] = []
  const affRe = /\$\s*([a-zA-Z_]\w*)\s*[+\-]=/g
  let am: RegExpExecArray | null
  while ((am = affRe.exec(all))) {
    if (!affinityVars.includes(am[1])) affinityVars.push(am[1])
  }

  const labels: string[] = []
  const labelRe = /^\s*label\s+([a-zA-Z_]\w*)/gm
  let lm: RegExpExecArray | null
  while ((lm = labelRe.exec(all))) {
    if (labels.length >= 200) break
    if (!labels.includes(lm[1])) labels.push(lm[1])
  }

  return { root: projectDir, scriptDir: resolvedScriptDir, scriptFiles: filtered, characters, affinityVars, labels, gameName }
}

/** Every lint path uses the same SDK identity and bundled-Python boundary.
 * In particular, a game executable is never used as an SDK fallback. */
export async function lintRenpyProject(sdkPath: string, projectDir: string): Promise<RenpyLintResult> {
  try {
    const layout = await resolveRenpySdkLayout(sdkPath)
    await validateRenpySdkLayout(layout, { source: 'explicit' })
    const result = await runRenpyLint(layout, projectDir)
    return { ok: result.ok, output: result.output, exitCode: result.exitCode }
  } catch (error) {
    return { ok: false, output: `Ren'Py SDK 不可用：${error instanceof Error ? error.message : String(error)}`, exitCode: null }
  }
}



export interface RenpyResourceResult {
  missing: string[]
  referenced: string[]
  imageAssets: string[]
  audioAssets: string[]
}

async function listAssets(rootDir: string, out: string[]): Promise<void> {
  let entries
  try {
    entries = await fs.readdir(rootDir, { withFileTypes: true })
  } catch {
    return
  }
  for (const e of entries) {
    const full = path.join(rootDir, e.name)
    if (e.isDirectory()) await listAssets(full, out)
    else out.push(full)
  }
}

export async function checkRenpyResources(projectDir: string): Promise<RenpyResourceResult> {
  const files = await collectScriptFiles(projectDir)
  const all = await readAllText(files)
  const defined = new Set<string>()
  const defRe = /\b(?:transform|image)\s+([a-zA-Z_]\w*)/g
  let dm: RegExpExecArray | null
  while ((dm = defRe.exec(all))) defined.add(dm[1].toLowerCase())

  const referenced: string[] = []
  const pushRef = (name: string): void => {
    if (!name) return
    const lower = name.toLowerCase()
    if (defined.has(lower)) return
    if (!referenced.includes(lower)) referenced.push(lower)
  }
  const visRe = /\b(?:scene|show)\s+([a-zA-Z_]\w*)/g
  let vm: RegExpExecArray | null
  while ((vm = visRe.exec(all))) pushRef(vm[1])
  const playRe = /play\s+(?:music|sound)\s+["']?([A-Za-z0-9_.\/-]+)["']?/g
  let pm: RegExpExecArray | null
  while ((pm = playRe.exec(all))) pushRef(pm[1].replace(/\.(?:ogg|mp3|wav|webm|png|jpg|jpeg)$/i, '').replace(/\\/g, '/'))

  const stripExt = (p: string): string => p.replace(/\.(?:png|jpg|jpeg|webp|gif|ogg|mp3|wav|webm)$/i, '').replace(/\\/g, '/').toLowerCase()
  const imageFiles: string[] = []
  const audioFiles: string[] = []
  await listAssets(path.join(projectDir, 'game', 'images'), imageFiles)
  await listAssets(path.join(projectDir, 'game', 'audio'), audioFiles)
  const imageBases = imageFiles.map(stripExt)
  const audioBases = audioFiles.map(stripExt)
  const imageKeys = [...imageBases, ...imageBases.map((b) => b.split('/').pop() ?? '')]
  const audioKeys = [...audioBases, ...audioBases.map((b) => b.split('/').pop() ?? '')]
  const matchKey = (ref: string, keys: string[]): boolean => keys.some((a) => a.startsWith(ref) || ref.startsWith(a))

  const missing: string[] = []
  for (const ref of referenced) {
    const base = ref.split('/').pop() ?? ref
    const inImages = matchKey(ref, imageKeys) || matchKey(base, imageKeys)
    const inAudio = matchKey(ref, audioKeys) || matchKey(base, audioKeys)
    if (!inImages && !inAudio) missing.push(ref)
  }

  return {
    missing,
    referenced,
    imageAssets: imageBases.map((b) => b.split('/').pop() ?? b),
    audioAssets: audioBases.map((b) => b.split('/').pop() ?? b)
  }
}

export interface RenpyVariableResult {
  undeclared: string[]
  declared: string[]
  usages: string[]
}

const VARIABLE_BUILTINS = new Set(['config', 'renpy', 'persistent', 'store', 'True', 'False', 'None', '_preferences'])

export async function checkRenpyVariables(projectDir: string): Promise<RenpyVariableResult> {
  const files = await collectScriptFiles(projectDir)
  const all = await readAllText(files)
  const declared = new Set<string>()
  const declRe = /(?:default|define)\s+([a-zA-Z_]\w*)\s*=/g
  let dm: RegExpExecArray | null
  while ((dm = declRe.exec(all))) declared.add(dm[1])

  const usages: string[] = []
  const pushUsage = (name: string): void => {
    if (!name) return
    if (VARIABLE_BUILTINS.has(name)) return
    if (name.startsWith('_')) return
    if (!usages.includes(name)) usages.push(name)
  }
  const assignRe = /\$\s*([a-zA-Z_]\w*)\s*(?:[+\-*/]?=)/g
  let am: RegExpExecArray | null
  while ((am = assignRe.exec(all))) pushUsage(am[1])
  const cmpRe = /(?:if|elif|while)\s+([a-zA-Z_]\w*)\s*(?:>=|<=|==|!=|>|<)/g
  let cm: RegExpExecArray | null
  while ((cm = cmpRe.exec(all))) pushUsage(cm[1])
  const bareRe = /(?:if|elif)\s+(?:not\s+)?([a-zA-Z_]\w*)\s*[:,]/g
  let bm: RegExpExecArray | null
  while ((bm = bareRe.exec(all))) pushUsage(bm[1])

  const undeclared = [...new Set(usages.filter((u) => !declared.has(u)))].sort()
  return { undeclared, declared: [...declared].sort(), usages: [...new Set(usages)].sort() }
}

export type PatchOpType = 'insert_after' | 'replace_line'

export interface PatchOperation {
  op: PatchOpType
  anchor: string
  lines: string[]
}

export interface ScenePatch {
  file: string
  operations: PatchOperation[]
}

export interface GalgameApi {
  apiKey: string
  baseUrl: string
  model: string
  maxTokens: number
  thinking?: ChatParams['thinking']
  temperature?: number
  topP?: number
  provider?: ChatParams['provider']
  userPresetPrompt?: string
}

export function galgameApiFromEffectiveProfile(effective: EffectiveProfile & { secret: string }, userPresetPrompt = ''): GalgameApi {
  return creativeApiFromEffectiveProfile(effective, userPresetPrompt)
}

export interface GeneratePatchResult {
  ok: boolean
  patch: ScenePatch | null
  error?: string
}

export function validatePatch(value: unknown): { ok: true; patch: ScenePatch } | { ok: false; error: string } {
  if (!value || typeof value !== 'object') return { ok: false, error: '补丁不是 JSON 对象' }
  const v = value as Record<string, unknown>
  if (typeof v.file !== 'string' || v.file.trim() === '') return { ok: false, error: '补丁缺少 file 字段' }
  // Gate 1：file 必须是 game/ 前缀的相对路径；禁止 ..、绝对路径、盘符穿越
  const normFile = v.file.replace(/\\/g, '/')
  if (!normFile.startsWith('game/')) return { ok: false, error: '补丁 file 必须是 game/ 下的相对路径' }
  if (normFile.includes('../') || normFile.startsWith('/') || /^[a-zA-Z]:/.test(normFile)) {
    return { ok: false, error: '补丁 file 非法（禁止 .. 穿越 / 绝对路径 / 盘符）' }
  }
  if (!Array.isArray(v.operations) || v.operations.length === 0) return { ok: false, error: '补丁缺少 operations 字段' }
  if (v.operations.length > 20) return { ok: false, error: 'operations 超过 20 条，已拒绝' }
  let totalLines = 0
  const ops: PatchOperation[] = []
  for (const op of v.operations) {
    if (!op || typeof op !== 'object') return { ok: false, error: 'operation 不是对象' }
    const o = op as Record<string, unknown>
    if (o.op !== 'insert_after' && o.op !== 'replace_line') return { ok: false, error: `不支持的操作类型：${String(o.op)}` }
    if (typeof o.anchor !== 'string' || o.anchor.trim() === '') return { ok: false, error: 'operation 缺少 anchor 字段' }
    if (o.anchor.length > 500) return { ok: false, error: 'anchor 过长（超过 500 字符）' }
    if (!Array.isArray(o.lines) || o.lines.length === 0 || !o.lines.every((l) => typeof l === 'string')) {
      return { ok: false, error: 'operation.lines 必须是非空字符串数组' }
    }
    totalLines += o.lines.length
    if (totalLines > 200) return { ok: false, error: '补丁新增行总数超过 200，已拒绝' }
    if (o.lines.some((l) => (l as string).length > 5000)) return { ok: false, error: '补丁行超过 5000 字符' }
    ops.push({ op: o.op, anchor: o.anchor, lines: o.lines.map(String) })
  }
  return { ok: true, patch: { file: v.file, operations: ops } }
}

/** 在内存中应用补丁操作（anchor 唯一性校验）；不写盘。返回新行数组或错误。 */
function applyPatchToLines(oldRaw: string, patch: ScenePatch): { ok: true; lines: string[] } | { ok: false; error: string } {
  const eol = oldRaw.includes('\r\n') ? '\r\n' : '\n'
  const lines = oldRaw.split(/\r?\n/)
  for (const op of patch.operations) {
    const matches = lines.map((l, i) => ({ l, i })).filter(({ l }) => l.trim() === op.anchor.trim())
    if (matches.length === 0) return { ok: false, error: `anchor 行未找到：${op.anchor.slice(0, 60)}` }
    if (matches.length > 1) return { ok: false, error: `anchor 行不唯一（${matches.length} 处匹配），已拒绝：${op.anchor.slice(0, 60)}` }
    const idx = matches[0].i
    if (op.op === 'insert_after') lines.splice(idx + 1, 0, ...op.lines)
    else lines.splice(idx, 1, ...op.lines)
  }
  return { ok: true, lines }
}

const sha256 = (s: string): string => createHash('sha256').update(s).digest('hex')

/** realpath containment：目标文件必须在项目目录内（逐级解析防 junction/symlink 逃逸） */
async function isWithinProject(target: string, projectDir: string): Promise<boolean> {
  const realTarget = await fs.realpath(target).catch(() => path.resolve(target))
  const realRoot = await fs.realpath(projectDir).catch(() => path.resolve(projectDir))
  const a = realTarget.toLowerCase()
  const r = realRoot.toLowerCase()
  return a === r || a.startsWith(r + path.sep)
}

/**
 * 写前备份：优先使用全局 checkpoint store（可经 IPC 回滚）；
 * 未初始化时（独立模块环境）回退到项目内 .dw-backups 本地备份。备份失败必须抛错中止写盘。
 */
async function backupForWrite(target: string, projectDir: string, sessionId?: string): Promise<void> {
  const cp = getCheckpointStore()
  if (cp) {
    await cp.beforeWrite(target, sessionId ?? 'galgame-patch')
    return
  }
  const backupDir = path.join(projectDir, '.dw-backups')
  await fs.mkdir(backupDir, { recursive: true })
  const stamp = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`
  await fs.copyFile(target, path.join(backupDir, `${stamp}-${path.basename(target)}`))
}

function extractJsonObject(raw: string): string {
  let t = raw.trim()
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/)
  if (fence) t = fence[1].trim()
  const start = t.indexOf('{')
  const end = t.lastIndexOf('}')
  if (start === -1 || end === -1 || end <= start) throw new Error('响应中未找到 JSON 对象')
  return t.slice(start, end + 1)
}

const RENPY_PATCH_SYSTEM = `你是 Ren'Py 8.5.3 剧情补丁生成器（Galgame 剧本）。
Ren'Py 语法规范：
- 角色用 define 声明（define sara = Character("莎拉")），运行期变量用 default 声明
- label 组织场景（label start: / label scene_01:）
- scene bg_xxx with dissolve 切背景；show sara happy at center with dissolve 显示立绘
- sara "台词" 角色对白；"旁白" 无引号前缀的叙述
- play music "bgm_xxx.ogg" loop / play sound "sfx_xxx.ogg"
- menu: 选项分支，选项内 jump 到对应 label
- $ var += 1 好感度增减；jump/call label 跳转与调用
- 对白可用 #vibe=8 标注情绪强度（0-10）
你的任务：根据用户提供的场景描述，输出结构化补丁。
硬性约束：
1. 只输出 JSON，不要输出任何其他文字、说明或代码块围栏
2. JSON schema：{"file": "game/script/xxx.rpy", "operations": [{"op": "insert_after"|"replace_line", "anchor": "目标文件里已存在的整行内容", "lines": ["新增的剧本行"]}]}
3. 禁止整库重写：只能通过 insert_after 在 anchor 行之后插入、或 replace_line 替换 anchor 行本身
4. file 必须是项目 game/ 目录下的相对路径；anchor 必须能逐行匹配目标文件现有内容
5. lines 只能包含剧本文本节点（对白/旁白/场景/音乐/菜单/jump/好感度），不得包含 define/default 声明
6. 引用角色/好感度变量/label 时，必须使用下方【项目信息】中已有的名字`

interface BranchContext {
  characters: RenpyCharacter[]
  affinityVars: string[]
  labels: string[]
  gameName: string | null
  branchDiags: BranchDiagnostic[]
}

async function buildProjectContext(projectDir: string): Promise<BranchContext> {
  const info = await scanRenpyProject(projectDir)
  let graph: BranchGraph
  try {
    graph = await buildBranchGraph(projectDir)
  } catch {
    graph = { labels: [], edges: [], diagnostics: [] }
  }
  return {
    characters: info.characters,
    affinityVars: info.affinityVars,
    labels: info.labels.slice(0, 100),
    gameName: info.gameName,
    branchDiags: graph.diagnostics
  }
}

function formatBranchContext(ctx: BranchContext): string {
  const parts: string[] = []
  parts.push(`游戏名：${ctx.gameName ?? '未识别'}`)
  if (ctx.characters.length > 0) {
    parts.push(`角色：${ctx.characters.map((c) => `${c.varName}（${c.displayName || '未命名'}）`).join('、')}`)
  }
  if (ctx.affinityVars.length > 0) parts.push(`好感度变量：${ctx.affinityVars.join('、')}`)
  if (ctx.labels.length > 0) parts.push(`已有 label：${ctx.labels.join('、')}`)
  if (ctx.branchDiags.length > 0) {
    parts.push(`分支诊断（可参考避免新错误）：${ctx.branchDiags.slice(0, 10).map((d) => d.message).join('；')}`)
  }
  return parts.join('\n')
}

async function callPatchModel(api: GalgameApi, messages: Array<{ role: string; content: string }>): Promise<string> {
  let text = ''
  await streamChat(
    {
      apiKey: api.apiKey,
      baseUrl: api.baseUrl,
      model: api.model,
      messages: injectUserPresetSystemMessage(messages as never, api.userPresetPrompt),
      thinking: api.thinking ?? { enabled: false, effort: 'high' },
      maxTokens: Math.min(8192, Math.max(1024, api.maxTokens || 4096)),
      temperature: api.temperature ?? 0.6,
      topP: api.topP ?? 0.9,
      provider: api.provider
    },
    (ev) => {
      if (ev.type === 'text') text += ev.delta ?? ''
    }
  )
  return text
}

function parsePatchText(text: string): { ok: true; patch: ScenePatch } | { ok: false; error: string } {
  let parsed: unknown
  try {
    parsed = JSON.parse(extractJsonObject(text))
  } catch (e) {
    return { ok: false, error: `JSON 解析失败：${(e as Error).message}` }
  }
  return validatePatch(parsed)
}

export async function generateScenePatch(input: { projectDir: string; sceneSpec: string; api: GalgameApi; studioProduction?: boolean }): Promise<GeneratePatchResult> {
  const { projectDir, sceneSpec, api } = input
  if (input.studioProduction && sceneSpec.length > 120_000) return { ok: false, patch: null, error: '确认的大纲与素材上下文超过单次制作容量，请缩小已确认的制作范围；未截断大纲或写入作品' }
  const systemPrompt = input.studioProduction ? RENPY_PATCH_SYSTEM.replace('5. lines 只能包含剧本文本节点（对白/旁白/场景/音乐/菜单/jump/好感度），不得包含 define/default 声明', '5. Studio 完整生产只支持场景描述列出的剧情语句，允许自有 label；禁止 define/default、Python 或其他新声明').replace('6. 引用角色/好感度变量/label 时，必须使用下方【项目信息】中已有的名字', '6. Studio 完整生产允许在场景描述给定的独占命名空间内新增 label；角色和素材只能用已声明者。必须遵循完整制作约定和目标文件的原样 anchor。') : RENPY_PATCH_SYSTEM
  const ctx = await buildProjectContext(projectDir)
  const userMsg = [
    `## 项目信息\n${formatBranchContext(ctx)}`,
    `## 场景描述\n${input.studioProduction ? sceneSpec : sceneSpec.slice(0, 3000)}`,
    `## 输出\n请输出符合约束的 JSON patch。`
  ].join('\n\n')

  let text = ''
  try {
    text = await callPatchModel(api, [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userMsg }
    ])
  } catch (e) {
    return { ok: false, patch: null, error: `模型调用失败：${(e as Error).message}` }
  }

  let parsed = parsePatchText(text)
  if (!parsed.ok) {
    try {
      const retry = await callPatchModel(api, [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userMsg },
        { role: 'assistant', content: text },
        { role: 'user', content: `上次输出无效：${parsed.error}。请重新输出，只输出符合 schema 的严格 JSON，不要代码块围栏。` }
      ])
      parsed = parsePatchText(retry)
    } catch {
      parsed = { ok: false, error: '模型调用失败（重试）' }
    }
  }

  if (!parsed.ok) return { ok: false, patch: null, error: parsed.error }

  const root = path.resolve(projectDir)
  const target = path.resolve(root, parsed.patch.file)
  if (target.toLowerCase() !== root.toLowerCase() && !target.toLowerCase().startsWith(root.toLowerCase() + path.sep)) {
    return { ok: false, patch: null, error: `补丁目标文件超出项目目录：${parsed.patch.file}` }
  }
  return { ok: true, patch: parsed.patch }
}

export interface ApplyPatchResult {
  ok: boolean
  diff: string | null
  file: string
  /** 应用前文件的 sha256（供下次应用前校验 base drift） */
  baseSha256?: string
  error?: string
}

export async function applyRenpyPatch(input: { projectDir: string; patch: ScenePatch; sessionId?: string; baseSha256?: string }): Promise<ApplyPatchResult> {
  const v = validatePatch(input.patch)
  if (!v.ok) return { ok: false, diff: null, file: '', error: v.error }
  const root = path.resolve(input.projectDir)
  const target = path.resolve(root, v.patch.file)
  if (!(await isWithinProject(target, root))) return { ok: false, diff: null, file: '', error: '补丁目标文件超出项目目录（realpath 校验）' }
  let oldRaw: string
  try {
    oldRaw = await fs.readFile(target, 'utf-8')
  } catch {
    return { ok: false, diff: null, file: target, error: '目标文件不存在' }
  }
  // base hash 校验：文件自补丁生成后若已变化，拒绝应用（防 base drift 改错位置）
  const baseSha256 = sha256(oldRaw)
  if (input.baseSha256 && input.baseSha256 !== baseSha256) {
    return { ok: false, diff: null, file: target, error: '文件自补丁生成后已变化（base hash 不匹配），拒绝应用' }
  }
  const applied = applyPatchToLines(oldRaw, v.patch)
  if (!applied.ok) return { ok: false, diff: null, file: target, error: applied.error }
  const newRaw = applied.lines.join(oldRaw.includes('\r\n') ? '\r\n' : '\n')
  if (newRaw !== oldRaw) {
    // Gate 1：写前备份必须成功，失败则中止（磁盘保持原状态）
    try {
      await backupForWrite(target, root, input.sessionId)
    } catch (e) {
      return { ok: false, diff: null, file: target, error: `写前备份失败（${(e as Error).message}），拒绝写盘` }
    }
    // 原子写：临时文件 + rename（失败时磁盘保持原状态）
    try {
      const tmp = `${target}.dw-tmp-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`
      await fs.writeFile(tmp, newRaw, 'utf-8')
      await fs.rename(tmp, target)
    } catch (e) {
      return { ok: false, diff: null, file: target, error: `写盘失败（${(e as Error).message}），磁盘保持原状态` }
    }
  }
  const d = makeDiff(oldRaw, newRaw, target)
  return { ok: true, diff: d ? d.content : null, file: target, baseSha256 }
}

/** 补丁预览：只计算 diff，不写盘（用于用户批准前展示） */
export async function buildPatchPreview(projectDir: string, patch: ScenePatch): Promise<ApplyPatchResult> {
  const v = validatePatch(patch)
  if (!v.ok) return { ok: false, diff: null, file: '', error: v.error }
  const root = path.resolve(projectDir)
  const target = path.resolve(root, v.patch.file)
  if (!(await isWithinProject(target, root))) return { ok: false, diff: null, file: '', error: '补丁目标文件超出项目目录（realpath 校验）' }
  let oldRaw: string
  try {
    oldRaw = await fs.readFile(target, 'utf-8')
  } catch {
    return { ok: false, diff: null, file: target, error: '目标文件不存在' }
  }
  const applied = applyPatchToLines(oldRaw, v.patch)
  if (!applied.ok) return { ok: false, diff: null, file: target, error: applied.error }
  const newRaw = applied.lines.join(oldRaw.includes('\r\n') ? '\r\n' : '\n')
  const d = makeDiff(oldRaw, newRaw, target)
  return { ok: true, diff: d ? d.content : null, file: target, baseSha256: sha256(oldRaw) }
}

export interface LintDiagnostic {
  severity: 'error' | 'warning'
  file: string | null
  line: number | null
  code: string
  message: string
}

export function parseLintOutput(output: string): LintDiagnostic[] {
  const out: LintDiagnostic[] = []
  const seen = new Set<string>()
  const push = (d: LintDiagnostic): void => {
    const key = `${d.code}|${d.file}|${d.line}|${d.message}`
    if (seen.has(key)) return
    seen.add(key)
    out.push(d)
  }
  let summaryErrors = 0
  const problemRe = /^(.+?\.rpy)\s*,\s*(\d+)\s*:\s*(.+)$/
  const traceRe = /^File\s+"(.+?\.rpy)"\s*,\s*line\s+(\d+)/i
  for (const line of output.split(/\r?\n/)) {
    const t = line.trim()
    if (!t) continue
    const m = problemRe.exec(t)
    if (m) {
      const isWarn = /warning|recommend|may\b|reachable|unused|obsolete/i.test(m[3])
      push({
        severity: isWarn ? 'warning' : 'error',
        file: m[1],
        line: Number(m[2]),
        code: isWarn ? 'lint-warning' : 'lint-error',
        message: m[3]
      })
      continue
    }
    const se = /(\d+)\s+errors?/i.exec(t)
    if (se) summaryErrors = Math.max(summaryErrors, Number(se[1]))
    const tb = traceRe.exec(t)
    if (tb) push({ severity: 'error', file: tb[1], line: Number(tb[2]), code: 'lint-error', message: '脚本解析异常' })
  }
  if (summaryErrors > 0 && !out.some((d) => d.severity === 'error')) {
    push({ severity: 'error', file: null, line: null, code: 'lint-error', message: `lint 报告 ${summaryErrors} 个错误` })
  }
  return out
}

async function readSnippets(projectDir: string, diagnostics: LintDiagnostic[]): Promise<string> {
  const root = path.resolve(projectDir)
  const realRoot = await fs.realpath(root).catch(() => root)
  const byFile = new Map<string, number[]>()
  for (const d of diagnostics) {
    if (!d.file) continue
    const p = path.resolve(root, d.file)
    // Gate 1：diagnostic 文件必须 realpath 在项目目录内（防恶意 lint 输出读取项目外 .rpy）
    const real = await fs.realpath(p).catch(() => p)
    const a = real.toLowerCase()
    const r = realRoot.toLowerCase()
    if (a !== r && !a.startsWith(r + path.sep)) continue
    const arr = byFile.get(real) ?? []
    arr.push(d.line ?? 0)
    byFile.set(real, arr)
  }
  const parts: string[] = []
  for (const [file, lineNos] of byFile) {
    try {
      const raw = await fs.readFile(file, 'utf-8')
      const all = raw.split(/\r?\n/)
      const want = new Set<number>()
      for (const ln of lineNos) {
        for (let i = Math.max(0, ln - 8); i <= Math.min(all.length - 1, ln + 8); i++) want.add(i)
      }
      const rows = [...want].sort((a, b) => a - b).map((i) => `${i + 1}: ${all[i]}`).join('\n')
      parts.push(`=== ${path.relative(root, file) || file} ===\n${rows}`)
    } catch {
      void 0
    }
  }
  return parts.join('\n\n').slice(0, 6000)
}

const RENPY_REPAIR_SYSTEM = `你是 Ren'Py 剧本修复专家。
根据下方诊断列表与文件片段，输出最小化结构化补丁修复脚本问题：
- 只修复诊断中列出的问题，不重写无关代码、不新增剧情、不整库重写
- 只输出 JSON：{"file": "game/script/xxx.rpy", "operations": [{"op": "insert_after"|"replace_line", "anchor": "现有整行内容", "lines": ["修复后的剧本行"]}]}
- insert_after 在 anchor 行之后插入；replace_line 用 lines 替换 anchor 行本身
- anchor 必须逐行匹配片段中存在的行；file 为项目内相对路径
- 不要输出代码块围栏或任何解释文字`

export interface RepairProposal {
  /** 待用户批准后应用的补丁 */
  patch: ScenePatch
  /** 应用后的真实 diff 预览 */
  diff: string
  file: string
  /** 该补丁针对的诊断 */
  diagnostics: LintDiagnostic[]
}

export interface RepairLoopResult {
  ok: boolean
  lintOutput: string
  repairRounds: number
  diagnostics: LintDiagnostic[]
  /** mode=propose：AI 生成的修复提案（未写盘），用户批准后调 applyRenpyPatch */
  proposals: RepairProposal[]
  /** 是否实际写盘过（mode=apply 时可能为 true） */
  autoApplied: boolean
}

/**
 * 修复循环（Gate 1 / P0-07）：
 * - 默认 mode='propose'：只生成修复提案（含真实 diff 预览），**绝不写盘**；
 *   用户批准后走 applyRenpyPatch（带 base hash / 唯一 anchor / 原子写 / checkpoint）。
 * - mode='apply'：保留旧自动写盘行为（显式开启，仅内部/测试使用）。
 */
export async function repairLoop(input: { projectDir: string; sdkPath: string; api: GalgameApi; maxRepairs?: number; mode?: 'propose' | 'apply' }): Promise<RepairLoopResult> {
  const mode = input.mode ?? 'propose'
  const maxRepairs = input.maxRepairs ?? 2
  let lint = await lintRenpyProject(input.sdkPath, input.projectDir)
  let diagnostics = parseLintOutput(lint.output)
  let rounds = 0
  let autoApplied = false
  const proposals: RepairProposal[] = []

  while (rounds < maxRepairs) {
    const errors = diagnostics.filter((d) => d.severity === 'error')
    if (errors.length === 0) break
    if (!input.api.apiKey && input.api.provider?.authStyle !== 'none') throw new Error('当前修复模型缺少可用 API Key')
    const top = errors.slice(0, 10)
    const snippets = await readSnippets(input.projectDir, top)
    const diagText = top.map((d) => `${d.file ?? '?'}${d.line ? ':' + d.line : ''} [${d.code}] ${d.message}`).join('\n')
    let patch: ScenePatch | null = null
    try {
      const text = await callPatchModel(input.api, [
        { role: 'system', content: RENPY_REPAIR_SYSTEM },
        { role: 'user', content: `## 诊断列表（前 ${top.length} 条）\n${diagText}\n\n## 相关文件片段\n${snippets}\n\n## 输出\n请输出修复补丁 JSON。` }
      ])
      const parsed = parsePatchText(text)
      if (parsed.ok) patch = parsed.patch
    } catch (error) {
      if (isCreativeAuthError(error)) throw error
      patch = null
    }
    if (!patch) break
    if (mode === 'propose') {
      // 只生成提案：真实 diff 预览，不写盘；一轮后返回（应用与复验由用户批准后完成）
      const preview = await buildPatchPreview(input.projectDir, patch)
      if (preview.ok && preview.diff) {
        proposals.push({ patch, diff: preview.diff, file: preview.file, diagnostics: top })
      }
      rounds++
      break
    }
    const applied = await applyRenpyPatch({ projectDir: input.projectDir, patch, sessionId: 'galgame-repair' })
    if (!applied.ok) break
    autoApplied = true
    lint = await lintRenpyProject(input.sdkPath, input.projectDir)
    diagnostics = parseLintOutput(lint.output)
    rounds++
  }
  const errors = diagnostics.filter((d) => d.severity === 'error')
  return { ok: errors.length === 0, lintOutput: lint.output, repairRounds: rounds, diagnostics, proposals, autoApplied }
}
