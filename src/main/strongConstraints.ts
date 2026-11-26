import { createHash } from 'node:crypto'
import type {
  StoryConfig,
  StrongConstraintInput,
  StrongConstraintSnapshot,
  StrongConstraintViolation,
  ThemeLockMode,
  ExpressionFreedom
} from '../shared/types'
import { codePointLength, takeCodePoints } from '../shared/textMetrics'

export const SERMON_PATTERNS: ReadonlyArray<{ label: string; re: RegExp }> = [
  { label: '人生的意义', re: /人生的意义(?:在于|就是|是)/u },
  { label: '这告诉我们', re: /这(?:个故事|件事)?告诉我们/u },
  { label: '这让我们明白', re: /这让我们明白/u },
  { label: '我们应该', re: /我们(?:每个人)?应该/u },
  { label: '唯有…才能', re: /唯有.{0,24}才能/u },
  { label: '归根结底', re: /归根结底/u },
  { label: '更大的价值', re: /(?:社会|时代|人类).{0,18}(?:价值|意义|责任)/u }
]

const META_OPENING_RE = /^(?:当然[，。,:：]?|好的[，。,:：]?|以下是|下面(?:是|我将)|作为(?:一个|一名)|#+\s|\*\*)/u
const QUOTED_RE = /[《“"「『]([^》”"」』]{2,24})[》”"」』]/gu
const TOPIC_PATTERNS = [/(?:围绕|关于)([^，。；;！？!?]{2,30})/u, /以([^，。；;！？!?]{2,30}?)(?:为(?:主题|背景|主线)|展开|写)/u]
const NATURAL_TASK_PATTERNS = [
  /(?:^|[。！？；;\n])(?:请)?(?:写|创作)(?:一个|一篇|一部|一段|出)?([^，,。！？；;\n]{2,60})/u,
  /(?:^|[。！？；;\n])(?:请)?讲述([^，,。！？；;\n]{2,60})/u,
  /(?:^|[。！？；;\n])(?:请)?续写[：:]?([^，,。！？；;\n]{2,60})/u
]
const GENRE_SUFFIX_RE = /(?:的)?(?:(?:悬疑|科幻|奇幻|爱情|历史|校园|都市|恐怖|冒险|现实主义|推理)?(?:故事|小说|文章|散文|正文|续文))$/u
const INSTRUCTION_NOISE_RE = /(?:\d[\d,.]*|[一二三四五六七八九十百千万两〇零]+)\s*(?:字|字符)|写(?:一个|一篇|一部|一段)|(?:不要|不得|禁止|避免|保持)(?:说教|升华|主题|人称|视角)?/u
const GENERIC_ANCHORS = new Set(['故事', '小说', '文章', '正文', '续写', '创作', '悬疑', '科幻', '奇幻', '第一人称', '第三人称'])

function unique(items: string[], max = 24): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const raw of items) {
    const item = raw.trim().replace(/^[：:、，,；;\-\s]+|[：:、，,；;。\s]+$/gu, '')
    if (codePointLength(item) < 2 || codePointLength(item) > 80 || seen.has(item)) continue
    seen.add(item)
    out.push(item)
    if (out.length >= max) break
  }
  return out
}

export function splitConstraintItems(text: string | null | undefined): string[] {
  return unique(String(text ?? '').split(/[\n，,；;]+/u))
}

function positiveTaskClauses(task: string): string[] {
  // Quoted source text is context, not a requirement to repeat it. This is a
  // bounded lexical distinction, not an attempt to infer arbitrary negation.
  const instructions = task.replace(/【(?:前文|上文|旧文|已有正文|示例|反例|错误示例|禁止示例)】[\s\S]*?(?=【[^】\n]+】|$)/gu, '')
  const clauses: string[] = []
  let clause = ''
  let closeQuote = ''
  const quotePairs: Record<string, string> = { '《': '》', '“': '”', '"': '"', '「': '」', '『': '』' }
  for (const char of instructions) {
    if (closeQuote) {
      clause += char
      if (char === closeQuote) closeQuote = ''
    } else if (quotePairs[char]) {
      closeQuote = quotePairs[char] ?? ''
      clause += char
    } else if (/[，,。！？!?；;\n]/u.test(char)) {
      clauses.push(clause)
      clause = ''
    } else clause += char
  }
  clauses.push(clause)
  return clauses.map((part) => {
    // Only instruction verbs outside quotes define a negative clause scope.
    const unquoted = part.replace(QUOTED_RE, (quoted) => ' '.repeat(quoted.length))
    const negative = unquoted.search(/不要|不得|禁止|避免|别(?:再)?(?:重复|重述|复制|引用|使用|包含|写|提及|围绕|加入)|不(?:重复|重述|复制|引用|使用|包含|写|提及)|无须|不必|无需/u)
    return (negative < 0 ? part : part.slice(0, negative)).trim()
  }).filter(Boolean)
}

function extractThemeAnchors(task: string): string[] {
  const clauses = positiveTaskClauses(task)
  const positiveTask = clauses.join('；')
  const anchors: string[] = []
  for (const clause of clauses) {
    for (const match of clause.matchAll(QUOTED_RE)) {
      const before = clause.slice(0, match.index)
      if (/(?:围绕|关于|主题|标题|题目|(?:^|以|请)(?:写|创作|讲述))/u.test(before) && !/(?:前文|上文|旧文|示例|例句|原句|引用|断裂处|结尾|片段)/u.test(before)) anchors.push(match[1] ?? '')
    }
  }
  for (const re of TOPIC_PATTERNS) {
    const match = positiveTask.match(re)
    if (!match?.[1]) continue
    const phrase = match[1]
    anchors.push(phrase)
    for (const raw of phrase.split(/(?:的|与|和|及|、)/u)) {
      // “围绕海边灯塔的守夜人写四千字……”应冻结可在正文直接核验的
      // “灯塔 / 守夜人”，而不是把“写四千字”误当主题的一部分。
      const cleaned = raw.replace(/写(?:一篇|一部|成|出)?[\s\S]*$/u, '').trim()
      if (cleaned) {
        anchors.push(cleaned)
        if (codePointLength(cleaned) >= 4) anchors.push(Array.from(cleaned).slice(-2).join(''))
      }
    }
  }
  for (const re of NATURAL_TASK_PATTERNS) {
    const match = positiveTask.match(re)
    if (!match?.[1]) continue
    let phrase = match[1]
      .replace(/(?:约|大约|至少|不超过)?\s*(?:\d[\d,.]*|[一二三四五六七八九十百千万两〇零]+)\s*(?:字|字符)[\s\S]*$/u, '')
      .replace(GENRE_SUFFIX_RE, '')
      .replace(/^(?:一个|一篇|一部|一段|发生在|位于)/u, '')
      .trim()
    if (!phrase) continue
    anchors.push(phrase)
    const pieces = phrase
      .split(/(?:中的|里的|的|中|里|与|和|及|、|寻找|发现|守护|调查|等待|回到|逃离|遇见|追查)/u)
      .map((part) => part.replace(GENRE_SUFFIX_RE, '').trim())
      .filter(Boolean)
    for (const piece of pieces) {
      anchors.push(piece)
      if (codePointLength(piece) >= 4) anchors.push(Array.from(piece).slice(-2).join(''))
    }
  }
  return unique(anchors, 18).filter((anchor) => !GENERIC_ANCHORS.has(anchor) && !INSTRUCTION_NOISE_RE.test(anchor))
}

function extractWorldAnchors(worldSetting: string): string[] {
  if (!worldSetting.trim()) return []
  const quoted = [...worldSetting.matchAll(QUOTED_RE)].map((m) => m[1] ?? '')
  const lead = worldSetting.split(/[，。；;\n]/u).slice(0, 3)
  return unique([...quoted, ...lead], 8)
}

function stableHash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

export function resolveWritingAxes(input: {
  enabled?: boolean
  level?: 'balanced' | 'strict'
  themeLockMode?: ThemeLockMode
  expressionFreedom?: ExpressionFreedom
  antiMoralizingEnabled?: boolean
}): { themeLockMode: ThemeLockMode; expressionFreedom: ExpressionFreedom; antiMoralizingEnabled: boolean } {
  return {
    themeLockMode: input.themeLockMode ?? (input.enabled === false ? 'off' : 'strong'),
    expressionFreedom: input.expressionFreedom ?? (input.level === 'strict' ? 'controlled' : 'high'),
    antiMoralizingEnabled: input.antiMoralizingEnabled ?? true
  }
}

export function buildStrongConstraintSnapshot(input: {
  runMode: string
  phase?: 'plan' | 'execute'
  task: string
  story: StoryConfig | null
  settings: {
    strongConstraintEnabled?: boolean
    strongConstraintLevel?: 'balanced' | 'strict'
    themeLockMode?: ThemeLockMode
    expressionFreedom?: ExpressionFreedom
    antiMoralizingEnabled?: boolean
    strongConstraintPerspective?: 'auto' | 'first' | 'third'
    strongConstraintGenre?: string
    strongConstraintMustKeep?: string
    strongConstraintAvoid?: string
  }
  visible?: StrongConstraintInput
}): StrongConstraintSnapshot {
  // plan 产物是执行计划而不是正文，正文漂移门禁只在 execute 冻结。
  const active = input.runMode === 'longwrite' && input.phase !== 'plan'
  const visible = input.visible
  const legacyEnabled = visible?.enabled ?? input.settings.strongConstraintEnabled ?? true
  // An explicit off choice is authoritative.  The newer axis defaults (for
  // example anti-moralizing=true) must not silently turn a user-disabled run
  // back on merely because themeLockMode was also serialized as `off`.
  const explicitlyDisabled = visible?.enabled === false || input.settings.strongConstraintEnabled === false
  const level = visible?.level ?? input.settings.strongConstraintLevel ?? 'balanced'
  const axes = resolveWritingAxes({
    enabled: legacyEnabled,
    level,
    themeLockMode: visible?.themeLockMode ?? input.settings.themeLockMode,
    expressionFreedom: visible?.expressionFreedom ?? input.settings.expressionFreedom,
    antiMoralizingEnabled: visible?.antiMoralizingEnabled ?? input.settings.antiMoralizingEnabled
  })
  const perspective = visible?.perspective ?? input.settings.strongConstraintPerspective ?? 'auto'
  const genre = (visible?.genre || input.settings.strongConstraintGenre || (input.story?.enabled ? input.story.genre : '')).trim()
  const mustKeep = splitConstraintItems(visible?.mustKeep ?? input.settings.strongConstraintMustKeep)
  const forbiddenTerms = splitConstraintItems(visible?.avoid ?? input.settings.strongConstraintAvoid)
  const hasNewAxes = visible?.themeLockMode !== undefined || input.settings.themeLockMode !== undefined
  const enabled = active && !explicitlyDisabled && (hasNewAxes
    ? axes.themeLockMode !== 'off' || axes.antiMoralizingEnabled || mustKeep.length > 0 || forbiddenTerms.length > 0
    : legacyEnabled)
  // 用户逐项 mustKeep 与自动词法主题是两套证据；不得用任意一个主题词
  // 命中来替代另一个明确保留项。
  const sourceTask = (visible?.task || input.task).trim()
  const themeAnchors = unique(extractThemeAnchors(sourceTask), 24)
  const characterAnchors = input.story?.enabled ? unique(input.story.characters.map((c) => c.name), 12) : []
  const worldAnchors = input.story?.enabled ? extractWorldAnchors(input.story.worldSetting) : []
  const base = {
    schemaVersion: 1 as const,
    enabled,
    level,
    ...axes,
    sourceTask,
    themeAnchors,
    genre,
    perspective,
    tone: input.story?.enabled ? input.story.tone.trim() : '',
    forbiddenTerms,
    mustKeep,
    characterAnchors,
    worldAnchors,
    // legacy R39 snapshot 仍按旧预算恢复；R42 writingPipeline 自身固定只允许一次定点修订。
    maxRepairAttempts: level === 'strict' ? 3 : 2
  }
  return { ...base, hash: stableHash(base) }
}

export function buildStrongConstraintSystemPrompt(snapshot: StrongConstraintSnapshot, writingForm?: 'narrative' | 'expository' | 'open'): string {
  if (!snapshot.enabled) return ''
  const axes = resolveWritingAxes(snapshot)
  const editorial = writingForm === 'expository' || writingForm === 'open'
  const lines = [
    '## 本次创作坐标（运行期间固定）',
    writingForm ? '' : `用户任务：${snapshot.sourceTask || '按当前用户消息写作'}`,
    `主题锁定：${axes.themeLockMode === 'strong' ? '锁定核心命题' : axes.themeLockMode === 'guided' ? '允许自然延展' : '不自动锁定'}`,
    `表达自由：${axes.expressionFreedom === 'high' ? editorial ? '高（保留作者声音、措辞和组织方式）' : '高（保留人物声音、节奏、意象与留白）' : axes.expressionFreedom === 'balanced' ? '平衡' : '受控'}`,
    snapshot.genre ? `体裁：${snapshot.genre}` : '',
    snapshot.perspective !== 'auto' ? `叙事视角：${snapshot.perspective === 'first' ? '第一人称' : '第三人称'}` : '',
    snapshot.tone ? `语气：${snapshot.tone}` : '',
    axes.themeLockMode !== 'off' && snapshot.themeAnchors.length ? `主题参考：${snapshot.themeAnchors.join('；')}` : '',
    snapshot.mustKeep.length ? `用户明确要求保持（硬边界）：${snapshot.mustKeep.join('；')}` : '',
    snapshot.forbiddenTerms.length ? `用户明确排除（硬边界）：${snapshot.forbiddenTerms.join('；')}` : '',
    snapshot.characterAnchors.length ? `角色锚点：${snapshot.characterAnchors.join('；')}` : '',
    snapshot.worldAnchors.length ? `世界观锚点：${snapshot.worldAnchors.join('；')}` : '',
    editorial ? '按作者确认的体裁、读者、材料和声音展开；解释、论证、记录或叙事服从具体任务，不套用统一写法。' : '把注意力放在具体场景、人物动作、独特声音和有呼吸的节奏上；允许含蓄、反讽、安静段落与自由间接引语。',
    '用户明确给出的可逐项核对文本、禁项、格式和视角不可改动；自动主题词和风格提示只用于审校，不要求逐段复读。',
    editorial ? '保留材料中的数字、专名、限定条件和出处；样段用于作者约定的写法参考，不冒充事实来源。' : '角色与世界观设定用于上下文连贯性参考；未能由本地规则可靠核验的隐含事实不会伪装成硬校验通过。',
    axes.antiMoralizingEnabled ? editorial ? '结尾服从本节目的；可以给出材料支持的结论、限定或下一步，不强塞升华，也不强迫用人物动作收尾。' : '结尾优先用场景、动作或声音自然收住；说教模板只作为可局部修订的审校信号，不否定整段正文。' : '',
    '直接交付正文；不要解释约束，也不要用元话语声明自己遵守了约束。'
  ]
  return lines.filter(Boolean).join('\n')
}

function includesTerm(text: string, term: string): boolean {
  return /[A-Za-z]/u.test(term) ? text.toLocaleLowerCase().includes(term.toLocaleLowerCase()) : text.includes(term)
}

function evidenceAround(text: string, needle: string): string {
  const at = text.indexOf(needle)
  if (at < 0) return needle
  return text.slice(Math.max(0, at - 24), Math.min(text.length, at + needle.length + 48)).replace(/\s+/gu, ' ')
}

function narrationOnly(text: string): string {
  return text.replace(/“[^”]*”|「[^」]*」|『[^』]*』|"[^"]*"/gu, '')
}

function utf16IndexToCp(text: string, index: number): number {
  return codePointLength(text.slice(0, Math.max(0, index)))
}

function paragraphSpanAt(text: string, utf16Index: number, utf16Length: number): { startCp: number; endCp: number } {
  const start = Math.max(0, text.lastIndexOf('\n', Math.max(0, utf16Index - 1)) + 1)
  const nextBreak = text.indexOf('\n', utf16Index + utf16Length)
  const end = nextBreak < 0 ? text.length : nextBreak
  return { startCp: utf16IndexToCp(text, start), endCp: utf16IndexToCp(text, end) }
}

export function evaluateStrongConstraints(
  snapshot: StrongConstraintSnapshot | null | undefined,
  draft: string,
  latestSegment: string,
  opts: { atTarget: boolean; requireThemeInSegment?: boolean; checkSegmentPerspective?: boolean; qualityReview?: boolean; writingForm?: 'narrative' | 'expository' | 'open' }
): { ok: boolean; violations: StrongConstraintViolation[] } {
  if (!snapshot?.enabled) return { ok: true, violations: [] }
  const violations: StrongConstraintViolation[] = []
  const forbiddenHits = snapshot.forbiddenTerms.filter((term) => includesTerm(draft, term))
  if (forbiddenHits.length > 0) {
    const first = forbiddenHits[0] ?? ''
    const localAt = latestSegment.indexOf(first)
    const localStartCp = localAt >= 0 ? utf16IndexToCp(latestSegment, localAt) : undefined
    violations.push({
      code: 'forbidden_expression', category: '禁止项', message: `命中用户明确排除的内容：${forbiddenHits.join('、')}`,
      evidence: forbiddenHits.slice(0, 3).map((term) => evidenceAround(draft, term)), severity: 'hard', source: 'explicit',
      ...(localStartCp !== undefined ? { startCp: localStartCp, endCp: localStartCp + codePointLength(first) } : {})
    })
  }

  if (opts.atTarget) {
    for (const required of snapshot.mustKeep) {
      if (includesTerm(draft, required)) continue
      violations.push({
        code: 'must_keep_missing', category: '必须保持', message: `缺少用户明确要求逐项保留的内容：${required}`,
        evidence: [required], severity: 'hard', source: 'explicit', startCp: 0,
        endCp: Math.max(1, codePointLength(latestSegment)), repairIntent: '这是全文级明确要求，不自动重写；等待用户确认'
      })
    }
  }

  const tailSource = latestSegment || draft
  const tail = Array.from(tailSource).slice(-Math.min(1000, codePointLength(tailSource))).join('')
  const axes = resolveWritingAxes(snapshot)
  const sermonMatches = axes.antiMoralizingEnabled && opts.writingForm !== 'expository' && opts.writingForm !== 'open'
    ? SERMON_PATTERNS.flatMap((p) => { const m = tail.match(p.re); return m?.index === undefined ? [] : [{ label: p.label, index: m.index, text: m[0] }] })
    : []
  const sermonThreshold = axes.expressionFreedom === 'controlled' ? 1 : axes.expressionFreedom === 'balanced' ? 2 : 2
  if (sermonMatches.some((m) => m.label === '人生的意义') || sermonMatches.length >= sermonThreshold) {
    const first = sermonMatches[0]
    const tailOffsetUtf16 = tailSource.length - tail.length
    const span = first ? paragraphSpanAt(tailSource, tailOffsetUtf16 + first.index, first.text.length) : { startCp: Math.max(0, codePointLength(tailSource) - 300), endCp: codePointLength(tailSource) }
    violations.push({ code: 'preachy_ending', category: '说教式收尾', message: `末段出现${sermonMatches.map((m) => m.label).join('、')}式议论`, evidence: sermonMatches.slice(0, 3).map((m) => m.label), severity: 'soft', source: 'deterministic', ...span, repairIntent: '保留事件事实和人物声音，只把命中的说教式收束改为场景化收尾' })
  }

  const checkableAnchors = snapshot.themeAnchors.filter((anchor) => !GENERIC_ANCHORS.has(anchor) && !INSTRUCTION_NOISE_RE.test(anchor) && !/(?:人称|视角|语气|风格|体裁)$/u.test(anchor))
  if (opts.requireThemeInSegment && checkableAnchors.length > 0) {
    const matched = checkableAnchors.filter((anchor) => includesTerm(latestSegment, anchor))
    if (matched.length === 0) {
      violations.push({ code: 'topic_anchor_missing', category: '主题', message: '首个正文候选没有落到用户任务的可靠主题锚点', evidence: checkableAnchors.slice(0, 4), severity: 'soft', source: 'deterministic', startCp: 0, endCp: codePointLength(latestSegment), repairIntent: '让场景自然落到用户主题，不机械复读关键词' })
    }
  } else if (opts.atTarget && checkableAnchors.length > 0) {
    const matched = checkableAnchors.filter((anchor) => includesTerm(draft, anchor))
    const required = snapshot.level === 'strict' && checkableAnchors.length >= 3 ? 2 : 1
    if (matched.length < required) {
      violations.push({ code: 'topic_anchor_missing', category: '主题', message: `正文未保留足够的用户主题锚点（${matched.length}/${required}）`, evidence: checkableAnchors.slice(0, 4), severity: opts.qualityReview ? 'soft' : axes.themeLockMode === 'strong' ? 'hard' : 'soft', source: 'deterministic', startCp: 0, endCp: codePointLength(latestSegment), repairIntent: '只修当前偏离片段，使其重新承接核心命题' })
    }
  }

  if (snapshot.perspective !== 'auto' && (opts.checkSegmentPerspective || opts.atTarget)) {
    const perspectiveSource = opts.checkSegmentPerspective ? latestSegment : draft
    const narration = narrationOnly(perspectiveSource)
    const first = (narration.match(/(?:^|[^A-Za-z\u4e00-\u9fff])(?:我|我们)(?=$|[^A-Za-z\u4e00-\u9fff])/gu) ?? []).length + (narration.match(/我(?:看见|听见|想到|走|说|觉得|知道|记得)/gu) ?? []).length
    const third = (narration.match(/(?:他|她|他们|她们)(?:看见|听见|想到|走|说|觉得|知道|记得|来到|转身)/gu) ?? []).length
    const mismatch = snapshot.perspective === 'first' ? first === 0 && third >= 3 : first >= 4 && third === 0
    if (mismatch) violations.push({ code: 'perspective_mismatch', category: '叙事视角', message: `${opts.checkSegmentPerspective ? '当前候选段' : '正文'}与${snapshot.perspective === 'first' ? '第一' : '第三'}人称约束明显不一致`, evidence: [`第一人称叙述信号 ${first}`, `第三人称叙述信号 ${third}`], severity: 'hard', source: 'explicit', startCp: 0, endCp: codePointLength(latestSegment), repairIntent: `保持事件不变，改为${snapshot.perspective === 'first' ? '第一' : '第三'}人称叙述` })
  }

  const proseGenre = /小说|故事|叙事|悬疑|科幻|奇幻|历史|校园|都市|恐怖|冒险/u.test(snapshot.genre)
  if (proseGenre && META_OPENING_RE.test(draft.trimStart())) {
    violations.push({ code: 'genre_mismatch', category: '体裁', message: '正文以回答说明或 Markdown 标题开场，不符合叙事正文体裁', evidence: [takeCodePoints(draft.trimStart(), 80)], severity: 'hard', source: 'explicit', startCp: 0, endCp: Math.min(codePointLength(latestSegment), 120), repairIntent: '移除回答式开场，直接进入叙事场景' })
  }
  return { ok: violations.length === 0, violations }
}

export function buildStrongConstraintRepairInstruction(input: {
  snapshot: StrongConstraintSnapshot
  violations: StrongConstraintViolation[]
  remainingChars: number
  repairAttempt: number
  writingForm?: 'narrative' | 'expository' | 'open'
}): string {
  const categories = unique(input.violations.map((v) => v.category)).join('、')
  const facts = input.violations.map((v) => `- ${v.category}：${v.message}`).join('\n')
  return [
    '[强约束修复请求]',
    `约束版本：${input.snapshot.schemaVersion}；约束指纹：${input.snapshot.hash}`,
    `刚才的候选段未通过可审计检查（第 ${input.repairAttempt} 次）：${categories}。该候选段已撤回，不属于正文。`,
    facts,
    `请紧接仍然有效的正文重新写这一段，最多输出 ${Math.max(0, input.remainingChars)} 个 Unicode code point。`,
    input.writingForm === 'expository' || input.writingForm === 'open' ? '只输出修正后的正文；保持作者约定的体裁、声音、事实和材料边界，不把文章改成小说。' : '只输出修正后的正文；回到用户原始主题与当前场景，保持既定体裁、视角、角色和世界观。',
    input.writingForm === 'expository' || input.writingForm === 'open' ? '不要复述检查结果或解释修改过程；保留作者需要的解释与结论，不补造材料或出处。' : '不要复述检查结果，不要解释修改过程，不要总结人生意义，不要说教或扩大价值判断。'
  ].join('\n')
}
