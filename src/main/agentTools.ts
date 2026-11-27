import { app, dialog } from 'electron'
import { runProcess } from './commandProcess'
import { readFilePage } from './fileReadPage'
import { searchFileText } from './fileSearch'
import { readDocumentPage } from './documentReadPage'
import { pdfTextAvailable } from './pdfText'
import { readProjectArchiveResult } from './projectArchive'
import { sourceFromReadPage } from './fileEvidence'
import { isUnsupportedTextHead } from './fileTextProbe'
import { createWorkFileTools, relativeFileGlob } from './workFileTools'
import { planManuscriptEdit, decodeManuscript, ManuscriptEditMatchError } from './manuscriptEdit'
import { boundedInteger, readTextBounded, writeTextAtomically } from './agentFiles'
import type { CommandResult, PermissionDecision } from '../shared/types'
export type { CommandResult } from '../shared/types'
import { promises as fs } from 'fs'
import * as fsSync from 'fs'
import * as path from 'path'
import type { AgentEnv, ToolDef, ToolResult } from './tools'
import { assertPathAllowed, resolveRealPath } from './tools'
import { isSafeAutoCommand, parseCommandLine, CMD_BUILTINS, type PermissionManager } from './permissions'
import { getCheckpointStore, makeDiff } from './checkpoint'
import { makeFileEditUndoMetadata } from './editUndo'
import type { PermissionOperation } from '../shared/permissionRequest'
import type { PermissionIdentity } from './permissions'

export type { AgentEnv } from './tools'

/** R4.2 A2：从 AgentEnv 构造权限判定 identity（缺省字段不参与 lease 匹配） */
export function identityFromEnv(env?: AgentEnv): PermissionIdentity {
  if (!env) return {}
  return { webContentsId: env.webContentsId, sessionId: env.sessionId, runId: env.runId, signal: env.signal, permissionMode: env.permissionMode, workspaceRoot: env.permissionWorkspaceRoot, legacyReadRoots: [env.workDir, env.docDir], nonInteractive: env.nonInteractiveLocalRead, goalMode: env.goalMode, commandCwd: env.workDir }
}

let permissionManager: PermissionManager | null = null

export function setPermissionManager(pm: PermissionManager | null): void {
  permissionManager = pm
}

export function getPermissionManager(): PermissionManager | null {
  return permissionManager
}

let sessionTrusted = false

export function setSessionTrusted(v: boolean): void {
  sessionTrusted = v
}

export function isSessionTrusted(): boolean {
  return sessionTrusted
}

const CMD_TIMEOUT_MS = 90_000
const MAX_OUTPUT = 200_000

/** cmd.exe 元字符前置 ^ 转义（用于拼接 /c 参数，双引号不转义 & | < > 等） */
function quoteCmdToken(t: string): string {
  let out = ''
  for (const ch of t) out += /[&|<>^()]/.test(ch) ? `^${ch}` : ch
  if (/[ \t]/.test(out)) return `"${out}"`
  return out
}

/** 参数解析后的绝对路径（相对 cwd 解析）；失败返回 null */
function resolveArgPath(arg: string, cwd: string): string | null {
  if (!arg || arg.startsWith('-') || (process.platform === 'win32' && arg.startsWith('/'))) return null
  const p = path.isAbsolute(arg) ? arg : path.join(cwd, arg)
  return path.resolve(p)
}

/** realpath 前缀 containment（resolveRealPath 逐级解析防 junction/symlink 逃逸） */
async function withinReal(p: string, root: string): Promise<boolean> {
  try {
    const rp = await resolveRealPath(path.resolve(p))
    const rr = await resolveRealPath(path.resolve(root))
    return rp === rr || rp.toLowerCase().startsWith(rr.toLowerCase() + path.sep)
  } catch {
    return false
  }
}

/**
 * 安全执行：`type` 的原生实现（只读、路径 containment 强制）。
 * `type` 是 cmd 内置命令，不能 spawn 独立进程；用 fs 实现且只允许读取工作目录内文件。
 */
async function execType(argv: string[], cwd: string): Promise<CommandResult> {
  const out: string[] = []
  for (const arg of argv.slice(1)) {
    const p = resolveArgPath(arg, cwd)
    if (!p) continue
    if (!(await withinReal(p, cwd))) return { exitCode: 1, stdout: '', stderr: `拒绝：${arg} 越出工作目录`, timedOut: false, durationMs: 0 }
    try {
      const st = await fs.stat(p)
      if (st.isDirectory()) {
        out.push(`${arg}：是目录`)
        continue
      }
      if (st.size > 20 * 1024 * 1024) {
        out.push(`${arg}：文件过大（${Math.round(st.size / 1024 / 1024)}MB），拒绝读取`)
        continue
      }
      out.push(await fs.readFile(p, 'utf-8'))
    } catch (e) {
      out.push(`${arg}：读取失败（${(e as Error).message}）`)
    }
  }
  const text = out.join('\n')
  return { exitCode: 0, stdout: text.slice(-MAX_OUTPUT), stderr: '', timedOut: false, durationMs: 0 }
}

/** `findstr` 原生实现：`findstr [/i] [/s] "pattern" file...`，路径 containment 强制 */
async function execFindstr(argv: string[], cwd: string): Promise<CommandResult> {
  let caseInsensitive = false
  let recursive = false
  const rest: string[] = []
  for (const a of argv.slice(1)) {
    if (a === '/i' || a === '-i') caseInsensitive = true
    else if (a === '/s' || a === '-s') recursive = true
    else rest.push(a)
  }
  if (rest.length < 2) return { exitCode: 1, stdout: '', stderr: '用法：findstr [/i] [/s] "pattern" file...', timedOut: false, durationMs: 0 }
  const pattern = rest[0]
  let regex: RegExp
  try {
    regex = new RegExp(pattern, caseInsensitive ? 'i' : '')
  } catch {
    return { exitCode: 1, stdout: '', stderr: `无效正则：${pattern}`, timedOut: false, durationMs: 0 }
  }
  const files = rest.slice(1)
  const hits: string[] = []
  const walk = async (dir: string, depth: number): Promise<void> => {
    if (hits.length >= 500) return
    let entries
    try {
      entries = await fs.readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      if (hits.length >= 500) return
      const full = path.join(dir, e.name)
      if (e.isDirectory()) {
        if (recursive && depth > 0) await walk(full, depth - 1)
        continue
      }
      try {
        if ((await fs.stat(full)).size > 2_000_000) continue
        const content = await fs.readFile(full, 'utf-8')
        const lines = content.split('\n')
        for (let i = 0; i < lines.length && hits.length < 500; i++) {
          if (regex.test(lines[i].slice(0, 4000))) hits.push(`${path.relative(cwd, full)}:${i + 1}: ${lines[i].slice(0, 220)}`)
        }
      } catch {
        /* unreadable */
      }
    }
  }
  for (const f of files) {
    const p = resolveArgPath(f, cwd)
    if (!p) continue
    if (!(await withinReal(p, cwd))) return { exitCode: 1, stdout: '', stderr: `拒绝：${f} 越出工作目录`, timedOut: false, durationMs: 0 }
    const st = await fs.stat(p).catch(() => null)
    if (!st) {
      hits.push(`${f}：不存在`)
      continue
    }
    if (st.isDirectory()) await walk(p, 3)
    else {
      try {
        const content = await fs.readFile(p, 'utf-8')
        const lines = content.split('\n')
        for (let i = 0; i < lines.length && hits.length < 500; i++) {
          if (regex.test(lines[i].slice(0, 4000))) hits.push(`${path.relative(cwd, p)}:${i + 1}: ${lines[i].slice(0, 220)}`)
        }
      } catch (e) {
        hits.push(`${f}：读取失败（${(e as Error).message}）`)
      }
    }
  }
  const text = hits.length > 0 ? hits.join('\n') : ''
  return { exitCode: 0, stdout: text.slice(-MAX_OUTPUT), stderr: '', timedOut: false, durationMs: 0 }
}

/** `dir`/`ls` 原生实现：列目录（单层），路径 containment 强制 */
async function execDir(argv: string[], cwd: string): Promise<CommandResult> {
  let target = cwd
  for (const a of argv.slice(1)) {
    if (a === '-la' || a === '-l' || a === '-a' || a === '/a' || a === '/b' || a === '/s') continue
    const p = resolveArgPath(a, cwd)
    if (p) target = p
  }
  if (!(await withinReal(target, cwd))) return { exitCode: 1, stdout: '', stderr: `拒绝：${target} 越出工作目录`, timedOut: false, durationMs: 0 }
  try {
    const entries = await fs.readdir(target, { withFileTypes: true })
    const lines = entries.map((e) => {
      const p = path.join(target, e.name)
      const size = e.isFile() ? `${(fsSync.statSync(p).size / 1024).toFixed(1)}KB` : ''
      return `${e.isDirectory() ? '[DIR] ' : '[FILE]'} ${e.name}${size ? `  ${size}` : ''}`
    })
    return { exitCode: 0, stdout: `目录 ${target}：\n${lines.join('\n')}`, stderr: '', timedOut: false, durationMs: 0 }
  } catch (e) {
    return { exitCode: 1, stdout: '', stderr: `列目录失败：${(e as Error).message}`, timedOut: false, durationMs: 0 }
  }
}

/** 用 cmd.exe /d /s /c 执行 .cmd/.bat（token 已过滤未引用元字符 + ^ 转义，注入面关闭） */
function runCmdScript(script: string, args: string[], cwd: string, timeoutMs: number, signal?: AbortSignal): Promise<CommandResult> {
  const line = [script, ...args].map(quoteCmdToken).join(' ')
  return runProcess(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', line], cwd, timeoutMs, signal)
}

/**
 * 执行命令（Gate 1 / P0-01）：
 * - 不再使用 shell:true；命令先经 parseCommandLine 拆为 argv（未引用元字符直接拒绝）
 * - cmd 内置命令（type/dir/findstr/echo/cd/pwd 等）由 Node 原生实现，路径参数强制 realpath containment
 * - 其他可执行文件以 spawn(argv, shell:false) 执行；Windows 上 .cmd/.bat 走 cmd.exe /d /s /c + ^ 转义
 */
export async function runCommand(cmd: string, cwd: string, timeoutMs = CMD_TIMEOUT_MS, signal?: AbortSignal): Promise<CommandResult> {
  const argv = parseCommandLine(cmd)
  if (!argv) return { exitCode: 1, stdout: '', stderr: '命令含未加引号的 shell 元字符或无法解析，已拒绝执行', timedOut: false, durationMs: 0 }
  const program = argv[0]
  // R4-4：取消信号——已中止则不启动新进程
  if (signal?.aborted) return { exitCode: null, stdout: '', stderr: '已取消', timedOut: false, cancelled: true, durationMs: 0 }

  // ---- cmd 内置命令：Node 原生实现（自动放行只读命令时同样走这里，containment 强制） ----
  if (CMD_BUILTINS.has(program)) {
    if (program === 'type') return execType(argv, cwd)
    if (program === 'findstr') return execFindstr(argv, cwd)
    if (program === 'dir' || program === 'ls') return execDir(argv, cwd)
    if (program === 'echo') return { exitCode: 0, stdout: argv.slice(1).join(' '), stderr: '', timedOut: false, durationMs: 0 }
    if (program === 'pwd') return { exitCode: 0, stdout: cwd, stderr: '', timedOut: false, durationMs: 0 }
    if (program === 'cd') return { exitCode: 1, stdout: '', stderr: 'cd 不改变工作目录（每次运行固定在工作目录内），请改用路径参数', timedOut: false, durationMs: 0 }
    if (program === 'where' || program === 'tasklist') return { exitCode: 1, stdout: '', stderr: `系统命令 ${program} 已禁用（避免系统信息泄漏）`, timedOut: false, durationMs: 0 }
  }

  if (process.platform === 'win32') {
    return runWithExtension(program, argv.slice(1), cwd, timeoutMs, signal)
  }
  return runProcess(program, argv.slice(1), cwd, timeoutMs, signal)
}

async function runWithExtension(program: string, args: string[], cwd: string, timeoutMs: number, signal?: AbortSignal): Promise<CommandResult> {
  if (path.extname(program)) {
    return /\.(cmd|bat)$/i.test(program)
      ? runCmdScript(program, args, cwd, timeoutMs, signal)
      : runProcess(program, args, cwd, timeoutMs, signal)
  }
  const dirs = [cwd, ...(process.env.PATH ?? '').split(';').filter(Boolean)]
  for (const dir of dirs) {
    for (const ext of ['.exe', '.cmd', '.bat', '.com']) {
      const candidate = path.resolve(dir, `${program}${ext}`)
      try { await fs.access(candidate) } catch { continue }
      return /\.(cmd|bat)$/i.test(candidate)
        ? runCmdScript(candidate, args, cwd, timeoutMs, signal)
        : runProcess(candidate, args, cwd, timeoutMs, signal)
    }
  }
  return runProcess(program, args, cwd, timeoutMs, signal)
}

function isWithin(p: string, root: string): boolean {
  const a = path.resolve(p)
  const r = path.resolve(root)
  return a === r || a.toLowerCase().startsWith(r.toLowerCase() + path.sep)
}

/**
 * 读路径授权：realpath 前缀检查是否在允许根（workDir/docDir/defaultDir/temp）内。
 * 工作区内直接放行（不弹窗）；越界才走权限决策。
 */
async function readPermission(p: string, defaultDir: string, env?: AgentEnv): Promise<PermissionDecision> {
  if (env?.nonInteractiveLocalRead && !(await withinReal(p, env.workDir)) && !(await withinReal(p, env.docDir))) return { action: 'deny', reason: '后台读取范围之外的路径需要额外授权，当前不允许发起交互确认' }
  if (permissionManager) return permissionManager.decide('path', await resolveRealPath(path.resolve(p)), { ...identityFromEnv(env), operation: 'read' })
  if (env?.goalMode === 'autonomous') return { action: 'deny', reason: '自主任务授权服务不可用，文件未读取' }
  const roots = [env?.workDir, env?.docDir, defaultDir, app.getPath('temp')].filter((r): r is string => Boolean(r))
  try {
    const norm = await resolveRealPath(path.resolve(p))
    const realRoots: string[] = []
    for (const r of roots) {
      try {
        realRoots.push(await resolveRealPath(path.resolve(r)))
      } catch {
        /* 根目录不存在则跳过 */
      }
    }
    for (const rr of realRoots) {
      if (norm === rr || norm.toLowerCase().startsWith(rr.toLowerCase() + path.sep)) return { action: 'allow', reason: '已授权目录内读取' }
    }
  } catch {
    return { action: 'deny', reason: '无法确认路径的读取授权，未读取' }
  }
  return { action: 'deny', reason: '此路径尚未获得读取授权' }
}

export async function fileOperationPermission(p: string, defaultDir: string, env: AgentEnv | undefined, operation: PermissionOperation | 'write'): Promise<PermissionDecision> {
  const target = await resolveRealPath(path.resolve(p))
  const resolvedOperation = operation === 'write' ? (await fs.stat(target).catch(() => null)) ? 'overwrite' : 'create' : operation
  if (permissionManager) return permissionManager.decide('path', target, { ...identityFromEnv(env), operation: resolvedOperation })
  if (env?.goalMode === 'autonomous') return { action: 'deny', reason: '自主任务授权服务不可用，文件未写入' }
  const allowed = await assertPathAllowed(target, [env?.workDir ?? defaultDir, defaultDir])
  return { action: allowed ? 'allow' : 'deny', reason: allowed ? '已获得路径授权' : '路径写入未获批准' }
}

function truncate(s: string, max = 16000): string {
  if (s.length <= max) return s
  return s.slice(0, max) + `\n…（已截断，共 ${s.length} 字符）`
}

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}

const IGNORE_DIRS = new Set(['node_modules', '.git', 'out', 'dist', 'build', '__pycache__', '.venv', 'venv', 'env'])

const isTextFile = (name: string): boolean =>
  !/\.(png|jpe?g|gif|bmp|ico|webp|pdf|docx?|xlsx?|pptx?|epub|odt|zip|rar|7z|exe|dll|so|dylib|bin|dat|class|pyc|woff2?|ttf|otf|mp4|mp3|wav|avi|mkv)$/i.test(name)

async function listTree(dir: string, depth: number, signal?: AbortSignal): Promise<string> {
  const lines: string[] = []
  let length = 0
  let truncated = false
  const walk = async (current: string, remaining: number, prefix: string): Promise<void> => {
    const directory = await fs.opendir(current)
    for await (const entry of directory) {
      signal?.throwIfAborted()
      if (entry.name.startsWith('.') || (entry.isDirectory() && IGNORE_DIRS.has(entry.name))) continue
      const line = `${prefix}${entry.name}${entry.isDirectory() ? '/' : ''}\n`
      if (length + line.length > 16000) { truncated = true; break }
      lines.push(line)
      length += line.length
      if (entry.isDirectory() && remaining > 0) await walk(path.join(current, entry.name), remaining - 1, prefix + '  ')
      if (truncated) break
    }
  }
  await walk(dir, depth, '')
  return lines.join('') + (truncated ? '…（目录较大，请指定子目录继续查看）' : '')
}

const readableDocuments = pdfTextAvailable ? 'DOCX/XLSX/PPTX/PDF/EPUB' : 'DOCX/XLSX/PPTX/EPUB'
const pdfHint = pdfTextAvailable ? '' : 'PDF请用桌面版。'
export const agentTools: ToolDef[] = [
  {
    name: 'list_files',
    description: '列出目录结构与文件列表（跳过 node_modules/.git 等）。适合探索代码库/项目。',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '目标目录，相对工作目录或绝对路径' },
        depth: { type: 'number', description: '递归深度，默认 2' }
      }
    },
    async execute(args, defaultDir, env) {
      const base = env?.workDir ?? defaultDir
      const target = args.path ? (path.isAbsolute(String(args.path)) ? String(args.path) : path.join(base, String(args.path))) : base
      const permission = await readPermission(target, defaultDir, env)
      if (permission.action !== 'allow') return { ok: false, message: `未读取目录：${permission.reason}` }
      if (env?.signal?.aborted) return { ok: false, message: '任务已停止' }
      try {
        const tree = await listTree(target, boundedInteger(args.depth, 2, 0, 4), env?.signal)
        return { ok: true, message: tree ? `目录结构：\n${tree}` : '（空目录）', name: 'list_files' }
      } catch (error) {
        return { ok: false, message: `列目录失败：${(error as Error).message}` }
      }
    }
  },
  {
    name: 'read_file',
    description: `读取文本、${readableDocuments}的正文或指定ZIP的目录/文本条目。${pdfHint}ZIP先列目录，再用archive_entry读原路径。文档行列指提取文本，不是排版页码，不做OCR。搜索后用cursor读原文，或用start_line/start_column定位。行列从1按Unicode码点计数，终点不含；续读用返回的cursor。`,
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '文件路径' },
        start_line: { type: 'integer', minimum: 1, description: '起始行（从 1 开始）。不与 cursor 同用' },
        start_column: { type: 'integer', minimum: 1, description: '起始列（从1按Unicode码点计数；含CR/BOM），默认1；不与 cursor 同用。长段落使用搜索返回的位置' },
        line_count: { type: 'integer', minimum: 1, maximum: 1000, description: '最多读取的行数，分页默认 100' },
        cursor: { type: 'string', description: '上一页返回的续读位置；沿用同一路径' },
        archive_entry: { type: 'string', description: '仅ZIP：目录返回的完整条目原路径，区分大小写；条目续读须保留它。不指定时列ZIP目录，目录cursor可继续列。' },
        max_chars: { type: 'integer', minimum: 1, maximum: 400000, description: '分页按Unicode码点计，每次最多8000。文档/ZIP始终分页；普通文本单独指定且无行/列/cursor时沿用旧版UTF-16前缀上限' }
      },
      required: ['path']
    },
    async execute(args, defaultDir, env) {
      if (typeof args.path === 'string' && args.path.startsWith('attachment:')) {
        if (!env?.readAttachment) return { ok: false, message: '本次运行没有此附件；工作目录里的ZIP请使用文件路径' }
        try {
          const read = await env.readAttachment(args, env.readBudgetChars)
          return { ok: true, name: 'read_file', ...(typeof read === 'string' ? { message: read } : read) }
        }
        catch (error) { return { ok: false, message: `附件读取失败：${(error as Error).message}` } }
      }
      const base = env?.workDir ?? defaultDir
      const p = path.isAbsolute(String(args.path)) ? String(args.path) : path.join(base, String(args.path))
      const permission = await readPermission(p, defaultDir, env)
      if (permission.action !== 'allow') return { ok: false, message: `文件读取未执行：${permission.reason}` }
      try {
        const st = await fs.stat(p)
        if (st.isDirectory()) return { ok: false, message: `${p} 是目录，请用 list_files` }
        if (/\.zip$/i.test(p)) return { name: 'read_file', path: p, ...await readProjectArchiveResult(p, args, env?.signal, undefined, path.resolve(p), path.relative(base, p) || path.basename(p), env?.readBudgetChars) }
        if (args.archive_entry !== undefined) return { ok: false, message: 'archive_entry 仅适用于ZIP文件；其他文档直接按行列/cursor读取' }
        if (/\.(docx|xlsx|pptx|pdf|epub)$/i.test(p)) {
          const page = await readDocumentPage(p, args, env?.signal, env?.readBudgetChars)
          if (page.budgetLimited) return { ok: false, name: 'read_file', path: p, message: `read_input_budget_insufficient：本次未展示 ${path.relative(base, p) || path.basename(p)} 的正文，不能据此回答内容。原定位 ${page.first}:${page.firstColumn}；请精确定位/缩小本次输入或使用更大窗口后重读，未自动续读。` }
          const next = (page.budgetLimited ? '本次模型输入预算不足，正文未展示；' : '') + (page.cursor ? `续读 cursor=${page.cursor}` : page.truncated ? '已到提取上限；后续未读取，不能视为全文完毕' : '已到提取文本末尾')
          const label = /\.docx$/i.test(p) ? 'DOCX' : path.extname(p).slice(1).toUpperCase()
          const detail = label === 'DOCX' ? '仅正文提取文本（行号不是Word页码；不含图片/OCR；输入≤20MB，解压≤32MB，提取≤300000个UTF-16单位）'
            : label === 'PDF' ? '仅PDF文字层（正文页标记来自PDF，行列是提取文本位置而非页面坐标；不做OCR，图像/扫描内容仍未读取；输入≤20MB，提取≤300000个UTF-16单位）'
            : label === 'EPUB' ? '按spine章节顺序提取正文（章节路径见正文，行号不是排版页码；不执行脚本/外部加载/图片OCR；输入≤20MB，单章≤8MB/累计读取≤32MB，提取≤300000个UTF-16单位）'
            : '结构提取文本（工作表/单元格或幻灯片标记见正文；行号不是Office页码；不含图片/OCR、公式计算或执行宏；输入≤20MB，XML单项≤8MB/累计≤32MB，提取≤300000个UTF-16单位）'
          return { ok: true, name: 'read_file', path: p, sources: sourceFromReadPage({ path: path.resolve(p), displayName: path.basename(p), kind: 'document', page, extractionTruncated: page.truncated }),
            message: `${label} ${path.relative(base, p) || path.basename(p)}：${detail}\n提取范围 [${page.first}:${page.firstColumn}, ${page.endLine}:${page.endColumn})，列按Unicode码点；${next}${page.truncated ? '；提取已截断，原文仍有未读内容' : ''}\n${page.text}` }
        }
        if (/\.(doc|xls|ppt)$/i.test(p)) return { ok: false, message: '旧版 Office 二进制格式尚不支持，未提取正文；请另存为 DOCX/XLSX/PPTX 或纯文本后读取。' }
        if (/\.(png|jpe?g|gif|bmp|ico|webp|tiff?)$/i.test(p)) return { ok: false, message: '这是图片文件，read_file 不读取图像内容或执行 OCR；尚未读到图片中的文字。桌面可直接把同一文件添加为图片素材。' }
        if (!isTextFile(p)) return { ok: false, message: `${path.basename(p)} 是二进制文件，无法读取（${fmtBytes(st.size)}）` }
        if (!st.isFile()) return { ok: false, message: '不是普通文本文件，未读取' }
        // An unfamiliar extension is not proof of text. Prevent NUL-bearing
        // binaries and renamed common containers from becoming model prose.
        const probe = await fs.open(p, 'r')
        try {
          const sample = Buffer.alloc(4096), { bytesRead } = await probe.read(sample, 0, sample.length, 0), head = sample.subarray(0, bytesRead)
          if (isUnsupportedTextHead(head)) return { ok: false, message: '文件头含二进制格式或不支持的文本编码，未按普通正文读取；请使用正确的文档格式或UTF-8文本。' }
        } finally { await probe.close() }
        if (args.start_line !== undefined || args.start_column !== undefined || args.line_count !== undefined || args.cursor !== undefined || env?.readBudgetChars !== undefined || (env?.pagedFileReads && args.max_chars === undefined)) {
          if (!st.isFile()) return { ok: false, message: '不是普通文本文件' }
          const page = await readFilePage(p, args, env?.signal, env?.readBudgetChars)
          if (page.budgetLimited) return { ok: false, name: 'read_file', path: p, message: `read_input_budget_insufficient：本次未展示 ${path.relative(base, p) || path.basename(p)} 的正文，不能据此判断文件为空。原定位 ${page.first}:${page.firstColumn}；请精确定位/缩小本次输入或使用更大窗口后重读，未自动续读。` }
          const span = page.text ? (page.first === page.last ? `第 ${page.first} 行` : `第 ${page.first}–${page.last} 行`) : page.budgetLimited ? '本次模型输入预算不足，正文未展示' : '空文件'
          const next = page.cursor ? `；续读 cursor=${page.cursor}` : '；已到文件末尾'
          const range = `；Unicode码点范围 [${page.first}:${page.firstColumn}, ${page.endLine}:${page.endColumn})`
          return { ok: true, message: `文件 ${path.relative(base, p) || path.basename(p)}（${span}${range}${next}）：\n${page.text}`, name: 'read_file', path: p,
            sources: sourceFromReadPage({ path: path.resolve(p), displayName: path.basename(p), kind: 'text', page }) }
        }
        const max = boundedInteger(args.max_chars, 60000, 1, 400000)
        const content = await readTextBounded(p, max + 1, env?.signal)
        const shown = content.length > max ? content.slice(0, max) + '\n…（已截断，可增加 max_chars 读取）' : content
        return { ok: true, message: `文件 ${p}（${fmtBytes(st.size)}）:\n${shown}`, name: 'read_file', path: p }
      } catch (e) {
        return { ok: false, message: `读取失败: ${(e as Error).message}` }
      }
    }
  },
  {
    name: 'write_file',
    description: '写入/覆盖文件内容（自动创建目录）。适合生成代码、脚本、文档。',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '文件路径（工作目录内）' },
        content: { type: 'string', description: '完整文件内容' }
      },
      required: ['path', 'content']
    },
    async execute(args, defaultDir, env) {
      const base = env?.workDir ?? defaultDir
      const p = path.isAbsolute(String(args.path)) ? String(args.path) : path.join(base, String(args.path))
      const authorizedTarget = await resolveRealPath(path.resolve(p))
      const initiallyExisted = Boolean(await fs.stat(authorizedTarget).catch(() => null))
      const permission = await fileOperationPermission(authorizedTarget, defaultDir, env, 'write')
      if (permission.action !== 'allow') return { ok: false, message: `文件写入未执行：${permission.reason}` }
      if (await resolveRealPath(path.resolve(p)) !== authorizedTarget) return { ok: false, message: '授权后文件位置已变动，请重试' }
      if (env?.signal?.aborted) return { ok: false, message: '任务已停止，未写入文件' }
      const newContent = String(args.content ?? '')
      const cp = env?.sessionId ? getCheckpointStore() : null
      let backupId = ''
      let existed = false
      let oldContent: string | null = null
      if (cp) {
        const b = await cp.beforeWrite(p, env!.sessionId!)
        backupId = b.backupId
        existed = b.existed
        if (existed && env?.includeFileDiff !== false) {
          try {
            oldContent = await fs.readFile(p, 'utf-8')
          } catch {
            oldContent = null
          }
        }
      }
      try {
        await writeTextAtomically(authorizedTarget, newContent, env?.signal, async () => {
          if (await resolveRealPath(path.resolve(p)) !== authorizedTarget || !initiallyExisted && await fs.stat(authorizedTarget).catch(() => null)) throw new Error('写入目标已变动，请重读后再写入')
        })
        const st = await fs.stat(p)
        const res: ToolResult = { ok: true, message: `已写入 ${p}（${fmtBytes(st.size)}）`, name: 'write_file', path: p, size: st.size }
        if (backupId) res.backupId = backupId
        if (existed && oldContent !== null) {
          const d = makeDiff(oldContent, newContent, p)
          if (d) {
            res.diffText = d.content
            res.diffAdded = d.added
            res.diffRemoved = d.removed
            res.diffPath = d.path
          }
        }
        return res
      } catch (e) {
        return { ok: false, message: `写入失败: ${(e as Error).message}` }
      }
    }
  },
  {
    name: 'edit_file',
    description: '局部改稿。用读到的原文精确替换，不改无关段落。重复原文可用 at_line 定位；仅在要求全文统一替换时使用 replace_all。引号或空白不同只返回原文候选，不自动改写；核对后用 editRecovery.candidates 中 retry 的 old_text/at_line 重试。',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '文件路径' },
        old_text: { type: 'string', description: '稿件中的原文，不是正则表达式' },
        new_text: { type: 'string', description: '按原样写入的新文本；空字符串表示删除' },
        at_line: { type: 'integer', minimum: 1, description: '只改从指定行开始的唯一匹配；行号从 1 开始' },
        replace_all: { type: 'boolean', description: '显式替换整份文件中全部匹配，不与 at_line 同用' }
      },
      required: ['path', 'old_text', 'new_text']
    },
    async execute(args, defaultDir, env) {
      if (typeof args.path !== 'string' || !args.path.trim()) return { ok: false, message: '需要稿件的文件路径' }
      const base = env?.workDir ?? defaultDir, p = path.resolve(base, args.path)
      try {
        env?.signal?.throwIfAborted()
        const target = await fs.realpath(p)
        const stat = await fs.stat(target)
        if (!stat.isFile() || !isTextFile(target)) throw new Error('请选择可编辑的文本文件')
        const cp = env?.sessionId ? getCheckpointStore() : null
        const authorizedOverwrite = !cp || Buffer.byteLength(String(args.old_text ?? ''), 'utf8') >= stat.size / 2
        const permission = await fileOperationPermission(target, defaultDir, env, authorizedOverwrite ? 'overwrite' : 'edit')
        if (permission.action !== 'allow') return { ok: false, message: `文件修改未执行：${permission.reason}` }
        const original = await fs.readFile(target, { signal: env?.signal })
        const content = decodeManuscript(original)
        const edit = planManuscriptEdit(content, args)
        const label = path.relative(base, p) || path.basename(p)
        if (edit.text === content) return { ok: true, name: 'edit_file', path: p, message: label + '：内容没有变化，未写盘', edit: { count: 0, lines: [] } }
        const originalChars = Array.from(content.replace(/\r\n/g, '\n')).length
        const replacedChars = edit.count * Array.from(String(args.old_text).replace(/\r\n/g, '\n')).length
        const insertedChars = edit.count * Array.from(String(args.new_text).replace(/\r\n/g, '\n')).length
        const affectedChars = Math.max(replacedChars, insertedChars)
        const highImpact = affectedChars >= 4096 || affectedChars >= originalChars / 2
        if (!authorizedOverwrite && highImpact) {
          const overwritePermission = await fileOperationPermission(target, defaultDir, env, 'overwrite')
          if (overwritePermission.action !== 'allow') return { ok: false, message: `大范围修改未执行：${overwritePermission.reason}` }
        }
        const diff = env?.includeFileDiff === false ? null : makeDiff(content, edit.text, p)
        const backupId = cp ? (await cp.beforeWrite(target, env!.sessionId!)).backupId : ''
        if (cp && !backupId) throw new Error('无法保存原稿检查点，未修改文件')
        const checkpointRoot = cp?.getUndoRoot ? await cp.getUndoRoot().catch(() => undefined) : undefined
        const editUndo = env && backupId ? await makeFileEditUndoMetadata({
          sessionId: env.sessionId, runId: env.runId, toolCallId: env.toolCallId, backupId, checkpointRoot,
          requestedPath: p, targetPath: target, workDir: base, docDir: env.docDir,
          before: original, after: Buffer.from(edit.text, 'utf8')
        }) : undefined
        await writeTextAtomically(target, edit.text, env?.signal, async () => {
          if (await fs.realpath(p) !== target || !original.equals(await fs.readFile(target, { signal: env?.signal }))) throw new Error('稿件在改写前已变动，未覆盖；请重读该段后再改')
        })
        return {
          ok: true, name: 'edit_file', path: p,
          message: label + '：已替换 ' + edit.count + ' 处（原稿第 ' + edit.lines.join('、') + ' 行' + (edit.count > 6 && edit.lines.length === 6 ? '等' : '') + '）',
          edit: { count: edit.count, lines: edit.lines }, ...(backupId ? { backupId } : {}),
          ...(editUndo ? { editUndo } : {}),
          ...(diff ? { diffText: diff.content, diffAdded: diff.added, diffRemoved: diff.removed, diffPath: diff.path } : {})
        }
      } catch (e) {
        return { ok: false, message: '编辑失败：' + (e as Error).message,
          ...(e instanceof ManuscriptEditMatchError && e.recovery ? { editRecovery: e.recovery } : {}) }
      }
    }
  },
  {
    name: 'search_files',
    description: `查文本或${readableDocuments}原文。${pdfHint}指定文件直接查；目录默认只搜文本，搜文档时显式documents:true并用path/include限定资料。命中附read_file可回读的cursor；文档行列指提取文本，不是页码。`,
    parameters: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: '最多500个UTF-16单位。默认逐行正则，忽略大小写，查每行前4000单位。' },
        literal: { type: 'boolean', description: '找原话用true：区分大小写，可跨行，标点和换行按原样匹配。' },
        path: { type: 'string', description: '文件或目录，默认工作目录。跳过隐藏项、依赖、构建目录和链接。' },
        documents: { type: 'boolean', description: '目录也搜文档；默认false。' },
        include: { type: 'string', description: '相对glob，如资料/**/*.docx。*段内、?单字符、**跨目录；无斜杠匹配各级文件名，忽略大小写。' },
        max_results: { type: 'number', description: '最多返回条数，默认 50' }
      },
      required: ['pattern']
    },
    async execute(args, defaultDir, env) {
      const base = env?.workDir ?? defaultDir
      const root = args.path ? (path.isAbsolute(String(args.path)) ? String(args.path) : path.join(base, String(args.path))) : base
      const permission = await readPermission(root, defaultDir, env)
      if (permission.action !== 'allow') return { ok: false, message: `搜索未执行：${permission.reason}` }
      const patternStr = String(args.pattern ?? '')
      if (patternStr.length > 500) return { ok: false, message: '搜索词过长（超过 500 字符），已拒绝' }
      if (args.literal !== undefined && typeof args.literal !== 'boolean') return { ok: false, message: 'literal 必须为布尔值；查原话使用 true' }
      if (args.documents !== undefined && typeof args.documents !== 'boolean') return { ok: false, message: 'documents 必须为布尔值；目录文档搜索须显式使用 true' }
      let include: string | undefined
      try { if (args.include !== undefined) include = relativeFileGlob(args.include) }
      catch (error) { return { ok: false, message: `include 无效：${(error as Error).message}` } }
      if (args.documents === true && !include && !(typeof args.path === 'string' && args.path.trim())) return { ok: false, message: '目录文档搜索请显式提供path或include选定资料集；默认泛搜不会提取全树文档。' }
      if (args.literal && !patternStr) return { ok: false, message: '原文搜索词不能为空' }
      if (args.literal && Array.from(patternStr).some(point => point.length === 1 && /[\uD800-\uDFFF]/.test(point))) return { ok: false, message: '原文搜索词须包含完整Unicode字符，不能只给代理对的一半' }
      try {
        if (!args.literal) new RegExp(patternStr, 'i')
      } catch (e) {
        return { ok: false, message: `正则无效: ${(e as Error).message}` }
      }
      try {
        const result = await searchFileText({ root, base, pattern: patternStr, literal: args.literal === true,
          documents: args.documents === true, include,
          allowRead: async file => (await readPermission(file, defaultDir, env)).action === 'allow',
          maxResults: boundedInteger(args.max_results, 50, 1, 200), signal: env?.signal, readBudgetChars: env?.readBudgetChars, isTextFile,
          ignored: name => IGNORE_DIRS.has(name) || name.startsWith('.') })
        return { ...result, name: 'search_files' }
      } catch (error) {
        return { ok: false, message: env?.signal?.aborted ? '任务已停止，搜索未完成' : `搜索未完成：${(error as Error).message}` }
      }
    }
  },
  {
    name: 'run_command',
    description: '在系统 Shell 中执行命令（工作目录下）。适合运行脚本、构建、测试、安装依赖。执行前会请求用户确认。',
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', description: '要执行的完整命令' },
        timeout_seconds: { type: 'number', description: '超时秒数（默认 90）' }
      },
      required: ['command']
    },
    async execute(args, defaultDir, env) {
      const base = env?.workDir ?? defaultDir
      const cmd = String(args.command ?? '').trim()
      if (!cmd) return { ok: false, message: '空命令' }
      if (env && !isWithin(base, env.workDir)) {
        const perm = permissionManager ? await permissionManager.decide('path', base, identityFromEnv(env)) : null
        if (!perm || perm.action !== 'allow') return { ok: false, message: '工作目录越界，已拒绝执行' }
      }
      if (permissionManager) {
        const perm = await permissionManager.decide('command', cmd, { ...identityFromEnv(env), operation: 'command' })
        if (perm.action !== 'allow') return { ok: false, message: `命令未执行：${perm.reason}` }
        if (perm.reason === '只读命令白名单' && !isSafeAutoCommand(cmd)) return { ok: false, message: '命令包含 shell 元字符，已拒绝' }
      } else if (env?.goalMode === 'autonomous') {
        return { ok: false, message: '自主任务授权服务不可用，命令未执行' }
      } else if (!sessionTrusted) {
        const result = await dialog.showMessageBox({
          type: 'warning',
          buttons: ['运行', '拒绝', '本会话信任并运行'],
          defaultId: 1,
          cancelId: 1,
          title: '执行命令确认',
          message: 'Agent 请求执行命令',
          detail: `命令：${cmd}\n\n工作目录：${base}\n\n请确认这是你期望的操作。`
        })
        if (result.response === 2) sessionTrusted = true
        else if (result.response !== 0) return { ok: false, message: '用户拒绝了命令执行' }
      }
      try {
        const timeoutSec = boundedInteger(args.timeout_seconds, 90, 5, 3600)
        const r = await runCommand(cmd, base, Math.max(5, Math.min(timeoutSec, 3600)) * 1000, env?.signal)
        const output = [r.stdout, r.stderr].filter(Boolean).join('\n--- stderr ---\n') || '（无输出）'
        const timeoutNote = r.cancelled ? '\n命令已随任务停止' : r.timedOut ? '\n命令超时已被终止' : ''
        return {
          ok: r.exitCode === 0 && !r.cancelled && !r.timedOut,
          message: `命令: ${cmd}\n退出码: ${r.exitCode}（${r.durationMs}ms）${timeoutNote}\n输出:\n${truncate(output)}`,
          name: 'run_command',
          exitCode: r.exitCode
        }
      } catch (e) {
        return { ok: false, message: `命令启动失败: ${(e as Error).message}` }
      }
    }
  }
]

agentTools.push(...createWorkFileTools({ allowRead: readPermission,
  readFile: (args, defaultDir, env) => agentTools.find(tool => tool.name === 'read_file')!.execute(args, defaultDir, env) }))
