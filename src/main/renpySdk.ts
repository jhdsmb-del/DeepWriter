import { promises as fs, createReadStream } from 'node:fs'
import * as path from 'node:path'
import { createHash, randomBytes } from 'node:crypto'
import { spawn } from 'node:child_process'
import { registerChildProcess } from './childRegistry'
import { AsyncUnzipInflate, Unzip } from 'fflate'
import {
  RENPY_SDK_DOWNLOAD_URL,
  RENPY_SDK_MANIFEST,
  RENPY_SDK_SHA256,
  RENPY_SDK_VERSION,
  type GalgameSdkEvidence
} from '../shared/galgameStudio'

const MAX_DOWNLOAD_BYTES = 2 * 1024 * 1024 * 1024
const MAX_ZIP_ENTRIES = 50_000
const MAX_EXPANDED_BYTES = 4 * 1024 * 1024 * 1024
const MAX_ENTRY_EXPANDED_BYTES = 512 * 1024 * 1024
const VERSION_TIMEOUT_MS = 30_000

export interface RenpySdkLayout {
  root: string
  pythonPath: string
  renpyScriptPath: string
  launcherPath: string | null
  /** Bundled interpreter selected from the engine's declared release line. */
  pythonMajor?: 2 | 3
  declaredVersion?: string
}

export interface RenpySdkCandidate {
  source: 'explicit' | 'managed' | 'discovered'
  layout: RenpySdkLayout
  version: string
  versionOutput: string
  evidence: GalgameSdkEvidence
}

export interface RenpySdkInspection {
  status: 'missing' | 'invalid' | 'ready'
  candidate: RenpySdkCandidate | null
  explicit: { configured: boolean; message?: string }
  managed: { checked: number; message?: string }
  discovered: { checked: number; roots: string[]; message?: string }
  message: string
}

export interface RenpyLintExecution {
  ok: boolean
  output: string
  exitCode: number | null
  command: string
  verified: boolean
  cancelled?: boolean
}

export interface RenpySdkProgress {
  phase: 'download' | 'verify' | 'extract' | 'validate' | 'installed'
  receivedBytes?: number
  totalBytes?: number | null
  percent?: number | null
  message: string
}

export interface SdkCommandResult {
  code: number | null
  output: string
  cancelled?: boolean
}

export type SdkCommandRunner = (command: string, args: string[], cwd: string, signal?: AbortSignal) => Promise<SdkCommandResult>
export type SdkFetch = (input: string, init?: { signal?: AbortSignal; redirect?: 'error' | 'follow' | 'manual' }) => Promise<Response>

export interface SdkDownloadOptions {
  userDataDir: string
  signal?: AbortSignal
  onProgress?: (progress: RenpySdkProgress) => void
  fetchImpl?: SdkFetch
  runCommand?: SdkCommandRunner
}

export interface SdkInspectionOptions {
  userDataDir: string
  explicitPath?: string | null
  discoveryRoots?: string[]
  runCommand?: SdkCommandRunner
}

export class RenpySdkError extends Error {
  constructor(public readonly code: 'missing' | 'invalid' | 'download_failed' | 'hash_mismatch' | 'zip_slip' | 'cancelled' | 'version_failed', message: string) {
    super(message)
    this.name = 'RenpySdkError'
  }
}

function nonce(): string {
  return `${Date.now().toString(36)}-${randomBytes(8).toString('hex')}`
}

function checkCancelled(signal?: AbortSignal): void {
  if (signal?.aborted) throw new RenpySdkError('cancelled', 'Ren\'Py SDK 下载已取消')
}

const WINDOWS_RUNTIME_DIRECTORY = /^(?:py[23]-)?windows-(?:x86_64|i686)$/i

function sdkRootFromCandidate(candidate: string): string {
  const absolute = path.resolve(candidate)
  const base = path.basename(absolute).toLowerCase()
  if (base === 'renpy.py' || base === 'renpy.exe') return path.dirname(absolute)
  const parent = path.dirname(absolute)
  if ((base === 'python.exe' || base === 'pythonw.exe') && WINDOWS_RUNTIME_DIRECTORY.test(path.basename(parent)) && path.basename(path.dirname(parent)).toLowerCase() === 'lib') return path.dirname(path.dirname(parent))
  if (WINDOWS_RUNTIME_DIRECTORY.test(base) && path.basename(parent).toLowerCase() === 'lib') return path.dirname(parent)
  return absolute
}

export function managedSdkRoot(userDataDir: string): string {
  return path.join(path.resolve(userDataDir), 'renpy-sdk', RENPY_SDK_VERSION)
}

export function managedSdkInstallsDir(userDataDir: string): string {
  return path.join(managedSdkRoot(userDataDir), 'installs')
}

async function smallSdkSource(file: string): Promise<string> {
  const stat = await fs.stat(file).catch(() => null)
  if (!stat?.isFile() || stat.size > 1024 * 1024) return ''
  return fs.readFile(file, 'utf8').catch(() => '')
}

async function checkSdkRoot(root: string): Promise<{ layout?: RenpySdkLayout; message: string }> {
  const script = path.join(root, 'renpy.py')
  if (!(await fs.stat(script).catch(() => null))?.isFile()) return { message: '缺少 SDK 入口 renpy.py，请选择完整解压后的 SDK 根目录' }
  // A distributed game also has renpy.py and lib/. The SDK launcher source is
  // required before invoking any executable; a game is never a probe target.
  const launcherSource = path.join(root, 'launcher', 'game', 'project.rpy')
  if (!(await fs.stat(launcherSource).catch(() => null))?.isFile()) return { message: '缺少 launcher/game/project.rpy：这是游戏目录或不完整 SDK，不会启动其中的程序' }
  const source = await smallSdkSource(path.join(root, 'renpy', 'vc_version.py'))
  const declaredVersion = /\bversion\s*=\s*u?['"](\d+\.\d+(?:\.\d+)?)(?:\.\d+)?['"]/u.exec(source)?.[1]
  if (!declaredVersion) return { message: '无法读取 renpy/vc_version.py 中的 SDK 版本' }
  const major = Number(declaredVersion.split('.')[0])
  if (major !== 7 && major !== 8) return { message: `暂不支持 Ren'Py ${declaredVersion}；请选择 Ren'Py 7 或 8 SDK` }
  const pythonMajor = major === 7 ? 2 : 3
  const runtimes = major === 7
    ? ['py2-windows-x86_64', 'py2-windows-i686', 'windows-x86_64', 'windows-i686']
    : ['py3-windows-x86_64']
  // A 32-bit host cannot execute the 64-bit interpreter. Never fall back to a
  // system Python or a different release line's bundled interpreter.
  const compatible = process.arch === 'ia32' ? runtimes.filter(value => value.endsWith('i686')) : runtimes
  let pythonPath = ''
  for (const runtime of compatible) {
    const file = path.join(root, 'lib', runtime, 'python.exe')
    if ((await fs.stat(file).catch(() => null))?.isFile()) { pythonPath = file; break }
  }
  if (!pythonPath) return { message: `Ren'Py ${declaredVersion} 缺少可用的 Windows Python ${pythonMajor} 运行时（${compatible.join('、') || '当前架构不可用'}），请完整解压匹配的 SDK` }
  const lintSource = await smallSdkSource(path.join(root, 'renpy', 'lint.py'))
  if (!lintSource.includes('--error-code')) return { message: `Ren'Py ${declaredVersion} 不提供 lint --error-code，无法可靠判断检查是否通过` }
  const launcher = path.join(root, 'renpy.exe')
  return { layout: { root, pythonPath, renpyScriptPath: script, launcherPath: (await fs.stat(launcher).catch(() => null))?.isFile() ? launcher : null, pythonMajor, declaredVersion }, message: '' }
}

/** Resolve only a complete SDK or one unambiguous archive wrapper directory. */
export async function resolveRenpySdkLayout(candidate: string): Promise<RenpySdkLayout> {
  if (!candidate.trim()) throw new RenpySdkError('missing', '未选择 Ren’Py SDK 路径')
  if (!(await fs.stat(path.resolve(candidate)).catch(() => null))) throw new RenpySdkError('missing', `SDK 路径不存在或不可访问：${candidate}`)
  const root = sdkRootFromCandidate(candidate)
  const direct = await checkSdkRoot(root)
  if (direct.layout) return direct.layout
  const children = await fs.readdir(root, { withFileTypes: true }).catch(() => [] as import('node:fs').Dirent[])
  const directories = children.filter(entry => entry.isDirectory())
  if (directories.length === 1) {
    const wrapped = await checkSdkRoot(path.join(root, directories[0].name))
    if (wrapped.layout) return wrapped.layout
  }
  throw new RenpySdkError('invalid', `${root}：${direct.message}`)
}

/** Compatibility query; callers needing a diagnostic use resolveRenpySdkLayout. */
export async function findRenpySdkLayout(candidate: string): Promise<RenpySdkLayout | null> {
  try { return await resolveRenpySdkLayout(candidate) } catch { return null }
}

function defaultCommandRunner(command: string, args: string[], cwd: string, signal?: AbortSignal, timeoutMs = VERSION_TIMEOUT_MS): Promise<SdkCommandResult> {
  if (signal?.aborted) return Promise.resolve({ code: null, output: 'SDK 命令已取消，未启动', cancelled: true })
  return new Promise((resolve) => {
    let output = ''
    let settled = false
    let cancelled = false
    const child = spawn(command, args, { cwd, shell: false, windowsHide: true })
    registerChildProcess(child)
    const finish = (result: SdkCommandResult): void => {
      if (settled) return
      settled = true
      signal?.removeEventListener('abort', kill)
      resolve(result)
    }
    const append = (chunk: Buffer): void => {
      output = (output + chunk.toString('utf8')).slice(-256 * 1024)
    }
    child.stdout?.on('data', append)
    child.stderr?.on('data', append)
    const kill = (): void => {
      cancelled = true
      try { child.kill() } catch { /* child may already have exited */ }
    }
    if (signal) {
      if (signal.aborted) kill()
      else signal.addEventListener('abort', kill, { once: true })
    }
    const timer = setTimeout(() => {
      cancelled = true
      try { child.kill() } catch { /* child may already have exited */ }
    }, timeoutMs)
    child.once('error', (error) => {
      clearTimeout(timer)
      finish({ code: null, output: output || error.message, cancelled })
    })
    child.once('close', (code) => {
      clearTimeout(timer)
      finish({ code, output, cancelled })
    })
  })
}

function parseVersion(output: string): string | null {
  return /\bRen['’]?Py\s+(\d+\.\d+(?:\.\d+)?)(?:\.\d+)?\b/i.exec(output)?.[1] ?? null
}

export async function validateRenpySdkLayout(layout: RenpySdkLayout, options: { source: 'explicit' | 'managed' | 'discovered'; runCommand?: SdkCommandRunner }): Promise<RenpySdkCandidate> {
  const run = options.runCommand ?? defaultCommandRunner
  const scriptArg = path.relative(layout.root, layout.renpyScriptPath).replace(/\\/g, '/') || 'renpy.py'
  const result = await run(layout.pythonPath, [scriptArg, '--version'], layout.root)
  if (result.cancelled) throw new RenpySdkError('cancelled', 'Ren\'Py SDK 版本检查已取消')
  const version = parseVersion(result.output)
  if (result.code !== 0 || !version) {
    throw new RenpySdkError('version_failed', `Ren'Py SDK 版本检查失败（exit ${result.code ?? '未启动'}）：${result.output.slice(-500) || '没有版本输出'}`)
  }
  if (!/^[78]\./u.test(version) || (layout.declaredVersion && version !== layout.declaredVersion)) {
    throw new RenpySdkError('version_failed', `SDK 版本身份不一致：源文件 ${layout.declaredVersion ?? '未知'}，运行结果 ${version}`)
  }
  if (options.source === 'managed' && version !== RENPY_SDK_VERSION) {
    throw new RenpySdkError('version_failed', `托管下载固定为 ${RENPY_SDK_VERSION}，实际检测到 ${version}；本机其它版本请通过手动选择使用`)
  }
  const command = `${layout.pythonPath} ${scriptArg} --version`
  const evidence: GalgameSdkEvidence = {
    source: options.source,
    root: layout.root,
    pythonPath: layout.pythonPath,
    renpyScriptPath: layout.renpyScriptPath,
    version,
    verifiedAt: Date.now(),
    command
  }
  return { source: options.source, layout, version, versionOutput: result.output, evidence }
}

async function inspectExplicit(options: SdkInspectionOptions): Promise<{ candidate: RenpySdkCandidate | null; message: string }> {
  const configured = options.explicitPath?.trim()
  if (!configured) return { candidate: null, message: '未配置显式 SDK 路径' }
  try {
    const layout = await resolveRenpySdkLayout(configured)
    return { candidate: await validateRenpySdkLayout(layout, { source: 'explicit', runCommand: options.runCommand }), message: '显式 SDK 已验证' }
  } catch (error) {
    return { candidate: null, message: error instanceof Error ? error.message : '显式 SDK 版本验证失败' }
  }
}

async function managedCandidates(userDataDir: string): Promise<string[]> {
  const base = managedSdkRoot(userDataDir)
  const out: string[] = []
  const direct = path.join(base, 'sdk')
  if (await fs.stat(direct).then((s) => s.isDirectory()).catch(() => false)) out.push(direct)
  const installs = managedSdkInstallsDir(userDataDir)
  const entries = await fs.readdir(installs, { withFileTypes: true }).catch(() => [] as import('node:fs').Dirent[])
  for (const entry of entries.filter((item) => item.isDirectory()).sort((a, b) => b.name.localeCompare(a.name))) out.push(path.join(installs, entry.name))
  return out
}

const SDK_DIRECTORY_PATTERN = /^renpy-\d+\.\d+\.\d+(?:-sdk)?$/i
const MAX_DISCOVERY_CHILDREN = 300

/**
 * Bounded discovery for common user folders. Only directories whose own name
 * looks like an SDK are candidates; at most two levels are inspected and no
 * arbitrary files are read. Manual selection remains the fallback for custom
 * layouts.
 */
export async function discoverRenpySdkCandidates(roots: string[]): Promise<string[]> {
  const found = new Set<string>()
  const inspectLevel = async (root: string, depth: number): Promise<void> => {
    const absolute = path.resolve(root)
    const ownName = path.basename(absolute)
    if (SDK_DIRECTORY_PATTERN.test(ownName)) found.add(absolute)
    if (depth <= 0) return
    const entries = await fs.readdir(absolute, { withFileTypes: true }).catch(() => [] as import('node:fs').Dirent[])
    for (const entry of entries.filter((item) => item.isDirectory()).slice(0, MAX_DISCOVERY_CHILDREN)) {
      const child = path.join(absolute, entry.name)
      if (SDK_DIRECTORY_PATTERN.test(entry.name)) found.add(child)
      else if (depth > 1) await inspectLevel(child, depth - 1)
    }
  }
  for (const root of [...new Set(roots.filter((value) => value.trim()).map((value) => path.resolve(value)))].slice(0, 8)) {
    await inspectLevel(root, 2)
  }
  return [...found].sort((a, b) => {
    const preferred = `renpy-${RENPY_SDK_VERSION}-sdk`
    const aPreferred = path.basename(a).toLowerCase() === preferred ? 0 : 1
    const bPreferred = path.basename(b).toLowerCase() === preferred ? 0 : 1
    return aPreferred - bPreferred || a.localeCompare(b)
  })
}

export async function inspectRenpySdk(options: SdkInspectionOptions): Promise<RenpySdkInspection> {
  const explicit = await inspectExplicit(options)
  if (explicit.candidate) {
    return { status: 'ready', candidate: explicit.candidate, explicit: { configured: true, message: explicit.message }, managed: { checked: 0 }, discovered: { checked: 0, roots: [] }, message: `已使用手动选择的 Ren'Py ${explicit.candidate.version} SDK：${explicit.candidate.layout.root}` }
  }
  // An explicit selection is a user decision, not a discovery hint. A broken
  // selected SDK must not be silently replaced (and persisted) by another one.
  if (options.explicitPath?.trim()) return {
    status: 'invalid', candidate: null, explicit: { configured: true, message: explicit.message },
    managed: { checked: 0 }, discovered: { checked: 0, roots: [] }, message: explicit.message
  }
  const candidates = await managedCandidates(options.userDataDir)
  let invalidMessage = ''
  for (const candidatePath of candidates) {
    const layout = await findRenpySdkLayout(candidatePath)
    if (!layout) {
      invalidMessage = '托管 SDK 目录结构不完整'
      continue
    }
    try {
      const candidate = await validateRenpySdkLayout(layout, { source: 'managed', runCommand: options.runCommand })
      return { status: 'ready', candidate, explicit: { configured: Boolean(options.explicitPath?.trim()), message: explicit.message }, managed: { checked: candidates.length }, discovered: { checked: 0, roots: [] }, message: `已使用 DeepWriter 托管 Ren'Py SDK：${candidate.layout.root}` }
    } catch (error) {
      invalidMessage = error instanceof Error ? error.message : '托管 SDK 版本验证失败'
    }
  }
  const discoveryRoots = [...new Set((options.discoveryRoots ?? []).map((value) => path.resolve(value)))]
  const discoveredCandidates = await discoverRenpySdkCandidates(discoveryRoots)
  let discoveredMessage = ''
  for (const candidatePath of discoveredCandidates) {
    const layout = await findRenpySdkLayout(candidatePath)
    if (!layout) continue
    try {
      const candidate = await validateRenpySdkLayout(layout, { source: 'discovered', runCommand: options.runCommand })
      return {
        status: 'ready', candidate,
        explicit: { configured: Boolean(options.explicitPath?.trim()), message: explicit.message },
        managed: { checked: candidates.length, message: invalidMessage || undefined },
        discovered: { checked: discoveredCandidates.length, roots: discoveryRoots },
        message: `已自动发现 Ren'Py ${candidate.version} SDK：${candidate.layout.root}`
      }
    } catch (error) {
      discoveredMessage = error instanceof Error ? error.message : '自动发现的 SDK 版本验证失败'
    }
  }
  const hasAny = Boolean(options.explicitPath?.trim()) || candidates.length > 0 || discoveredCandidates.length > 0
  const checkedText = discoveryRoots.length > 0 ? `已扫描 ${discoveryRoots.length} 个常用位置` : '未配置自动扫描位置'
  const details = [explicit.message, invalidMessage, discoveredMessage].filter(Boolean).join('；')
  const message = hasAny ? details : `未找到 Ren'Py SDK（${checkedText}），可手动选择 SDK 目录或下载官方 ${RENPY_SDK_VERSION} SDK`
  return {
    status: hasAny ? 'invalid' : 'missing', candidate: null,
    explicit: { configured: Boolean(options.explicitPath?.trim()), message: explicit.message },
    managed: { checked: candidates.length, message: invalidMessage || undefined },
    discovered: { checked: discoveredCandidates.length, roots: discoveryRoots, message: discoveredMessage || undefined },
    message
  }
}

function safeZipPath(name: string): string {
  const normalized = name.replace(/\\/g, '/')
  if (!normalized || normalized.includes('\0') || normalized.startsWith('/') || /^[A-Za-z]:\//.test(normalized) || normalized.split('/').some((part) => part === '..')) {
    throw new RenpySdkError('zip_slip', `SDK ZIP 包含不安全路径：${name.slice(0, 200)}`)
  }
  return normalized
}

async function downloadToFile(response: Response, target: string, options: { signal?: AbortSignal; onProgress?: (received: number, total: number | null) => void }): Promise<number> {
  if (!response.body) throw new RenpySdkError('download_failed', '官方 SDK 下载响应没有内容')
  const totalHeader = response.headers.get('content-length')
  const total = totalHeader && /^\d+$/.test(totalHeader) ? Number(totalHeader) : null
  const handle = await fs.open(target, 'wx')
  let received = 0
  try {
    const reader = response.body.getReader()
    for (;;) {
      checkCancelled(options.signal)
      const next = await reader.read()
      if (next.done) break
      const chunk = next.value
      received += chunk.byteLength
      if (received > MAX_DOWNLOAD_BYTES) throw new RenpySdkError('download_failed', 'SDK 下载包超过大小上限')
      const buffer = Buffer.from(chunk)
      let offset = 0
      while (offset < buffer.length) {
        const written = await handle.write(buffer, offset, buffer.length - offset, null)
        offset += written.bytesWritten
      }
      options.onProgress?.(received, total)
    }
    return received
  } finally {
    await handle.close().catch(() => undefined)
  }
}

export async function extractZipSafely(zipPath: string, stage: string, signal?: AbortSignal, onProgress?: (done: number, total: number | null) => void): Promise<void> {
  const root = path.resolve(stage)
  const rootReal = await fs.realpath(root)
  const seen = new Set<string>()
  let entryCount = 0
  let expanded = 0
  let done = 0
  let totalEntries: number | null = null
  let activeFiles = 0
  let streamFinished = false
  let resolveDrain: () => void = () => undefined
  const drained = new Promise<void>((resolve) => { resolveDrain = resolve })
  let extractionError: Error | null = null
  let pending = Promise.resolve()
  const decoders = new Set<{ terminate?: () => void }>()
  const fail = (error: unknown): void => {
    if (!extractionError) extractionError = error instanceof Error ? error : new Error(String(error))
  }
  const unzip = new Unzip((file) => {
    try {
      checkCancelled(signal)
      entryCount++
      if (entryCount > MAX_ZIP_ENTRIES) throw new RenpySdkError('zip_slip', 'SDK ZIP 条目数量超过上限')
      const normalized = safeZipPath(file.name).replace(/\/+$/, '')
      if (!normalized) return
      if (seen.has(normalized)) throw new RenpySdkError('zip_slip', `SDK ZIP 包含重复路径：${file.name}`)
      seen.add(normalized)
      const target = path.resolve(root, ...normalized.split('/'))
      if (target !== root && !target.startsWith(root + path.sep)) throw new RenpySdkError('zip_slip', `SDK ZIP 路径越界：${file.name}`)
      const targetParent = path.dirname(target)
      if (targetParent !== root && !targetParent.startsWith(root + path.sep)) throw new RenpySdkError('zip_slip', `SDK ZIP 父目录越界：${file.name}`)
      if (file.originalSize !== undefined && file.originalSize > MAX_ENTRY_EXPANDED_BYTES) throw new RenpySdkError('download_failed', `SDK ZIP 单条目过大：${file.name}`)
      if (file.name.endsWith('/')) {
        pending = pending.then(() => fs.mkdir(target, { recursive: true }).then(() => undefined))
        return
      }
      activeFiles++
      pending = pending.then(async () => {
        await fs.mkdir(targetParent, { recursive: true })
        const parentReal = await fs.realpath(targetParent)
        if (parentReal !== rootReal && !parentReal.startsWith(rootReal + path.sep)) throw new RenpySdkError('zip_slip', `SDK ZIP 解压目录越界：${file.name}`)
        const handle = await fs.open(target, 'wx')
        let entryBytes = 0
        let closed = false
        let ended = false
        const close = async (): Promise<void> => {
          if (closed) return
          closed = true
          await handle.close().catch(() => undefined)
        }
        file.ondata = (error, data, final) => {
          if (error) {
            fail(error)
            if (!ended) {
              ended = true
              activeFiles--
              if (streamFinished && activeFiles === 0) resolveDrain()
            }
            void close()
            return
          }
          if (data && data.byteLength > 0) {
            try {
              checkCancelled(signal)
              entryBytes += data.byteLength
              expanded += data.byteLength
              if (entryBytes > MAX_ENTRY_EXPANDED_BYTES) throw new RenpySdkError('download_failed', `SDK ZIP 单条目超过展开上限：${file.name}`)
              if (expanded > MAX_EXPANDED_BYTES) throw new RenpySdkError('download_failed', 'SDK 解压后超过大小上限')
              // The decoder owns the callback timing; queue writes in order so
              // no complete entry is retained in memory.
              pending = pending.then(() => handle.write(Buffer.from(data)).then(() => undefined))
            } catch (writeError) {
              fail(writeError)
              void close()
            }
          }
          if (final && !ended) {
            ended = true
            done++
            activeFiles--
            onProgress?.(done, totalEntries)
            pending = pending.then(close)
            if (streamFinished && activeFiles === 0) resolveDrain()
          }
        }
        decoders.add(file)
        file.start()
      }).catch((error) => {
        activeFiles--
        if (streamFinished && activeFiles === 0) resolveDrain()
        fail(error)
      })
    } catch (error) {
      fail(error)
    }
  })
  unzip.register(AsyncUnzipInflate)
  try {
    const stream = createReadStream(zipPath, { highWaterMark: 1024 * 1024 })
    for await (const chunk of stream) {
      checkCancelled(signal)
      if (extractionError) throw extractionError
      unzip.push(new Uint8Array(chunk), false)
    }
    checkCancelled(signal)
    unzip.push(new Uint8Array(0), true)
    streamFinished = true
    if (activeFiles === 0) resolveDrain()
    await drained
    await pending
    if (extractionError) throw extractionError
    if (entryCount === 0) throw new RenpySdkError('zip_slip', 'SDK ZIP 为空')
  } catch (error) {
    for (const decoder of decoders) {
      try { decoder.terminate?.() } catch { /* decoder cleanup is best effort */ }
    }
    await pending.catch(() => undefined)
    try { streamCancel(unzip) } catch { /* parser cleanup is best effort */ }
    throw error
  }
}

function streamCancel(unzip: Unzip): void {
  // fflate's public Unzip API has no terminate method. A no-op helper keeps
  // the catch path explicit while the read stream is closed by for-await.
  void unzip
}

async function hashFile(file: string): Promise<string> {
  const hash = createHash('sha256')
  const stream = createReadStream(file, { highWaterMark: 1024 * 1024 })
  for await (const chunk of stream) hash.update(chunk)
  return hash.digest('hex')
}

export async function runRenpyLint(layout: RenpySdkLayout, projectDir: string, options: { signal?: AbortSignal; runCommand?: SdkCommandRunner } = {}): Promise<RenpyLintExecution> {
  const scriptArg = path.relative(layout.root, layout.renpyScriptPath).replace(/\\/g, '/') || 'renpy.py'
  const command = `${layout.pythonPath} ${scriptArg} ${projectDir} lint --error-code`
  const result = options.runCommand
    ? await options.runCommand(layout.pythonPath, [scriptArg, projectDir, 'lint', '--error-code'], layout.root, options.signal)
    : await defaultCommandRunner(layout.pythonPath, [scriptArg, projectDir, 'lint', '--error-code'], layout.root, options.signal, 120_000)
  return { ok: result.code === 0 && !result.cancelled, output: result.output, exitCode: result.code, command, verified: true, cancelled: result.cancelled }
}

export async function downloadAndInstallManagedSdk(options: SdkDownloadOptions): Promise<RenpySdkCandidate> {
  const signal = options.signal
  checkCancelled(signal)
  const fetchImpl = options.fetchImpl ?? (globalThis.fetch as unknown as SdkFetch)
  if (typeof fetchImpl !== 'function') throw new RenpySdkError('download_failed', '当前环境不支持 HTTPS 下载')
  const root = managedSdkRoot(options.userDataDir)
  const installs = managedSdkInstallsDir(options.userDataDir)
  await fs.mkdir(installs, { recursive: true })
  const downloadPath = path.join(root, `.download-${nonce()}.zip`)
  const stage = path.join(root, `.staging-${nonce()}`)
  let keepStage = false
  try {
    options.onProgress?.({ phase: 'download', receivedBytes: 0, totalBytes: null, percent: 0, message: '正在下载官方 Ren\'Py SDK…' })
    const response = await fetchImpl(RENPY_SDK_DOWNLOAD_URL, { redirect: 'error', signal })
    if (!response.ok) throw new RenpySdkError('download_failed', `官方 SDK 下载失败（HTTP ${response.status}）`)
    if (response.redirected) throw new RenpySdkError('download_failed', '官方 SDK 下载发生了未允许的重定向')
    if (response.url) {
      const finalUrl = new URL(response.url)
      const officialUrl = new URL(RENPY_SDK_DOWNLOAD_URL)
      if (finalUrl.protocol !== officialUrl.protocol || finalUrl.hostname !== officialUrl.hostname || finalUrl.pathname !== officialUrl.pathname || finalUrl.search !== officialUrl.search || finalUrl.username || finalUrl.password) {
        throw new RenpySdkError('download_failed', '官方 SDK 下载最终地址不是固定官方来源')
      }
    }
    let totalBytes: number | null = null
    const totalHeader = response.headers.get('content-length')
    if (totalHeader && /^\d+$/.test(totalHeader)) totalBytes = Number(totalHeader)
    await downloadToFile(response, downloadPath, {
      signal,
      onProgress: (received, total) => {
        totalBytes = total
        options.onProgress?.({ phase: 'download', receivedBytes: received, totalBytes: total, percent: total ? Math.round(received / total * 100) : null, message: '正在下载官方 Ren\'Py SDK…' })
      }
    })
    checkCancelled(signal)
    options.onProgress?.({ phase: 'verify', receivedBytes: totalBytes ?? undefined, totalBytes, percent: 100, message: '正在校验 SDK SHA-256…' })
    const digest = await hashFile(downloadPath)
    if (digest !== RENPY_SDK_SHA256) throw new RenpySdkError('hash_mismatch', `SDK SHA-256 校验失败：收到 ${digest}`)
    let finalDir = path.join(installs, digest.slice(0, 32))
    const existing = await findRenpySdkLayout(finalDir)
    if (existing) {
      const candidate = await validateRenpySdkLayout(existing, { source: 'managed', runCommand: options.runCommand })
      return candidate
    }
    if (await fs.stat(finalDir).then(() => true).catch(() => false)) finalDir = path.join(installs, `${digest.slice(0, 32)}-${nonce()}`)
    await fs.rm(stage, { recursive: true, force: true }).catch(() => undefined)
    await fs.mkdir(stage, { recursive: true })
    options.onProgress?.({ phase: 'extract', percent: 0, message: '正在安全解压 SDK…' })
    await extractZipSafely(downloadPath, stage, signal, (done, total) => options.onProgress?.({ phase: 'extract', percent: total ? Math.round(done / total * 100) : null, message: `正在解压 SDK（${done}${total ? `/${total}` : ''}）…` }))
    checkCancelled(signal)
    const stagedLayout = await findRenpySdkLayout(stage)
    if (!stagedLayout) throw new RenpySdkError('invalid', 'SDK ZIP 解压后缺少官方运行结构')
    options.onProgress?.({ phase: 'validate', percent: 0, message: '正在验证 SDK 版本…' })
    const validated = await validateRenpySdkLayout(stagedLayout, { source: 'managed', runCommand: options.runCommand })
    checkCancelled(signal)
    // Never replace an existing install. A complete staged directory is made
    // visible with one rename; failed downloads leave old installs untouched.
    await fs.rename(stage, finalDir)
    keepStage = true
    const relativeRoot = path.relative(stage, stagedLayout.root)
    const finalLayout = await findRenpySdkLayout(relativeRoot ? path.join(finalDir, relativeRoot) : finalDir)
    if (!finalLayout) throw new RenpySdkError('invalid', 'SDK 原子安装后结构验证失败')
    const result = await validateRenpySdkLayout(finalLayout, { source: 'managed', runCommand: options.runCommand })
    options.onProgress?.({ phase: 'installed', percent: 100, message: `Ren\'Py ${RENPY_SDK_VERSION} SDK 已安装` })
    return result
  } catch (error) {
    if (error instanceof RenpySdkError) throw error
    throw new RenpySdkError('download_failed', error instanceof Error ? error.message : 'SDK 下载失败')
  } finally {
    await fs.rm(downloadPath, { force: true }).catch(() => undefined)
    if (!keepStage) await fs.rm(stage, { recursive: true, force: true }).catch(() => undefined)
    const remaining = await fs.readdir(installs).catch(() => [] as string[])
    if (!keepStage && remaining.length === 0) {
      // No completed install is present, so this directory is entirely owned
      // by the current attempt; remove it even if a failed stream left a
      // transient entry that is not an install.
      await fs.rm(root, { recursive: true, force: true }).catch(() => undefined)
      // Keep the managed parent tidy after a cancelled/failed first install.
      // `root` is the version directory; removing it alone leaves an empty
      // `renpy-sdk/` marker which callers reasonably treat as a half install.
      const managedParent = path.dirname(root)
      const parentEntries = await fs.readdir(managedParent).catch(() => [] as string[])
      if (parentEntries.length === 0) await fs.rm(managedParent, { recursive: true, force: true }).catch(() => undefined)
    }
  }
}

export function officialSdkManifest(): typeof RENPY_SDK_MANIFEST {
  return RENPY_SDK_MANIFEST
}
