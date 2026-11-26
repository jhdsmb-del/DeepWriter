import { createHash } from 'node:crypto'
import type { DsMessage, LongWriteChapterCheckpoint, LongWriteChapterPlan, LongWriteCheckpoint, LongWritePlan } from '../shared/types'
import { estimateTokens } from '../shared/types'
import { codePointLength, takeCodePoints } from '../shared/textMetrics'

/** The UI accepts up to two million code points.  At the normalized minimum
 * provider capability (128 output tokens ≈ 92 useful code points/turn), that
 * target needs about 21,740 productive turns; seven safety turns for each of
 * the 64 bounded chapters plus the initial turn brings the worst valid plan to
 * 22,209.  Keep a generous absolute guard above that derived value; it is not
 * a normal completion budget. */
export const LONGWRITE_MAX_TURNS_CAP = 32768
export const LONGWRITE_MAX_CHAPTERS = 64
export const LONGWRITE_PLAN_SCHEMA_VERSION = 1

const DEFAULT_MODEL_OUTPUT_TOKENS = 4096
const MIN_MODEL_OUTPUT_TOKENS = 128
const MAX_MODEL_OUTPUT_TOKENS = 384000
const MIN_CHARS_PER_TURN = 64
const CHARS_PER_TOKEN = 0.72
const CHAPTER_TURN_MULTIPLIER = 5
// Short responses and an occasional critic/editor repair can consume several
// turns inside a chapter.  This is a per-chapter safety margin, not a global
// fixed round budget; productive turns still grow with target/capability.
const DEFAULT_SAFETY_TURNS_PER_CHAPTER = 7
const MIN_CHAPTER_TARGET = 4000
const MAX_CHAPTER_TARGET = 32000
const DEFAULT_RECENT_CHARS = 7000
const DEFAULT_SUMMARY_CHARS = 2500
const DEFAULT_MAX_SUMMARY_CHARS = 5000
const MAX_STATIC_SYSTEM_MESSAGES = 6
const MAX_STATIC_SYSTEM_CHARS = 16000

export interface LongWritePlanInput {
  targetChars: number
  modelOutputTokens?: number
  safetyTurnsPerChapter?: number
}

export interface LongWriteTurnLike {
  role: DsMessage['role']
  content: string
  turnId?: string
  turnSeq?: number
}

export interface LongWriteChapterSummary {
  id: string
  index: number
  targetChars: number
  measuredChars: number
  status: LongWriteChapterCheckpoint['status']
  summary: string
}

export interface LongWriteContextProjection {
  messages: DsMessage[]
  contextChars: number
  measuredChars: number
  currentChapter: number
  remainingChars: number
  chapterSummaries: LongWriteChapterSummary[]
  summaryHash: string
  compressionApplied: boolean
}

/** Only the planner's derived memory is compressible here. Current task,
 * author agreements, section/scene scope and repair instructions are kept
 * byte-for-byte. The complete accepted manuscript remains in the ledger. */
export function fitLongWriteMemoryProjections(messages: DsMessage[], budgetTokens: number): { messages: DsMessage[]; savedTokens: number } | null {
  const cost = (message: DsMessage): number => estimateTokens(JSON.stringify(message))
  const tail = messages.find(message => message.role === 'assistant' && message.content.startsWith('## 最近正文尾部（仅用于衔接；完整正文以 durable manuscript 为准）\n'))
  const summary = messages.find(message => message.role === 'system' && message.content.startsWith('## 长文 durable 章节摘要（有界工作集）\n'))
  const optional = new Set([tail, summary].filter((message): message is DsMessage => Boolean(message)))
  if (!optional.size) return null
  const total = messages.reduce((sum, message) => sum + cost(message), 0)
  if (total <= budgetTokens) return null
  const required = messages.filter(message => !optional.has(message)).reduce((sum, message) => sum + cost(message), 0)
  let remaining = Math.max(0, Math.floor(budgetTokens - required))
  const replacements = new Map<DsMessage, DsMessage | null>()
  const fit = (message: DsMessage, budget: number, recent: boolean): DsMessage | null => {
    if (cost(message) <= budget) return message
    const newline = message.content.indexOf('\n'), heading = message.content.slice(0, newline + 1)
    const points = Array.from(message.content.slice(newline + 1))
    const marker = recent ? '…[更早正文已省略，完整稿保留在本地]…\n' : '\n…[摘要按本模型窗口截短]…'
    let low = 0, high = points.length, best: DsMessage | null = null
    while (low <= high) {
      const count = Math.floor((low + high) / 2)
      const text = recent ? heading + marker + points.slice(points.length - count).join('') : heading + points.slice(0, count).join('') + marker
      const candidate = { ...message, content: text }
      if (cost(candidate) <= budget) { best = candidate; low = count + 1 } else high = count - 1
    }
    return best
  }
  if (tail) {
    const selected = fit(tail, summary ? Math.floor(remaining * 0.78) : remaining, true)
    replacements.set(tail, selected)
    remaining -= selected ? cost(selected) : 0
  }
  if (summary) replacements.set(summary, fit(summary, remaining, false))
  const selected = messages.flatMap(message => replacements.has(message) ? replacements.get(message) ? [replacements.get(message)!] : [] : [message])
  return { messages: selected, savedTokens: Math.max(0, total - selected.reduce((sum, message) => sum + cost(message), 0)) }
}

function finitePositive(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback
}

function normalizeTarget(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0
  return Math.max(1, Math.floor(value))
}

function normalizeModelOutputTokens(value: number | undefined): number {
  const raw = finitePositive(value, DEFAULT_MODEL_OUTPUT_TOKENS)
  return Math.min(MAX_MODEL_OUTPUT_TOKENS, Math.max(MIN_MODEL_OUTPUT_TOKENS, Math.floor(raw)))
}

function normalizeSafetyTurns(value: number | undefined): number {
  const raw = finitePositive(value, DEFAULT_SAFETY_TURNS_PER_CHAPTER)
  return Math.min(8, Math.max(1, Math.floor(raw)))
}

function estimatedCharsPerTurn(modelOutputTokens: number): number {
  return Math.max(MIN_CHARS_PER_TURN, Math.floor(modelOutputTokens * CHARS_PER_TOKEN))
}

function chapterBudgets(targetChars: number, chapterTargetChars: number): LongWriteChapterPlan[] {
  if (targetChars <= 0) {
    return [{ id: 'chapter-01', index: 1, startChars: 0, targetChars: 0, endChars: 0 }]
  }
  const chapterCount = Math.min(LONGWRITE_MAX_CHAPTERS, Math.max(1, Math.ceil(targetChars / chapterTargetChars)))
  const base = Math.floor(targetChars / chapterCount)
  const remainder = targetChars % chapterCount
  const chapters: LongWriteChapterPlan[] = []
  let start = 0
  for (let i = 0; i < chapterCount; i++) {
    const size = base + (i < remainder ? 1 : 0)
    const end = start + size
    chapters.push({ id: `chapter-${String(i + 1).padStart(2, '0')}`, index: i + 1, startChars: start, targetChars: size, endChars: end })
    start = end
  }
  return chapters
}

/**
 * Derive all normal long-form limits from the immutable target and provider
 * capability.  In particular, no 8k/128-turn special case exists here: a
 * 2m target gets more chapters and turns while the absolute cap only protects
 * against a broken provider or a non-progressing loop.
 */
export function deriveLongWritePlan(input: LongWritePlanInput): LongWritePlan {
  const targetChars = normalizeTarget(input.targetChars)
  const modelOutputTokens = normalizeModelOutputTokens(input.modelOutputTokens)
  const safetyTurnsPerChapter = normalizeSafetyTurns(input.safetyTurnsPerChapter)
  const charsPerTurn = estimatedCharsPerTurn(modelOutputTokens)
  const chapterTargetChars = Math.min(MAX_CHAPTER_TARGET, Math.max(MIN_CHAPTER_TARGET, charsPerTurn * CHAPTER_TURN_MULTIPLIER))
  const chapters = chapterBudgets(targetChars, chapterTargetChars)
  const productiveTurns = targetChars > 0
    ? chapters.reduce((sum, chapter) => sum + Math.max(1, Math.ceil(chapter.targetChars / charsPerTurn)), 0)
    : 1
  const computedMaxTurns = productiveTurns + chapters.length * safetyTurnsPerChapter + 1
  const maxTurns = Math.min(LONGWRITE_MAX_TURNS_CAP, Math.max(4, computedMaxTurns))
  const estimatedCompletionTokens = targetChars > 0
    ? Math.ceil(targetChars / Math.max(1, CHARS_PER_TOKEN)) + (chapters.length * safetyTurnsPerChapter * Math.max(64, Math.ceil(modelOutputTokens * 0.08)))
    : 0
  return {
    schemaVersion: LONGWRITE_PLAN_SCHEMA_VERSION,
    targetChars,
    modelOutputTokens,
    estimatedCharsPerTurn: charsPerTurn,
    chapterTargetChars,
    safetyTurnsPerChapter,
    chapters,
    maxTurns,
    estimatedCompletionTokens,
    contextRecentChars: DEFAULT_RECENT_CHARS,
    contextSummaryChars: DEFAULT_SUMMARY_CHARS,
    maxContextSummaryChars: DEFAULT_MAX_SUMMARY_CHARS
  }
}

/** Compatibility entry point retained for old snapshot/test callers. */
export function deriveLongwriteMaxTurns(targetChars: number, modelOutputTokens?: number): number {
  return deriveLongWritePlan({ targetChars, modelOutputTokens }).maxTurns
}

export function longWritePlanHash(plan: LongWritePlan): string {
  return createHash('sha256').update(JSON.stringify(plan), 'utf8').digest('hex')
}

function tailCodePointsFromPoints(points: string[], count: number): string {
  if (points.length === 0 || count <= 0) return ''
  return points.slice(Math.max(0, points.length - Math.floor(count))).join('')
}

function excerpt(text: string, limit: number): string {
  const safeLimit = Math.max(32, Math.floor(limit))
  if (codePointLength(text) <= safeLimit) return text
  const head = Math.max(16, Math.floor(safeLimit * 0.58))
  const tail = Math.max(16, safeLimit - head - 18)
  const points = Array.from(text)
  return `${points.slice(0, head).join('')}\n…[摘要截断]…\n${points.slice(Math.max(head, points.length - tail)).join('')}`
}

function statusForChapter(measuredChars: number, chapter: LongWriteChapterPlan): LongWriteChapterCheckpoint['status'] {
  if (measuredChars >= chapter.endChars && chapter.targetChars > 0) return 'completed'
  if (measuredChars > chapter.startChars) return 'writing'
  return 'pending'
}

function chapterSummariesForPoints(points: string[], plan: LongWritePlan): LongWriteChapterSummary[] {
  const measuredChars = points.length
  const summaryBudget = Math.min(plan.contextSummaryChars, plan.maxContextSummaryChars)
  const perChapter = Math.max(96, Math.floor(summaryBudget / Math.max(1, plan.chapters.length)))
  return plan.chapters.map((chapter) => {
    const content = points.slice(chapter.startChars, Math.min(measuredChars, chapter.endChars)).join('')
    const status = statusForChapter(measuredChars, chapter)
    const summary = content
      ? excerpt(content, perChapter)
      : status === 'pending' ? '（尚未开始）' : '（待生成摘要）'
    return { id: chapter.id, index: chapter.index, targetChars: chapter.targetChars, measuredChars: Math.max(0, Math.min(measuredChars, chapter.endChars) - chapter.startChars), status, summary }
  })
}

function chapterSummariesFor(text: string, plan: LongWritePlan): LongWriteChapterSummary[] {
  // Materialize code points once per projection.  The previous implementation
  // rescanned the complete prefix for every chapter (O(text × chapters)); at
  // 64 chapters that made a large manuscript increasingly expensive on every
  // continuation turn.
  return chapterSummariesForPoints(Array.from(text), plan)
}

function systemMessagesFor(turns: LongWriteTurnLike[]): DsMessage[] {
  const systems = turns.filter((turn) => turn.role === 'system' && turn.content.trim())
  if (systems.length <= 3) return systems.map((turn) => ({ role: 'system', content: excerpt(turn.content, 6000) }))
  // Long runs can accumulate several frozen system records (mode policy,
  // preset, plan, approved outline, and repair instructions).  Select by
  // semantic anchors instead of taking only the first three: otherwise a
  // late outline or the frozen longwrite plan disappears after a repair turn.
  const scored = systems.map((turn, index) => {
    const semantic = /长文执行计划|已确认大纲|Grill Me|写作契约|强约束|主题与写作|用户预设|已批准计划|当前任务/.test(turn.content)
    const score = (index === 0 ? 1000 : 0) +
      (index === 1 ? 900 : 0) +
      (index === systems.length - 1 ? 950 : 0) +
      (semantic ? 800 : 0)
    return { turn, index, score }
  }).sort((a, b) => b.score - a.score || a.index - b.index).slice(0, MAX_STATIC_SYSTEM_MESSAGES).sort((a, b) => a.index - b.index)
  let remaining = MAX_STATIC_SYSTEM_CHARS
  const out: DsMessage[] = []
  for (let i = 0; i < scored.length; i++) {
    const entry = scored[i]
    const slots = Math.max(1, scored.length - i)
    const limit = Math.min(6000, Math.max(32, Math.floor(remaining / slots)))
    const content = excerpt(entry.turn.content, limit)
    out.push({ role: 'system', content })
    remaining = Math.max(0, remaining - codePointLength(content))
  }
  return out
}

function userMessagesFor(turns: LongWriteTurnLike[]): DsMessage[] {
  const users = turns.filter((turn) => turn.role === 'user' && turn.content.trim())
  if (users.length === 0) return []
  const selected = users.length === 1 ? [users[0]] : [users[0], users[users.length - 1]]
  const seen = new Set<LongWriteTurnLike>()
  return selected.filter((turn) => {
    if (seen.has(turn)) return false
    seen.add(turn)
    return true
  }).map((turn) => ({ role: 'user', content: excerpt(turn.content, 3000) }))
}

function latestToolMessage(turns: LongWriteTurnLike[]): DsMessage | null {
  const tool = [...turns].reverse().find((turn) => turn.role === 'tool' && turn.content.trim())
  return tool ? { role: 'tool', tool_call_id: '', content: excerpt(tool.content, 1800) } : null
}

function selectedChapterSummaryIndices(summaries: LongWriteChapterSummary[], currentIndex: number): number[] {
  if (summaries.length === 0) return []
  const activeIndex = Math.max(0, Math.min(currentIndex, summaries.length - 1))
  const indices: number[] = [0]
  for (let i = Math.min(activeIndex - 1, summaries.length - 1); i >= 0; i--) {
    if (summaries[i].status === 'completed') {
      indices.push(i)
      break
    }
  }
  indices.push(Math.max(0, Math.min(activeIndex, summaries.length - 1)))
  return [...new Set(indices)].sort((a, b) => a - b)
}

function chapterSummaryText(summaries: LongWriteChapterSummary[], plan: LongWritePlan, measuredChars: number): string {
  const budget = Math.max(256, Math.min(plan.contextSummaryChars, plan.maxContextSummaryChars))
  const activeIndex = plan.chapters.findIndex((chapter) => measuredChars < chapter.endChars)
  const currentIndex = activeIndex >= 0 ? activeIndex : plan.chapters.length - 1
  const selected = selectedChapterSummaryIndices(summaries, currentIndex)
  const unique = [...new Set([...selected, 0, currentIndex])].filter((index) => index >= 0 && index < summaries.length).sort((a, b) => a - b)
  const anchor = `## 长文 durable 章节摘要（有界工作集）\n目标 ${plan.targetChars} 字；当前章节 ${currentIndex + 1}/${plan.chapters.length}；完整正文以 durable manuscript 为准。\n`
  const remaining = Math.max(1, budget - codePointLength(anchor) - Math.max(0, unique.length - 1))
  const perSection = Math.max(32, Math.floor(remaining / Math.max(1, unique.length)))
  const sections = unique.map((index) => {
    const summary = summaries[index]
    const heading = `### ${summary.id} · ${summary.status} · ${summary.measuredChars}/${summary.targetChars}`
    const contentBudget = Math.max(1, perSection - codePointLength(heading) - 1)
    return takeCodePoints(`${heading}\n${excerpt(summary.summary, contentBudget)}`, perSection)
  })
  return takeCodePoints(`${anchor}${sections.join('\n')}`, budget)
}

export function buildLongWriteProgressInstruction(plan: LongWritePlan, measuredChars: number, round?: number): string {
  const measured = Math.max(0, Math.floor(measuredChars))
  const current = plan.chapters.find((chapter) => measured < chapter.endChars) ?? plan.chapters[plan.chapters.length - 1]
  const currentMeasured = current ? Math.max(0, Math.min(current.targetChars, measured - current.startChars)) : 0
  const remaining = Math.max(0, plan.targetChars - measured)
  const roundText = round && round > 0 ? `；这是第 ${Math.floor(round)} 个写作轮次` : ''
  return `当前长文编排进度：总正文 ${measured}/${plan.targetChars} 个 Unicode code point，剩余约 ${remaining}；当前章节 ${current?.index ?? 1}/${plan.chapters.length}（${current?.id ?? 'chapter-01'}）已完成 ${currentMeasured}/${current?.targetChars ?? 0}${roundText}。只输出紧接 durable 正文的自然续写，推进当前章节并遵循已冻结的大纲、人物和约束；接近章节边界时自然收束，不要重复既有内容，不要输出字数说明、章节进度或任何元话语。`
}

export function buildLongWritePlanPrompt(plan: LongWritePlan): string {
  const chapterLines = plan.chapters.map((chapter) => `- ${chapter.id}：${chapter.targetChars} 字（${chapter.startChars}–${chapter.endChars}）`).join('\n')
  return `## 长文执行计划（已冻结）\n目标：${plan.targetChars} 个 Unicode code point\n模型单轮输出上限：${plan.modelOutputTokens} tokens；规划有效产出约 ${plan.estimatedCharsPerTurn} 字/轮\n计划参考轮数：${plan.maxTurns}（由目标、模型能力和每章 ${plan.safetyTurnsPerChapter} 轮余量估算；不是运行预算或自动停止条件）\n章节分段：\n${chapterLines}\n执行要求：按当前章节、剩余篇幅和自然句末连续写作；正文完整内容以 durable manuscript/checkpoint 为准，续写上下文只携带章节摘要与最近正文尾部；不得把内部 continuation 暴露为用户手动操作。`
}

export function buildLongWriteContextMessages(turns: LongWriteTurnLike[], plan: LongWritePlan, round?: number): LongWriteContextProjection {
  const assistantText = turns.filter((turn) => turn.role === 'assistant').map((turn) => turn.content).join('')
  const assistantPoints = Array.from(assistantText)
  const measuredChars = assistantPoints.length
  const chapterSummaries = chapterSummariesForPoints(assistantPoints, plan)
  const summaryText = chapterSummaryText(chapterSummaries, plan, measuredChars)
  const currentChapter = plan.chapters.find((chapter) => measuredChars < chapter.endChars)?.index ?? plan.chapters.length
  const remainingChars = Math.max(0, plan.targetChars - measuredChars)
  const recent = tailCodePointsFromPoints(assistantPoints, plan.contextRecentChars)
  const messages: DsMessage[] = []
  messages.push(...systemMessagesFor(turns))
  messages.push(...userMessagesFor(turns))
  if (summaryText) messages.push({ role: 'system', content: summaryText })
  if (recent) messages.push({ role: 'assistant', content: `## 最近正文尾部（仅用于衔接；完整正文以 durable manuscript 为准）\n${recent}` })
  const tool = latestToolMessage(turns)
  if (tool) messages.push(tool)
  messages.push({ role: 'system', content: buildLongWriteProgressInstruction(plan, measuredChars, round) })
  const contextChars = JSON.stringify(messages).length
  return {
    messages,
    contextChars,
    measuredChars,
    currentChapter,
    remainingChars,
    chapterSummaries,
    summaryHash: createHash('sha256').update(summaryText, 'utf8').digest('hex'),
    compressionApplied: turns.filter((turn) => turn.role === 'assistant').length > 1 || measuredChars > plan.contextRecentChars
  }
}

export function buildLongWriteCheckpoint(runId: string, turns: LongWriteTurnLike[], plan: LongWritePlan, updatedAt = Date.now()): LongWriteCheckpoint {
  const assistantText = turns.filter((turn) => turn.role === 'assistant').map((turn) => turn.content).join('')
  const assistantPoints = Array.from(assistantText)
  const measuredChars = assistantPoints.length
  const summaries = chapterSummariesForPoints(assistantPoints, plan)
  const chapters: LongWriteChapterCheckpoint[] = summaries.map((summary) => {
    const chapter = plan.chapters[summary.index - 1]
    const content = assistantPoints.slice(chapter.startChars, Math.min(measuredChars, chapter.endChars)).join('')
    return {
      id: summary.id,
      index: summary.index,
      targetChars: summary.targetChars,
      measuredChars: summary.measuredChars,
      status: summary.status,
      contentHash: createHash('sha256').update(content, 'utf8').digest('hex'),
      excerpt: excerpt(content, 360)
    }
  })
  const latestAssistant = [...turns].reverse().find((turn) => turn.role === 'assistant')
  const summaryText = summaries.map((summary) => `${summary.id}:${summary.status}:${summary.measuredChars}/${summary.targetChars}:${summary.summary}`).join('\n')
  return {
    schemaVersion: LONGWRITE_PLAN_SCHEMA_VERSION,
    runId,
    planHash: longWritePlanHash(plan),
    measuredChars,
    currentChapter: plan.chapters.find((chapter) => measuredChars < chapter.endChars)?.index ?? plan.chapters.length,
    chapters,
    summaryHash: createHash('sha256').update(summaryText, 'utf8').digest('hex'),
    latestTurnId: latestAssistant?.turnId ?? null,
    latestTurnSeq: latestAssistant?.turnSeq ?? null,
    updatedAt
  }
}
