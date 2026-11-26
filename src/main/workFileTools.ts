import { promises as fs } from 'node:fs'
import * as path from 'node:path'
import type { AgentEnv, ToolDef, ToolResult } from './tools'
import { FILE_EVIDENCE_MAX_SOURCES, type FileSourceEvidence } from '../shared/fileEvidence'
import { readOutputBudget } from './fileReadPage'
import type { PermissionDecision } from '../shared/types'

type ReadFile = ToolDef['execute']
const GENERATED = new Set(['node_modules', '.git', 'out', 'dist', 'build', '__pycache__', '.venv', 'venv', 'env'])
const RESULT_BUDGET = 16000
const READ_KEYS = new Set(['path', 'start_line', 'start_column', 'line_count', 'cursor', 'archive_entry', 'max_chars'])
const encodedResultSize = (value: unknown): number => JSON.stringify({ ok: true, message: JSON.stringify(value) }).length
function positive(value: unknown, fallback: number, name: string): number {
  if (value === undefined) return fallback
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) throw new Error(`${name} 必须是正整数`)
  return value
}

/** Glob stars never become provider-controlled regular expressions. A question
 * mark addresses one Unicode code point; bracket/plus characters are literal. */
function segmentMatches(name: string, pattern: string): boolean {
  const text = Array.from(name), glob = Array.from(pattern)
  let i = 0, j = 0, star = -1, mark = 0
  while (i < text.length) {
    if (j < glob.length && (glob[j] === '?' || glob[j] === text[i])) { i++; j++ }
    else if (glob[j] === '*') { star = j++; mark = i }
    else if (star >= 0) { j = star + 1; i = ++mark }
    else return false
  }
  while (glob[j] === '*') j++
  return j === glob.length
}
export function globMatches(relative: string, pattern: string): boolean {
  if (!pattern.includes('/')) return segmentMatches(relative.split('/').at(-1)!, pattern)
  const parts = relative.split('/'), globs = pattern.split('/')
  let previous = new Uint8Array(parts.length + 1); previous[0] = 1
  for (const glob of globs) {
    const current = new Uint8Array(parts.length + 1)
    if (glob === '**') {
      current[0] = previous[0]
      for (let i = 1; i <= parts.length; i++) current[i] = previous[i] || current[i - 1]
    } else for (let i = 1; i <= parts.length; i++) current[i] = previous[i - 1] && segmentMatches(parts[i - 1], glob) ? 1 : 0
    previous = current
  }
  return previous[parts.length] === 1
}

export function relativeFileGlob(value: unknown): string {
  if (typeof value !== 'string' || !value || value.length > 1024) throw new Error('glob 必须是1到1024字符的相对glob')
  const pattern = value.replaceAll('\\', '/')
  if (pattern.startsWith('/') || pattern.includes(':') || pattern.split('/').some(part => !part || part === '..' || part === '.')) throw new Error('glob必须相对于path，不允许绝对路径或..')
  return pattern
}

export function createWorkFileTools(input: { readFile: ReadFile; allowRead: (file: string, defaultDir: string, env?: AgentEnv) => Promise<PermissionDecision> }): ToolDef[] {
  return [{
    name: 'find_files',
    description: '按文件名或相对路径glob找资料，不读正文。*匹配一段内任意字符，?匹配一个Unicode字符，**匹配任意层目录；[]、+等其余符号按原样。无斜杠时在各层按文件名匹配。返回可直接read_file/read_files的路径。默认跳过隐藏/生成目录和链接，覆盖会如实列明；结果多时用after_path续页，不限制任务可调用次数。',
    parameters: { type: 'object', properties: {
      path: { type: 'string', description: '搜索目录，默认工作目录；也可明确一个文件' },
      pattern: { type: 'string', description: '例如 **/*交接*.md、*.docx、src/**/*.ts；必须为相对glob，不含..，最长1024字符' },
      case_sensitive: { type: 'boolean', description: '默认不区分大小写' },
      include_hidden: { type: 'boolean', description: '显式包含隐藏文件/目录；不读取正文或改变权限' },
      include_generated: { type: 'boolean', description: '显式包含node_modules/.git/out等生成或版本库目录' },
      after_path: { type: 'string', description: '原样传入上页next_after_path，按相对路径排序继续；更改目录/条件后应从头查' }
    }, required: ['pattern'], additionalProperties: false },
    async execute(args, defaultDir, env) {
      try {
        env?.signal?.throwIfAborted()
        if (typeof args.pattern !== 'string' || !args.pattern || args.pattern.length > 1024) throw new Error('pattern 必须是1到1024字符的相对glob')
        const pattern = relativeFileGlob(args.pattern)
        for (const key of ['case_sensitive', 'include_hidden', 'include_generated']) if (args[key] !== undefined && typeof args[key] !== 'boolean') throw new Error(`${key} 必须是布尔值`)
        if (args.path !== undefined && (typeof args.path !== 'string' || !args.path.trim())) throw new Error('path 必须是非空路径')
        if (args.after_path !== undefined && (typeof args.after_path !== 'string' || !args.after_path || args.after_path.includes('\\') || args.after_path.startsWith('/') || args.after_path.split('/').some(part => part === '..' || !part))) throw new Error('after_path 必须原样使用上页返回的相对路径')
        const base = env?.workDir ?? defaultDir, target = path.resolve(base, args.path as string ?? '.')
        const permission = await input.allowRead(target, defaultDir, env)
        if (permission.action !== 'allow') return { ok: false, message: `文件查找未执行：${permission.reason}` }
        const budget = env?.readBudgetChars === undefined ? 11000 : Math.min(11000, readOutputBudget(env.readBudgetChars))
        if (!budget) return { ok: false, name: 'find_files', message: 'read_input_budget_insufficient：本次未展示目录匹配；请精确指定子目录或缩小本次输入后重查，不能据此判断没有文件。' }
        const root = await fs.realpath(target), rootStat = await fs.stat(root), after = args.after_path as string ?? ''
        const matches: Array<{ path: string; relative_path: string }> = [], issues: string[] = []
        let checked = 0, matched = 0, hidden = 0, generated = 0, links = 0, unreadable = 0, tooLong = 0, cost = 0
        const noteIssue = (relative: string) => { unreadable++; if (issues.length < 3) issues.push(relative.slice(0, 300)) }
        const consider = (file: string, relative: string) => {
          checked++
          if (!globMatches(args.case_sensitive === true ? relative : relative.toLowerCase(), args.case_sensitive === true ? pattern : pattern.toLowerCase()) || relative <= after) return
          matched++
          const fromBase = path.relative(base, file), locator = fromBase && !fromBase.startsWith('..' + path.sep) && fromBase !== '..' && !path.isAbsolute(fromBase) ? fromBase : file
          const item = { path: locator, relative_path: relative }, size = JSON.stringify(JSON.stringify(item)).length
          if (size > budget) { tooLong++; return }
          let index = matches.findIndex(entry => relative < entry.relative_path)
          if (index < 0) index = matches.length
          matches.splice(index, 0, item); cost += size
          while (cost > budget && matches.length > 1) cost -= JSON.stringify(JSON.stringify(matches.pop())).length
        }
        const visit = async (current: string, relative: string): Promise<void> => {
          env?.signal?.throwIfAborted()
          try {
            const directory = await fs.opendir(current)
            for await (const entry of directory) {
              env?.signal?.throwIfAborted()
              const child = relative ? `${relative}/${entry.name}` : entry.name
              if (entry.isSymbolicLink()) { links++; continue }
              if (entry.isDirectory() && GENERATED.has(entry.name) && args.include_generated !== true) { generated++; continue }
              if (entry.name.startsWith('.') && args.include_hidden !== true) { hidden++; continue }
              const full = path.join(current, entry.name)
              // A directory replaced by a link during traversal must not let
              // discovery enumerate another root under an innocuous filename.
              const real = await fs.realpath(full).catch(() => null)
              const within = real && path.relative(root, real)
              if (real === null || within === '..' || within?.startsWith('..' + path.sep) || (within && path.isAbsolute(within))) { noteIssue(child); continue }
              if (entry.isDirectory()) await visit(full, child)
              else if (entry.isFile()) consider(full, child)
            }
          } catch (error) { env?.signal?.throwIfAborted(); noteIssue(relative || '.') }
        }
        if (rootStat.isDirectory()) await visit(root, '')
        else if (rootStat.isFile()) consider(target, path.basename(target))
        else throw new Error('path 不是普通文件或目录')
        env?.signal?.throwIfAborted()
        const more = matched - tooLong > matches.length
        return { ok: true, name: 'find_files', message: JSON.stringify({ matches, coverage: { files_checked: checked, matches_after_path: matched,
          skipped_hidden: hidden, skipped_generated_directories: generated, skipped_links: links, unreadable, unprintable_paths: tooLong },
          ...(more && matches.length ? { next_after_path: matches.at(-1)!.relative_path } : {}),
          note: `${more ? '本页未列完匹配；保留path/pattern/筛选条件，用next_after_path继续。' : '当前筛选下匹配已列完。'}${unreadable || tooLong ? '有不可读/未能展示范围，不能断言这些范围无匹配。' : ''}${hidden || generated || links ? '跳过项未检查；需要隐藏/生成文件可显式开启对应选项，链接须明确指定路径并重新授权。' : ''}续查重新枚举目录；资料在两次调用间变化时请从头查。` }) }
      } catch (error) { return { ok: false, message: `查找文件失败：${(error as Error).message}` } }
    }
  }, {
    name: 'read_files',
    description: '一次并行读取几份已定位资料，省去逐份工具往返；每项沿用read_file权限与文本/文档/ZIP/本任务附件定位，失败逐项返回。每项默认2000码点，显式max_chars沿用read_file每页最多8000（不是全文保证）；正文里的cursor继续读该文件。总结果有界，更多项用next_index从原files数组继续，不限制总文件数/任务调用次数。不运行任意工具、不写盘。',
    parameters: { type: 'object', properties: {
      files: { type: 'array', minItems: 1, items: { type: 'object', properties: {
        path: { type: 'string' }, start_line: { type: 'integer', minimum: 1 }, start_column: { type: 'integer', minimum: 1 },
        line_count: { type: 'integer', minimum: 1, maximum: 1000 }, max_chars: { type: 'integer', minimum: 1, maximum: 400000 },
        cursor: { type: 'string' }, archive_entry: { type: 'string' }
      }, required: ['path'], additionalProperties: false } },
      start_index: { type: 'integer', minimum: 1, description: '原files数组的1起始索引，默认1；续批用上次next_index，不省略前面的项' }
    }, required: ['files'], additionalProperties: false },
    async execute(args, defaultDir, env) {
      try {
        env?.signal?.throwIfAborted()
        if (!Array.isArray(args.files) || !args.files.length) throw new Error('files 必须是非空的read_file请求数组')
        const files = args.files as Record<string, unknown>[]
        for (const item of files) if (!item || typeof item !== 'object' || Array.isArray(item) || typeof item.path !== 'string' || !item.path.trim() || Object.keys(item).some(key => !READ_KEYS.has(key))) throw new Error('每项只接受read_file的路径/定位参数，不接受工具名、命令或写入字段')
        let index = positive(args.start_index, 1, 'start_index') - 1
        if (index >= files.length) throw new Error('start_index 超出原files数组范围')
        const results: Array<{ index: number; path: string; archive_entry?: string; ok: boolean; message: string }> = []
        const sources: FileSourceEvidence[] = []
        let remainingBody = env?.readBudgetChars === undefined || env.readBudgetChars >= RESULT_BUDGET ? undefined : readOutputBudget(env.readBudgetChars)
        if (remainingBody === 0) return { ok: false, name: 'read_files', message: `read_input_budget_insufficient：本次未展示资料正文；原files数组起点第${index + 1}项。请精确定位/缩小本次输入或使用更大窗口后重读，不自动重复同一批次。` }
        let attempted = 0
        const readItem = async (request: Record<string, unknown>, absoluteIndex: number, max: number, childBudget?: number) => {
          env?.signal?.throwIfAborted()
          let result: ToolResult
          try { result = await input.readFile({ ...request, line_count: request.line_count ?? 100, max_chars: max }, defaultDir, childBudget === undefined ? env : { ...env!, readBudgetChars: childBudget }) }
          catch (error) { result = { ok: false, message: (error as Error).message } }
          return { item: { index: absoluteIndex + 1, path: request.path as string, ...(typeof request.archive_entry === 'string' ? { archive_entry: request.archive_entry } : {}), ok: result.ok, message: result.message },
            sources: result.ok ? result.sources ?? [] : [], bodyUsed: (result.sources?.length ? result.sources.reduce((sum, source) => sum + JSON.stringify(source.excerpt).length - 2, 0) : JSON.stringify(result.message).length) * 2 }
        }
        const payload = (next: number) => ({ files: results, requested: files.length, attempted, ...(next < files.length ? { next_index: next + 1 } : {}),
          note: '每项是有界摘录；单项cursor仅用于该项read_file/后续files项，不是整批位置。next_index只续批尚未展示的项，须保留原files数组。失败或未展示项不代表没有正文；并行读取不是跨文件原子快照。' })
        while (index < files.length) {
          env?.signal?.throwIfAborted()
          // Four in-flight I/O/parse operations bound memory, not authorization
          // or number of files. Output pagination, not a call cap, stops a batch.
          const window = files.slice(index, index + (remainingBody !== undefined && remainingBody < 256 ? 1 : 4))
          // A JSON batch escapes its nested read messages a second time.
          const childBudget = remainingBody === undefined ? undefined : Math.floor(remainingBody / (window.length * 2))
          const batch = await Promise.all(window.map((request, offset) => readItem(request, index + offset, Math.min(8000, positive(request.max_chars, 2000, 'max_chars')), childBudget)))
          env?.signal?.throwIfAborted(); attempted += batch.length
          let stop = false
          for (let entry of batch) {
            results.push(entry.item)
            if (encodedResultSize(payload(index + 1)) > RESULT_BUDGET) {
              results.pop()
              if (results.length) { stop = true; break }
              // Quote/backslash-heavy pages grow again inside a structured
              // batch result. Ask the same reader for a smaller *real* page,
              // retaining its correct cursor rather than chopping its receipt.
              let max = Math.min(8000, positive(files[index].max_chars, 2000, 'max_chars'))
              while (max > 1) {
                max = Math.floor(max / 2)
                entry = await readItem(files[index], index, max, childBudget)
                results.push(entry.item)
                if (encodedResultSize(payload(index + 1)) <= RESULT_BUDGET) break
                results.pop()
              }
              if (!results.length) throw new Error(`第${index + 1}项元数据超过本次输出预算；请用read_file单独读取或缩短路径`)
            }
            sources.push(...entry.sources.slice(0, FILE_EVIDENCE_MAX_SOURCES - sources.length))
            if (remainingBody !== undefined) remainingBody = Math.max(0, remainingBody - entry.bodyUsed)
            index++
          }
          if (stop || remainingBody === 0) break
        }
        env?.signal?.throwIfAborted()
        return { ok: !(env?.readBudgetChars !== undefined && !sources.length && results.every(item => item.message.includes('read_input_budget_insufficient'))), name: 'read_files', message: JSON.stringify(payload(index)), ...(sources.length ? { sources } : {}) }
      } catch (error) { return { ok: false, message: `批量读取失败：${(error as Error).message}` } }
    }
  }]
}
