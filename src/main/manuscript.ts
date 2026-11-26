import { createHash } from 'node:crypto'
import type { AssistantOutputKind, LegacyManuscriptBackfillSource, LegacyManuscriptBackfillState, ManuscriptSegment, ManuscriptSegmentStatus } from '../shared/types'
import { codePointLength } from '../shared/textMetrics'

const BODY_LABEL = '(?:小说)?正文|文章|小说|内容|处理结果|输出结果|结果'
const META_PREFIX = new RegExp(`^(?:以下|下面)(?:是|为)?(?:你要的|按要求生成的|生成的)?(?:${BODY_LABEL})(?:如下)?\\s*[：:]?|^(?:写作|创作|输出)?说明\\s*[：:]?|^我将(?:为你)?(?:撰写|创作|继续(?:撰写|创作)?)(?:[。.!！？?]|\\s|$)|^好的?[，,、:：]\\s*(?:我)?(?:将|现在|继续)(?:[。.!！？?]|\\s|$)|^(?:here(?:\\s+is|\\s+are)|below\\s+is|the\\s+following\\s+is)\\b[^\\n]*[:：]\\s*`, 'iu')
const WRAPPER_LINE = new RegExp(`^(?:以下|下面)(?:是|为)?(?:你要的|按要求生成的|生成的)?(?:${BODY_LABEL})(?:如下)?[：:]?$|^(?:${BODY_LABEL})(?:如下)?[：:]$|^(?:标题|题目|篇名|字数|长度|输出格式)\\s*[：:].*$|^\\s*[（(]?(?:全文)?(?:约|共)?\\s*\\d+\\s*(?:字|字符)[）)]?\\s*$|^\\s*(?:\\[|【)?(?:${BODY_LABEL}|正文开始|正文如下)(?:\\]|】)?\\s*[：:]?\\s*$`, 'u')
const INLINE_WRAPPER = new RegExp(`^(?:以下|下面)(?:是|为)?(?:你要的|按要求生成的|生成的)?(?:${BODY_LABEL})(?:如下)?\\s*[：:]\\s*`, 'u')
const TITLE_LINE = /^(?:#{1,6}\s+.+|(?:标题|题目|篇名|title|story\s+title|subject)\s*[:：].*)$/iu
const NOTE_LINE = /^(?:注|备注|说明|Note|Notes|P\.S\.|FYI)\s*[:：\-]\s*/iu
const REPORT_LINE = /^(?:已完成(?:本次|当前)?(?:写作|创作|生成|任务)?|生成完成|本次(?:输出|生成)(?:已)?完成|字数(?:统计)?|长度(?:统计)?|输出格式|word\s*count|completed|generated|result)\s*(?:[:：\-]\s*[^\n]*)?[。.!！？!?]?$/iu
const FENCE_OPEN = /^```(?:[a-z][\w+.-]*)?\s*$/iu
const FENCE_CLOSE = /^```\s*$/u
const JSON_LABEL = /^(?:json)\s*[：:]\s*/iu
const JSON_LIKE = /^(?:json\s*[：:]\s*)?[{[]\s*["'{\[]?/iu
const NATURAL_END = /[。.!！？?…][”’」』）》】〕〉）"']*$/u

const ZH_REFUSAL_LEAD = '(?:抱歉|很抱歉|非常抱歉|对不起|不好意思|很遗憾|遗憾的是|我很抱歉|我深感抱歉|恐怕)'

export type WriterEnvelopeStatus = 'complete' | 'partial' | 'writing' | 'blocked' | 'refusal' | 'error'

export interface WriterStructuredEnvelope {
  schemaVersion: 1
  prose: string
  notes: string[]
  status?: WriterEnvelopeStatus
}

export type WriterEnvelopeParseResult =
  | { detected: false }
  | { detected: true; ok: true; envelope: WriterStructuredEnvelope; evidence: string[] }
  | { detected: true; ok: false; reason: string; evidence: string[] }

export interface ClassifiedAssistantOutput {
  kind: AssistantOutputKind
  content: string
  complete: boolean
  reason: string
  evidence: string[]
}

type StructuralKind = 'refusal' | 'meta' | 'report' | 'title' | 'fence' | 'json' | 'notes' | 'prose'

interface StructuralMarker {
  kind: StructuralKind
  evidence: string
  rest?: string
}

interface NormalizedOutput {
  kindHint?: Exclude<AssistantOutputKind, 'critic' | 'repair' | 'prose'>
  content: string
  evidence: string[]
  reason?: string
  boundaryUnsafe?: boolean
}

function normalizeLine(value: string): string {
  return value.replace(/^\uFEFF/u, '').trim()
}

function normalizeRefusalInput(value: string): string {
  return normalizeLine(value)
    .normalize('NFKC')
    .replace(/[’‘]/gu, "'")
    .replace(/[“”]/gu, '"')
    .replace(/\s+/gu, ' ')
    .toLocaleLowerCase()
}

interface RefusalMatch {
  id: string
  index: number
}

const REFUSAL_PATTERNS: ReadonlyArray<{ id: string; pattern: RegExp }> = [
  {
    id: 'zh_apology',
    pattern: /^(?:抱歉|很抱歉|非常抱歉|对不起|不好意思|很遗憾|遗憾的是|我很抱歉|我深感抱歉|恐怕)\s*(?:[，,：:]\s*)?(?:但|不过)?\s*(?:我\s*)?(?:不能|无法|不可以|不会|拒绝|必须拒绝|需要拒绝|只能拒绝)/u
  },
  {
    id: 'zh_apology_context',
    pattern: /^(?:抱歉|很抱歉|非常抱歉|对不起|不好意思|很遗憾|遗憾的是|我很抱歉|我深感抱歉|恐怕)\s*[，,：:]\s*[^。！？!?]{0,40}?(?:我\s*)?(?:不能|无法|不可以|不会|拒绝)/u
  },
  {
    id: 'zh_modal',
    pattern: /^(?:我\s*)?(?:不能|无法|不可以|不会)(?=\s*(?:帮助|协助|提供|完成|执行|继续|生成|写|改写|重现|描述|回答|参与|处理|访问|确认|绕过|越过|支持|满足|遵循|说明|解释|给出|披露|分享|核实|为|按|代替|停止|遵守|回应|履行))/u
  },
  {
    id: 'zh_ability',
    pattern: /^我(?:没有能力|不具备)(?=\s*(?:提供|完成|执行|继续|生成|写|协助|帮助|处理|访问|回答|给出|核实))/u
  },
  {
    id: 'zh_decline',
    pattern: /^(?:对此(?:请求)?\s*)?(?:我\s*)?(?:只能|必须|需要)\s*拒绝|^我\s*(?:必须|需要)\s*(?:停止|拒绝)|^请求被拒绝/u
  },
  {
    id: 'zh_policy',
    pattern: /^(?:作为(?:一个)?AI|作为人工智能|由于(?:安全|政策)|出于(?:安全|政策)|根据(?:安全政策|使用规范)|受(?:安全限制|限于权限)|这违反了?安全|这会涉及不当|该请求不适合|这类内容不在|(?:这类|此类|这个请求|该请求|对此请求)[^。！？!?]{0,40}(?:不能|无法|不在|满足|提供|执行|完成|回应|处理))/iu
  },
  {
    id: 'en_apology',
    pattern: /^(?:sorry|i(?:'m| am)\s+sorry|i\s+apologize|unfortunately|regrettably|i(?:'m| am)\s+afraid)\s*[,：:\-]?\s*(?:but|however)?\s*(?:i\s+)?(?:cannot|can\s*'t|am unable to|am not able to|must refuse|have to decline|need to decline)(?=\s|[,.:;!?]|$)/iu
  },
  {
    id: 'en_decline',
    pattern: /^(?:i\s+)?(?:must refuse|have to decline|must decline|need to decline|must stop and refuse)(?=\s|[,.:;!?]|$)/iu
  },
  {
    id: 'en_modal',
    pattern: /^(?:i\s+)?(?:cannot|can\s*'t|am unable to|am not able to|i'm unable to|i'm not able to|i'm not permitted to|i'm not allowed to|must refuse|have to decline|need to decline|will not|won't|must not|should not|am not permitted to|am not allowed to|do not have the ability to|don't have the ability to)(?=\s+(?:help|assist|comply|provide|complete|fulfill|continue|write|generate|answer|describe|reproduce|rewrite|process|access|perform|bypass|honor|meet|support|offer|share|disclose|verify|stop|refuse|decline|proceed|do|follow|fulfil|assist))/iu
  },
  {
    id: 'en_policy',
    pattern: /^(?:for safety reasons?|due to safety concerns?|under my safety policy|according to policy|this request is not something i can|this content is not something i can|this request is outside what i can|this request cannot be|this content cannot be)/iu
  }
]

function refusalMatch(value: string): RefusalMatch | null {
  const line = normalizeLine(value)
  const opening = line.match(/^[“「『"‘]\s*/u)
  const index = opening?.[0].length ?? 0
  const candidate = normalizeRefusalInput(line.slice(index))
  for (const entry of REFUSAL_PATTERNS) {
    if (entry.pattern.test(candidate)) return { id: entry.id, index }
  }
  return null
}

function refusalQuoteContains(value: string, index: number): boolean {
  const line = normalizeLine(value)
  const quotePatterns = [/“[^”]*”/gu, /「[^」]*」/gu, /『[^』]*』/gu, /"[^"]+"/gu, /‘[^’]*’/gu]
  for (const pattern of quotePatterns) {
    for (const match of line.matchAll(pattern)) {
      const start = match.index ?? 0
      if (index >= start && index < start + match[0].length) return true
    }
  }
  return false
}

function softLeadingRefusal(lines: string[]): RefusalMatch | null {
  const first = normalizeLine(lines[0] ?? '')
  if (!first || /^[“「『"‘]/u.test(first) || !/^(?:抱歉|很抱歉|非常抱歉|对不起|不好意思|很遗憾|遗憾的是|我很抱歉|我深感抱歉|恐怕|sorry|i(?:'m| am)?\s+sorry|i\s+apologize|unfortunately|regrettably|i(?:'m| am)?\s+afraid)[，,：:\s]?/iu.test(first)) return null
  const joined = lines.slice(0, 3).map(normalizeLine).filter(Boolean).join(' ')
  return refusalMatch(joined)
}

function looksLikeDialogue(value: string): boolean {
  const line = normalizeLine(value)
  if (!line) return false
  const pairedQuote = /(?:^|[：:，,\s])(?:“[^”]*”|「[^」]*」|『[^』]*』|‘[^’]*’|"[^"{}\n]{1,240}")/u.test(line)
  const attribution = /(?:^|[。！？!?，,]\s*)(?:[\p{Script=Han}A-Za-z·]{1,24}\s*)?(?:说|道|问|答|喊|叫|低声(?:说)?|喃喃(?:道)?|告诉|回答|解释|承认|叹道)(?:[：:，,\s]|$)|(?:^|[\s,])(?:said|asked|replied|whispered|murmured)(?:[,:\s]|$)/iu.test(line)
  return pairedQuote || attribution && /[：:，,]|\s/u.test(line)
}

function hasNarrativeAttribution(value: string): boolean {
  const line = normalizeLine(value)
  return /^(?:[\p{Script=Han}A-Za-z][\p{Script=Han}A-Za-z·'’-]{0,30})(?:低声|轻声|大声|小声)?(?:说|道|问|答|喊|叫|告诉|回答|解释|承认|喃喃)\s*[：:，,]?\s*(?:抱歉|很抱歉|非常抱歉|对不起|不好意思|很遗憾|遗憾的是|我很抱歉|我深感抱歉|恐怕|我(?:不能|无法|不可以))/u.test(line) ||
    /^(?:she|he|they|[A-Z][\p{L}'’-]{0,24})\s+(?:said|asked|replied|whispered|murmured)\s*[,:]?\s*(?:sorry|i(?:'m| am)?\s+sorry|i\s+(?:can(?:not|'t)|am unable|cannot))/iu.test(line)
}

function metaPrefixMatch(value: string): RegExpMatchArray | null {
  const line = normalizeLine(value)
  const courtesyBody = line.match(/^(?:当然|好的?|没问题)[，,、:：]\s*(?:以下|下面)\s*(?:(?:是|为)\s*)?(?:(?:你要的|按要求生成的|生成的)\s*)?(?:继续\s*)?(?:小说\s*)?(?:正文|文章|内容)(?:如下)?\s*[：:]?\s*/iu)
  if (courtesyBody) return courtesyBody
  const courtesyContinuation = line.match(/^(?:当然|好的?|没问题)[，,、:：]\s*(?:我\s*)?(?:来\s*)?(?:现在\s*)?继续(?:撰写|创作|写作|写)?\s*[。.!！？?：:]?\s*/iu)
  if (courtesyContinuation) return courtesyContinuation
  return line.match(META_PREFIX)
}

function markerForLeadingLine(value: string): StructuralMarker {
  const line = normalizeLine(value)
  if (FENCE_OPEN.test(line)) return { kind: 'fence', evidence: `fence:${line.slice(0, 80)}` }
  if (JSON_LIKE.test(line) || JSON_LABEL.test(line)) return { kind: 'json', evidence: `json:${line.slice(0, 160)}` }
  const refusal = refusalMatch(line)
  if (refusal && !hasNarrativeAttribution(line) && !looksLikeDialogue(line) && !refusalQuoteContains(line, refusal.index)) {
    return { kind: 'refusal', evidence: `refusal:${refusal.id}` }
  }
  const note = line.match(NOTE_LINE)
  if (note) {
    const noteRest = line.slice(note[0].length).trim()
    const noteRefusal = refusalMatch(noteRest)
    if (noteRefusal && !refusalQuoteContains(noteRest, noteRefusal.index)) return { kind: 'refusal', evidence: `refusal:${noteRefusal.id}:after_notes` }
    return { kind: 'notes', evidence: `notes:${line.slice(0, 160)}` }
  }
  if (TITLE_LINE.test(line)) return { kind: 'title', evidence: `title:${line.slice(0, 160)}` }
  if (WRAPPER_LINE.test(line)) return { kind: 'meta', evidence: `wrapper:${line.slice(0, 160)}` }
  const inlineWrapper = line.match(INLINE_WRAPPER)
  if (inlineWrapper) return { kind: 'meta', evidence: `wrapper:${inlineWrapper[0].slice(0, 160)}`, rest: line.slice(inlineWrapper[0].length).trim() }
  const metaPrefix = metaPrefixMatch(line)
  if (metaPrefix) {
    const rest = line.slice(metaPrefix[0].length).trim()
    return { kind: 'meta', evidence: `meta:${line.slice(0, 160)}`, ...(rest ? { rest } : {}) }
  }
  if (REPORT_LINE.test(line)) return { kind: 'report', evidence: `report:${line.slice(0, 160)}` }
  return { kind: 'prose', evidence: `prose:${line.slice(0, 160)}` }
}

interface TrailingBoundary {
  count: number
  kind: StructuralKind
  evidence: string
  unsafe: boolean
}

// Tail stripping must not use a small fixed removal count as a safety
// boundary.  A provider can put an arbitrary number of wrapper/refusal/report
// lines after otherwise valid prose.  We therefore keep stripping until the
// tail is stable, while bounding every line/byte inspection.  If a
// boundary cannot be proven inside either limit, callers fail closed by
// setting boundaryUnsafe (accepted manuscript rows require complete=true).
const MAX_TRAILING_SCAN_LINES = 4096
const MAX_TRAILING_SCAN_BYTES = 1024 * 1024

interface TrailingScanBudget {
  lines: number
  bytes: number
  exhausted: boolean
}

function trailingScanBudget(): TrailingScanBudget {
  return { lines: 0, bytes: 0, exhausted: false }
}

function inspectTrailingLine(lines: string[], index: number, budget: TrailingScanBudget): string | undefined {
  if (index < 0 || index >= lines.length) return undefined
  const bytes = Buffer.byteLength(lines[index] ?? '', 'utf8')
  if (budget.lines >= MAX_TRAILING_SCAN_LINES || budget.bytes + bytes > MAX_TRAILING_SCAN_BYTES) {
    budget.exhausted = true
    return undefined
  }
  budget.lines += 1
  budget.bytes += bytes
  return normalizeLine(lines[index] ?? '')
}

function looksLikeJsonBoundaryLine(line: string): boolean {
  return /^(?:JSON\s*[：:]|[{}\[\],]|["'][^\n"']+["']\s*:|[A-Za-z_$][\w$-]*\s*:|(?:true|false|null|-?\d+(?:\.\d+)?)(?:\s*[,}\]])?)$/iu.test(line)
}

function trailingStructuredBlock(lines: string[], budget: TrailingScanBudget): TrailingBoundary | null {
  const maximum = Math.min(MAX_TRAILING_SCAN_LINES, lines.length - 1)
  const suffix: string[] = []
  for (let offset = 0; offset < maximum; offset += 1) {
    const line = inspectTrailingLine(lines, lines.length - 1 - offset, budget)
    if (line === undefined) return null
    if (!looksLikeJsonBoundaryLine(line)) break
    suffix.unshift(line)
    const first = suffix[0] ?? ''
    const labeled = first.match(JSON_LABEL)
    const jsonText = labeled ? `${first.slice(labeled[0].length)}\n${suffix.slice(1).join('\n')}`.trim() : suffix.join('\n').trim()
    if (!labeled && !/^[{[]/u.test(jsonText)) continue
    if (!/^[{[]/u.test(jsonText)) continue
    try {
      JSON.parse(jsonText)
      return { count: suffix.length, kind: 'json', evidence: 'json:' + jsonText.slice(0, 160), unsafe: true }
    } catch {
      if (/(?:["']?)(?:outline|prose|notes|status|schemaVersion)(?:["']?)\s*:/iu.test(jsonText)) {
        return { count: suffix.length, kind: 'json', evidence: 'json:unparseable:' + jsonText.slice(0, 160), unsafe: true }
      }
    }
  }
  return null
}

function trailingCompositeMarker(lines: string[], budget: TrailingScanBudget): TrailingBoundary | null {
  const maximum = Math.min(MAX_TRAILING_SCAN_LINES, lines.length - 1)
  const suffix: string[] = []
  for (let offset = 0; offset < maximum; offset += 1) {
    const line = inspectTrailingLine(lines, lines.length - 1 - offset, budget)
    if (line === undefined) return null
    suffix.unshift(line)
    if (suffix.length < 2) continue
    const candidate = suffix.filter(Boolean).join(' ')
    if (!candidate) continue
    const marker = markerForLeadingLine(candidate)
    if (marker.kind === 'refusal' || marker.kind === 'meta' || marker.kind === 'notes' || marker.kind === 'report') {
      if (marker.rest) continue
      return { count: suffix.length, kind: marker.kind, evidence: marker.evidence, unsafe: false }
    }
    // A normal prose line cannot become a prefix-spanning presentation marker
    // by adding arbitrary earlier manuscript lines.  Stop as soon as the
    // oldest candidate is clearly ordinary prose; the bounded tail scan is
    // still able to cover short wrapped marker phrases.
    const oldest = suffix[0] ?? ''
    const oldestMarker = markerForLeadingLine(oldest)
    if (oldestMarker.kind === 'prose' && !/[，,：:；;、]$/u.test(oldest)) break
  }
  return null
}

function hasResidualTrailingStructure(value: string): boolean {
  const line = normalizeLine(value)
  if (!line) return false
  const marker = markerForLeadingLine(line)
  if (marker.kind !== 'prose') return true
  // A malformed or interleaved JSON block may leave a line such as `}` that
  // is not itself a valid JSON document and therefore is not classified by
  // markerForLeadingLine.  Treat JSON punctuation/key lines as unsafe tail
  // evidence rather than allowing them into accepted prose.
  if (/^\s*(?:\{|\}|\[|\]|,|JSON\s*[：:]|["'][^\n"']+["']\s*:)/iu.test(line)) return true
  if (/^\s*(?:outline|prose|notes|status|schemaVersion|type|content|arguments|tool_calls|response|result)\s*:/iu.test(line)) return true
  return false
}

function inlineTrailingPresentation(value: string): { prefix: string; marker: StructuralMarker; unsafe: boolean } | null {
  const line = normalizeLine(value)
  if (!line) return null
  if (markerForLeadingLine(line).kind !== 'prose') return null
  if (looksLikeDialogue(line)) return null
  for (let index = 1; index < line.length; index += 1) {
    const previous = line[index - 1] ?? ''
    if (!/[。.!！？?…]/u.test(previous) && !/\s/u.test(previous)) continue
    const suffix = line.slice(index).trim()
    if (!suffix) continue
    const marker = markerForLeadingLine(suffix)
    if (marker.rest || !['refusal', 'meta', 'notes', 'report', 'title', 'json'].includes(marker.kind)) continue
    const prefix = line.slice(0, index).trimEnd()
    if (!prefix) continue
    return { prefix, marker, unsafe: marker.kind === 'title' || marker.kind === 'json' }
  }
  return null
}

function trimTrailingPresentation(lines: string[], evidence: string[]): boolean {
  let unsafeBoundary = false
  while (lines.length > 0 && !normalizeLine(lines[lines.length - 1])) lines.pop()
  const budget = trailingScanBudget()
  while (lines.length > 0) {
    if (budget.exhausted) {
      evidence.push('trailing:scan_budget_exceeded')
      unsafeBoundary = true
      break
    }
    const structured = trailingStructuredBlock(lines, budget)
    if (structured) {
      evidence.push('trailing:' + structured.evidence)
      lines.splice(lines.length - structured.count, structured.count)
      unsafeBoundary = unsafeBoundary || structured.unsafe
      while (lines.length > 0 && !normalizeLine(lines[lines.length - 1])) lines.pop()
      continue
    }
    if (budget.exhausted) {
      evidence.push('trailing:scan_budget_exceeded')
      unsafeBoundary = true
      break
    }
    const last = inspectTrailingLine(lines, lines.length - 1, budget)
    if (last === undefined) {
      evidence.push('trailing:scan_budget_exceeded')
      unsafeBoundary = true
      break
    }
    const inline = inlineTrailingPresentation(last)
    if (inline) {
      evidence.push('trailing:' + inline.marker.evidence)
      lines[lines.length - 1] = inline.prefix
      unsafeBoundary = unsafeBoundary || inline.unsafe
      continue
    }
    if (lines.length <= 1) break
    const composite = trailingCompositeMarker(lines, budget)
    if (composite) {
      evidence.push('trailing:' + composite.evidence)
      lines.splice(lines.length - composite.count, composite.count)
      unsafeBoundary = unsafeBoundary || composite.unsafe
      while (lines.length > 0 && !normalizeLine(lines[lines.length - 1])) lines.pop()
      continue
    }
    if (budget.exhausted) {
      evidence.push('trailing:scan_budget_exceeded')
      unsafeBoundary = true
      break
    }
    const safeEnd = /^(?:以上(?:就是|为)?(?:正文|全文)|正文结束|end\s+of\s+(?:the\s+)?(?:prose|story)|希望这能帮到你)[。.!！？!?]?$/iu.test(last)
    const marker = markerForLeadingLine(last)
    if (safeEnd || marker.kind === 'refusal' || marker.kind === 'meta' || marker.kind === 'notes' || marker.kind === 'report') {
      evidence.push('trailing:' + last.slice(0, 160))
      lines.pop()
      while (lines.length > 0 && !normalizeLine(lines[lines.length - 1])) lines.pop()
      continue
    }
    if (marker.kind === 'title' || marker.kind === 'json') {
      evidence.push('trailing:' + marker.evidence)
      lines.pop()
      unsafeBoundary = true
      while (lines.length > 0 && !normalizeLine(lines[lines.length - 1])) lines.pop()
      continue
    }
    if (hasResidualTrailingStructure(last)) {
      evidence.push('trailing:residual_structural_marker')
      unsafeBoundary = true
    }
    break
  }
  if (!unsafeBoundary && !budget.exhausted && lines.length > 0) {
    const last = inspectTrailingLine(lines, lines.length - 1, budget)
    if (last === undefined) {
      evidence.push('trailing:scan_budget_exceeded')
      unsafeBoundary = true
    } else if (hasResidualTrailingStructure(last)) {
      evidence.push('trailing:residual_structural_marker')
      unsafeBoundary = true
    }
  }
  if (budget.exhausted && !evidence.includes('trailing:scan_budget_exceeded')) evidence.push('trailing:scan_budget_exceeded')
  return unsafeBoundary
}

function leadingCompositeMeta(lines: string[]): { count: number; marker: StructuralMarker } | null {
  const maximum = Math.min(3, lines.length)
  for (let count = 2; count <= maximum; count += 1) {
    const candidate = lines.slice(0, count).map(normalizeLine).filter(Boolean).join(' ')
    if (!candidate) continue
    const marker = markerForLeadingLine(candidate)
    if (marker.kind === 'meta' && !marker.rest) return { count, marker }
  }
  return null
}

function unwrapFence(lines: string[], evidence: string[]): { lines: string[]; kindHint?: 'plan' | 'meta' } {
  let firstIndex = 0
  while (firstIndex < lines.length && !normalizeLine(lines[firstIndex])) firstIndex += 1
  if (firstIndex >= lines.length || !FENCE_OPEN.test(normalizeLine(lines[firstIndex]))) return { lines }
  let lastIndex = lines.length - 1
  while (lastIndex > firstIndex && !normalizeLine(lines[lastIndex])) lastIndex -= 1
  if (!FENCE_CLOSE.test(normalizeLine(lines[lastIndex]))) return { lines, kindHint: 'meta' }
  const opening = normalizeLine(lines[firstIndex])
  const language = opening.replace(/^```/u, '').trim().toLocaleLowerCase()
  evidence.push(`fence:${opening.slice(0, 80)}`)
  const body = lines.slice(firstIndex + 1, lastIndex)
  if (language === 'json' || language === 'jsonc') return { lines: body, kindHint: 'plan' }
  return { lines: body }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

export type WriterEnvelopeValidation =
  | { ok: true; envelope: WriterStructuredEnvelope }
  | { ok: false; reason: string }

export function validateWriterStructuredEnvelope(value: unknown): WriterEnvelopeValidation {
  if (!isRecord(value)) return { ok: false, reason: 'envelope_not_object' }
  if (value.schemaVersion !== undefined && value.schemaVersion !== 1) return { ok: false, reason: 'envelope_schema_version' }
  if (typeof value.prose !== 'string') return { ok: false, reason: 'envelope_prose_not_string' }
  const status = value.status
  const allowedStatuses: readonly WriterEnvelopeStatus[] = ['complete', 'partial', 'writing', 'blocked', 'refusal', 'error']
  if (status !== undefined && (typeof status !== 'string' || !allowedStatuses.includes(status as WriterEnvelopeStatus))) {
    return { ok: false, reason: 'envelope_status_invalid' }
  }
  let notes: string[] = []
  if (value.notes !== undefined) {
    if (typeof value.notes === 'string') notes = [value.notes]
    else if (Array.isArray(value.notes) && value.notes.every((item) => typeof item === 'string')) notes = value.notes as string[]
    else return { ok: false, reason: 'envelope_notes_invalid' }
  }
  if (!value.prose.trim() && status !== 'partial' && status !== 'writing' && status !== 'blocked' && status !== 'refusal' && status !== 'error') {
    return { ok: false, reason: 'envelope_prose_empty' }
  }
  return {
    ok: true,
    envelope: {
      schemaVersion: 1,
      prose: value.prose,
      notes,
      ...(status !== undefined ? { status: status as WriterEnvelopeStatus } : {})
    }
  }
}

function structuredEnvelopeCandidate(value: string): { candidate: string; evidence: string[] } | null {
  const text = value.replace(/^\uFEFF/u, '').trim()
  if (!text) return null
  const lines = text.split(/\r?\n/u)
  let firstIndex = 0
  while (firstIndex < lines.length && !normalizeLine(lines[firstIndex])) firstIndex += 1
  if (firstIndex >= lines.length) return null
  const first = normalizeLine(lines[firstIndex])
  if (FENCE_OPEN.test(first)) {
    const language = first.slice(3).trim().toLocaleLowerCase()
    if (language !== 'json' && language !== 'jsonc') return null
    let lastIndex = lines.length - 1
    while (lastIndex > firstIndex && !normalizeLine(lines[lastIndex])) lastIndex -= 1
    if (lastIndex <= firstIndex || !FENCE_CLOSE.test(normalizeLine(lines[lastIndex]))) {
      return { candidate: lines.slice(firstIndex + 1).join('\n').trim(), evidence: ['envelope:fence_unclosed'] }
    }
    return { candidate: lines.slice(firstIndex + 1, lastIndex).join('\n').trim(), evidence: ['envelope:fence:' + language] }
  }
  const labeled = text.match(JSON_LABEL)
  if (labeled) return { candidate: text.slice(labeled[0].length).trim(), evidence: ['envelope:json_label'] }
  if (/^[{[]/u.test(first)) return { candidate: lines.slice(firstIndex).join('\n').trim(), evidence: ['envelope:json_object'] }
  return null
}

export function parseWriterStructuredEnvelope(value: string): WriterEnvelopeParseResult {
  const source = structuredEnvelopeCandidate(value)
  if (!source) return { detected: false }
  let parsed: unknown
  try {
    parsed = JSON.parse(source.candidate)
  } catch {
    if (!/(?:["']?)(?:prose|notes|status|schemaVersion)(?:["']?)\s*:/iu.test(source.candidate)) return { detected: false }
    return { detected: true, ok: false, reason: 'envelope_json_invalid', evidence: source.evidence }
  }
  if (!isRecord(parsed)) return { detected: false }
  const hasEnvelopeField = ['prose', 'notes', 'status', 'schemaVersion'].some((key) => Object.prototype.hasOwnProperty.call(parsed, key))
  if (!hasEnvelopeField) return { detected: false }
  const validated = validateWriterStructuredEnvelope(parsed)
  if (!validated.ok) return { detected: true, ok: false, reason: validated.reason, evidence: source.evidence }
  return { detected: true, ok: true, envelope: validated.envelope, evidence: [...source.evidence, 'envelope:valid'] }
}

function normalizeOutput(value: string, allowEnvelope = true): NormalizedOutput {
  let text = value.replace(/^\uFEFF/u, '').trim()
  const evidence: string[] = []
  if (!text) return { content: '', evidence: ['empty'], reason: 'empty_output' }
  if (allowEnvelope) {
    const envelope = parseWriterStructuredEnvelope(text)
    if (envelope.detected) {
      if (!envelope.ok) return { content: '', kindHint: 'meta', evidence: [...evidence, ...envelope.evidence, 'envelope:invalid=' + envelope.reason], reason: 'structured_envelope_invalid' }
      const status = envelope.envelope.status
      if (status === 'refusal') return { content: '', kindHint: 'refusal', evidence: [...evidence, ...envelope.evidence, 'envelope:status=refusal'], reason: 'structured_envelope_refusal' }
      if (status === 'blocked' || status === 'error') return { content: '', kindHint: 'meta', evidence: [...evidence, ...envelope.evidence, 'envelope:status=' + status], reason: 'structured_envelope_blocked' }
      const body = normalizeOutput(envelope.envelope.prose, false)
      if (!body.content) {
        return {
          content: '',
          kindHint: body.kindHint ?? 'meta',
          evidence: [...evidence, ...envelope.evidence, ...body.evidence, 'envelope:prose_empty'],
          reason: body.reason ?? 'structured_envelope_empty'
        }
      }
      const statusUnsafe = status !== undefined && status !== 'complete'
      return {
        content: body.content,
        evidence: [...evidence, ...envelope.evidence, ...body.evidence, 'envelope:notes=' + String(envelope.envelope.notes.length)],
        reason: statusUnsafe ? 'structured_envelope_partial' : 'structured_envelope_prose',
        ...(statusUnsafe || body.boundaryUnsafe ? { boundaryUnsafe: true } : {})
      }
    }
  }
  let lines = text.split(/\r?\n/u)
  let scans = 0
  let terminalKind: 'refusal' | 'plan' | 'meta' | undefined
  while (scans < 3) {
    while (lines.length > 0 && !normalizeLine(lines[0])) lines.shift()
    if (lines.length === 0) break
    if (scans === 0) {
      const softRefusal = softLeadingRefusal(lines)
      if (softRefusal && !refusalQuoteContains(lines.slice(0, 3).join(' '), softRefusal.index)) {
        return { content: '', kindHint: 'refusal', evidence: [`refusal:${softRefusal.id}:soft_wrap`], reason: 'refusal_prefix' }
      }
    }
    const compositeMeta = leadingCompositeMeta(lines)
    if (compositeMeta) {
      evidence.push(compositeMeta.marker.evidence)
      lines.splice(0, compositeMeta.count)
      scans += compositeMeta.count
      continue
    }
    const marker = markerForLeadingLine(lines[0])
    if (marker.kind === 'prose') break
    evidence.push(marker.evidence)
    if (marker.kind === 'refusal') return { content: '', kindHint: 'refusal', evidence, reason: 'refusal_prefix' }
    if (marker.kind === 'json') return { content: '', kindHint: 'plan', evidence, reason: 'structured_output' }
    if (marker.kind === 'fence') {
      const unwrapped = unwrapFence(lines, evidence)
      if (unwrapped.kindHint === 'meta') return { content: '', kindHint: 'meta', evidence, reason: 'fence_unclosed' }
      lines = unwrapped.lines
      if (unwrapped.kindHint === 'plan') terminalKind = 'plan'
      scans += 1
      continue
    }
    if (marker.rest !== undefined) lines[0] = marker.rest
    else lines.shift()
    scans += 1
  }
  while (lines.length > 0 && !normalizeLine(lines[0])) lines.shift()
  const unsafeBoundary = trimTrailingPresentation(lines, evidence)
  text = lines.join('\n').trim()
  if (!text) return { content: '', kindHint: terminalKind ?? 'meta', evidence, reason: evidence.some((item) => item.startsWith('notes:')) ? 'notes_only' : 'empty_after_wrapper' }
  const structured = text.replace(JSON_LABEL, '').trim()
  if (terminalKind === 'plan') return { content: '', kindHint: 'plan', evidence: [...evidence, 'json:fenced'], reason: 'structured_output' }
  if (JSON_LIKE.test(text) || ((structured.startsWith('{') && structured.endsWith('}')) || (structured.startsWith('[') && structured.endsWith(']')))) {
    if (structured.startsWith('{') || structured.startsWith('[')) {
      try {
        JSON.parse(structured)
        return { content: '', kindHint: 'plan', evidence: [...evidence, 'json:parse=ok'], reason: 'structured_output' }
      } catch {
        return { content: '', kindHint: 'plan', evidence: [...evidence, 'json:parse=failed'], reason: 'structured_output_unparseable' }
      }
    }
  }
  return { content: text, evidence, reason: evidence.length > 0 ? 'prose_after_boundary_strip' : 'prose', ...(unsafeBoundary ? { boundaryUnsafe: true } : {}) }
}

export function sanitizeWriterProse(value: string): string {
  const normalized = normalizeOutput(value)
  return normalized.kindHint === undefined ? normalized.content : ''
}

export function hasNaturalProseEnding(value: string): boolean {
  return NATURAL_END.test(value.trim())
}

export function classifyAssistantOutput(value: string): ClassifiedAssistantOutput {
  const normalized = normalizeOutput(value)
  if (!normalized.content) {
    const kind = normalized.kindHint ?? 'meta'
    return { kind, content: '', complete: false, reason: normalized.reason ?? 'empty_after_wrapper', evidence: normalized.evidence }
  }
  const contentHash = manuscriptSegmentHash(normalized.content)
  return {
    kind: 'prose',
    content: normalized.content,
    complete: !normalized.boundaryUnsafe && hasNaturalProseEnding(normalized.content),
    reason: normalized.reason ?? 'prose',
    evidence: [...normalized.evidence, `content_chars=${codePointLength(normalized.content)}`, `content_hash=${contentHash}`]
  }
}

export function manuscriptSegmentHash(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex')
}

export function manuscriptAcceptanceEvidenceIdentity(input: {
  runId: string
  segmentId: string
  candidateHash: string
  candidateCharCount: number
  evidenceRevision: number
  sceneId: string | null
  evidenceRefs: Record<string, string | null>
  supersedesAcceptedSegmentId?: string
}): string {
  const evidenceRefs = Object.fromEntries(Object.entries(input.evidenceRefs).sort(([a], [b]) => a.localeCompare(b)))
  return manuscriptSegmentHash(JSON.stringify({
    runId: input.runId,
    segmentId: input.segmentId,
    candidateHash: input.candidateHash,
    candidateCharCount: input.candidateCharCount,
    evidenceRevision: input.evidenceRevision,
    sceneId: input.sceneId,
    ...(input.supersedesAcceptedSegmentId ? { supersedesAcceptedSegmentId: input.supersedesAcceptedSegmentId } : {}),
    evidenceRefs
  }))
}

/**
 * Validate the durable shape of a legacy backfill before it can be resumed.
 * The accepted id list historically doubled as a plan, so ids that have not
 * been materialized yet are allowed only when they are deterministic legacy
 * ids (`<run>:legacy:<source turn>`).  Materialized ids must point to an
 * accepted prose segment; arbitrary/malformed ids fail closed.
 */
export function validateLegacyBackfillState(
  state: LegacyManuscriptBackfillState,
  segments?: readonly {
    segmentId: string
    runId: string
    sourceTurnId?: string | null
    status: string
    kind: string
  }[]
): void {
  const corrupt = (_reason: string): never => { throw new Error('manuscript_backfill_corrupt') }
  if (state.schemaVersion !== 1 || !state.runId || !Number.isInteger(state.expectedSourceCount) || state.expectedSourceCount < 0 ||
    !Number.isInteger(state.expectedSegmentCount) || state.expectedSegmentCount < 0 || state.expectedSourceCount !== state.sourceTurns.length ||
    state.expectedSegmentCount !== state.sourceTurns.length || !Number.isInteger(state.expectedAcceptedCharCount) || state.expectedAcceptedCharCount < 0) {
    corrupt('header')
  }
  const sourceIds = new Set<string>()
  const sourceSeqs = new Set<number>()
  for (let index = 0; index < state.sourceTurns.length; index += 1) {
    const source = state.sourceTurns[index]
    if (!source || !source.sourceTurnId || sourceIds.has(source.sourceTurnId) || !Number.isInteger(source.sourceTurnSeq) || sourceSeqs.has(source.sourceTurnSeq) ||
      !/^[0-9a-f]{64}$/u.test(source.sourceContentHash) || !Number.isInteger(source.sourceCharCount) || source.sourceCharCount < 0 ||
      (index > 0 && state.sourceTurns[index - 1]!.sourceTurnSeq >= source.sourceTurnSeq)) {
      corrupt('source')
    }
    sourceIds.add(source.sourceTurnId)
    sourceSeqs.add(source.sourceTurnSeq)
  }
  if (state.processedSourceTurnIds.length > state.sourceTurns.length || new Set(state.processedSourceTurnIds).size !== state.processedSourceTurnIds.length ||
    state.processedSourceTurnIds.some((id, index) => state.sourceTurns[index]?.sourceTurnId !== id)) {
    corrupt('processed')
  }
  if (new Set(state.acceptedSegmentIds).size !== state.acceptedSegmentIds.length || state.acceptedSegmentIds.some((id) => !id || typeof id !== 'string')) {
    corrupt('accepted_shape')
  }
  const hasSegmentEvidence = segments !== undefined
  const byId = new Map((segments ?? []).map((segment) => [segment.segmentId, segment]))
  const materializedIds = new Set<string>()
  for (const segmentId of state.acceptedSegmentIds) {
    const segment = byId.get(segmentId)
    if (!segment) {
      // buildLegacyBackfillPlan may persist its deterministic accepted plan
      // before the segment rows are replayed.  No arbitrary id gets this
      // migration allowance.
      const sourceId = segmentId.startsWith(`${state.runId}:legacy:`) ? segmentId.slice(`${state.runId}:legacy:`.length) : ''
      if (!sourceIds.has(sourceId)) corrupt('accepted_missing_unknown')
      continue
    }
    if (segment.runId !== state.runId || segment.status !== 'accepted' || segment.kind !== 'prose' || !segment.sourceTurnId || !sourceIds.has(segment.sourceTurnId)) {
      corrupt('accepted_row')
    }
    materializedIds.add(segmentId)
  }
  // A processed source must have its accepted id materialized whenever the
  // state says that source was accepted.  This catches stale/foreign ids while
  // still permitting the deterministic pre-materialization plan above.
  for (const segment of segments ?? []) {
    if (state.verification !== 'active_run' && !state.acceptedSegmentIds.includes(segment.segmentId) && segment.status === 'accepted' && segment.kind === 'prose' && segment.sourceTurnId && sourceIds.has(segment.sourceTurnId)) {
      corrupt('orphan_accepted_row')
    }
  }
  if (hasSegmentEvidence && state.status === 'complete') {
    if (state.processedSourceTurnIds.length !== state.sourceTurns.length || state.acceptedSegmentIds.some((id) => !materializedIds.has(id))) {
      corrupt('complete_incomplete')
    }
  }
}

export function manuscriptAcceptanceEvidenceMatches(input: {
  kind: string
  json: string
  segmentId: string
  contentHash: string
}): boolean {
  let evidence: Record<string, unknown>
  try {
    const parsed = JSON.parse(input.json) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return false
    evidence = parsed as Record<string, unknown>
  } catch {
    return false
  }
  const candidateHash = typeof evidence.candidateHash === 'string' ? evidence.candidateHash : ''
  const segmentHash = typeof evidence.segmentHash === 'string' ? evidence.segmentHash : ''
  const evidenceSegmentId = typeof evidence.segmentId === 'string' ? evidence.segmentId : ''
  if (input.kind === 'strong_constraint_latest') {
    return evidence.status === 'passed' && evidence.latestSegmentHash === input.contentHash
  }
  if (input.kind === 'writing_pipeline_latest') {
    return evidence.stage === 'accepted' && candidateHash === input.contentHash
  }
  if (input.kind === 'scene_contract_latest' || input.kind === `scene_contract_segment:${input.segmentId}:candidate`) {
    return evidence.stage === 'candidate' && evidence.status !== 'deviated' && evidenceSegmentId === input.segmentId && (candidateHash === input.contentHash || segmentHash === input.contentHash)
  }
  if (input.kind === 'narrative_quality_latest' || input.kind === `narrative_quality_segment:${input.segmentId}:candidate`) {
    return evidence.stage === 'candidate' && evidence.status !== 'blocked' && evidenceSegmentId === input.segmentId && candidateHash === input.contentHash
  }
  return false
}

export function legacyBackfillSourceSummaryHash(sourceTurns: readonly LegacyManuscriptBackfillSource[]): string {
  return manuscriptSegmentHash(JSON.stringify(sourceTurns.map((source) => ({
    sourceTurnId: source.sourceTurnId,
    sourceTurnSeq: source.sourceTurnSeq,
    sourceContentHash: source.sourceContentHash,
    sourceCharCount: source.sourceCharCount
  }))))
}

export function legacyBackfillCompletionMarker(state: LegacyManuscriptBackfillState): string {
  return manuscriptSegmentHash(JSON.stringify({
    schemaVersion: state.schemaVersion,
    runId: state.runId,
    status: state.status,
    verification: state.verification,
    sourceTurns: state.sourceTurns,
    sourceSummaryHash: state.sourceSummaryHash,
    expectedSourceCount: state.expectedSourceCount,
    expectedSegmentCount: state.expectedSegmentCount,
    expectedAcceptedCharCount: state.expectedAcceptedCharCount,
    expectedAcceptedContentHash: state.expectedAcceptedContentHash,
    expectedArtifactId: state.expectedArtifactId,
    expectedArtifactHash: state.expectedArtifactHash,
    expectedArtifactCharCount: state.expectedArtifactCharCount,
    processedSourceTurnIds: state.processedSourceTurnIds,
    acceptedSegmentIds: state.acceptedSegmentIds
  }))
}

export function makeManuscriptSegment(input: {
  runId: string
  sessionId: string
  turnId: string
  chunkIndex: number
  content: string
  status: ManuscriptSegmentStatus
  kind?: AssistantOutputKind
  createdAt: number
  updatedAt?: number
  revision?: number
  segmentId?: string
  sourceTurnId?: string
  sectionId?: string
  sceneId?: string
  supersedesSegmentId?: string
}): ManuscriptSegment {
  const updatedAt = input.updatedAt ?? Date.now()
  return {
    schemaVersion: 1,
    segmentId: input.segmentId ?? `${input.runId}:${input.turnId}`,
    runId: input.runId,
    sessionId: input.sessionId,
    sourceTurnId: input.sourceTurnId ?? input.turnId,
    ...(input.sectionId ? { sectionId: input.sectionId } : {}),
    ...(input.sceneId ? { sceneId: input.sceneId } : {}),
    chunkIndex: input.chunkIndex,
    revision: input.revision ?? 1,
    status: input.status,
    kind: input.kind ?? 'prose',
    content: input.content,
    contentHash: manuscriptSegmentHash(input.content),
    charCount: codePointLength(input.content),
    createdAt: input.createdAt,
    updatedAt,
    ...(input.supersedesSegmentId ? { supersedesSegmentId: input.supersedesSegmentId } : {})
  }
}

export function acceptedManuscriptSegments(segments: ManuscriptSegment[]): ManuscriptSegment[] {
  const seen = new Set<string>()
  return segments
    .filter((segment) => {
      if (segment.status !== 'accepted' || segment.kind !== 'prose' || seen.has(segment.segmentId)) return false
      seen.add(segment.segmentId)
      return true
    })
    .sort((a, b) => a.chunkIndex - b.chunkIndex || a.revision - b.revision || a.createdAt - b.createdAt || a.segmentId.localeCompare(b.segmentId))
}

export function validateManuscriptPartialGraph(segments: readonly {
  segmentId: string
  runId: string
  sceneId?: string | null
  chunkIndex: number
  status: string
  supersedesSegmentId?: string | null
}[]): void {
  const byId = new Map(segments.map((segment) => [segment.segmentId, segment]))
  const scopeKey = (segment: { runId: string; sceneId?: string | null; chunkIndex: number }): string => `${segment.runId}\u0000${segment.sceneId ?? ''}\u0000${segment.chunkIndex}`
  const activePartials = new Map<string, string>()
  for (const segment of segments) {
    if (segment.status === 'partial') {
      const key = scopeKey(segment)
      const previous = activePartials.get(key)
      if (previous && previous !== segment.segmentId) throw new Error('manuscript_partial_multiple_active')
      activePartials.set(key, segment.segmentId)
    }
  }
  for (const segment of segments) {
    let current = segment
    const visited = new Set<string>([segment.segmentId])
    while (current.supersedesSegmentId) {
      const parentId = current.supersedesSegmentId
      if (visited.has(parentId)) throw new Error('manuscript_partial_chain_cycle')
      const parent = byId.get(parentId)
      if (!parent) throw new Error('manuscript_partial_chain_broken')
      if (parent.runId !== segment.runId) throw new Error('manuscript_partial_chain_cross_run')
      if (parent.chunkIndex !== segment.chunkIndex || (parent.sceneId ?? null) !== (segment.sceneId ?? null)) {
        throw new Error('manuscript_partial_chain_scope_mismatch')
      }
      if (parent.status === 'accepted') throw new Error('manuscript_segment_accepted_cannot_supersede')
      // A candidate may carry a partial for review, but it must never erase
      // the partial before acceptance.  The same invariant applies to an
      // accepted child: reaching the final state through a candidate ancestor
      // would make the partial chain un-auditable during recovery.
      if ((segment.status === 'partial' || segment.status === 'accepted') && parent.status === 'candidate') {
        throw new Error('manuscript_partial_candidate_ancestor')
      }
      visited.add(parentId)
      current = parent
    }
  }
}

export function buildAcceptedManuscript(segments: ManuscriptSegment[]): string {
  return acceptedManuscriptSegments(segments).map((segment) => segment.content).join('')
}

export function mergeContinuationText(prefix: string, continuation: string): string {
  if (!prefix) return continuation
  if (!continuation) return prefix
  const prefixPoints = Array.from(prefix)
  const continuationPoints = Array.from(continuation)
  if (continuation.startsWith(prefix)) return continuation
  const maxOverlap = Math.min(prefixPoints.length, continuationPoints.length, 4096)
  for (let length = maxOverlap; length > 0; length--) {
    let matches = true
    for (let i = 0; i < length; i++) {
      if (prefixPoints[prefixPoints.length - length + i] !== continuationPoints[i]) {
        matches = false
        break
      }
    }
    if (matches) return prefix + continuationPoints.slice(length).join('')
  }
  return prefix + continuation
}
