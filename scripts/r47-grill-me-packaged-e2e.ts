import * as path from 'node:path'
import * as url from 'node:url'
import * as fs from 'node:fs'
import * as fsp from 'node:fs/promises'
import * as http from 'node:http'
import * as os from 'node:os'
import { createHash } from 'node:crypto'
import { execFile as execFileCallback } from 'node:child_process'
import { promisify } from 'node:util'
import { createRequire } from 'node:module'
import { DatabaseSync } from 'node:sqlite'
import { _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { closeElectronGracefully } from './electron-shutdown'
import { sanitizeDiagnosticValue } from '../src/main/diagnostics'

/**
 * R47/R48：Grill Me + stop-short 的真实打包验收。
 *
 * 默认每次构建全新的 dist-r47-<HEAD>-<nonce> Windows 包；--exe 仅保留给
 * 明确指定的包复算。--source 是显式低成本源码构建验收，日志与 manifest
 * 单独标记，不可当成 packaged 通过。脚本不会静默退回源码、dev server、静态
 * marker 或单元测试。所有 provider 请求必须到本脚本启动的 127.0.0.1 SSE 端点，错误
 * 请求和未知阶段均 fail-closed。
 */

const ROOT = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '..')
const EVIDENCE_ROOT = path.join(ROOT, 'tmp', 'r47-grill-me-packaged-e2e')
const TARGET_CHARS = 8000
const exeArg = process.argv.find((arg) => arg.startsWith('--exe='))?.slice('--exe='.length)
const sourceModeArg = process.argv.includes('--source')
const scenarioArg = process.argv.find((arg) => arg.startsWith('--scenario='))?.slice('--scenario='.length) ?? 'all'
const packageLabelArg = process.argv.find((arg) => arg.startsWith('--package-label='))?.slice('--package-label='.length) ?? 'r47'
const hExpectationArg = process.argv.find((arg) => arg.startsWith('--h-expect='))?.slice('--h-expect='.length) ?? 'success'
const selfTestArg = process.argv.includes('--selftest')
const reviewCrashArg = process.argv.includes('--review-crash')
let executablePath = exeArg ? path.resolve(ROOT, exeArg) : ''
const execFile = promisify(execFileCallback)
const appProfiles = new WeakMap<ElectronApplication, string>()

type Scenario = 'A' | 'B' | 'C' | 'D' | 'E' | 'F' | 'G' | 'H' | 'R48'
type RequestKind = 'interview' | 'planning' | 'draft' | 'critic' | 'editor' | 'verify' | 'unknown'

interface Check { name: string; ok: boolean; detail?: string }
interface RequestLog {
  id: string
  kind: RequestKind
  receivedAt: number
  path: string
  model: string
  maxTokens: number | null
  roles: string[]
  bodyBytes: number
  responseChars: number
  finishReason: string | null
  finishReasonPresent: boolean
  thinkingEnabled: boolean | null
  requestCandidateHash: string | null
  responseCandidateHash: string | null
  responseIssueIds: string[]
  responsePatchIssueIds: string[]
  responseId: string
  sseCompleted: boolean
  completedAt: number | null
}
interface ProviderCaps { contextWindow: number | null; modelMaxOutputTokens: number | null; profileMaxOutputTokens: number | null }
interface PackageManifest {
  schemaVersion: 1
  mode: 'fresh' | 'explicit' | 'source'
  head: string | null
  packageHead: string | null
  outputDir: string
  executablePath: string
  appAsarPath: string | null
  appAsarSha256: string | null
  exeSha256: string | null
  sourceSha256: string | null
  sourceFiles: string[]
  builtAt: string
  manifestPath?: string
}
let packageManifest: PackageManifest | null = null
interface MockServer {
  server: http.Server
  port: number
  requests: RequestLog[]
  planningPrompts: string[]
  draftObservers: Array<() => void>
  abortedRequests: number
  mark: (name: string) => number
  marks: Record<string, number>
}
interface DbSnapshot {
  run: { run_id: string; session_id: string; status: string; error_code: string | null; config_json: string } | null
  config: Record<string, unknown> | null
  assistantTurns: string[]
  canonical: string
  providerAttempts: Array<{ outcome: string; actor: string; stage_id: string; model_id: string }>
  usage: Array<{ call_type: string; input_tokens: number; output_tokens: number }>
  evaluations: Array<{ state: string; json: string }>
  workflowEvents: Array<Record<string, unknown>>
  artifacts: Array<{ artifact_id: string; artifact_type: string; display_name: string; relative_path: string | null; hash: string | null; char_count: number; status: string }>
  grillState: Record<string, unknown> | null
}

interface EActionObservation {
  beforeDrafts: number
  afterDrafts: number
  budgetInputSeen: boolean
  continuationRunObserved: boolean
  budgetExtensionObserved: boolean
  partialPrefixRetained: boolean
  provenanceRetained: boolean
}

interface InterviewQuestionView {
  text: string
  options: string[]
  isFinal: boolean
}

interface InterviewAnswerObservation extends InterviewQuestionView {
  action: 'option' | 'supplement' | 'no_more'
  supplementFocusOk?: boolean
  supplementQuestionUnchanged?: boolean
}

function cpLen(value: string): number { return Array.from(value).length }

async function sha256File(filePath: string): Promise<string> {
  const hash = createHash('sha256')
  hash.update(await fsp.readFile(filePath))
  return hash.digest('hex')
}

async function sourceFilesUnder(root: string, relative = ''): Promise<string[]> {
  const current = path.join(root, relative)
  const entries = await fsp.readdir(current, { withFileTypes: true })
  const files: string[] = []
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const next = path.join(relative, entry.name)
    if (entry.isDirectory()) files.push(...await sourceFilesUnder(root, next))
    else if (entry.isFile()) files.push(next)
  }
  return files
}

async function sourceFingerprint(): Promise<{ hash: string; files: string[] }> {
  const roots = ['src', 'electron.vite.config.ts', 'package.json']
  const files: string[] = []
  for (const root of roots) {
    const full = path.join(ROOT, root)
    if ((await fsp.stat(full)).isDirectory()) files.push(...await sourceFilesUnder(ROOT, root))
    else files.push(root)
  }
  files.sort()
  const hash = createHash('sha256')
  for (const file of files) {
    hash.update(file.replaceAll('\\', '/'))
    hash.update('\0')
    hash.update(await fsp.readFile(path.join(ROOT, file)))
    hash.update('\0')
  }
  return { hash: hash.digest('hex'), files }
}

function localNodeScript(name: 'electron-vite' | 'electron-builder'): string {
  const script = name === 'electron-vite'
    ? path.join(ROOT, 'node_modules', 'electron-vite', 'bin', 'electron-vite.js')
    : path.join(ROOT, 'node_modules', 'electron-builder', 'cli.js')
  if (!fs.existsSync(script)) throw new Error(`本地打包脚本不存在：${script}`)
  return script
}

async function runBuildCommand(command: string, args: string[]): Promise<void> {
  try {
    await execFile(command, args, { cwd: ROOT, maxBuffer: 32 * 1024 * 1024 })
  } catch (error) {
    const detail = error as { stdout?: string; stderr?: string; message?: string }
    const output = `${detail.stderr ?? ''}\n${detail.stdout ?? ''}`.trim().slice(-6000)
    throw new Error(`${path.basename(command)} ${args.join(' ')} failed${output ? `\n${output}` : `: ${detail.message ?? 'unknown error'}`}`)
  }
}

async function buildFreshPackage(): Promise<PackageManifest> {
  const head = (await execFile('git', ['rev-parse', 'HEAD'], { cwd: ROOT })).stdout.trim() || null
  const nonce = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
  const outputDir = path.join(ROOT, `dist-${packageLabelArg}-${head?.slice(0, 12) ?? 'unknown'}-${nonce}`)
  await fsp.mkdir(outputDir)
  await runBuildCommand(process.execPath, [localNodeScript('electron-vite'), 'build'])
  // Use the workspace's already installed Electron runtime. This makes the
  // packaged acceptance test independent of GitHub availability and still
  // exercises a fresh app.asar produced from the current source tree.
  await runBuildCommand(process.execPath, [
    localNodeScript('electron-builder'), '--win', '--dir', '--config.npmRebuild=false',
    `--config.electronDist=${path.join(ROOT, 'node_modules', 'electron', 'dist')}`,
    `--config.directories.output=${outputDir}`
  ])
  const packagedExe = path.join(outputDir, 'win-unpacked', 'DeepWriter.exe')
  const appAsarPath = path.join(outputDir, 'win-unpacked', 'resources', 'app.asar')
  if (!fs.existsSync(packagedExe) || !fs.existsSync(appAsarPath)) throw new Error(`fresh package incomplete: exe=${packagedExe} asar=${appAsarPath}`)
  const source = await sourceFingerprint()
  const manifest: PackageManifest = {
    schemaVersion: 1,
    mode: 'fresh',
    head,
    packageHead: head,
    outputDir,
    executablePath: packagedExe,
    appAsarPath,
    appAsarSha256: await sha256File(appAsarPath),
    exeSha256: await sha256File(packagedExe),
    sourceSha256: source.hash,
    sourceFiles: source.files,
    builtAt: new Date().toISOString()
  }
  const manifestPath = path.join(EVIDENCE_ROOT, `packaged-${packageLabelArg}-${head?.slice(0, 12) ?? 'unknown'}-${nonce}.manifest.json`)
  manifest.manifestPath = manifestPath
  await fsp.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
  return manifest
}

function assertScenario(value: string): Scenario[] {
  if (value === 'all') return ['A', 'B', 'C', 'D', 'E', 'F']
  const values = value.split(',').map((item) => item.trim().toUpperCase())
  if (values.length === 0 || values.some((item) => !['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'R48'].includes(item))) throw new Error(`--scenario 只接受 A/B/C/D/E/F/G/H/R48/all：${value}`)
  return [...new Set(values)] as Scenario[]
}

function check(checks: Check[], name: string, ok: boolean, detail = ''): void {
  checks.push({ name, ok, ...(detail ? { detail } : {}) })
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}

function messagesOf(parsed: { messages?: unknown }): Array<{ role: string; content: string }> {
  if (!Array.isArray(parsed.messages)) return []
  return parsed.messages.map((message) => {
    const item = message as { role?: unknown; content?: unknown }
    return { role: typeof item.role === 'string' ? item.role : '', content: typeof item.content === 'string' ? item.content : JSON.stringify(item.content ?? '') }
  })
}

function classifyRequest(messages: Array<{ role: string; content: string }>, previous: RequestLog[], scenario: Scenario): RequestKind {
  const all = messages.map((message) => message.content).join('\n')
  if (/你是采访助手/.test(all)) return 'interview'
  if (/你是文章规划师/.test(all)) return 'planning'
  if (/你是定点文字编辑/.test(all)) return 'editor'
  if (/你是文字审校员/.test(all)) {
    const lastDraft = [...previous].reverse().find((item) => item.kind === 'draft')
    const verificationAfterDraft = lastDraft ? previous.filter((item) => item.receivedAt > lastDraft.receivedAt && (item.kind === 'critic' || item.kind === 'verify')).length : 0
    return verificationAfterDraft > 0 ? 'verify' : 'critic'
  }
  if (/Grill Me 已确认写作契约/.test(all)) return 'draft'
  // A valid request must expose a phase marker.  Do not guess that an arbitrary
  // provider request is a draft: an unknown request is a hard test failure.
  void scenario
  return 'unknown'
}

function uniqueChineseSegment(round: number, length = 1000): string {
  const lead = `第${round}段：海边灯塔的记录继续向前推进。`
  const chars = Array.from(lead)
  let index = 0
  while (chars.length < length) {
    // Keep every synthetic segment disjoint across all continuation rounds.
    // A modulo-0x4fff range wrapped at round 6 and made the product's genuine
    // repetition guard (correctly) pause a test fixture that was supposed to
    // represent fresh provider content.
    const codePoint = 0x10000 + round * 1000 + index
    chars.push(String.fromCodePoint(codePoint))
    index += 1
  }
  // Give the delivery gate auditable natural sentence boundaries while keeping
  // every round's substantive characters disjoint.
  for (let i = 99; i < chars.length; i += 100) chars[i] = '。'
  return chars.slice(0, length).join('')
}

function planningSourceIds(messages: Array<{ role: string; content: string }>): string[] {
  const prompt = messages.map((message) => message.content).join('\n')
  const match = prompt.match(/已确认信息：([\s\S]*?)\r?\n待采用假设：/u)
  if (match) {
    try {
      const parsed = JSON.parse(match[1]) as unknown
      if (Array.isArray(parsed)) {
        const ids = parsed.flatMap((item) => {
          if (!item || typeof item !== 'object') return []
          const value = item as { id?: unknown; source?: unknown }
          return typeof value.id === 'string' && value.source !== 'assumption' ? [value.id] : []
        })
        if (ids.length > 0) return [...new Set(ids)]
      }
    } catch { /* fall through to the deterministic fixture IDs */ }
  }
  return ['characters', 'setting', 'conflict']
}

function outlineForTarget(sourceSlotIds: string[] = ['characters', 'setting', 'conflict'], concrete = false): Record<string, unknown> {
  const sourceIds = sourceSlotIds.length > 0 ? [...new Set(sourceSlotIds)] : ['conflict']
  const sections = Array.from({ length: 8 }, (_, index) => ({
    id: `r47-s${index + 1}`,
    title: `灯塔档案第${index + 1}幕`,
    purpose: `推进守夜人与失踪船员的线索，让这一幕产生具体变化并承接下一幕。`,
    targetChars: 1000,
    beats: concrete ? ['林舟抵达灯塔', '沈遥点亮灯塔'] : [`第${index + 1}幕出现一个可验证的现场变化`, `第${index + 1}幕留下下一步行动线索`],
    sourceSlotIds: [sourceIds[index % sourceIds.length]]
  }))
  return { title: '灯塔档案：八幕推进计划', premise: '守夜人沿着一组可验证的线索追查失踪船员，在海边灯塔中完成一次克制而具体的悬疑调查。', sections, targetChars: TARGET_CHARS }
}

function fixtureDraft(scenario: Scenario, round: number, length = 1000): string {
  const filler = uniqueChineseSegment(round, length)
  if (scenario !== 'D') return filler
  const prefix = `夜班第${round}轮，林舟抵达灯塔。沈遥点亮灯塔。`
  return prefix + Array.from(filler).slice(cpLen(prefix)).join('')
}

function parseJson(value: string): Record<string, unknown> {
  try { return JSON.parse(value) as Record<string, unknown> } catch { return {} }
}

function lastUserContent(messages: Array<{ role: string; content: string }>): string {
  return [...messages].reverse().find((message) => message.role === 'user')?.content ?? ''
}

function responseFor(kind: RequestKind, requestNo: number, messages: Array<{ role: string; content: string }>, scenario: Scenario): { content: string; finishReason: string | null } {
  if (kind === 'interview') {
    const prompt = messages.map((message) => message.content).join('\n')
    if (/当前问题类型：final_check/u.test(prompt)) {
      return {
        content: JSON.stringify({
          question: '还有什么必须补充的吗？如果没有，请选择没有了；如果有，请继续补充。',
          options: [{ id: 'none', label: '没有了', value: '没有了' }, { id: 'supplement', label: '还有补充', value: '还有补充' }],
          readiness: 'ready',
          nextSlot: null
        }),
        finishReason: 'stop'
      }
    }
    if (scenario === 'D' && /目标维度：(characters|setting|conflict)/u.test(prompt)) {
      const dimension = prompt.match(/目标维度：(characters|setting|conflict)/u)?.[1]
      const answer = dimension === 'characters' ? '林舟、沈遥' : dimension === 'setting' ? '雾港灯塔' : '林舟抵达灯塔，沈遥点亮灯塔'
      return { content: JSON.stringify({ question: dimension === 'characters' ? '守夜人与搭档是谁？' : dimension === 'setting' ? '这一夜发生在什么地方？' : '本轮具体完成什么行动？', options: [{ id: 'concrete', label: answer, value: answer }, { id: 'later', label: '我想补充其他选择', value: '我想补充其他选择' }], readiness: 'insufficient', nextSlot: null }), finishReason: 'stop' }
    }
    if (scenario === 'G' && requestNo === 3) {
      return {
        content: JSON.stringify({
          question: '关于冲突的强度，你希望巨娘与城市之间主要是哪种对抗关系？',
          // The value is intentionally opaque while the label carries the
          // human-readable meaning. The durable slot should remain `mixed`.
          options: [
            { id: 'mixed', label: '二者兼具，但以感官冲击为重', value: 'mixed' },
            { id: 'physical', label: '物理破坏为主，城市被动承受', value: 'physical' },
            { id: 'psychological', label: '心理挣扎为主，破坏是副作用', value: 'psychological' }
          ],
          readiness: 'insufficient',
          nextSlot: null
        }),
        finishReason: 'stop'
      }
    }
    // The first three rounds provide concrete, topic-shaped choices.  The
    // fourth model call deliberately declares readiness while required slots
    // are still missing, so the real product must surface assumption_review
    // instead of silently jumping to final_check or planning.
    if (requestNo >= 4) {
      return {
        content: JSON.stringify({
          question: '现有信息已经足够开始构思；未明确的部分要采用哪些保守边界？',
          options: [
            { id: 'keep_evidence', label: '只用已给线索', value: '只用已经确认的线索，不补造事实' },
            { id: 'keep_scope', label: '收紧主题范围', value: '只围绕核心主题推进，不额外扩张' },
            { id: 'leave_flexible', label: '保留少量弹性', value: '只固定必要边界，其余交给写作判断' }
          ],
          readiness: 'ready',
          nextSlot: 'final_check'
        }),
        finishReason: 'stop'
      }
    }
    return {
      content: JSON.stringify({
        question: `第${requestNo}轮先确认一个具体写作取向，避免后续展开时偏离主题。`,
        options: [
          { id: 'concrete', label: '推进具体线索', value: '优先推进可以落到具体场景的线索' },
          { id: 'restrained', label: '保持克制表达', value: '保持克制表达，不额外拔高主题' },
          { id: 'flexible', label: '留出调整空间', value: '保留必要弹性，让后续细节自然展开' }
        ],
        readiness: 'insufficient',
        nextSlot: null
      }),
      finishReason: 'stop'
    }
  }
  if (kind === 'planning') {
    const sourceIds = planningSourceIds(messages)
    const outline = outlineForTarget(sourceIds, scenario === 'D')
    // R50 regression: the real provider once omitted the `conflict` provenance
    // despite receiving the confirmed slot. The first response exercises the
    // product's deterministic repair; a second valid response is available if
    // the implementation chooses one bounded retry instead.
    if (scenario === 'G') {
      outline.sections = outline.sections.map((section) => ({ ...section, sourceSlotIds: sourceIds.filter((id) => id !== 'conflict') }))
      if (requestNo > 1) outline.sections = outline.sections.map((section) => ({ ...section, sourceSlotIds: sourceIds }))
    }
    return { content: JSON.stringify(outline), finishReason: 'stop' }
  }
  if (kind === 'draft') return { content: fixtureDraft(scenario, requestNo), finishReason: scenario === 'D' ? 'length' : scenario === 'F' ? null : 'stop' }
  if (kind === 'critic' || kind === 'verify') {
    const body = parseJson(lastUserContent(messages))
    const candidateHash = typeof body.candidateHash === 'string' ? body.candidateHash : ''
    const candidate = typeof body.candidate === 'string' ? body.candidate : ''
    // Force one small, fully auditable advisory on the first normal segment.
    // This proves the packaged default path actually reaches editor and the
    // post-edit verification critic; later segments remain clean.
    if (kind === 'critic' && scenario !== 'F' && requestNo === 1 && candidate.length >= 5) {
      const startCp = scenario === 'D' ? 50 : 0
      const quote = Array.from(candidate).slice(startCp, startCp + 5).join('')
      return {
        content: JSON.stringify({
          schemaVersion: 1,
          candidateHash,
          issues: [{ issueId: 'r47-q1', code: 'cliche_language', severity: 'advisory', basis: 'quality', startCp, endCp: startCp + 5, quote, reason: '测试夹具要求验证一次可局部修订的风格建议', repairIntent: '只替换命中范围，保持场景和事实不变' }]
        }),
        finishReason: 'stop'
      }
    }
    return { content: JSON.stringify({ schemaVersion: 1, candidateHash, issues: [] }), finishReason: 'stop' }
  }
  if (kind === 'editor') {
    const body = parseJson(lastUserContent(messages))
    const issue = body.issue && typeof body.issue === 'object' ? body.issue as Record<string, unknown> : {}
    const quote = typeof issue.quote === 'string' ? issue.quote : ''
    const replacement = Array.from(quote).map((_, index) => index === 0 ? '序' : '幕').join('')
    return {
      content: JSON.stringify({
        schemaVersion: 1,
        candidateHash: typeof body.candidateHash === 'string' ? body.candidateHash : '',
        patches: [{ issueId: issue.issueId, startCp: issue.startCp, endCp: issue.endCp, quote, replacement }]
      }),
      finishReason: 'stop'
    }
  }
  return { content: JSON.stringify({ error: 'r47_unknown_provider_phase' }), finishReason: 'stop' }
}

async function startMock(scenario: Scenario): Promise<MockServer> {
  const requests: RequestLog[] = []
  const planningPrompts: string[] = []
  const draftObservers: Array<() => void> = []
  const marks: Record<string, number> = {}
  let abortedRequests = 0
  let requestSerial = 0
  let interviewSerial = 0
  let planningSerial = 0
  let draftSerial = 0
  const server = http.createServer((req, res) => {
    const requestPath = req.url ?? ''
    if (req.method !== 'POST' || !requestPath.endsWith('/chat/completions')) {
      res.writeHead(404).end()
      return
    }
    let raw = ''
    req.on('data', (chunk) => { raw += String(chunk) })
    req.on('error', () => { res.destroy() })
    req.on('end', () => {
      const parsed = parseJson(raw)
      const messages = messagesOf(parsed)
      const kind = classifyRequest(messages, requests, scenario)
      const requestId = `r47-${scenario}-${++requestSerial}`
      if (kind === 'interview') interviewSerial += 1
      if (kind === 'planning') planningSerial += 1
      if (kind === 'planning') planningPrompts.push(messages.map((message) => message.content).join('\n'))
      if (kind === 'draft') { draftSerial += 1; for (const observe of draftObservers.splice(0)) observe() }
      const response = responseFor(kind, kind === 'interview' ? interviewSerial : kind === 'planning' ? planningSerial : draftSerial, messages, scenario)
      const thinking = parsed.thinking as { type?: unknown } | undefined
      const thinkingEnabled = thinking?.type === 'enabled' ? true : thinking?.type === 'disabled' ? false : typeof parsed.enable_thinking === 'boolean' ? parsed.enable_thinking : null
      const requestBody = parseJson(lastUserContent(messages))
      const responseBody = (kind === 'critic' || kind === 'verify' || kind === 'editor') ? parseJson(response.content) : {}
      const responseIssues = Array.isArray(responseBody.issues) ? responseBody.issues : []
      const responsePatches = Array.isArray(responseBody.patches) ? responseBody.patches : []
      const record: RequestLog = {
        id: requestId,
        kind,
        receivedAt: Date.now(),
        path: requestPath,
        model: typeof parsed.model === 'string' ? parsed.model : '',
        maxTokens: typeof parsed.max_tokens === 'number' ? parsed.max_tokens : null,
        roles: messages.map((message) => message.role),
        bodyBytes: Buffer.byteLength(raw, 'utf8'),
        responseChars: cpLen(response.content),
        finishReason: response.finishReason,
        finishReasonPresent: response.finishReason !== null,
        thinkingEnabled,
        requestCandidateHash: typeof requestBody.candidateHash === 'string' && requestBody.candidateHash.length > 0 ? requestBody.candidateHash : null,
        responseCandidateHash: typeof responseBody.candidateHash === 'string' && responseBody.candidateHash.length > 0 ? responseBody.candidateHash : null,
        responseIssueIds: responseIssues.flatMap((issue) => issue && typeof issue === 'object' && typeof (issue as { issueId?: unknown }).issueId === 'string' ? [(issue as { issueId: string }).issueId] : []),
        responsePatchIssueIds: responsePatches.flatMap((patch) => patch && typeof patch === 'object' && typeof (patch as { issueId?: unknown }).issueId === 'string' ? [(patch as { issueId: string }).issueId] : []),
        responseId: requestId,
        sseCompleted: false,
        completedAt: null
      }
      requests.push(record)
      const chunks = Array.from({ length: Math.max(1, Math.ceil(cpLen(response.content) / 160)) }, (_, index) => Array.from(response.content).slice(index * 160, (index + 1) * 160).join(''))
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' })
      const write = (payload: unknown): void => { if (!res.destroyed) res.write(`data: ${JSON.stringify(payload)}\n\n`) }
      let chunkIndex = 0
      let completed = false
      // R48 lets the first question complete normally, then holds the second
      // interview response open. The path under test is therefore answer →
      // durable 1-round projection → stop an actually in-flight next question.
      // H keeps the first writer stream open long enough for the packaged UI
      // to render an active writing row before the provider attempt settles.
      const intervalMs = scenario === 'H' && kind === 'draft'
        ? 200
        : scenario === 'R48' && kind === 'interview' && interviewSerial >= 2 ? 5000 : 2
      const timer = setInterval(() => {
        if (res.destroyed) { clearInterval(timer); return }
        if (chunkIndex < chunks.length) {
          write({ id: requestId, choices: [{ index: 0, delta: { role: 'assistant', content: chunks[chunkIndex++] }, finish_reason: null }], usage: null })
          return
        }
        clearInterval(timer)
        const finalChoice: { index: number; delta: Record<string, never>; finish_reason?: string } = { index: 0, delta: {} }
        if (response.finishReason !== null) finalChoice.finish_reason = response.finishReason
        write({ id: requestId, choices: [finalChoice], usage: { prompt_tokens: Math.max(1, Math.ceil(Buffer.byteLength(raw, 'utf8') / 4)), completion_tokens: Math.max(1, cpLen(response.content)), total_tokens: Math.max(1, Math.ceil(Buffer.byteLength(raw, 'utf8') / 4)) + Math.max(1, cpLen(response.content)), prompt_cache_hit_tokens: 0, prompt_cache_miss_tokens: Math.max(1, Math.ceil(Buffer.byteLength(raw, 'utf8') / 4)) } })
        completed = true
        record.sseCompleted = true
        record.completedAt = Date.now()
        res.end('data: [DONE]\n\n')
      }, intervalMs)
      res.on('close', () => {
        if (!completed) abortedRequests += 1
        clearInterval(timer)
      })
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  return {
    server,
    port: (server.address() as { port: number }).port,
    requests,
    planningPrompts,
    draftObservers,
    get abortedRequests() { return abortedRequests },
    marks,
    mark: (name) => { const value = Date.now(); marks[name] = value; return value }
  }
}

async function configure(page: Page, port: number, budget: number, _docDir: string): Promise<void> {
  await page.evaluate(async ({ port: mockPort, budget: tokenBudget }) => {
    const ds = (window as any).ds
    if (!ds?.getSettings || !ds?.setSettings) throw new Error('settings bridge unavailable')
    const current = await ds.getSettings()
    const updated = await ds.setSettings({
      ...current,
      apiKey: 'r47-local-synthetic-only',
      baseUrl: `http://127.0.0.1:${mockPort}`,
      model: 'deepseek-v4-flash',
      maxTokens: 8192,
      thinkingEnabled: false,
      toolsEnabled: false,
      planMode: false,
      completionTokenBudget: tokenBudget,
      completionWallClockMs: 0,
      // Default confirmed Grill runs must exercise the strong writer pipeline;
      // the explicit-off path remains covered by the dedicated R39 regression.
      strongConstraintEnabled: true,
      themeLockMode: 'strong',
      expressionFreedom: 'high',
      antiMoralizingEnabled: true
    })
    if (updated === false) throw new Error('settings update rejected')
  }, { port, budget })
  await page.reload()
  await page.waitForSelector('.composer', { timeout: 15000 })
  const actual = await page.evaluate(async () => (window as any).ds.getSettings()) as { baseUrl?: string; completionTokenBudget?: number }
  if (actual.baseUrl !== `http://127.0.0.1:${port}`) throw new Error(`local mock endpoint not active: ${actual.baseUrl}`)
  if (actual.completionTokenBudget !== budget) throw new Error(`budget setting not active: ${actual.completionTokenBudget}`)
}

function setFixtureDocDir(userData: string, docDir: string): void {
  const settingsFile = path.join(userData, 'settings.json')
  const stored = JSON.parse(fs.readFileSync(settingsFile, 'utf8')) as Record<string, unknown>
  stored.docDir = docDir
  fs.mkdirSync(docDir, { recursive: true })
  fs.writeFileSync(settingsFile, `${JSON.stringify(stored, null, 2)}\n`, 'utf8')
}

async function configureSyntheticReferencePricing(page: Page, port: number, scenarioDir: string): Promise<void> {
  const receipt = await page.evaluate(async (mockPort) => {
    const ds = (window as any).ds
    const snapshot = await ds.providerSnapshot()
    if (!snapshot.ok) throw new Error('fixture provider snapshot rejected')
    const profile = snapshot.data.profiles.find((item: { id: string }) => item.id === snapshot.data.bindings?.defaultProfileId)
    const model = snapshot.data.models.find((item: { id: string }) => item.id === profile?.modelId)
    const provider = snapshot.data.providers.find((item: { id: string }) => item.id === profile?.providerId)
    const origin = `http://127.0.0.1:${mockPort}`
    if (!profile || !model || provider?.baseUrl !== origin || provider.authStyle !== 'none') throw new Error('synthetic pricing exact local profile identity mismatch')
    const saved = await ds.providerPricingUpsert({ modelId: model.id, currency: 'CNY', unit: 'per_1m_tokens', inputPrice: 0.02, outputPrice: 0.04, cacheHitInputPrice: 0.002, reasoningBillingRule: 'included_in_output', validFrom: '2026-01-01T00:00:00.000Z', acknowledgeReferenceOnly: true })
    if (!saved.ok || saved.data.source !== 'user_supplied' || saved.data.canonicalOrigin !== origin || saved.data.remoteModelId !== model.remoteModelId || saved.data.providerId !== provider.id) throw new Error('normal user reference pricing IPC rejected/misbound')
    const listed = await ds.providerPricingList(model.id)
    if (!listed.ok || !listed.data.some((item: { priceProfileHash: string }) => item.priceProfileHash === saved.data.priceProfileHash)) throw new Error('normal user reference pricing readback differs')
    const bound = await ds.profileSetBindings({ defaultProfileId: profile.id, planningProfileId: profile.id, draftProfileId: profile.id, reviewProfileId: profile.id, polishProfileId: profile.id })
    if (!bound.ok) throw new Error('normal profile bindings IPC rejected')
    return { classification: 'synthetic_loopback_user_reference_not_official_or_bill', pricing: saved.data, profileId: profile.id }
  }, port)
  await fsp.writeFile(path.join(scenarioDir, 'synthetic-reference-price.manifest.json'), `${JSON.stringify(receipt, null, 2)}\n`, 'utf8')
  await page.reload()
  await page.waitForSelector('.composer', { timeout: 15000 })
}

function redirectBuiltInRegistry(userData: string, port: number, includeFiniteCapabilities = true): void {
  const dbPath = path.join(userData, 'deepwriter.db')
  if (!fs.existsSync(dbPath)) throw new Error(`provider registry database missing: ${dbPath}`)
  const db = new DatabaseSync(dbPath)
  try {
    const provider = db.prepare("SELECT id FROM provider_registry WHERE builtin_locked=1 ORDER BY id LIMIT 1").get() as { id?: string } | undefined
    if (!provider?.id) throw new Error('built-in provider row missing')
    const endpoint = `http://127.0.0.1:${port}`
    // The isolated fixture has no real secret.  The test server is local and
    // intentionally auth-free; this avoids creating or persisting any key.
    db.prepare('UPDATE provider_registry SET base_url=?,auth_style=?,default_credential_ref_id=NULL,transport_policy_json=?,updated_at=? WHERE id=?').run(endpoint, 'none', JSON.stringify({ scope: 'loopback_http', allowNonDefaultPort: true, protocol: 'deepseek-chat' }), new Date().toISOString(), provider.id)
    // Most scenarios provide finite fixture metadata. H intentionally leaves
    // both model capability columns NULL and raises only the profile output
    // reserve: this is the exact packaged regression shape that used to make
    // the confirmed Grill handoff stop before chat:start. The DB is isolated
    // per scenario, so this never changes a user profile.
    if (includeFiniteCapabilities) {
      db.prepare('UPDATE provider_models SET context_window=?,max_output_tokens=? WHERE provider_id=?').run(131072, 8192, provider.id)
    } else {
      db.prepare('UPDATE provider_models SET context_window=NULL,max_output_tokens=NULL WHERE provider_id=?').run(provider.id)
      const profile = db.prepare('SELECT id,generation_json FROM provider_profiles WHERE provider_id=? ORDER BY id LIMIT 1').get(provider.id) as { id?: string; generation_json?: string } | undefined
      if (!profile?.id) throw new Error('built-in provider profile missing for unknown capability fixture')
      let generation: Record<string, unknown> = {}
      try { generation = profile.generation_json ? JSON.parse(profile.generation_json) as Record<string, unknown> : {} } catch { generation = {} }
      generation.maxOutputTokens = 65536
      db.prepare('UPDATE provider_profiles SET generation_json=?,updated_at=? WHERE id=?').run(JSON.stringify(generation), new Date().toISOString(), profile.id)
    }
    const updated = db.prepare('SELECT base_url,auth_style,transport_policy_json FROM provider_registry WHERE id=?').get(provider.id) as { base_url?: string; auth_style?: string; transport_policy_json?: string }
    if (updated.base_url !== endpoint || updated.auth_style !== 'none' || !/loopback_http/.test(updated.transport_policy_json ?? '')) throw new Error('built-in provider redirect did not persist')
  } finally {
    db.close()
  }
}

function readProviderCaps(userData: string): ProviderCaps {
  const db = new DatabaseSync(path.join(userData, 'deepwriter.db'))
  try {
    const model = db.prepare('SELECT context_window,max_output_tokens FROM provider_models ORDER BY id LIMIT 1').get() as { context_window?: number | null; max_output_tokens?: number | null } | undefined
    const profile = db.prepare('SELECT generation_json FROM provider_profiles ORDER BY id LIMIT 1').get() as { generation_json?: string } | undefined
    let profileMaxOutputTokens: number | null = null
    try {
      const generation = profile?.generation_json ? JSON.parse(profile.generation_json) as { maxOutputTokens?: unknown } : {}
      profileMaxOutputTokens = typeof generation.maxOutputTokens === 'number' ? generation.maxOutputTokens : null
    } catch { profileMaxOutputTokens = null }
    return {
      contextWindow: typeof model?.context_window === 'number' ? model.context_window : null,
      modelMaxOutputTokens: typeof model?.max_output_tokens === 'number' ? model.max_output_tokens : null,
      profileMaxOutputTokens
    }
  } finally {
    db.close()
  }
}

async function chooseLongformEntry(page: Page): Promise<void> {
  const novelNav = page.locator('.dw-global-nav button').filter({ hasText: '长文' }).first()
  await novelNav.click()
  await page.getByRole('textbox', { name: '剧情简介与硬性要求', exact: true }).waitFor({ state: 'visible', timeout: 10000 })
  // Longform now owns its entry and target contract; there is no Composer
  // mode popover here. Use the current visible controls, not test seeding.
  const contract = page.locator('details.dw-longform-contract')
  if (await contract.getAttribute('open') === null) await contract.locator('summary').click()
  const target = page.getByRole('spinbutton', { name: '长文目标篇幅', exact: true })
  await target.waitFor({ state: 'visible', timeout: 10000 })
  await target.fill(String(TARGET_CHARS))
  await target.press('Enter')
  await page.waitForFunction((chars) => Number((document.querySelector('[data-testid="long-target-input"]') as HTMLInputElement | null)?.value) === chars, TARGET_CHARS)
}

async function waitUntil(predicate: () => boolean, timeoutMs: number, stepMs = 50): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, stepMs))
  if (!predicate()) throw new Error(`condition timeout after ${timeoutMs}ms`)
}

async function waitForMock(mock: MockServer, predicate: () => boolean, timeoutMs = 30000): Promise<void> {
  await waitUntil(predicate, timeoutMs, 60)
  void mock
}

async function currentInterviewQuestion(page: Page): Promise<InterviewQuestionView | null> {
  const stage = page.locator('[data-testid="grill-interview-stage"]')
  if (!(await stage.isVisible().catch(() => false))) return null
  const question = stage.locator('.grill-me-question')
  // During the durable transition to assumption_review the old stage can
  // remain mounted for a tick without a question node.  Let the caller
  // re-check the explicit assumption card instead of turning that race into
  // a false packaged failure.
  if (!(await question.isVisible().catch(() => false))) return null
  const text = (await question.innerText()).trim()
  const options = (await stage.locator('[role="group"][aria-label="快速回答"] button').allTextContents())
    .map((item) => item.trim())
    .filter(Boolean)
  return { text, options, isFinal: /还有什么必须补充/.test(text) }
}

async function answerOneInterview(page: Page, mock: MockServer, ordinal: number, finalAction: 'supplement' | 'no_more' = 'no_more'): Promise<InterviewAnswerObservation | null> {
  const view = await currentInterviewQuestion(page)
  if (!view) {
    if (await page.getByRole('button', { name: '生成大纲', exact: true }).isVisible().catch(() => false)) return null
    throw new Error('采访问题未出现，且页面未进入大纲准备阶段')
  }
  if (view.options.length < 2 || view.options.length > 4) throw new Error(`当前问题选项数量不在 2–4 范围：${view.options.length}（${view.text}）`)
  const stage = page.locator('[data-testid="grill-interview-stage"]')
  const before = mock.requests.filter((item) => item.kind === 'interview').length

  // A question can render before the provider stream has settled; in that
  // window the real UI keeps its choices disabled.  Wait for an enabled
  // choice instead of turning this normal renderer transition into a false
  // packaged regression.
  await page.waitForFunction(() => {
    const buttons = Array.from(document.querySelectorAll('[data-testid="grill-interview-stage"] [role="group"][aria-label="快速回答"] button')) as HTMLButtonElement[]
    const assumptionReady = Array.from(document.querySelectorAll('button')).some((button) => (button.textContent ?? '').trim() === '接受默认值')
    return buttons.some((button) => !button.disabled) || assumptionReady
  }, undefined, { timeout: 15000 })
  // Readiness can transition directly to the durable assumption card while
  // the previous question is still mounted for one React tick. Let the
  // caller's next loop handle that card instead of clicking stale choices.
  if (await page.getByRole('button', { name: '接受默认值', exact: true }).isVisible().catch(() => false)) return null

  if (view.isFinal && finalAction === 'supplement') {
    const supplement = stage.locator('[role="group"][aria-label="快速回答"] button').filter({ hasText: '还有补充' }).first()
    if (!(await supplement.isVisible().catch(() => false))) throw new Error('final_check 缺少“还有补充”选项')
    await supplement.click()
    await page.waitForTimeout(80)
    const afterText = (await stage.locator('.grill-me-question').innerText()).trim()
    const focus = await page.evaluate(() => document.activeElement?.getAttribute('aria-label') === '自由填写回答')
    const unchanged = afterText === view.text
    if (!focus || !unchanged || mock.requests.filter((item) => item.kind === 'interview').length !== before) throw new Error(`“还有补充”不应直接提交：focus=${focus} unchanged=${unchanged} interviewRequests=${mock.requests.filter((item) => item.kind === 'interview').length - before}`)
    const answer = stage.locator('textarea[aria-label="自由填写回答"]')
    await answer.fill(`第${ordinal}轮补充：请保留这条具体要求，并在后续大纲中体现。`)
    await stage.getByRole('button', { name: '提交补充，继续梳理', exact: true }).click()
    await waitForMock(mock, () => mock.requests.filter((item) => item.kind === 'interview').length > before, 20000)
    return { ...view, action: 'supplement', supplementFocusOk: focus, supplementQuestionUnchanged: unchanged }
  }

  if (view.isFinal && finalAction === 'no_more') {
    const noMore = stage.locator('[role="group"][aria-label="快速回答"] button').filter({ hasText: '没有了' }).first()
    if (!(await noMore.isVisible().catch(() => false))) throw new Error('final_check 缺少“没有了，生成大纲”选项')
    await noMore.click()
    await page.locator('[data-testid="grill-outline-ready-stage"]').waitFor({ state: 'visible', timeout: 20000 })
    if (mock.requests.filter((item) => item.kind === 'interview').length !== before) throw new Error('“没有了，生成大纲”不应额外调用采访模型')
    return { ...view, action: 'no_more' }
  }

  await stage.locator('[role="group"][aria-label="快速回答"] button').first().click()
  await waitForMock(mock, () => mock.requests.filter((item) => item.kind === 'interview').length > before, 20000)
  return { ...view, action: 'option' }
}

async function completeInterview(page: Page, mock: MockServer, checks: Check[]): Promise<void> {
  let answered = 0
  let optionRounds = 0
  let finalSeen = 0
  let supplementFocusOk = false
  let supplementQuestionUnchanged = false
  let supplementSubmitted = false
  let finalConfirmed = false
  let assumptionSeen = false
  let assumptionAccepted = false
  let assumptionPlanningBefore = -1
  let assumptionDraftBefore = -1
  for (let loop = 0; loop < 20; loop += 1) {
    const generate = page.getByRole('button', { name: '生成大纲', exact: true })
    if (await generate.isVisible().catch(() => false)) break
    // The renderer can retain the previous question for one React tick while
    // the durable state changes to assumption_review.  Prefer the explicit
    // decision card before reading the stale question node.
    const assumption = page.getByRole('button', { name: '接受默认值', exact: true })
    if (await assumption.isVisible().catch(() => false)) {
      assumptionSeen = true
      assumptionPlanningBefore = mock.requests.filter((item) => item.kind === 'planning').length
      assumptionDraftBefore = mock.requests.filter((item) => item.kind === 'draft').length
      const assumptionText = await page.locator('[data-testid="grill-assumption-stage"]').innerText().catch(() => '')
      check(checks, '模型 readiness 触发了明确的默认值审阅', /保守默认值/.test(assumptionText), assumptionText.slice(0, 280))
      await assumption.click()
      assumptionAccepted = true
      await page.waitForTimeout(100)
      continue
    }
    if (await page.locator('[data-testid="grill-interview-stage"]').isVisible().catch(() => false)) {
      answered += 1
      const view = await currentInterviewQuestion(page)
      if (!view) { await page.waitForTimeout(80); continue }
      if (view.isFinal) {
        finalSeen += 1
        const observation = await answerOneInterview(page, mock, answered, supplementSubmitted ? 'no_more' : 'supplement')
        if (observation?.action === 'supplement') {
          supplementSubmitted = true
          supplementFocusOk = observation.supplementFocusOk === true
          supplementQuestionUnchanged = observation.supplementQuestionUnchanged === true
        } else if (observation?.action === 'no_more') {
          finalConfirmed = true
          break
        }
      } else {
        optionRounds += 1
        await answerOneInterview(page, mock, answered)
      }
      continue
    }
    if (await page.locator('[data-testid="grill-outline-stage"]').isVisible().catch(() => false)) await page.waitForTimeout(100)
    else await page.waitForTimeout(150)
  }
  check(checks, '采访完成后进入大纲准备状态', await page.getByRole('button', { name: '生成大纲', exact: true }).isVisible().catch(() => false), `answered=${answered}`)
  check(checks, '采访自动问题至少三轮', mock.requests.filter((item) => item.kind === 'interview').length >= 3, `interview=${mock.requests.filter((item) => item.kind === 'interview').length}`)
  check(checks, '每轮 current question 提供 2–4 个动态选项', optionRounds >= 3, `optionRounds=${optionRounds}`)
  check(checks, '接受默认值前没有 planning/draft 请求', assumptionSeen && assumptionPlanningBefore === 0 && assumptionDraftBefore === 0, JSON.stringify({ assumptionSeen, planning: assumptionPlanningBefore, draft: assumptionDraftBefore }))
  check(checks, '默认值审阅可接受并继续到最终补充确认', assumptionSeen && assumptionAccepted && finalSeen >= 1, JSON.stringify({ assumptionSeen, assumptionAccepted, finalSeen }))
  check(checks, 'final “还有补充”只聚焦并保持原问题', supplementFocusOk && supplementQuestionUnchanged, JSON.stringify({ supplementFocusOk, supplementQuestionUnchanged }))
  check(checks, '补充提交后再次出现 final 并可确认', supplementSubmitted && finalSeen >= 2 && finalConfirmed, JSON.stringify({ supplementSubmitted, finalSeen, finalConfirmed }))
}

async function startInterview(page: Page, mock: MockServer): Promise<void> {
  await page.getByRole('textbox', { name: '剧情简介与硬性要求', exact: true }).fill('写一篇关于海边旧灯塔与守夜人的长文。')
  await page.getByRole('button', { name: '开始梳理', exact: true }).click()
  await page.locator('[aria-label="长文写作梳理"]').waitFor({ state: 'visible', timeout: 15000 })
  await waitForMock(mock, () => mock.requests.some((item) => item.kind === 'interview'), 20000)
}

async function runR48StopScenario(): Promise<{ checks: Check[]; requests: RequestLog[]; evidencePath: string }> {
  const checks: Check[] = []
  const scenarioDir = await fsp.mkdtemp(path.join(EVIDENCE_ROOT, 'r48-'))
  const userData = await fsp.mkdtemp(path.join(scenarioDir, 'user-data-'))
  const mock = await startMock('R48')
  const diagnostics: string[] = []
  let app: ElectronApplication | null = null
  let page: Page | null = null
  let db: DbSnapshot | null = null
  let firstStateId = ''
  let secondStateId = ''
  const bindDiagnostics = (target: Page): void => {
    target.on('console', (message) => {
      const text = message.text()
      if (message.type() === 'error' || /grill|chat:start|send\]|error|失败|拒绝/i.test(text)) diagnostics.push(`console:${message.type()}:${text}`)
    })
    target.on('pageerror', (error) => diagnostics.push(`pageerror:${error.message}`))
    target.on('requestfailed', (request) => diagnostics.push(`requestfailed:${request.url()}:${request.failure()?.errorText ?? 'unknown'}`))
  }
  try {
    // Bootstrap an isolated DB, redirect its built-in planning profile to the
    // local SSE server, then relaunch the exact same packaged executable.
    app = (await launch(executablePath, userData)).app
    page = await app.firstWindow()
    bindDiagnostics(page)
    await configure(page, mock.port, 200000, path.join(scenarioDir, 'documents'))
    const bootstrapExit = await quit(app)
    check(checks, 'R48：bootstrap Electron 自然退出', bootstrapExit === 0, `exit=${bootstrapExit}`)
    await app.close().catch(() => undefined)
    app = null
    page = null
    setFixtureDocDir(userData, path.join(scenarioDir, 'documents'))
    redirectBuiltInRegistry(userData, mock.port)

    app = (await launch(executablePath, userData)).app
    page = await app.firstWindow()
    bindDiagnostics(page)
    await configure(page, mock.port, 200000, path.join(scenarioDir, 'documents'))
    await page.setViewportSize({ width: 1400, height: 900 }).catch(() => undefined)
    await chooseLongformEntry(page)
    check(checks, 'R48：长文起稿输入与目标契约真实可见', await page.getByRole('textbox', { name: '剧情简介与硬性要求', exact: true }).isVisible() && await page.getByRole('spinbutton', { name: '长文目标篇幅', exact: true }).isVisible())

    await page.locator('.novel-direct-input').fill('写一篇关于海边旧灯塔与守夜人的长文，保持具体克制。')
    await page.locator('.novel-sub .btn.primary').first().click()
    const workbench = page.locator('[aria-label="长文写作梳理"]')
    await workbench.waitFor({ state: 'visible', timeout: 15000 })
    await page.locator('[data-testid="grill-interview-stage"]').waitFor({ state: 'visible', timeout: 15000 })
    check(checks, 'R48：开始梳理后真实挂载 Grill 面板', await page.locator('.grill-me-workbench').count() === 1 && await workbench.isVisible())
    const initialText = await workbench.innerText()
    check(checks, 'R48：首问可见且没有固定 0/13 假进度', Boolean((await page.locator('.grill-me-question').innerText().catch(() => '')).trim()) && !/0\s*\/\s*13/.test(initialText), initialText.slice(0, 360))
    await waitForMock(mock, () => mock.requests.some((item) => item.kind === 'interview'), 10000)

    // The first provider response must finish normally. Exercise the actual
    // first-question option path, then wait until the durable state records
    // one answer before the deliberately slow second provider call is stopped.
    await page.waitForFunction(() => {
      const button = document.querySelector('[data-testid="grill-interview-stage"] .grill-me-option') as HTMLButtonElement | null
      return Boolean(button && !button.disabled)
    }, undefined, { timeout: 15000 })
    const firstOption = page.locator('[data-testid="grill-interview-stage"] .grill-me-option').first()
    await firstOption.click()
    await waitForMock(mock, () => mock.requests.filter((item) => item.kind === 'interview').length >= 2, 10000)
    await waitUntil(() => {
      try { return (readDb(userData).grillState?.answers as unknown[] | undefined)?.length === 1 } catch { return false }
    }, 15000, 100)
    const afterAnswer = readDb(userData)
    check(checks, 'R48：首问选项提交后 durable answers 从 0 变为 1', Array.isArray(afterAnswer.grillState?.answers) && afterAnswer.grillState.answers.length === 1, JSON.stringify({ answers: afterAnswer.grillState?.answers }))
    await page.waitForFunction(() => /已回答\s*1\s*轮/.test(document.querySelector('.dw-activity-rail .dw-task-run-main')?.textContent ?? ''), undefined, { timeout: 10000 }).catch(() => undefined)
    const visibleWorkflow = await page.locator('.dw-activity-rail .dw-task-run-main').innerText().catch(() => '')
    check(checks, 'R48：可见工作流细节显示已回答 1 轮且不含 0/13', /已回答\s*1\s*轮/.test(visibleWorkflow) && !/0\s*\/\s*13/.test(visibleWorkflow), visibleWorkflow)
    const journalAfterAnswer = await readActivityJournal(userData)
    check(checks, 'R48：工作流显示已回答 1 轮且不再显示 0/13', /已回答\s*1\s*轮/.test(journalAfterAnswer) && !/0\s*\/\s*13/.test(journalAfterAnswer), journalAfterAnswer.slice(-1200))

    const activeRow = page.locator('.dw-activity-rail .dw-task-run').first()
    await activeRow.waitFor({ state: 'visible', timeout: 10000 })
    const stopButton = activeRow.getByRole('button', { name: '停止', exact: true })
    check(checks, 'R48：provider 在途时工作流显示可点击停止', await stopButton.isVisible() && !(await stopButton.isDisabled().catch(() => true)))
    await stopButton.click()

    await waitUntil(() => mock.abortedRequests >= 1, 15000, 100)
    check(checks, 'R48：停止动作真实 abort provider HTTP 流', mock.abortedRequests >= 1, `aborted=${mock.abortedRequests}`)
    await waitUntil(() => {
      try {
        const snapshot = readDb(userData)
        return snapshot.grillState?.status === 'cancelled'
      } catch { return false }
    }, 15000, 150)
    db = readDb(userData)
    firstStateId = typeof db.grillState?.stateId === 'string' ? db.grillState.stateId : ''
    check(checks, 'R48：Grill Me durable state 落为 cancelled', db.grillState?.status === 'cancelled', JSON.stringify({ stateId: firstStateId, status: db.grillState?.status, run: db.run?.status }))
    const cancelledJournal = await readActivityJournal(userData)
    check(checks, 'R48：工作流 run 也落为 cancelled', /"type":"run\.cancelled"/.test(cancelledJournal) && /梳理已停止/.test(cancelledJournal), cancelledJournal.slice(-1200))
    await page.locator('[aria-label="长文写作梳理"]').waitFor({ state: 'hidden', timeout: 15000 }).catch(async () => {
      await waitUntil(() => page?.locator('[aria-label="长文写作梳理"]').count() === 0, 5000, 100)
    })
    check(checks, 'R48：停止后 Grill 面板退出并恢复普通输入', await page.locator('[aria-label="长文写作梳理"]').count() === 0 && await page.locator('.composer textarea').isVisible() && await page.locator('.composer textarea').isEnabled())

    const requestsBeforeRestart = mock.requests.filter((item) => item.kind === 'interview').length
    await page.locator('.composer textarea').fill('同一会话重新梳理一篇关于旧灯塔守夜人的短篇，先确认一个核心冲突。')
    await page.locator('.composer .btn.primary').first().click()
    await page.locator('[aria-label="长文写作梳理"]').waitFor({ state: 'visible', timeout: 15000 })
    await page.locator('[data-testid="grill-interview-stage"]').waitFor({ state: 'visible', timeout: 15000 })
    await waitForMock(mock, () => mock.requests.filter((item) => item.kind === 'interview').length > requestsBeforeRestart, 10000)
    const restarted = readDb(userData)
    secondStateId = typeof restarted.grillState?.stateId === 'string' ? restarted.grillState.stateId : ''
    check(checks, 'R48：同 session 可重新创建新 Grill 状态', Boolean(firstStateId && secondStateId && firstStateId !== secondStateId) && restarted.grillState?.status !== 'cancelled', JSON.stringify({ firstStateId, secondStateId, status: restarted.grillState?.status }))
    check(checks, 'R48：重新开始后首问与面板仍真实可见', await page.locator('.grill-me-workbench').count() === 1 && Boolean((await page.locator('.grill-me-question').innerText().catch(() => '')).trim()))
    // Stop the second slow request too, leaving no provider stream or active
    // Grill run behind for the final natural Electron shutdown.
    const secondStop = page.locator('.dw-activity-rail .dw-task-run').first().getByRole('button', { name: '停止', exact: true })
    if (await secondStop.isVisible().catch(() => false)) await secondStop.click()
    await waitUntil(() => mock.abortedRequests >= 2, 15000, 100).catch(() => undefined)
  } catch (error) {
    const body = page ? await page.locator('body').innerText().catch(() => '') : ''
    if (body) diagnostics.push(`body:${body.slice(-1800)}`)
    check(checks, 'R48：harness 没有异常', false, `${error instanceof Error ? error.message : String(error)}${diagnostics.length ? ` | ${diagnostics.slice(-4).join(' || ')}` : ''}`)
  } finally {
    const exit = await quit(app)
    check(checks, 'R48：最终 Electron 自然退出', exit === 0, `exit=${exit}`)
    if (app) await app.close().catch(() => undefined)
    try { db = readDb(userData) } catch { /* keep latest snapshot */ }
    await new Promise<void>((resolve) => mock.server.close(() => resolve()))
  }
  const result = { scenario: 'R48', executablePath, packageManifest, userData, requests: mock.requests, abortedRequests: mock.abortedRequests, db, diagnostics, checks, passed: checks.filter((item) => item.ok).length, failed: checks.filter((item) => !item.ok).length }
  const evidencePath = path.join(scenarioDir, 'result.json')
  await fsp.writeFile(evidencePath, `${JSON.stringify(result, null, 2)}\n`, 'utf8')
  console.log(`R48: ${result.passed} PASS / ${result.failed} FAIL`)
  console.log(`evidence: ${evidencePath}`)
  return { checks, requests: mock.requests, evidencePath }
}

async function captureCommercialStage(page: Page, scenario: Scenario, stage: 'interview' | 'outline'): Promise<void> {
  await page.bringToFront()
  const phase = commercialEvidencePhase()
  const contract = page.locator('details.dw-longform-contract')
  if (await contract.getAttribute('open') !== null) await contract.locator('summary').click()
  for (const width of [1280, 1024, 800]) {
    await page.setViewportSize({ width, height: 900 })
    const closeActivity = page.getByRole('button', { name: '关闭活动抽屉', exact: true })
    if (await closeActivity.isVisible()) await closeActivity.click()
    await page.locator(`[data-testid="grill-${stage === 'outline' ? 'outline' : 'interview'}-stage"]`).scrollIntoViewIfNeeded()
    await page.screenshot({ path: path.join(EVIDENCE_ROOT, `commercial-${scenario}-${stage}-${phase}-${width}.png`), animations: 'disabled' })
    if (stage === 'outline') {
      await page.getByRole('button', { name: '确认大纲，开始写作', exact: true }).scrollIntoViewIfNeeded()
      await page.screenshot({ path: path.join(EVIDENCE_ROOT, `commercial-${scenario}-confirmation-actions-${phase}-${width}.png`), animations: 'disabled' })
    }
  }
  await page.setViewportSize({ width: 1280, height: 900 })
}

function commercialEvidencePhase(): string {
  const phase = process.env.DW_UI_EVIDENCE_PHASE ?? 'before'
  if (!/^[a-z][a-z0-9-]{0,48}$/u.test(phase)) throw new Error('invalid commercial evidence phase')
  return phase
}

async function completeWithBoundedUserReview(page: Page, userData: string, checks: Check[], scenarioDir: string): Promise<DbSnapshot> {
  const observations: Array<Record<string, unknown>> = []
  const deadline = Date.now() + 90000
  const seen = new Set<string>()
  while (Date.now() < deadline) {
    const db = readDb(userData)
    if (db.run?.status === 'completed') {
      check(checks, 'B：抽象推进点仅走适用的人工接受正文动作并保留每段revision审计（非无人连续）', observations.length >= 8 && observations.length <= 12 && observations.every(item => item.decision === 'accept_prose_no_state' && item.auditVerified === true), JSON.stringify(observations))
      await fsp.writeFile(path.join(scenarioDir, 'user-review-decisions.json'), JSON.stringify(observations, null, 2), 'utf8')
      return db
    }
    if (db.run?.status === 'waiting_user' && db.run.error_code === 'narrative_state_pending_review') {
      if (observations.length >= 12) throw new Error('bounded user review exceeded 12 decisions')
      const response = await page.evaluate(async runId => (window as any).ds.runsNarrativeReview(runId), db.run.run_id)
      const packet = response.review
      if (!response.ok || !packet || typeof packet.revision !== 'number') throw new Error('actual durable review packet missing')
      if (packet.status !== 'pending_review' || seen.has(packet.packetHash)) { await page.waitForTimeout(100); continue }
      const decision = 'accept_prose_no_state'
      const capabilities = packet.effectiveAllowedDecisions ?? packet.allowedDecisions
      if (!capabilities?.[decision]?.allowed) throw new Error('review decision forbidden')
      if (observations.length === 0) {
        check(checks, 'B：抽象缺失推进点不宣传仅角色歧义可用的保留未知动作', capabilities?.accept_unknown?.allowed === false)
        check(checks, 'B：实际审阅界面不显示不可适用的保留未知按钮', await page.getByRole('button', { name: /^接受正文，保留未知/u }).count() === 0)
      }
      const label = '接受正文，不写入状态'
      const button = page.getByRole('button', { name: new RegExp(`^${label}`) }).last()
      await button.waitFor({ state: 'visible', timeout: 10000 })
      if (observations.length < 2) await page.screenshot({ path: path.join(EVIDENCE_ROOT, `commercial-B-review-${decision}-${commercialEvidencePhase()}-${observations.length + 1}.png`), animations: 'disabled' })
      await button.click()
      await waitUntil(() => {
        const sqlite = new DatabaseSync(path.join(userData, 'deepwriter.db'))
        try {
          return (sqlite.prepare("SELECT json FROM run_evidence WHERE run_id=? AND kind LIKE 'narrative_semantic_review_decision:%'").all(db.run!.run_id) as Array<{ json: string }>).some(row => {
            const record = JSON.parse(row.json)
            return record.decision === decision && record.packetHash === packet.packetHash && record.expectedRevision === packet.revision && record.revision === packet.revision + 1 && record.candidateHash === packet.candidate.contentHash && /^[a-f0-9]{64}$/.test(record.decisionHash)
          })
        } finally { sqlite.close() }
      }, 10000, 100)
      seen.add(packet.packetHash)
      observations.push({ decision, reason: packet.reason, expectedRevision: packet.revision, packetHash: packet.packetHash, candidateHash: packet.candidate.contentHash, auditVerified: true })
    } else if (db.run && ['failed', 'cancelled', 'recovery_required'].includes(db.run.status)) throw new Error(`user reviewed run terminal blocker: ${db.run.status} ${db.run.error_code ?? ''}`)
    await page.waitForTimeout(100)
  }
  throw new Error('bounded user reviewed completion deadline exceeded')
}

async function prepareOutline(page: Page, mock: MockServer, checks: Check[], scenario: Scenario, startAfter = true): Promise<number> {
  const beforePlanning = mock.requests.filter((item) => item.kind === 'planning').length
  const beforeDraft = mock.requests.filter((item) => item.kind === 'draft').length
  check(checks, '大纲确认前 planning 已允许、draft 仍为零', beforeDraft === 0, `planning=${beforePlanning} draft=${beforeDraft}`)
  await page.getByRole('button', { name: '生成大纲', exact: true }).click()
  await waitForMock(mock, () => mock.requests.filter((item) => item.kind === 'planning').length > beforePlanning, 20000)
  const outline = page.locator('[data-testid="grill-outline-stage"]')
  await outline.waitFor({ state: 'visible', timeout: 20000 })
  // Source labels live inside collapsed section details; expand them before
  // checking the repaired provenance instead of inspecting only the summary.
  if (scenario === 'G') {
    const sections = outline.locator('.grill-me-section')
    for (let index = 0; index < await sections.count(); index += 1) {
      const section = sections.nth(index)
      if (!(await section.getAttribute('open'))) await section.locator('summary').click()
    }
  }
  const outlineText = await outline.innerText()
  const titleInput = outline.getByRole('textbox', { name: '大纲标题', exact: true })
  const originalTitle = await titleInput.inputValue()
  const draftTitle = `${originalTitle}（未提交编辑）`
  await titleInput.fill(draftTitle)
  await page.waitForTimeout(800) // Cross the durable poll without saving.
  check(checks, '权威大纲重挂后可编辑且同 revision 轮询不覆盖未提交修改', await titleInput.inputValue() === draftTitle, `titleDraftRetained=${await titleInput.inputValue() === draftTitle}`)
  await titleInput.fill(originalTitle)
  check(checks, '规划响应形成可编辑大纲且预算精确 8000', /合计\s*8000\s*\/\s*8000\s*字/.test(outlineText.replaceAll(',', '')), outlineText.match(/合计[^\n]*/)?.[0] ?? outlineText.slice(-100))
  if (scenario === 'G') {
    const planningCount = mock.requests.filter((item) => item.kind === 'planning').length
    check(checks, 'G：首轮遗漏 conflict 来源后自动恢复到可确认大纲', planningCount >= 1 && planningCount <= 2, `planning=${planningCount}`)
    check(checks, 'G：恢复后的大纲保留 conflict 来源标记', /conflict/.test(outlineText), outlineText.match(/来源[^\n]*/g)?.join(' | ') ?? outlineText.slice(-300))
  }
  check(checks, '大纲阶段没有正文 provider 请求', mock.requests.filter((item) => item.kind === 'draft').length === 0, `draft=${mock.requests.filter((item) => item.kind === 'draft').length}`)
  if (scenario === 'B') {
    const warning = page.getByTestId('outline-applicability-warning')
    await warning.waitFor({ state: 'visible', timeout: 10000 })
    check(checks, 'B：付费正文前提示抽象推进点需要逐段人工复核且可重新规划', (await warning.innerText()).includes('人工复核') && await warning.getByRole('button', { name: '重新规划具体推进点', exact: true }).isEnabled() && mock.requests.filter(item => item.kind === 'draft').length === 0)
  } else if (scenario === 'D') {
    const warning = page.getByTestId('outline-applicability-warning')
    check(checks, 'D：具体可观察事件大纲不铺常驻抽象推进点警示', await warning.count() === 0 && mock.requests.filter(item => item.kind === 'draft').length === 0)
  }
  if (scenario === 'B' || scenario === 'D') await captureCommercialStage(page, scenario, 'outline')
  await page.getByRole('button', { name: '确认大纲，开始写作', exact: true }).scrollIntoViewIfNeeded()
  await page.screenshot({ path: path.join(EVIDENCE_ROOT, `commercial-${scenario}-outline-confirmation-${commercialEvidencePhase()}.png`), animations: 'disabled' })
  const preparedAt = mock.mark('outlinePrepared')
  if (startAfter) {
    const clickAt = mock.mark('outlineConfirmClick')
    await page.getByRole('button', { name: '确认大纲，开始写作', exact: true }).click()
    await waitForMock(mock, () => mock.requests.some((item) => item.kind === 'draft'), 30000)
    return clickAt
  }
  return preparedAt
}

async function confirmOutlineAndStart(page: Page, mock: MockServer, checks: Check[], scenario: Scenario): Promise<number> {
  return prepareOutline(page, mock, checks, scenario, true)
}

async function waitForDbStatus(userData: string, statuses: string[], timeoutMs = 90000): Promise<DbSnapshot | null> {
  let latest: DbSnapshot | null = null
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      latest = readDb(userData)
      if (latest.run && statuses.includes(latest.run.status)) return latest
    } catch {
      // The app may still be creating/migrating the database; continue polling.
    }
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  return latest
}

async function waitForDraftsOrTerminal(userData: string, mock: MockServer, requiredDrafts: number, timeoutMs = 90000): Promise<DbSnapshot | null> {
  let latest: DbSnapshot | null = null
  const terminal = new Set(['waiting_user', 'failed', 'cancelled', 'paused', 'recovery_required'])
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (mock.requests.filter((item) => item.kind === 'draft').length >= requiredDrafts) {
      try { latest = readDb(userData) } catch { /* final run row may be one tick behind */ }
      return latest
    }
    try {
      latest = readDb(userData)
      if (latest.run && terminal.has(latest.run.status)) return latest
    } catch {
      // The app may still be creating/migrating the database; continue polling.
    }
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  return latest
}

function tableExists(db: DatabaseSync, table: string): boolean {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table))
}

function readDb(userData: string): DbSnapshot {
  const dbPath = path.join(userData, 'deepwriter.db')
  if (!fs.existsSync(dbPath)) throw new Error(`database missing: ${dbPath}`)
  const db = new DatabaseSync(dbPath)
  try {
    const run = db.prepare('SELECT run_id,session_id,status,error_code,config_json FROM runs ORDER BY started_at DESC LIMIT 1').get() as DbSnapshot['run']
    const latestGrillRow = tableExists(db, 'grill_me_sessions')
      ? db.prepare('SELECT state_json FROM grill_me_sessions ORDER BY updated_at DESC LIMIT 1').get() as { state_json?: string } | undefined
      : undefined
    let latestGrillState: Record<string, unknown> | null = null
    try { latestGrillState = latestGrillRow?.state_json ? JSON.parse(latestGrillRow.state_json) as Record<string, unknown> : null } catch { latestGrillState = null }
    // Grill Me interview cancellation is a durable planning state, not an
    // AgentRunEngine `runs` row. Keep it observable even before any正文 run
    // exists; otherwise a real cancelled state would be misreported as null.
    if (!run) return { run: null, config: null, assistantTurns: [], canonical: '', providerAttempts: [], usage: [], evaluations: [], workflowEvents: [], artifacts: [], grillState: latestGrillState }
    let config: Record<string, unknown> | null = null
    try { config = JSON.parse(run.config_json) as Record<string, unknown> } catch { config = null }
    const assistantTurns = (db.prepare("SELECT content FROM turns WHERE run_id=? AND role='assistant' ORDER BY turn_seq").all(run.run_id) as Array<{ content: string }>).map((row) => row.content)
    const canonical = (db.prepare("SELECT content FROM session_messages WHERE session_id=? AND role='assistant' ORDER BY seq DESC LIMIT 1").get(run.session_id) as { content?: string } | undefined)?.content ?? ''
    const providerAttempts = tableExists(db, 'provider_call_attempts')
      ? db.prepare('SELECT outcome,actor,stage_id,model_id FROM provider_call_attempts WHERE run_id=? ORDER BY started_at,attempt_no').all(run.run_id) as DbSnapshot['providerAttempts']
      : []
    const usage = tableExists(db, 'usage_log') ? db.prepare('SELECT call_type,input_tokens,output_tokens FROM usage_log WHERE run_id=? ORDER BY id').all(run.run_id) as DbSnapshot['usage'] : []
    const evaluations = tableExists(db, 'completion_evaluations') ? db.prepare('SELECT state,json FROM completion_evaluations WHERE run_id=? ORDER BY revision').all(run.run_id) as DbSnapshot['evaluations'] : []
    const workflowEvents = tableExists(db, 'workflow_events')
      ? (db.prepare('SELECT event_json FROM workflow_events WHERE run_id=? ORDER BY seq').all(run.run_id) as Array<{ event_json: string }>).flatMap((row) => { try { return [JSON.parse(row.event_json) as Record<string, unknown>] } catch { return [] } })
      : []
    const artifacts = tableExists(db, 'artifacts')
      ? db.prepare('SELECT artifact_id,artifact_type,display_name,relative_path,hash,char_count,status FROM artifacts WHERE run_id=? ORDER BY created_at').all(run.run_id) as DbSnapshot['artifacts']
      : []
    const grillRow = tableExists(db, 'grill_me_sessions') ? db.prepare('SELECT state_json FROM grill_me_sessions WHERE session_id=?').get(run.session_id) as { state_json?: string } | undefined : undefined
    let grillState: Record<string, unknown> | null = null
    try { grillState = grillRow?.state_json ? JSON.parse(grillRow.state_json) as Record<string, unknown> : null } catch { grillState = null }
    return { run, config, assistantTurns, canonical, providerAttempts, usage, evaluations, workflowEvents, artifacts, grillState }
  } finally {
    db.close()
  }
}

async function readActivityJournal(userData: string): Promise<string> {
  const root = path.join(userData, 'runs', 'runs')
  if (!fs.existsSync(root)) return ''
  const entries = await fsp.readdir(root, { withFileTypes: true })
  const texts: string[] = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const events = path.join(root, entry.name, 'events.jsonl')
    if (fs.existsSync(events)) texts.push(await fsp.readFile(events, 'utf8'))
  }
  return texts.join('\n')
}

function configGrillStateId(snapshot: DbSnapshot | null): string | null {
  const grill = snapshot?.config?.grillMe
  return grill && typeof grill === 'object' && typeof (grill as { stateId?: unknown }).stateId === 'string'
    ? (grill as { stateId: string }).stateId
    : null
}

function hasWritingPhase(snapshot: DbSnapshot | null): boolean {
  return Boolean(snapshot?.workflowEvents.some((event) =>
    event.type === 'phase.changed' && ['thinking', 'writing', 'validating'].includes(String(event.phase))))
}

function readCommittedSceneProgression(userData: string, runId: string): Array<Record<string, unknown>> {
  const sqlite = new DatabaseSync(path.join(userData, 'deepwriter.db'))
  try {
    const rows = sqlite.prepare(`SELECT s.scene_id,s.scene_order,s.lifecycle,s.contract_id,s.contract_hash,s.accepted_segment_id,s.accepted_hash,
      s.completion_decision_json,s.completion_evidence_hash,n.accepted_content_hash,n.contract_hash AS commit_contract_hash,n.accepted_segment_id AS commit_segment_id,
      m.content,m.content_hash,m.char_count,m.status AS segment_status
      FROM scene_states s JOIN narrative_commits n ON n.run_id=s.run_id AND n.scene_id=s.scene_id
      JOIN manuscript_segments m ON m.run_id=s.run_id AND m.segment_id=s.accepted_segment_id
      WHERE s.run_id=? ORDER BY s.scene_order`).all(runId) as Array<Record<string, unknown>>
    return rows.map(row => {
      const decision = JSON.parse(String(row.completion_decision_json))
      const content = String(row.content)
      return {
        sceneId: row.scene_id, order: row.scene_order, lifecycle: row.lifecycle, contractId: row.contract_id, contractHash: row.contract_hash,
        acceptedChars: row.char_count, acceptedSegmentId: row.accepted_segment_id, acceptedHash: row.accepted_hash,
        completionStatus: decision.status,
        bound: row.segment_status === 'accepted' && row.accepted_segment_id === row.commit_segment_id && row.accepted_hash === row.accepted_content_hash && row.accepted_hash === row.content_hash && row.accepted_hash === createHash('sha256').update(content, 'utf8').digest('hex') && row.char_count === cpLen(content) && row.contract_hash === row.commit_contract_hash && decision.contractHash === row.contract_hash && decision.candidateHash === row.accepted_hash && decision.candidateSegmentId === row.accepted_segment_id && decision.evidenceHash === row.completion_evidence_hash
      }
    })
  } finally { sqlite.close() }
}

async function waitForGrillRun(userData: string, stateId: string, timeoutMs = 30000): Promise<DbSnapshot | null> {
  let latest: DbSnapshot | null = null
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      latest = readDb(userData)
      if (latest.run && configGrillStateId(latest) === stateId) return latest
    } catch { /* the app may still be creating the run row */ }
    await new Promise((resolve) => setTimeout(resolve, 150))
  }
  return latest
}

/** Wait for a real writer response, not merely an HTTP request being accepted. */
async function waitForWriterSuccess(userData: string, stateId: string, timeoutMs = 60000): Promise<DbSnapshot | null> {
  let latest: DbSnapshot | null = null
  const deadline = Date.now() + timeoutMs
  const rejected = new Set(['queued', 'waiting_user', 'failed', 'cancelled', 'paused', 'recovery_required'])
  while (Date.now() < deadline) {
    try {
      latest = readDb(userData)
      const status = latest.run?.status ?? ''
      const writerSuccess = latest.providerAttempts.some((attempt) => attempt.actor === 'writer' && attempt.outcome === 'success')
      const assistantContent = latest.assistantTurns.join('')
      const enteredWriting = hasWritingPhase(latest)
      if (latest.run && configGrillStateId(latest) === stateId && !rejected.has(status) && writerSuccess && (assistantContent.length > 0 || enteredWriting)) return latest
      // Return a bad terminal state promptly so the acceptance checks report the
      // actual failure instead of turning it into a generic timeout.
      if (latest.run && configGrillStateId(latest) === stateId && rejected.has(status)) return latest
    } catch { /* the run/turn may be between SQLite transactions */ }
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
  return latest
}

async function runHScenario(): Promise<{ checks: Check[]; requests: RequestLog[]; evidencePath: string }> {
  const checks: Check[] = []
  const scenarioDir = await fsp.mkdtemp(path.join(EVIDENCE_ROOT, 'h-'))
  const userData = await fsp.mkdtemp(path.join(scenarioDir, 'user-data-'))
  const mock = await startMock('H')
  const diagnostics: string[] = []
  const expectBlocked = hExpectationArg === 'blocked'
  let app: ElectronApplication | null = null
  let page: Page | null = null
  let db: DbSnapshot | null = null
  let preTeardownDb: DbSnapshot | null = null
  let finalDb: DbSnapshot | null = null
  let stateId = ''
  let providerCaps: ProviderCaps = { contextWindow: null, modelMaxOutputTokens: null, profileMaxOutputTokens: null }
  const bindDiagnostics = (target: Page): void => {
    target.on('console', (message) => {
      const text = message.text()
      if (message.type() === 'error' || /chat:start|send\]|error|失败|拒绝/i.test(text)) diagnostics.push(`console:${message.type()}:${text}`)
    })
    target.on('pageerror', (error) => diagnostics.push(`pageerror:${error.message}`))
    target.on('requestfailed', (request) => diagnostics.push(`requestfailed:${request.url()}:${request.failure()?.errorText ?? 'unknown'}`))
  }

  try {
    // Bootstrap the exact package once, then mutate only the isolated DB. H
    // deliberately preserves NULL model capability columns and sets the
    // profile reserve to 65536, matching the production failure shape.
    app = (await launch(executablePath, userData)).app
    page = await app.firstWindow()
    bindDiagnostics(page)
    await configure(page, mock.port, 200000, path.join(scenarioDir, 'documents'))
    const bootstrapExit = await quit(app)
    check(checks, 'H：bootstrap Electron 自然退出', bootstrapExit === 0, `exit=${bootstrapExit}`)
    await app.close().catch(() => undefined)
    app = null
    page = null
    setFixtureDocDir(userData, path.join(scenarioDir, 'documents'))
    redirectBuiltInRegistry(userData, mock.port, false)
    providerCaps = readProviderCaps(userData)
    check(checks, 'H：fixture 保留 provider_models NULL 能力且 profile maxOutput=65536', providerCaps.contextWindow === null && providerCaps.modelMaxOutputTokens === null && providerCaps.profileMaxOutputTokens === 65536, JSON.stringify(providerCaps))

    // App 1 completes the real Grill flow and confirms its outline without
    // starting a run. This proves the next process must recover durable state,
    // rather than accidentally using a fresh in-memory interview.
    app = (await launch(executablePath, userData)).app
    page = await app.firstWindow()
    bindDiagnostics(page)
    await configure(page, mock.port, 200000, path.join(scenarioDir, 'documents'))
    check(checks, 'H：真实打包 renderer 已加载', page.url().includes('app.asar') || page.url().includes('out/renderer'), page.url())
    await chooseLongformEntry(page)
    await startInterview(page, mock)
    await completeInterview(page, mock, checks)
    await prepareOutline(page, mock, checks, 'H', false)
    const confirmed = await page.evaluate(async () => {
      const ds = (window as any).ds
      const state = await ds?.grillLatestUnconsumed?.()
      if (!state || state.status !== 'awaiting_outline_confirmation' || typeof state.outlineHash !== 'string') throw new Error(`outline state not confirmable: ${JSON.stringify(state)}`)
      return await ds.grillOutlineConfirm(state.sessionId, state.outlineHash)
    }) as { stateId?: string; sessionId?: string; status?: string; approvedOutline?: unknown }
    stateId = typeof confirmed.stateId === 'string' ? confirmed.stateId : ''
    db = readDb(userData)
    check(checks, 'H：App 1 真实确认后持久化 confirmed Grill 状态', confirmed.status === 'confirmed' && Boolean(stateId) && db.grillState?.status === 'confirmed', JSON.stringify({ stateId, status: confirmed.status, durableStatus: db.grillState?.status }))
    check(checks, 'H：确认阶段尚未创建正文 run', db.run === null, JSON.stringify(db.run))
    const firstProcessExit = await quit(app)
    check(checks, 'H：确认态进程自然退出', firstProcessExit === 0, `exit=${firstProcessExit}`)
    await app.close().catch(() => undefined)
    app = null
    page = null

    // App 2 must recover the same confirmed state, then exercise the actual
    // renderer -> context preview -> chat:start -> AgentRunEngine handoff.
    app = (await launch(executablePath, userData)).app
    page = await app.firstWindow()
    bindDiagnostics(page)
    await configure(page, mock.port, 200000, path.join(scenarioDir, 'documents'))
    // A confirmed Grill state can restore the novel workspace during startup;
    // clicking the Long-form nav again would hide the workbench and create a
    // false restart failure. Only navigate when the restored workbench is not
    // already visible.
    const restoredWorkbench = page.locator('[aria-label="长文写作梳理"]')
    // Give the startup restore effect a chance before navigating. If the app
    // starts in the default chat workspace, enter Long once and wait for the
    // durable workbench itself (not the transient novel input) to appear.
    await page.waitForFunction(() => {
      const element = document.querySelector('[aria-label="长文写作梳理"]') as HTMLElement | null
      return Boolean(element && element.offsetParent !== null)
    }, undefined, { timeout: 3000 }).catch(() => undefined)
    if (!(await restoredWorkbench.isVisible().catch(() => false))) {
      await page.locator('.dw-global-nav button').filter({ hasText: '长文' }).first().click()
      await restoredWorkbench.waitFor({ state: 'visible', timeout: 20000 })
    }
    const workbench = page.locator('[aria-label="长文写作梳理"]')
    await workbench.waitFor({ state: 'visible', timeout: 20000 })
    await page.locator('[data-phase="confirmed"]').waitFor({ state: 'visible', timeout: 20000 })
    const recoveredText = await workbench.innerText()
    const recovered = await page.evaluate(async () => await (window as any).ds?.grillLatestUnconsumed?.()) as { stateId?: string; status?: string; approvedOutline?: unknown } | null
    check(checks, 'H：重启后恢复同一 confirmed Grill 状态', recovered?.stateId === stateId && recovered?.status === 'confirmed' && /大纲已确认，可以开始写作/.test(recoveredText), JSON.stringify({ expected: stateId, recovered: recovered?.stateId, status: recovered?.status, text: recoveredText.slice(0, 180) }))

    if (expectBlocked) {
      const beforeDrafts = mock.requests.filter((item) => item.kind === 'draft').length
      await page.getByRole('button', { name: '开始写作', exact: true }).click()
      await page.locator('.grill-me-start-error').waitFor({ state: 'visible', timeout: 15000 }).catch(() => undefined)
      await page.waitForTimeout(1000)
      db = readDb(userData)
      const startError = await page.locator('.grill-me-start-error').innerText().catch(() => '')
      check(checks, 'H-old：能力未知时在 chat:start 前阻断正文启动', /正文启动失败/.test(startError) && mock.requests.filter((item) => item.kind === 'draft').length === beforeDrafts && db.run === null, JSON.stringify({ startError, drafts: mock.requests.filter((item) => item.kind === 'draft').length - beforeDrafts, run: db.run }))
      check(checks, 'H-old：阻断后 confirmed 大纲仍保留可重试', db.grillState?.status === 'confirmed' && await workbench.isVisible().catch(() => false), JSON.stringify({ status: db.grillState?.status, visible: await workbench.isVisible().catch(() => false) }))
    } else {
      const startAt = mock.mark('hStartClick')
      await page.getByRole('button', { name: '开始写作', exact: true }).click()
      const handoff = await waitForGrillRun(userData, stateId, 30000)
      db = handoff
      check(checks, 'H：开始写作获得真实 chat:start/run handoff', Boolean(handoff?.run && configGrillStateId(handoff) === stateId), JSON.stringify({ run: handoff?.run?.run_id ?? null, status: handoff?.run?.status ?? null, stateId: configGrillStateId(handoff) }))
      await waitForMock(mock, () => mock.requests.filter((item) => item.kind === 'draft').length >= 1, 30000)
      const firstDraft = mock.requests.find((item) => item.kind === 'draft')
      // Observe the visible active workflow while the deliberately slowed H
      // stream is still in flight; a request count alone is not a UI success.
      await page.waitForFunction(() => {
        const row = document.querySelector('.dw-activity-rail .dw-task-run')
        const text = row?.textContent ?? ''
        return Boolean(row) && /正在写作|生成内容|正在检查结果|模型思考中|审校/.test(text) && !/失败|已取消|等待你的确认/.test(text)
      }, undefined, { timeout: 15000 }).catch(() => undefined)
      const activeRow = page.locator('.dw-activity-rail .dw-task-run').first()
      const activeText = await activeRow.innerText().catch(() => '')
      const assistant = page.locator('.msg.assistant:visible').last()
      const assistantText = await assistant.innerText().catch(() => '')
      check(checks, 'H：正文启动后 Activity Rail 显示真实活动阶段', await activeRow.count() > 0 && /正在写作|生成内容|正在检查结果|模型思考中|审校/.test(activeText) && !/失败|已取消|等待你的确认/.test(activeText), activeText)
      check(checks, 'H：正文启动后主区出现可见 assistant 运行消息', await assistant.count() > 0 && /正在|生成|思考|正文/.test(assistantText), assistantText.slice(0, 260))
      const generated = await waitForWriterSuccess(userData, stateId, 60000)
      preTeardownDb = generated
      db = generated
      const status = generated?.run?.status ?? ''
      const writerSuccess = generated?.providerAttempts.some((attempt) => attempt.actor === 'writer' && attempt.outcome === 'success') ?? false
      const assistantContent = generated?.assistantTurns.join('') ?? ''
      check(checks, 'H：拒绝 queued/waiting/failed/cancelled，且真实 writer provider attempt 成功', Boolean(generated?.run && configGrillStateId(generated) === stateId && ['running', 'completed'].includes(status) && writerSuccess), JSON.stringify({ status, writerSuccess, runId: generated?.run?.run_id ?? null, phase: hasWritingPhase(generated) }))
      check(checks, 'H：首个 SSE 完整结束且 assistant 已有正文内容或明确 writing 阶段', Boolean(firstDraft?.sseCompleted && firstDraft.completedAt && (assistantContent.length > 0 || hasWritingPhase(generated))), JSON.stringify({ sseCompleted: firstDraft?.sseCompleted, completedAt: firstDraft?.completedAt, assistantChars: cpLen(assistantContent), writingPhase: hasWritingPhase(generated) }))
      check(checks, 'H：首个正文请求发生在重启后开始写作点击之后', (firstDraft?.receivedAt ?? 0) >= startAt, JSON.stringify({ firstDraft: firstDraft?.receivedAt, startAt }))
      check(checks, 'H：成功 handoff 没有错误字段', generated?.run?.error_code === null, JSON.stringify(generated?.run ?? null))
    }
  } catch (error) {
    if (!db) {
      try { db = readDb(userData) } catch { /* database may not exist yet */ }
    }
    const body = page ? await page.locator('body').innerText().catch(() => '') : ''
    if (body) diagnostics.push(`body:${body.slice(-1800)}`)
    check(checks, `H${expectBlocked ? '-old' : ''}：harness 没有异常`, false, `${error instanceof Error ? error.message : String(error)}${diagnostics.length ? ` | ${diagnostics.slice(-4).join(' || ')}` : ''}`)
  } finally {
    const exit = await quit(app)
    check(checks, `H${expectBlocked ? '-old' : ''}：最终 Electron 自然退出`, exit === 0, `exit=${exit}`)
    if (app) await app.close().catch(() => undefined)
    try { finalDb = readDb(userData) } catch { /* keep the latest snapshot */ }
    if (!db) db = finalDb
    await new Promise<void>((resolve) => mock.server.close(() => resolve()))
  }

  const drafts = mock.requests.filter((item) => item.kind === 'draft')
  const unknown = mock.requests.filter((item) => item.kind === 'unknown')
  check(checks, `H${expectBlocked ? '-old' : ''}：provider 请求全部来自本地 SSE`, mock.requests.length > 0 && mock.requests.every((item) => item.path.endsWith('/chat/completions')), `requests=${mock.requests.length}`)
  check(checks, `H${expectBlocked ? '-old' : ''}：没有未知 provider 阶段`, unknown.length === 0, unknown.map((item) => item.id).join(',') || 'none')
  if (!exeArg) {
    const expectedPrefix = `dist-${packageLabelArg}-`
    check(checks, `H：使用独立 fresh ${packageLabelArg} 制品`, packageManifest?.mode === 'fresh' && packageManifest.outputDir.includes(expectedPrefix) && packageManifest.packageHead === packageManifest.head && Boolean(packageManifest.appAsarSha256) && Boolean(packageManifest.exeSha256) && Boolean(packageManifest.sourceSha256), JSON.stringify(packageManifest))
  }
  if (!expectBlocked) {
    check(checks, 'H：provider draft 记录包含完整 SSE 结束标记', drafts.length >= 1 && drafts[0].sseCompleted === true && drafts[0].completedAt !== null, JSON.stringify(drafts.slice(0, 1)))
  }
  const result = { scenario: 'H', expectation: expectBlocked ? 'blocked' : 'success', executablePath, packageManifest, userData, providerCaps, stateId, requests: mock.requests, preTeardownDb, finalDb, db, diagnostics, checks, passed: checks.filter((item) => item.ok).length, failed: checks.filter((item) => !item.ok).length }
  const evidencePath = path.join(scenarioDir, 'result.json')
  await fsp.writeFile(evidencePath, `${JSON.stringify(result, null, 2)}\n`, 'utf8')
  console.log(`R47-H${expectBlocked ? '-old' : ''}: ${result.passed} PASS / ${result.failed} FAIL`)
  console.log(`evidence: ${evidencePath}`)
  return { checks, requests: mock.requests, evidencePath }
}

function distinctSegmentCheck(segments: string[]): boolean {
  const hashes = new Set(segments)
  if (hashes.size !== segments.length) return false
  for (let i = 1; i < segments.length; i += 1) {
    const previous = new Set(Array.from(segments[i - 1]).map((_, index, points) => index + 8 <= points.length ? points.slice(index, index + 8).join('') : '').filter(Boolean))
    const current = Array.from(segments[i])
    let repeated = 0
    let total = 0
    for (let index = 0; index + 8 <= current.length; index += 1) {
      total += 1
      if (previous.has(current.slice(index, index + 8).join(''))) repeated += 1
    }
    if (total > 0 && repeated / total >= 0.85) return false
  }
  return true
}

function requestOrder(requests: RequestLog[]): string {
  return requests.map((item) => item.kind).join(' → ')
}

async function quit(app: ElectronApplication | null): Promise<number> {
  if (!app) return 0
  try {
    await closeElectronGracefully(app, { profile: appProfiles.get(app) ?? '', diagnosticsDir: EVIDENCE_ROOT })
    return 0
  } catch {
    // The shared guard records the captured PID, timeout/forced cleanup and
    // throws. Never turn that cleanup into a successful acceptance exit.
    return 255
  }
}

async function launch(executable: string, userData: string): Promise<{ app: ElectronApplication; page: Page }> {
  const app = await electron.launch({ executablePath: executable, args: [...(sourceModeArg ? [ROOT] : []), `--user-data-dir=${userData}`], env: { ...process.env, NODE_ENV: 'test', DW_TEST_USERDATA: userData } })
  appProfiles.set(app, userData)
  try {
    const page = await app.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    await page.waitForSelector('.composer', { timeout: 20000 })
    if (!page.url().includes('app.asar') && !page.url().includes('out/renderer')) throw new Error(`not a packaged renderer: ${page.url()}`)
    return { app, page }
  } catch (error) {
    await quit(app)
    throw error
  }
}

/** Explicit fault injection, never the shutdown helper or a natural-exit PASS. */
async function crashOwnedPendingReview(app: ElectronApplication, userData: string, scenarioDir: string): Promise<void> {
  const child = app.process()
  const pid = child.pid
  if (!Number.isSafeInteger(pid) || (pid ?? 0) <= 0 || appProfiles.get(app) !== userData || path.dirname(userData) !== scenarioDir || !scenarioDir.startsWith(EVIDENCE_ROOT + path.sep) || child.exitCode !== null || child.signalCode !== null) throw new Error('owned isolated crash target is not valid')
  await fsp.writeFile(path.join(scenarioDir, 'expected-forced-crash.json'), JSON.stringify({ kind: 'expected_forced_crash', pid, userData, executablePath, sourceSha256: packageManifest?.sourceSha256, countsAsNaturalShutdown: false }, null, 2), 'utf8')
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const exited = new Promise<void>(resolve => child.once('exit', () => resolve()))
    console.log(`[expected forced crash] owned isolated Electron PID ${pid}; not a Gate5 natural exit`)
    if (process.platform === 'win32') await execFile('taskkill', ['/F', '/T', '/PID', String(pid)])
    else child.kill('SIGKILL')
    await Promise.race([exited, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('expected forced crash did not terminate captured PID')), 10000) })])
    await app.close().catch(() => undefined)
  } finally { clearTimeout(timer) }
}

async function runScenario(scenario: Scenario): Promise<{ checks: Check[]; requests: RequestLog[]; evidencePath: string }> {
  const checks: Check[] = []
  const scenarioDir = await fsp.mkdtemp(path.join(EVIDENCE_ROOT, `${scenario.toLowerCase()}-`))
  const userData = await fsp.mkdtemp(path.join(scenarioDir, 'user-data-'))
  const mock = await startMock(scenario)
  const diagnostics: string[] = []
  let app: ElectronApplication | null = null
  let page: Page | null = null
  let db: DbSnapshot | null = null
  let budgetWaitingSnapshot: DbSnapshot | null = null
  let eAction: EActionObservation | null = null
  let providerCaps: ProviderCaps = { contextWindow: null, modelMaxOutputTokens: null, profileMaxOutputTokens: null }
  let uiText = ''
  try {
    app = (await launch(executablePath, userData)).app
    page = await app.firstWindow()
    page.on('console', (message) => {
      const text = message.text()
      if (message.type() === 'error' || /chat:start|send\]|error|失败|拒绝/i.test(text)) diagnostics.push(`console:${message.type()}:${text}`)
    })
    page.on('pageerror', (error) => diagnostics.push(`pageerror:${error.message}`))
    page.on('requestfailed', (request) => diagnostics.push(`requestfailed:${request.url()}:${request.failure()?.errorText ?? 'unknown'}`))
      // Keep Grill interview/planning out of the completion-budget probe.  For
      // E the low budget is applied only after the outline is ready, immediately
      // before the confirmed正文 chat:start snapshot is created.
      await configure(page, mock.port, 200000, path.join(scenarioDir, 'documents'))
    // The first launch creates the isolated DB.  Close it before redirecting
    // the built-in registry so the final tested process loads the loopback
    // profile from disk rather than retaining an in-memory pre-redirect copy.
    const bootstrapExit = await quit(app)
    if (bootstrapExit !== 0) throw new Error(`bootstrap packaged process did not exit naturally: ${bootstrapExit}`)
    await app.close().catch(() => undefined)
    app = null
    page = null
    setFixtureDocDir(userData, path.join(scenarioDir, 'documents'))
    // Grill interview/planning resolve the durable Provider Registry profile,
    // while chat uses the legacy settings seam.  Redirect only this isolated
    // test DB's built-in profile to the local loopback SSE server; no production
    // file or provider is changed.
    redirectBuiltInRegistry(userData, mock.port)
    providerCaps = readProviderCaps(userData)
    app = (await launch(executablePath, userData)).app
    page = await app.firstWindow()
    await page.setViewportSize({ width: 1280, height: 900 })
    app.process().stderr?.on('data', (chunk: Buffer) => {
      for (const line of chunk.toString().split(/\r?\n/u)) {
        if (/^\[ipc\] |^Error occurred in handler for 'chat:start':|^\s+code: /u.test(line)) diagnostics.push(`main:${String(sanitizeDiagnosticValue(line))}`)
      }
    })
    page.on('console', (message) => {
      const text = message.text()
      if (message.type() === 'error' || /chat:start|send\]|error|失败|拒绝/i.test(text)) diagnostics.push(`console:${message.type()}:${text}`)
    })
    page.on('pageerror', (error) => diagnostics.push(`pageerror:${error.message}`))
    page.on('requestfailed', (request) => diagnostics.push(`requestfailed:${request.url()}:${request.failure()?.errorText ?? 'unknown'}`))
    await configure(page, mock.port, scenario === 'E' ? 1 : 200000, path.join(scenarioDir, 'documents'))
    if (scenario === 'B' || scenario === 'D') {
      await configureSyntheticReferencePricing(page, mock.port, scenarioDir)
      check(checks, `${scenario}：正常 IPC 保存并回读本机 synthetic 正费率 CNY 用户参考价`, true)
    }
    check(checks, sourceModeArg ? 'source-local 真实 renderer 已加载（不是发行包）' : '真实打包 renderer 已加载', sourceModeArg ? page.url().includes('out/renderer') && !page.url().includes('app.asar') : page.url().includes('app.asar'), page.url())
    await chooseLongformEntry(page)
    check(checks, '真实点击长文起稿输入与目标契约', await page.getByRole('textbox', { name: '剧情简介与硬性要求', exact: true }).isVisible() && await page.getByRole('spinbutton', { name: '长文目标篇幅', exact: true }).isVisible())
    await startInterview(page, mock)
    if (scenario === 'B' || scenario === 'D') await captureCommercialStage(page, scenario, 'interview')
    await page.screenshot({ path: path.join(EVIDENCE_ROOT, `commercial-${scenario}-interview-${commercialEvidencePhase()}.png`), animations: 'disabled' })

    if (scenario === 'A') {
      await answerOneInterview(page, mock, 1)
      await answerOneInterview(page, mock, 2)
      check(checks, 'A：未完成三轮采访时 planning=0', mock.requests.filter((item) => item.kind === 'planning').length === 0, requestOrder(mock.requests))
      check(checks, 'A：未完成三轮采访时 draft=0', mock.requests.filter((item) => item.kind === 'draft').length === 0, requestOrder(mock.requests))
      check(checks, 'A：未完成三轮采访时仍显示单个问题', await page.locator('[data-testid="grill-interview-stage"]').isVisible().catch(() => false))
      await answerOneInterview(page, mock, 3)
      await page.getByRole('button', { name: '接受默认值', exact: true }).waitFor({ state: 'visible', timeout: 10000 })
      check(checks, 'A：模型提前 ready 先进入默认值审阅', await page.locator('[data-testid="grill-assumption-stage"]').isVisible().catch(() => false), requestOrder(mock.requests))
      check(checks, 'A：默认值尚未确认时 planning/draft 仍为零', mock.requests.filter((item) => item.kind === 'planning').length === 0 && mock.requests.filter((item) => item.kind === 'draft').length === 0, requestOrder(mock.requests))
      const rejectBefore = mock.requests.filter((item) => item.kind === 'interview').length
      await page.getByRole('button', { name: '继续补充', exact: true }).click()
      await page.locator('[data-testid="grill-interview-stage"]').waitFor({ state: 'visible', timeout: 20000 })
      await waitForMock(mock, () => mock.requests.filter((item) => item.kind === 'interview').length > rejectBefore, 20000)
      check(checks, 'A：拒绝默认值后继续单问', await page.locator('[data-testid="grill-interview-stage"]').isVisible().catch(() => false) && mock.requests.filter((item) => item.kind === 'interview').length > rejectBefore, requestOrder(mock.requests))
      await page.getByRole('button', { name: '退出梳理', exact: true }).click().catch(() => undefined)
    } else {
      await completeInterview(page, mock, checks)
      if (scenario === 'E') {
        await page.evaluate(async () => {
          const ds = (window as any).ds
          const current = await ds.getSettings()
          await ds.setSettings({ ...current, completionTokenBudget: 1 })
        })
      }
      const confirmAt = await confirmOutlineAndStart(page, mock, checks, scenario)
      check(checks, `${scenario}：首个正文请求发生在大纲确认后`, (mock.requests.find((item) => item.kind === 'draft')?.receivedAt ?? 0) >= confirmAt, requestOrder(mock.requests))
      const expectedStatus = scenario === 'E' ? ['waiting_user'] : scenario === 'F' ? ['failed', 'waiting_user', 'paused', 'recovery_required', 'completed'] : scenario === 'G' ? ['queued', 'running', 'completed', 'waiting_user'] : ['completed']
      if (scenario === 'E') {
        await waitForMock(mock, () => mock.requests.filter((item) => item.kind === 'draft').length >= 1, 30000)
        db = await waitForDbStatus(userData, expectedStatus, 30000)
        const beforeAction = db ?? readDb(userData)
        budgetWaitingSnapshot = beforeAction
        const beforeDrafts = mock.requests.filter((item) => item.kind === 'draft').length
        // The durable waiting_user write and the renderer ActivityBus event
        // are separate commits.  Give the packaged renderer one tick to render
        // the actionable paused state before inspecting buttons.
        await page.waitForTimeout(750)
        const actionButtons = await page.locator('button:visible').evaluateAll((buttons) => buttons.map((button) => {
          const item = button as HTMLButtonElement
          return { text: (item.innerText || item.textContent || '').trim(), disabled: item.disabled }
        }))
        const enabledActions = actionButtons.filter((item) => !item.disabled)
        check(checks, 'E：waiting_user 暴露可操作的继续与停止', enabledActions.some((item) => /继续/.test(item.text)) && enabledActions.some((item) => /停止/.test(item.text)), JSON.stringify(enabledActions.filter((item) => /继续|停止/.test(item.text))))

        // A label alone is not an acceptance criterion.  Enter the real run
        // inspector through the recovery banner, edit the budget and confirm,
        // then observe an actual
        // continuation request or a real settings surface.  A close+toast
        // implementation must remain red.  The original partial and Grill Me
        // provenance must survive the action.
        let budgetInputSeen = false
        let continuationRunObserved = false
        let budgetExtensionObserved = false
        let partialPrefixRetained = false
        let provenanceRetained = false
        const recoverButton = page.locator('button.dw-recover-name').first()
        const bannerContinue = page.getByRole('button', { name: '继续', exact: true }).first()
        const directContinue = page.getByRole('button', { name: '继续写作', exact: true }).first()
        const activityContinue = page.locator('button.activity-continue').first()
        const continueButton = page.getByRole('button', { name: '继续写作（调整预算）', exact: true }).first()
        const actionButton = (await activityContinue.count() > 0 && await activityContinue.isVisible().catch(() => false))
          ? activityContinue
          : (await directContinue.count() > 0 && await directContinue.isVisible().catch(() => false))
            ? directContinue
            : (await bannerContinue.count() > 0 && await bannerContinue.isVisible().catch(() => false))
              ? bannerContinue
              : continueButton
        if (await actionButton.count() > 0 && await actionButton.isVisible().catch(() => false)) {
            await actionButton.click()
            const budgetInput = page.getByTestId('budget-continue-input')
            await budgetInput.waitFor({ state: 'visible', timeout: 10000 }).then(() => { budgetInputSeen = true }).catch(() => undefined)
            if (budgetInputSeen) {
              await budgetInput.fill('20001')
              await page.getByTestId('budget-continue-confirm').click()
            }
            await waitForMock(mock, () => mock.requests.filter((item) => item.kind === 'draft').length > beforeDrafts, 30000).catch(() => undefined)
            continuationRunObserved = mock.requests.filter((item) => item.kind === 'draft').length > beforeDrafts
            const afterAction = (() => { try { return readDb(userData) } catch { return null } })()
            if (afterAction) {
              const beforeText = beforeAction.assistantTurns.join('')
              const afterText = afterAction.assistantTurns.join('')
              partialPrefixRetained = beforeText.length > 0 && afterText.startsWith(beforeText)
              const beforeOutline = JSON.stringify(beforeAction.grillState?.approvedOutline ?? beforeAction.grillState?.outline ?? null)
              const afterOutline = JSON.stringify(afterAction.grillState?.approvedOutline ?? afterAction.grillState?.outline ?? null)
              provenanceRetained = beforeOutline !== 'null' && beforeOutline === afterOutline
              const contract = afterAction.config?.completionContract as { tokenBudget?: unknown } | undefined
              budgetExtensionObserved = afterAction.config?.budgetExtensions instanceof Array && afterAction.config.budgetExtensions.length > 0 && typeof contract?.tokenBudget === 'number' && contract.tokenBudget > 1
            }
        } else if (await recoverButton.count() > 0) {
          // Fallback for a recovery banner that is present but has not yet
          // rendered its inline action: open the inspector and use its
          // durable budget-extension action.
          await recoverButton.click()
          const inspector = page.locator('.run-inspector')
          await inspector.waitFor({ state: 'visible', timeout: 10000 }).catch(() => undefined)
          if (await continueButton.count() > 0 && await continueButton.isVisible().catch(() => false)) {
            await continueButton.click()
            const budgetInput = page.getByTestId('budget-continue-input')
            await budgetInput.waitFor({ state: 'visible', timeout: 10000 }).then(() => { budgetInputSeen = true }).catch(() => undefined)
            if (budgetInputSeen) {
              await budgetInput.fill('20001')
              await page.getByTestId('budget-continue-confirm').click()
            }
            await waitForMock(mock, () => mock.requests.filter((item) => item.kind === 'draft').length > beforeDrafts, 30000).catch(() => undefined)
            continuationRunObserved = mock.requests.filter((item) => item.kind === 'draft').length > beforeDrafts
          }
        }
        eAction = { beforeDrafts, afterDrafts: mock.requests.filter((item) => item.kind === 'draft').length, budgetInputSeen, continuationRunObserved, budgetExtensionObserved, partialPrefixRetained, provenanceRetained }
        check(checks, 'E：继续动作产生真实预算设置/续写状态变化（不是关闭+提示）', budgetInputSeen && continuationRunObserved && budgetExtensionObserved, JSON.stringify(eAction))
        check(checks, 'E：继续动作保留 partial 正文与 Grill Me provenance', partialPrefixRetained && provenanceRetained, JSON.stringify(eAction))
      } else if (scenario === 'F') {
        await waitForMock(mock, () => mock.requests.filter((item) => item.kind === 'draft').length >= 1, 30000)
        db = await waitForDbStatus(userData, expectedStatus, 60000)
      } else if (scenario === 'G') {
        // R50 only needs to prove the repaired outline crosses the real
        // chat:start boundary and reaches the first writer request. Do not
        // spend time completing the full 8,000-character synthetic run here.
        await waitForMock(mock, () => mock.requests.filter((item) => item.kind === 'draft').length >= 1, 30000)
        db = await waitForDbStatus(userData, expectedStatus, 30000)
      } else if (scenario === 'B') {
        if (reviewCrashArg) {
          const pendingDb = await waitForDbStatus(userData, 'waiting_user', 90000)
          if (pendingDb.run?.error_code !== 'narrative_state_pending_review' || !app) throw new Error('crash requires actual semantic pending review')
          const runId = pendingDb.run.run_id
          const before = await page.evaluate(async id => (window as any).ds.runsNarrativeReview(id), runId)
          if (!before.ok || before.review?.status !== 'pending_review') throw new Error('actual pending packet unavailable before crash')
          await page.getByRole('button', { name: /^接受正文，不写入状态/u }).last().waitFor({ state: 'visible', timeout: 10000 })
          await page.screenshot({ path: path.join(EVIDENCE_ROOT, `commercial-B-before-pending-crash-${commercialEvidencePhase()}.png`), animations: 'disabled' })
          const frozenConfigHash = createHash('sha256').update(pendingDb.run.config_json).digest('hex')
          const draftsBefore = mock.requests.filter(item => item.kind === 'draft').length
          await crashOwnedPendingReview(app, userData, scenarioDir)
          app = null; page = null
          const restored = await launch(executablePath, userData)
          app = restored.app; page = restored.page
          page.on('pageerror', error => diagnostics.push(`pageerror:${error.message}`))
          await page.setViewportSize({ width: 1280, height: 900 })
          const restoredAccept = page.getByRole('button', { name: /^接受正文，不写入状态/u }).last()
          // Startup may already present the durable review. Do not click a
          // navigation/banner behind that real modal or bypass its overlay.
          const autoPresented = await restoredAccept.waitFor({ state: 'visible', timeout: 5000 }).then(() => true, () => false)
          if (!autoPresented) {
            const recovery = page.locator('.dw-recover-items .recover-item').filter({ hasText: runId.slice(0, 8) })
            await recovery.getByRole('button', { name: '继续', exact: true }).click({ timeout: 15000 })
            await restoredAccept.waitFor({ state: 'visible', timeout: 10000 })
          }
          const after = await page.evaluate(async id => (window as any).ds.runsNarrativeReview(id), runId)
          const restoredDb = readDb(userData)
          const identityRetained = after.ok && after.review?.packetHash === before.review.packetHash && after.review.revision === before.review.revision && after.review.candidate.segmentId === before.review.candidate.segmentId && after.review.candidate.contentHash === before.review.candidate.contentHash && createHash('sha256').update(restoredDb.run?.config_json ?? '').digest('hex') === frozenConfigHash
          const pendingSqlite = new DatabaseSync(path.join(userData, 'deepwriter.db'))
          let stillCandidate = false
          try { stillCandidate = (pendingSqlite.prepare('SELECT status FROM manuscript_segments WHERE run_id=? AND segment_id=?').get(runId, before.review.candidate.segmentId) as { status?: string } | undefined)?.status === 'candidate' } finally { pendingSqlite.close() }
          check(checks, 'B crash：真实重启/恢复入口保留原冻结配置和 pending packet/revision/hash，未重写原段', identityRetained && draftsBefore === 1 && mock.requests.filter(item => item.kind === 'draft').length === draftsBefore && stillCandidate)
          if (!identityRetained) throw new Error('pending review restore changed frozen identity')
          await page.screenshot({ path: path.join(EVIDENCE_ROOT, `commercial-B-restored-pending-review-${commercialEvidencePhase()}.png`), animations: 'disabled' })
          mock.draftObservers.push(() => {
            const sqlite = new DatabaseSync(path.join(userData, 'deepwriter.db'))
            try {
              const candidate = sqlite.prepare('SELECT status,content_hash FROM manuscript_segments WHERE run_id=? AND segment_id=?').get(runId, before.review.candidate.segmentId) as { status?: string; content_hash?: string } | undefined
              const audits = sqlite.prepare("SELECT json FROM run_evidence WHERE run_id=? AND kind LIKE 'narrative_semantic_review_decision:%'").all(runId) as Array<{ json: string }>
              const audited = audits.some(row => { const audit = JSON.parse(row.json); return audit.packetHash === before.review.packetHash && audit.expectedRevision === before.review.revision && audit.decision === 'accept_prose_no_state' })
              check(checks, 'B crash：下一次 writer 边界前原段已合法审批且审计持久化（原段审批 0 新 writer）', candidate?.status === 'accepted' && candidate.content_hash === before.review.candidate.contentHash && audited && mock.requests.filter(item => item.kind === 'draft').length === draftsBefore)
            } finally { sqlite.close() }
          })
        }
        db = await completeWithBoundedUserReview(page, userData, checks, scenarioDir)
        if (reviewCrashArg) {
          check(checks, 'B crash：恢复后仍完整 8 场/8000 字真实交付，没有重放首段 writer', mock.requests.filter(item => item.kind === 'draft').length === 8 && cpLen(db.canonical) === TARGET_CHARS && db.run?.status === 'completed')
          await page.locator('.dw-global-nav button').filter({ hasText: '长文' }).first().click()
        }
      } else {
        // Stop waiting as soon as the product exposes a terminal blocker.  An
        // implementation that pauses after a short chunk must be reported as
        // a failed completion contract, not converted into a harness timeout.
        db = await waitForDraftsOrTerminal(userData, mock, 8, 90000)
        if (mock.requests.filter((item) => item.kind === 'draft').length >= 8 && db?.run?.status !== 'completed') db = await waitForDbStatus(userData, expectedStatus, 90000)
        const draftCount = mock.requests.filter((item) => item.kind === 'draft').length
        const currentStatus = db?.run?.status
        if (draftCount < 8 && (!currentStatus || !['completed', 'waiting_user'].includes(currentStatus))) {
          throw new Error(`正文未达到 8 轮且没有可审计终态（draft=${mock.requests.filter((item) => item.kind === 'draft').length} status=${db?.run?.status ?? 'none'}）`)
        }
      }
      await page.waitForTimeout(500)
      if (scenario !== 'E' && scenario !== 'F' && scenario !== 'G') {
        await page.screenshot({ path: path.join(EVIDENCE_ROOT, `commercial-${scenario}-workflow-terminal-${commercialEvidencePhase()}.png`), animations: 'disabled' })
        // The current longform shell presents the authoritative workflow,
        // while the canonical prose remains reachable in the same session's
        // Agent transcript. Keep the full-body UI checks through that real nav.
        await page.locator('.dw-global-nav').getByRole('button', { name: 'Agent', exact: true }).click()
        if (reviewCrashArg) {
          // A fresh window does not silently adopt a historical conversation.
          // Open the one visible fixture session through its ordinary sidebar.
          const session = page.locator('.session-item-main').filter({ hasText: '写一篇关于海边旧灯塔与守夜人的长文。' })
          if (await session.count() !== 1) throw new Error('restored fixture session is not uniquely reachable in sidebar')
          await session.click()
        }
        await page.locator('.msg.assistant .msg-bubble .markdown-body').last().waitFor({ state: 'visible', timeout: 10000 })
        uiText = await page.locator('.msg.assistant .msg-bubble').last().innerText().catch(() => '')
        await page.screenshot({ path: path.join(EVIDENCE_ROOT, `commercial-${scenario}-delivered-transcript-${commercialEvidencePhase()}.png`), animations: 'disabled' })
        check(checks, `${scenario}：UI 正文在目标 1% 内并自然收尾`, cpLen(uiText) >= Math.floor(TARGET_CHARS * 0.99) && cpLen(uiText) <= Math.ceil(TARGET_CHARS * 1.01) && /[。！？!?…][”’」』）】》]?$/.test(uiText.trim()), `ui=${cpLen(uiText)} tail=${uiText.slice(-20)}`)
        check(checks, `${scenario}：UI 不包含控制语或续写元话语`, !/(字数不足|还差\s*\d+\s*字|续写说明|完成校验未通过)/.test(uiText), uiText.slice(-120))
      }
    }
  } catch (error) {
    if (!db) {
      try { db = readDb(userData) } catch { /* database may not exist yet */ }
    }
    const body = page ? await page.locator('body').innerText().catch(() => '') : ''
    if (body) diagnostics.push(`body:${body.slice(-1800)}`)
    check(checks, `${scenario}：harness 没有异常`, false, `${error instanceof Error ? error.message : String(error)}${diagnostics.length ? ` | ${diagnostics.slice(-4).join(' || ')}` : ''}`)
  } finally {
    const exit = await quit(app)
    check(checks, `${scenario}：Electron 自然退出`, exit === 0, `exit=${exit}`)
    if (app) await app.close().catch(() => undefined)
    // The terminal event persists the canonical assistant projection after the
    // run row/turns become terminal.  Do not retain the earlier polling
    // snapshot: it can legitimately observe completed turns before the
    // synchronous terminal projection has been committed, which would turn a
    // durable canonical artifact into a false red result.
    try {
      const finalDb = readDb(userData)
      if (!db || !db.run || finalDb.run?.run_id === db.run.run_id) db = finalDb
    } catch {
      // Keep the last snapshot when the temporary user-data directory is
      // already unavailable; the existing checks will report the real state.
    }
    await new Promise<void>((resolve) => mock.server.close(() => resolve()))
  }

  if (!db) {
    try { db = readDb(userData) } catch { db = null }
  }
  const interview = mock.requests.filter((item) => item.kind === 'interview')
  const planning = mock.requests.filter((item) => item.kind === 'planning')
  const drafts = mock.requests.filter((item) => item.kind === 'draft')
  const critics = mock.requests.filter((item) => item.kind === 'critic')
  const editors = mock.requests.filter((item) => item.kind === 'editor')
  const verifications = mock.requests.filter((item) => item.kind === 'verify')
  const unknown = mock.requests.filter((item) => item.kind === 'unknown')
  check(checks, `${scenario}：provider 请求全部来自本地 SSE`, mock.requests.length > 0 && mock.requests.every((item) => item.path.endsWith('/chat/completions')), `requests=${mock.requests.length}`)
  check(checks, `${scenario}：没有未知 provider 阶段`, unknown.length === 0, unknown.map((item) => item.id).join(',') || 'none')
  check(checks, `${scenario}：采访/规划/正文顺序可审计`, scenario === 'A' ? interview.length >= 3 && planning.length === 0 && drafts.length === 0 : scenario === 'G' ? interview.length >= 3 && planning.length >= 1 && planning.length <= 2 && drafts.length >= 1 : interview.length >= 3 && planning.length === 1 && (drafts.length === 0 || drafts.length >= 1), requestOrder(mock.requests))
  if (sourceModeArg) check(checks, `${scenario}：显式 source-local 证据不冒充发行包`, packageManifest?.mode === 'source' && Boolean(packageManifest.sourceSha256) && packageManifest.appAsarSha256 === null, `mode=${packageManifest?.mode} source=${packageManifest?.sourceSha256}`)
  else if (!exeArg) check(checks, `${scenario}：使用本轮 fresh dist-${packageLabelArg} 制品`, packageManifest?.mode === 'fresh' && packageManifest.outputDir.includes(`dist-${packageLabelArg}-`) && Boolean(packageManifest.appAsarSha256) && Boolean(packageManifest.sourceSha256), JSON.stringify(packageManifest))
  if (scenario !== 'A') {
    const writerRequestsHaveThinkingOff = drafts.length > 0 && drafts.every((item) => item.thinkingEnabled === false)
    check(checks, `${scenario}：writer thinking 明确关闭`, writerRequestsHaveThinkingOff, JSON.stringify(drafts.map((item) => ({ thinkingEnabled: item.thinkingEnabled, id: item.id }))))
    const caps = [providerCaps.contextWindow, providerCaps.modelMaxOutputTokens, providerCaps.profileMaxOutputTokens].filter((value): value is number => typeof value === 'number' && value > 0)
    const writerTokensWithinCaps = drafts.length > 0 && caps.length === 3 && drafts.every((item) => typeof item.maxTokens === 'number' && item.maxTokens > 0 && caps.every((cap) => (item.maxTokens as number) <= cap))
    check(checks, `${scenario}：writer max_tokens 不超过 profile/model/context cap`, writerTokensWithinCaps, JSON.stringify({ caps: providerCaps, writerMaxTokens: drafts.map((item) => item.maxTokens) }))
  }

  if (scenario === 'A') {
    check(checks, 'A：没有任何正文请求', drafts.length === 0)
  } else if (scenario === 'E') {
    check(checks, 'E：每次 mock 正文仍为 900-1200 字且 finish=stop', drafts.length >= 1 && drafts.every((item) => item.responseChars >= 900 && item.responseChars <= 1200 && item.finishReason === 'stop'), JSON.stringify(drafts.map((item) => [item.responseChars, item.finishReason])))
    const waiting = budgetWaitingSnapshot ?? db
    check(checks, 'E：预算耗尽进入 waiting_user 而非 completed', waiting?.run?.status === 'waiting_user', `${waiting?.run?.status ?? 'no-run'} ${waiting?.run?.error_code ?? ''}`)
    check(checks, 'E：完成评估记录 budget_exhausted', Boolean(waiting?.evaluations.some((item) => item.state === 'waiting_user' && /budget_exhausted/.test(item.json))), waiting?.evaluations.map((item) => item.state).join(',') ?? 'none')
    check(checks, 'E：run 快照确实冻结了低 token 预算', Boolean(waiting?.config?.completionContract && (waiting.config.completionContract as { tokenBudget?: unknown }).tokenBudget === 1), JSON.stringify(waiting?.config?.completionContract ?? null))
  } else if (scenario === 'F') {
    check(checks, 'F：终止 SSE 缺失 finish_reason', drafts.length >= 1 && drafts.every((item) => item.responseChars >= 900 && item.responseChars <= 1200 && item.finishReason === null && item.finishReasonPresent === false), JSON.stringify(drafts.map((item) => [item.responseChars, item.finishReason, item.finishReasonPresent])))
    const incompleteEvidence = `${db?.run?.error_code ?? ''} ${JSON.stringify(db?.evaluations ?? [])} ${JSON.stringify(db?.workflowEvents ?? [])}`
    check(checks, 'F：incomplete_stream 不得完成任务', db?.run?.status !== 'completed' && /incomplete_stream/.test(incompleteEvidence), `${db?.run?.status ?? 'no-run'} ${db?.run?.error_code ?? ''}`)
  } else if (scenario === 'G') {
    check(checks, 'G：修复后的大纲确认后已创建真实 run 并触发首个 draft', drafts.length >= 1 && Boolean(db?.run) && db?.config?.runMode === 'longwrite', JSON.stringify({ drafts: drafts.length, run: db?.run?.run_id ?? null, status: db?.run?.status ?? null }))
    const grill = db?.grillState as { status?: unknown; approvedOutline?: { sections?: Array<{ sourceSlotIds?: unknown }> }; slots?: Array<{ id?: unknown; answer?: unknown; source?: unknown }> } | null
    const sources = grill?.approvedOutline?.sections?.flatMap((section) => Array.isArray(section.sourceSlotIds) ? section.sourceSlotIds : []) ?? []
    check(checks, 'G：durable confirmed snapshot 保留 conflict provenance', grill?.status === 'confirmed' && sources.includes('conflict'), JSON.stringify({ status: grill?.status, sources: [...new Set(sources)] }))
    const conflictSlot = grill?.slots?.find((slot) => slot.id === 'conflict')
    check(checks, 'G：opaque option 已规范化为人类语义答案且来源为 user', conflictSlot?.answer === '二者兼具，但以感官冲击为重' && conflictSlot.answer !== 'mixed' && conflictSlot.source === 'user', JSON.stringify(conflictSlot ?? null))
    const planningPrompt = mock.planningPrompts[0] ?? ''
    const semanticAnswer = /"(?:value|answer)":"二者兼具，但以感官冲击为重"/.test(planningPrompt)
    const opaqueAnswer = /"(?:value|answer)":"mixed"/.test(planningPrompt)
    check(checks, 'G：规划 prompt 携带 slot id、slot label 与语义答案且不传 opaque mixed', /"id":"conflict"/.test(planningPrompt) && /"label":"核心矛盾、问题或推动力"/.test(planningPrompt) && semanticAnswer && !opaqueAnswer, planningPrompt.slice(0, 1200))
  } else {
    check(checks, `${scenario}：每次 mock 正文 900-1200 字且 finish=${scenario === 'D' ? 'length' : 'stop'}`, drafts.length >= 8 && drafts.every((item) => item.responseChars >= 900 && item.responseChars <= 1200 && item.finishReason === (scenario === 'D' ? 'length' : 'stop')), JSON.stringify(drafts.map((item) => [item.responseChars, item.finishReason])))
    check(checks, `${scenario}：正文各轮无覆盖或高度重复`, distinctSegmentCheck(drafts.map((item) => fixtureDraft(scenario, drafts.indexOf(item) + 1, item.responseChars))), requestOrder(drafts))
    check(checks, `${scenario}：DB completed 且自然收束/文件交付契约冻结`, db?.run?.status === 'completed' && db.config?.runMode === 'longwrite' && db.config?.longMode === true && (db.config.completionContract as any)?.targetChars?.min === TARGET_CHARS && (db.config.completionContract as any)?.targetChars?.max === Math.ceil(TARGET_CHARS * 1.01) && (db.config.deliveryContract as any)?.manuscriptFile === true, `${db?.run?.status ?? 'no-run'} ${JSON.stringify({ completion: db?.config?.completionContract, delivery: db?.config?.deliveryContract })}`)
    if (scenario === 'D' && db?.run) {
      const sqlite = new DatabaseSync(path.join(userData, 'deepwriter.db'))
      try {
        const reviewDecisions = sqlite.prepare("SELECT COUNT(*) AS count FROM run_evidence WHERE run_id=? AND kind LIKE 'narrative_semantic_review_decision:%'").get(db.run.run_id) as { count: number }
        check(checks, 'D：具体场景合同真实自动推进到 8k，没有人工审阅决定', db.run.status === 'completed' && reviewDecisions.count === 0, `status=${db.run.status} manualDecisions=${reviewDecisions.count}`)
      } finally { sqlite.close() }
    }
    if (scenario === 'B' || scenario === 'D') {
      const budget = db?.config?.providerCallBudget as { maxCost?: { amount?: number; currency?: string; unknownPolicy?: string } } | undefined
      const frozen = db?.config?.providerProfileSnapshots as { draft?: { model?: { pricing?: { source?: string; canonicalOrigin?: string; inputMissPerMillion?: number; outputPerMillion?: number; priceProfileHash?: string } } } } | undefined
      const price = frozen?.draft?.model?.pricing
      check(checks, `${scenario}：正常运行冻结 exact loopback 用户参考价及有界成本上限`, price?.source === 'user_supplied' && price.canonicalOrigin === `http://127.0.0.1:${mock.port}` && (price.inputMissPerMillion ?? 0) > 0 && (price.outputPerMillion ?? 0) > 0 && /^[a-f0-9]{64}$/.test(price.priceProfileHash ?? '') && budget?.maxCost?.currency === 'CNY' && budget.maxCost.unknownPolicy === 'deny' && (budget.maxCost.amount ?? 0) > 0 && (budget.maxCost.amount ?? Infinity) <= 100000, JSON.stringify({ price, budget }))
    }
    const durableText = db?.assistantTurns.join('') ?? ''
    check(checks, `${scenario}：assistant/canonical 同源且在 1% 窗口自然收尾`, Boolean(db && durableText === db.canonical && cpLen(durableText) >= Math.floor(TARGET_CHARS * 0.99) && cpLen(durableText) <= Math.ceil(TARGET_CHARS * 1.01) && /[。！？!?…][”’」』）】》]?$/.test(durableText.trim())), `turns=${cpLen(durableText)} canonical=${cpLen(db?.canonical ?? '')} tail=${durableText.slice(-20)}`)
    const manuscript = db?.artifacts.find((item) => item.artifact_type === 'manuscript' && item.status === 'completed')
    let manuscriptContent = ''
    try { if (manuscript?.relative_path) manuscriptContent = await fsp.readFile(manuscript.relative_path, 'utf8') } catch { manuscriptContent = '' }
    const manuscriptHash = manuscriptContent ? createHash('sha256').update(manuscriptContent).digest('hex') : ''
    check(checks, `${scenario}：完成前真实生成 manuscript 文件并校验内容/哈希`, Boolean(manuscript && manuscript.relative_path && manuscript.relative_path.startsWith(path.join(scenarioDir, 'documents')) && manuscriptContent === durableText && manuscript.char_count === cpLen(durableText) && manuscript.hash === manuscriptHash), JSON.stringify({ manuscript, fileChars: cpLen(manuscriptContent), hash: manuscriptHash }))
    check(checks, `${scenario}：activity 记录稿件文件完成事件`, Boolean(db?.workflowEvents.some((event) => event.type === 'artifact.completed' && JSON.stringify(event).includes('manuscript'))), `events=${db?.workflowEvents.length ?? 0}`)
    const pipelineCalls = critics.length + editors.length + verifications.length
    const expectedAttempts = drafts.length + pipelineCalls
    const criticUsage = db?.usage.filter((row) => row.call_type === 'kernel-critic').length ?? 0
    const editorUsage = db?.usage.filter((row) => row.call_type === 'kernel-editor').length ?? 0
    check(checks, `${scenario}：provider attempt ledger 与 writer/审校请求一致`, Boolean(db && db.providerAttempts.length === expectedAttempts && db.usage.filter((row) => row.call_type === 'kernel-chat').length === drafts.length && criticUsage === critics.length + verifications.length && editorUsage === editors.length), `attempts=${db?.providerAttempts.length ?? 0}/${expectedAttempts} kernel-chat=${db?.usage.filter((row) => row.call_type === 'kernel-chat').length ?? 0}/${drafts.length} critic=${criticUsage}/${critics.length + verifications.length} editor=${editorUsage}/${editors.length}`)
    check(checks, `${scenario}：confirmed Grill 默认快照启用 R42 审校链`, Boolean(db?.config?.strongConstraints && (db.config.strongConstraints as { enabled?: unknown }).enabled === true && Boolean(db.config.writingPipeline) && (db.config.writingPipeline as { mode?: unknown }).mode === 'writer-critic-targeted-editor'), JSON.stringify({ strong: db?.config?.strongConstraints, pipeline: db?.config?.writingPipeline }))
    check(checks, `${scenario}：provider 分类实际经过 critic/editor/verification`, critics.length >= drafts.length && editors.length >= 1 && verifications.length >= 1, JSON.stringify({ draft: drafts.length, critic: critics.length, editor: editors.length, verify: verifications.length, order: requestOrder(mock.requests) }))
    const firstCritic = critics[0]
    const firstEditor = editors[0]
    const firstVerify = verifications[0]
    const criticHash = firstCritic?.requestCandidateHash ?? ''
    const issueId = firstCritic?.responseIssueIds[0] ?? ''
    const reviewHandshake = Boolean(
      firstCritic && firstEditor && firstVerify &&
      /^[a-f0-9]{16,128}$/i.test(criticHash) &&
      firstCritic.responseCandidateHash === criticHash &&
      firstCritic.responseIssueIds.length > 0 &&
      firstEditor.requestCandidateHash === criticHash &&
      firstEditor.responsePatchIssueIds.includes(issueId) &&
      firstVerify.requestCandidateHash &&
      firstVerify.responseIssueIds.length === 0 &&
      mock.requests.indexOf(firstCritic) < mock.requests.indexOf(firstEditor) &&
      mock.requests.indexOf(firstEditor) < mock.requests.indexOf(firstVerify)
    )
    check(checks, `${scenario}：审校链首轮返回合法 candidateHash → 定点 editor → verify`, reviewHandshake, JSON.stringify({ critic: firstCritic, editor: firstEditor, verify: firstVerify }))
    // A frozen SceneContractPlan advances through committed scenes, not the
    // old unplanned longwrite `continuing` evaluation branch. Require the
    // actual per-scene commit/prose/contract bindings and ordered writer
    // activity; do not accept a terminal label or relax the completion gate.
    const sceneProgression = db?.run ? readCommittedSceneProgression(userData, db.run.run_id) : []
    await fsp.writeFile(path.join(scenarioDir, 'scene-progression.json'), JSON.stringify(sceneProgression, null, 2), 'utf8')
    const contracts = (db?.config?.sceneContracts as { contracts?: Array<{ sceneId: string; order: number; contractId: string; frozenHash: string }> } | undefined)?.contracts ?? []
    const events = db?.workflowEvents ?? []
    const writingIndexes = events.flatMap((event, index) => event.type === 'phase.changed' && event.phase === 'writing' ? [index] : [])
    const writtenIndexes = events.flatMap((event, index) => event.type === 'phase.changed' && event.title === '正文生成完成' ? [index] : [])
    const completedIndex = events.findIndex(event => event.type === 'run.completed')
    const activityProgression = writingIndexes.length === drafts.length && writtenIndexes.length === drafts.length && writingIndexes.every((index, order) => index < writtenIndexes[order] && (order === 0 || index > writtenIndexes[order - 1])) && completedIndex > (writtenIndexes.at(-1) ?? Infinity) && events.some(event => event.title === '完成校验通过')
    check(checks, `${scenario}：activity 按实际逐场 writer 推进后完成校验（非旧 continuation 文案）`, activityProgression && drafts.length >= 8, `writing=${writingIndexes.length} written=${writtenIndexes.length} completedIndex=${completedIndex}`)
    const finalEvaluation = [...(db?.evaluations ?? [])].reverse().find(item => item.state === 'completed')
    const evaluation = finalEvaluation ? JSON.parse(finalEvaluation.json) : null
    const allScenesBound = contracts.length >= 8 && sceneProgression.length === contracts.length && sceneProgression.every((scene, index) => scene.order === index + 1 && scene.sceneId === contracts[index].sceneId && scene.contractId === contracts[index].contractId && scene.contractHash === contracts[index].frozenHash && scene.lifecycle === 'committed' && scene.completionStatus === 'complete' && scene.bound === true)
    check(checks, `${scenario}：冻结合同每场真实 committed → 最终完成评估 accepted`, allScenesBound && evaluation?.state === 'completed' && evaluation.measuredChars === cpLen(durableText) && evaluation.measuredChars >= TARGET_CHARS && evaluation.hardFailures.length === 0 && evaluation.remainingWork.length === 0, `scenes=${sceneProgression.length}/${contracts.length} evaluation=${evaluation?.state ?? 'none'} chars=${evaluation?.measuredChars ?? 0}`)
  }

  const result = { scenario, executablePath, packageManifest, userData, providerCaps, requests: mock.requests, db, eAction, uiTextChars: cpLen(uiText), diagnostics, checks, passed: checks.filter((item) => item.ok).length, failed: checks.filter((item) => !item.ok).length }
  const evidencePath = path.join(scenarioDir, 'result.json')
  await fsp.writeFile(evidencePath, `${JSON.stringify(result, null, 2)}\n`, 'utf8')
  console.log(`R47-${scenario}: ${result.passed} PASS / ${result.failed} FAIL`)
  console.log(`evidence: ${evidencePath}`)
  return { checks, requests: mock.requests, evidencePath }
}

async function runHarnessSelfTest(): Promise<void> {
  const source = await fsp.readFile(path.join(ROOT, 'scripts', 'r47-grill-me-packaged-e2e.ts'), 'utf8')
  const legacySelectors = [
    ['.grill-me-', 'card textarea'].join(''),
    ['确认', '这轮'].join(''),
    ['接受这些', '默认值'].join('')
  ]
  for (const legacy of legacySelectors) {
    if (source.includes(legacy)) throw new Error(`harness selftest: legacy selector/text remains: ${legacy}`)
  }
  const required = [
    '[data-testid="grill-interview-stage"]',
    '[role="group"][aria-label="快速回答"]',
    'textarea[aria-label="自由填写回答"]',
    '提交补充，继续梳理',
    '[data-testid="grill-assumption-stage"]',
    '接受默认值',
    '继续补充',
    '[data-testid="grill-outline-stage"]',
    '确认大纲，开始写作'
  ]
  for (const marker of required) {
    if (!source.includes(marker)) throw new Error(`harness selftest: current UI contract missing: ${marker}`)
  }
  if (!source.includes('supplementQuestionUnchanged') || !source.includes('finalSeen >= 2')) throw new Error('harness selftest: final supplement/reconfirmation assertions missing')
  if (!source.includes('interviewSerial') || !source.includes('requestNo >= 4') || !source.includes('assumptionPlanningBefore === 0')) throw new Error('harness selftest: dynamic readiness/assumption boundary assertions missing')
  if (!source.includes('runR48StopScenario') || !source.includes('abortedRequests') || !source.includes('readActivityJournal') || !source.includes('可见工作流细节显示已回答 1 轮且不含 0/13') || !source.includes('首问选项提交后 durable answers 从 0 变为 1') || !source.includes('同 session 可重新创建新 Grill 状态')) throw new Error('harness selftest: R48 real answer/projection/stop/restart assertions missing')
  if (!source.includes('runHScenario') || !source.includes('waitForWriterSuccess') || !source.includes('preTeardownDb')) throw new Error('harness selftest: R51 capability/handoff assertions missing')
  console.log(`R47/R48/R51 harness selftest: ${required.length} current selectors + dynamic readiness/reject path + real stop/restart path + packaged capability/handoff path + legacy guard PASS`)
}

async function main(): Promise<void> {
  if (selfTestArg) {
    await runHarnessSelfTest()
    return
  }
  if (!['r47', 'r51', 'r53'].includes(packageLabelArg)) throw new Error(`--package-label 只接受 r47/r51/r53：${packageLabelArg}`)
  if (!['success', 'blocked'].includes(hExpectationArg)) throw new Error(`--h-expect 只接受 success 或 blocked：${hExpectationArg}`)
  const scenarios = assertScenario(scenarioArg)
  if (reviewCrashArg && (scenarios.length !== 1 || scenarios[0] !== 'B')) throw new Error('--review-crash requires the explicit unchanged 8000-character B scenario only')
  await fsp.mkdir(EVIDENCE_ROOT, { recursive: true })
  if (sourceModeArg && exeArg) throw new Error('--source 与 --exe 不能同时使用')
  if (sourceModeArg) {
    executablePath = createRequire(import.meta.url)('electron') as string
    if (!fs.existsSync(path.join(ROOT, 'out', 'main', 'index.js'))) throw new Error('--source 需要先显式执行生产源码构建')
    const fingerprint = await sourceFingerprint()
    packageManifest = { schemaVersion: 1, mode: 'source', head: null, packageHead: null, outputDir: path.join(ROOT, 'out'), executablePath, appAsarPath: null, appAsarSha256: null, exeSha256: null, sourceSha256: fingerprint.hash, sourceFiles: fingerprint.files, builtAt: new Date().toISOString() }
    console.log(`SOURCE-LOCAL ONLY: ${fingerprint.hash}; not a packaged acceptance`)
  } else if (exeArg) {
    if (!fs.existsSync(executablePath)) throw new Error(`显式 exe 不存在：${executablePath}`)
    packageManifest = { schemaVersion: 1, mode: 'explicit', head: null, packageHead: null, outputDir: path.resolve(executablePath, '..', '..'), executablePath, appAsarPath: null, appAsarSha256: null, exeSha256: null, sourceSha256: null, sourceFiles: [], builtAt: new Date().toISOString() }
  } else {
    packageManifest = await buildFreshPackage()
    executablePath = packageManifest.executablePath
  }
  const all: Array<{ scenario: Scenario; result: Awaited<ReturnType<typeof runScenario>> }> = []
  for (const scenario of scenarios) {
    if (scenario === 'R48') {
      const result = await runR48StopScenario()
      all.push({ scenario, result: result as Awaited<ReturnType<typeof runScenario>> })
    } else if (scenario === 'H') {
      const result = await runHScenario()
      all.push({ scenario, result: result as Awaited<ReturnType<typeof runScenario>> })
    } else {
      all.push({ scenario, result: await runScenario(scenario) })
    }
  }
  const failed = all.reduce((sum, item) => sum + item.result.checks.filter((checkItem) => !checkItem.ok).length, 0)
  console.log(`\nR47/R48 ${sourceModeArg ? 'source-local (NOT packaged)' : 'packaged'} Grill Me: ${all.reduce((sum, item) => sum + item.result.checks.filter((checkItem) => item.result.checks.includes(checkItem) && checkItem.ok).length, 0)} PASS / ${failed} FAIL`)
  if (failed > 0) process.exitCode = 1
}

await main().catch((error) => { console.error(error); process.exitCode = 2 })
