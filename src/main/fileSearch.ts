import { promises as fs } from 'node:fs'
import * as path from 'node:path'
import { readFileCursor, readFileIdentity, readOutputBudget } from './fileReadPage'
import { sourceFromReadPage } from './fileEvidence'
import { fileSourceRange, type FileSourceEvidence } from '../shared/fileEvidence'
import { isUnsupportedTextHead } from './fileTextProbe'

const MAX_BYTES = 2_000_000
const MAX_LINES = 200_000
const REGEX_LINE_UNITS = 4000
// Leave space for coverage notes and the JSON/tool wrappers below the engine's
// 20k spill threshold. Budget escaped text, not just visible characters.
const HIT_BUDGET = 12_000
const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })

export async function searchFileText(input: {
  root: string; base: string; pattern: string; literal: boolean; maxResults: number; signal?: AbortSignal; readBudgetChars?: number
  isTextFile: (file: string) => boolean; ignored: (name: string) => boolean
  allowRead?: (file: string) => Promise<boolean>
}): Promise<{ ok: boolean; message: string; sources?: FileSourceEvidence[] }> {
  const { root, base, pattern, literal, signal } = input
  if (input.readBudgetChars !== undefined && readOutputBudget(input.readBudgetChars) === 0) return { ok: false, message: 'read_input_budget_insufficient：本次未向模型返回搜索正文；请精确定位文件/缩小本次输入或使用更大窗口，不能据此判断无匹配。' }
  const hitBudget = input.readBudgetChars === undefined ? HIT_BUDGET : Math.min(HIT_BUDGET, readOutputBudget(input.readBudgetChars) + 500)
  const regex = literal ? null : new RegExp(pattern, 'i')
  const hits: string[] = [], issues: string[] = [], sources: FileSourceEvidence[] = []
  let filesRead = 0, linesChecked = 0, excluded = 0, oversized = 0, unreadable = 0, found = 0, encoded = 0
  let partialRegexLines = 0, edgeCandidates = 0
  let budgetClipped = false
  let stopped = ''
  const label = (file: string): string => path.relative(base, file) || path.basename(file)
  const issue = (file: string, reason: string): void => {
    unreadable++
    if (issues.length < 3) issues.push(`${label(file)}（${reason}）`.slice(0, 240))
  }
  const scan = async (file: string): Promise<void> => {
    signal?.throwIfAborted()
    if (input.allowRead && !(await input.allowRead(file))) { issue(file, '未获读取授权'); return }
    const handle = await fs.open(file, 'r')
    try {
      const st = await handle.stat({ bigint: true })
      if (!st.isFile()) { issue(file, '不是普通文件'); return }
      if (st.size > MAX_BYTES) { oversized++; return }
      const tag = readFileIdentity(st), bytes = Buffer.alloc(Number(st.size))
      let loaded = 0
      while (loaded < bytes.length) {
        signal?.throwIfAborted()
        const { bytesRead } = await handle.read(bytes, loaded, bytes.length - loaded, loaded)
        if (!bytesRead) throw new Error('读取时文件改变')
        loaded += bytesRead
      }
      if (isUnsupportedTextHead(bytes.subarray(0, 4096))) { issue(file, '二进制格式或不支持的文本编码（与read_file一致，未作为原文证据）'); return }
      const content = utf8.decode(bytes)
      if (readFileIdentity(await handle.stat({ bigint: true })) !== tag) throw new Error('读取时文件改变')
      filesRead++
      const lines = content.split('\n')
      // read_file does not invent a final empty line after the last LF.
      if (content.endsWith('\n')) lines.pop()
      let byteOffset = 0, charOffset = 0
      const searchableLines = Math.min(lines.length, MAX_LINES - linesChecked)
      let searchableEnd = 0
      for (let i = 0; i < searchableLines; i++) searchableEnd += lines[i].length + 1
      const literalText = literal ? content.slice(0, Math.min(content.length, searchableEnd)) : ''
      let nextLiteral = literal ? literalText.indexOf(pattern) : -1
      for (let index = 0; index < lines.length; index++) {
        signal?.throwIfAborted()
        if (linesChecked >= MAX_LINES) { stopped = '达到 200000 行检查上限'; return }
        const line = lines[index]
        linesChecked++
        // Preserve the old per-line regex workload in the main process.
        // Literal lookup is linear and can still inspect the complete line.
        const clipped = !literal && line.length > REGEX_LINE_UNITS
        let window = clipped ? line.slice(0, REGEX_LINE_UNITS) : line
        if (clipped) {
          partialRegexLines++
          if (/[\uD800-\uDBFF]/.test(window.at(-1) ?? '') && /[\uDC00-\uDFFF]/.test(line[REGEX_LINE_UNITS])) window = window.slice(0, -1)
        }
        let match = regex?.exec(window)
        // An artificial window end can satisfy $, or cut a greedy match.
        // Do not advertise that boundary candidate as a complete match.
        if (clipped && match && match.index + match[0].length >= window.length) { edgeCandidates++; match = null }
        let start = literal ? (nextLiteral >= charOffset && nextLiteral <= charOffset + line.length ? nextLiteral - charOffset : -1) : match?.index ?? -1
        let endAbsolute = literal ? nextLiteral + pattern.length : charOffset + start + (match?.[0].length ?? 0)
        if (start >= 0) {
          found++
          // Regex can name one UTF-16 surrogate; locators must still address
          // whole Unicode code points. Literal matching keeps exact newlines.
          if (start > 0 && /[\uDC00-\uDFFF]/.test(line[start]) && /[\uD800-\uDBFF]/.test(line[start - 1])) start--
          if (endAbsolute > 0 && /[\uDC00-\uDFFF]/.test(content[endAbsolute] ?? '') && /[\uD800-\uDBFF]/.test(content[endAbsolute - 1])) endAbsolute++
          const prefix = Array.from(line.slice(0, start)), first = prefix.length
          let from = Math.max(0, first - 80), before = prefix.slice(0, from).join(''), fromAbsolute = charOffset + before.length
          const matchText = content.slice(charOffset + start, endAbsolute), matchRange = fileSourceRange(index + 1, first + 1, matchText)
          // Preserve the old same-line preview. A multiline literal gets its
          // complete (<=500 UTF-16) phrase plus bounded neighboring context.
          const multiline = matchRange.end_line !== index + 1
          const endLine = multiline ? content.indexOf('\n', endAbsolute) : charOffset + line.length
          const ceiling = endLine < 0 ? content.length : endLine
          const tail = Array.from(content.slice(endAbsolute, ceiling)).slice(0, 100).join('')
          let snippet = Array.from(content.slice(fromAbsolute, endAbsolute) + tail).slice(0, multiline ? 800 : 480).join('')
          if (input.readBudgetChars !== undefined && JSON.stringify(snippet).length - 2 > Math.max(0, hitBudget - encoded - 500)) {
            budgetClipped = true; from = first; before = prefix.join(''); fromAbsolute = charOffset + before.length
            const budget = Math.max(0, hitBudget - encoded - 500)
            let size = 0; snippet = ''
            for (const point of content.slice(fromAbsolute, ceiling)) {
              const cost = JSON.stringify(point).length - 2
              if (size + cost > budget || Array.from(snippet).length >= 800) break
              size += cost; snippet += point
            }
          }
          const toAbsolute = fromAbsolute + snippet.length, snippetRange = fileSourceRange(index + 1, from + 1, snippet)
          const startByte = byteOffset + Buffer.byteLength(before), endByte = startByte + Buffer.byteLength(snippet)
          const read = { path: label(file), ...(st.size ? { cursor: readFileCursor(tag, startByte, index + 1) } : { start_line: 1 }),
            line_count: Math.min(1000, Math.max(snippetRange.end_line, matchRange.end_line) - snippetRange.start_line + 1), max_chars: Math.min(8000, Math.max(640, Array.from(matchText).length + 200)) }
          const location = multiline ? `命中范围 [${matchRange.start_line}:${matchRange.start_column}, ${matchRange.end_line}:${matchRange.end_column})；片段范围 [${snippetRange.start_line}:${snippetRange.start_column}, ${snippetRange.end_line}:${snippetRange.end_column})`
            : `${clipped ? '窗口内正则候选列' : '命中列'} [${first + 1}, ${matchRange.end_column})；片段列 [${from + 1}, ${snippetRange.end_column})`
          const hit = `${label(file)}:${index + 1}:${first + 1}: ${location}\n${from ? '…' : ''}${snippet}${toAbsolute < ceiling ? '…' : ''}\n读取原文：read_file ${JSON.stringify(read)}`
          const cost = JSON.stringify(hit).length
          if (encoded + cost > hitBudget) { stopped = '达到返回文本上限'; return }
          hits.push(hit); encoded += cost
          sources.push(...sourceFromReadPage({ path: path.resolve(file), displayName: path.basename(file), kind: 'text', page: {
            text: snippet, first: index + 1, firstColumn: from + 1, last: snippetRange.end_line,
            endLine: snippetRange.end_line, endColumn: snippetRange.end_column,
            readCursor: readFileCursor(tag, startByte, index + 1),
            ...(toAbsolute < content.length ? { cursor: readFileCursor(tag, endByte, snippetRange.end_line) } : {}) } }))
          if (hits.length >= input.maxResults) { stopped = '已达到结果条数上限（max_results）'; return }
          nextLiteral = literal ? literalText.indexOf(pattern, charOffset + line.length + 1) : -1
        }
        charOffset += line.length + 1
        byteOffset += Buffer.byteLength(line) + 1
      }
    } finally { await handle.close() }
  }
  const visit = async (target: string, explicit = false): Promise<void> => {
    signal?.throwIfAborted()
    if (stopped) return
    try {
      const st = await fs.stat(target)
      if (st.isFile()) {
        if (!input.isTextFile(target)) { if (explicit) issue(target, '不是可搜索的文本文件'); else excluded++; return }
        await scan(target)
      } else if (st.isDirectory()) {
        const entries = await fs.readdir(target, { withFileTypes: true })
        entries.sort((a, b) => a.name.localeCompare(b.name, 'en'))
        for (const entry of entries) {
          if (stopped) break
          signal?.throwIfAborted()
          if (input.ignored(entry.name) || entry.isSymbolicLink() || (!entry.isDirectory() && !entry.isFile())) { excluded++; continue }
          await visit(path.join(target, entry.name))
        }
      } else issue(target, '不是普通文件或目录')
    } catch (error) {
      signal?.throwIfAborted()
      const code = (error as NodeJS.ErrnoException).code
      issue(target, code === 'ENOENT' ? '不存在' : error instanceof TypeError ? '不是有效 UTF-8' : code ?? '无法完整读取')
    }
  }
  await visit(root, true)
  const partial = Boolean(stopped || oversized || unreadable || partialRegexLines)
  const coverage = `读取 ${filesRead} 个文本文件，检查 ${linesChecked} 行；${partial ? '搜索未完成，不能据此断言整个范围无匹配' : '默认可搜索范围已查完'}。`
  const notes = [
    stopped,
    budgetClipped ? '当前模型输入预算缩小了正文片段；未展示部分请按返回路径/原文定位继续读取' : '',
    partialRegexLines ? `${partialRegexLines} 条长行未查完：正则每行仅检查前 ${REGEX_LINE_UNITS} 个 UTF-16 单位；窗口内结果仅为候选，跨窗口条件或完整匹配尚未确认。查确切原话请用 literal:true 搜索整行` : '',
    edgeCandidates ? `${edgeCandidates} 个窗口末尾候选可能截断，未作为完整匹配返回` : '',
    oversized ? `跳过 ${oversized} 个大于 2 MB 的文件（未查，可用 read_file 分页）` : '',
    unreadable ? `${unreadable} 项未能读取：${issues.join('、')}` : '',
    excluded ? `默认排除 ${excluded} 项（隐藏项、依赖/构建目录、非文本文件或链接）` : ''
  ].filter(Boolean)
  const heading = hits.length ? (partialRegexLines ? `返回 ${hits.length} 个定位（长行正则为窗口内候选；每个起始行第一处）：` : `找到 ${hits.length} 个匹配行（每个起始行显示第一处）：`) : found ? '已有匹配，但定位文本超出返回上限；请缩小文件范围。' : partial ? '已检查部分未返回可确认匹配；其余内容尚未确认。' : '未找到匹配。'
  return { ok: hits.length > 0 || !partial, message: `${heading}\n${coverage}${notes.length ? '\n搜索范围说明：' + notes.join('；') : ''}\n行/列从 1 开始；列按 Unicode 码点计数（CR/BOM 保留），区间 [起点, 终点) 不含终点。续读请原样使用 cursor。${hits.length ? '\n' + hits.join('\n\n') : ''}`, ...(sources.length ? { sources } : {}) }
}
