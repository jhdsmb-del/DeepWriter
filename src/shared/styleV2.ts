// ==================== 高保真笔风模仿（Style V2 Pipeline） ====================

export type CorpusSplit = 'profile' | 'example' | 'holdout'

export interface CorpusChunk {
  id: string
  sourceId: string
  sourceName: string
  workTitle: string
  chapterOrdinal: number
  sectionIndex: number
  /** 原文（surfaceText） */
  text: string
  /** 内容遮蔽视图（专名/数字/题材高频词 → 占位符），用于风格表示 */
  maskedText: string
  charCount: number
  split: CorpusSplit
  sceneType: string
  narrativeFunctions: string[]
  dialogueRatio: number
  sha256: string
}

export interface MetricDistribution {
  p10: number
  p25: number
  p50: number
  p75: number
  p90: number
  mean: number
  std: number
  n: number
}

export interface ProfileQuality {
  effectiveChars: number
  sceneCoverage: Record<string, number>
  crossChapterStability: number
  topicLeakageRisk: number
  confidence: number
  backgroundBaselineId?: string
  distinctiveness?: Record<string, number>
}

export interface StylometryProfile {
  sentenceLen: MetricDistribution
  paraLen: MetricDistribution
  sentenceVar: MetricDistribution
  dialogueRatio: MetricDistribution
  exclamRatio: MetricDistribution
  ellipsisDensity: MetricDistribution
  punctDensity: MetricDistribution
  actionDensity: MetricDistribution
  psychDensity: MetricDistribution
  sensoryDensity: MetricDistribution
  colorDensity: MetricDistribution
  idiomDensity: MetricDistribution
  firstPersonRatio: MetricDistribution
  /** 对白句后接什么（动作/心理/环境/叙述/留白）的比例 */
  dialogueNext: Record<string, number>
  quality?: ProfileQuality
}

export interface ContentSkeleton {
  facts: string[]
  eventOrder: string[]
  pov: string
  emotionalArc: string[]
  paragraphFunctions: string[]
  dialogueIntents: string[]
}

export interface ExemplarPair {
  id: string
  chunkId: string
  skeleton: ContentSkeleton
  sceneType: string
  narrativeFunctions: string[]
  dialogueRatio: number
  representativeness: number
  leakageRisk: number
}

export interface StyleGenTask {
  mode: 'new' | 'rewrite' | 'continue'
  targetChars: number
  sceneType: string
  narrativeFunctions: string[]
  pov: string
  requiredFacts: string[]
  forbiddenFacts: string[]
  emotionalArc: string[]
  outputFormat: 'prose' | 'renpy'
  fidelity: 'light' | 'balanced' | 'high'
  userPrompt: string
}

export interface StyleCandidate {
  id: string
  variant: 'A' | 'B' | 'C'
  text: string
  charCount: number
}

export interface MetricEval {
  metric: string
  z: number
  score: number
}

export interface OverlapFinding {
  length: number
  text: string
  sourceName: string
}

export interface FailedSpan {
  start: number
  end: number
  rule: string
}

export interface CandidateEvaluation {
  candidateId: string
  hardGates: { content: boolean; novelty: boolean; fluency: boolean }
  stylometry: MetricEval[]
  stylometryScore: number
  contentScore: number
  noveltyScore: number
  naturalnessScore: number
  overlaps: OverlapFinding[]
  failedSpans: FailedSpan[]
  finalRank?: number
}

export interface RevisionRequest {
  spanStart: number
  spanEnd: number
  preserveFacts: string[]
  failedRules: string[]
  leftContext: string
  rightContext: string
}

export type StyleJobStage = 'skeleton' | 'retrieving' | 'generating' | 'scoring' | 'revising' | 'done' | 'failed' | 'cancelled'

export interface StyleJobState {
  jobId: string
  profileId: string
  task: StyleGenTask
  stage: StyleJobStage
  skeleton: ContentSkeleton | null
  exemplarIds: string[]
  candidates: StyleCandidate[]
  evaluations: CandidateEvaluation[]
  chosenCandidateId?: string
  usageTokens: { skeleton: number; candidates: number; revise: number; total: number }
  /** run 开始时的不可变快照：运行中修改设置不影响本 job */
  configSnapshot?: {
    model: string
    baseUrl: string
    providerVersion: string
    profileHash: string
    sourceHashes: string[]
    createdAt: number
  }
  error?: string
}

// ==================== 分布计算 ====================

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))
  return sorted[idx]
}

export function computeDistribution(values: number[]): MetricDistribution {
  if (values.length === 0) {
    return { p10: 0, p25: 0, p50: 0, p75: 0, p90: 0, mean: 0, std: 0, n: 0 }
  }
  const sorted = [...values].sort((a, b) => a - b)
  const mean = sorted.reduce((a, b) => a + b, 0) / sorted.length
  const std = sorted.length > 1 ? Math.sqrt(sorted.reduce((a, b) => a + (b - mean) * (b - mean), 0) / (sorted.length - 1)) : 0
  return {
    p10: percentile(sorted, 10),
    p25: percentile(sorted, 25),
    p50: percentile(sorted, 50),
    p75: percentile(sorted, 75),
    p90: percentile(sorted, 90),
    mean: Math.round(mean * 100) / 100,
    std: Math.round(std * 100) / 100,
    n: sorted.length
  }
}

// ==================== 语料切分 / 去重 ====================

export interface RawSection {
  /** 作品/来源名（一个文件 = 一个作品） */
  work?: string
  /** 章节标题（segmentText 提取；整本书一个文件时按章分段） */
  workTitle: string
  chapterOrdinal: number
  text: string
}

const CHAPTER_MARK = /^(第[零一二三四五六七八九十百千0-9]+[章回节卷]|Chapter\s*\d+|序章|尾声|楔子|番外|后记)/

export function segmentText(text: string): RawSection[] {
  const lines = text.split(/\r?\n/)
  const sections: RawSection[] = []
  let current = { workTitle: '未命名', chapterOrdinal: 1, text: '' }
  let order = 0
  for (const raw of lines) {
    const line = raw.trim()
    if (CHAPTER_MARK.test(line) && line.length <= 30) {
      if (current.text.trim().length > 0) sections.push({ ...current })
      order++
      current = { workTitle: line, chapterOrdinal: order, text: '' }
      continue
    }
    current.text += raw + '\n'
  }
  if (current.text.trim().length > 0) sections.push({ ...current })
  return sections
}

export function splitChunksByParagraph(sections: RawSection[], minChars = 400, maxChars = 3000): { work?: string; workTitle: string; chapterOrdinal: number; text: string }[] {
  const out: { work?: string; workTitle: string; chapterOrdinal: number; text: string }[] = []
  for (const sec of sections) {
    const paras = sec.text.split(/\n+/).map((p) => p.trim()).filter((p) => p.length > 0)
    let buf = ''
    let idx = 0
    for (const p of paras) {
      if (buf.length + p.length > maxChars && buf.length >= minChars) {
        out.push({ work: sec.work, workTitle: sec.workTitle, chapterOrdinal: sec.chapterOrdinal + idx / 1000, text: buf })
        idx++
        buf = ''
      }
      buf += p + '\n'
    }
    if (buf.trim().length >= 50) out.push({ work: sec.work, workTitle: sec.workTitle, chapterOrdinal: sec.chapterOrdinal + idx / 1000, text: buf })
  }
  return out
}

export function splitCorpusByChapter(chunks: { work?: string; workTitle?: string; chapterOrdinal: number }[], profileRatio = 0.6, exampleRatio = 0.25): { split: CorpusSplit }[] {
  // group-aware：同一作品内按章节分组（Math.floor 归一同一章节的多个 chunk），
  // 相邻 chunk 不会跨 profile/example/holdout；单文件整本书 → 每章一组，天然产出 example/holdout
  const groupOf = (c: { work?: string; workTitle?: string; chapterOrdinal: number }): string => {
    const w = (c.work ?? '').trim()
    const ch = Math.floor(c.chapterOrdinal)
    if (w.length > 0) return `w:${w}|ch:${ch}`
    const t = (c.workTitle ?? '').trim()
    if (t.length > 0) return `t:${t}|ch:${ch}`
    return `ch:${ch}`
  }
  const groups: string[] = []
  const seen = new Set<string>()
  for (const c of chunks) {
    const g = groupOf(c)
    if (!seen.has(g)) {
      seen.add(g)
      groups.push(g)
    }
  }
  const n = groups.length
  const nProfile = Math.max(1, Math.min(n, Math.floor(n * profileRatio)))
  const nExample = Math.max(0, Math.min(n - nProfile, Math.floor(n * exampleRatio)))
  const assign = new Map<string, CorpusSplit>()
  groups.forEach((g, i) => {
    if (i < nProfile) assign.set(g, 'profile')
    else if (i < nProfile + nExample) assign.set(g, 'example')
    else assign.set(g, 'holdout')
  })
  return chunks.map((c) => ({ split: assign.get(groupOf(c)) ?? 'profile' }))
}

export function dedupeChunks(chunks: { sha256: string; text: string }[]): { sha256: string; text: string }[] {
  const seen = new Set<string>()
  const out: { sha256: string; text: string }[] = []
  for (const c of chunks) {
    if (seen.has(c.sha256)) continue
    seen.add(c.sha256)
    out.push(c)
  }
  return out
}

// ==================== 内容遮蔽（本地近似） ====================

/** 常见中文虚词/高频非人名短语（2 字 n-gram 命中即跳过，防把"的了"级短语当人名） */
const NAME_STOPWORDS = new Set([
  '我们', '你们', '他们', '她们', '它们', '一个', '什么', '自己', '没有', '可以', '这个', '那个', '就是', '知道', '觉得', '时候',
  '这样', '那样', '现在', '已经', '还是', '但是', '如果', '因为', '所以', '而且', '虽然', '然后', '可是', '不过', '于是', '即使',
  '无论', '或者', '不是', '而是', '真的', '非常', '一直', '正在', '开始', '继续', '最后', '终于', '突然', '只是', '好像', '仿佛',
  '似乎', '几乎', '大概', '也许', '可能', '应该', '需要', '能够', '愿意', '希望', '想要', '过去', '未来', '大家', '一切', '所有',
  '每个', '任何', '许多', '有些', '这些', '那些', '这里', '那里', '于是', '之后', '之前', '出来', '起来', '进去', '出来', '过来',
  '下去', '回去', '说话', '回答', '声音', '眼睛', '心里', '脸上', '身上', '手中', '门口', '窗外', '身后', '眼前', '面前', '东西',
  '事情', '问题', '原因', '结果', '感觉', '表情', '神色', '语气', '目光', '呼吸', '脚步', '身影', '名字', '地方', '时候', '分钟',
  '小时', '一天', '一个', '两个人', '两个人', '那晚', '这天', '那天', '此刻', '当时', '忽然', '渐渐', '慢慢', '轻轻', '悄悄'
])

export function collectFrequentNames(chunks: { text: string }[], minCount = 4, maxNames = 60): Set<string> {
  const grams = new Map<string, number>()
  for (const c of chunks) {
    const t = [...c.text].filter((ch) => /[\u4e00-\u9fff]/.test(ch))
    for (const len of [3, 2]) {
      for (let i = 0; i <= t.length - len; i++) {
        const g = t.slice(i, i + len).join('')
        if (len === 2 && NAME_STOPWORDS.has(g)) continue
        const cnt = (grams.get(g) ?? 0) + 1
        grams.set(g, cnt)
      }
    }
  }
  const names = new Set<string>()
  for (const [g, cnt] of [...grams.entries()].sort((a, b) => b[1] - a[1])) {
    if (cnt < minCount) continue
    if (names.size >= maxNames) break
    if ([...names].some((n) => n.includes(g) || g.includes(n))) continue
    names.add(g)
  }
  return names
}

export function maskContent(text: string, names: Set<string>): string {
  let t = text.replace(/\d+(?:[.,]\d+)*/g, '⟨NUM⟩')
  for (const n of names) {
    t = t.split(n).join('⟨NAME⟩')
  }
  return t
}

// ==================== 扩展文体统计（分布版） ====================

const COLOR_WORDS = ['红', '黄', '蓝', '绿', '白', '黑', '粉', '紫', '金', '灰', '青', '橙', '褐', '绯', '碧', '靛', '赭', '玫', '天蓝', '墨绿', '雪白', '漆黑', '湛蓝', '嫣红']
const SENSORY_WORDS = ['声', '音', '风', '雨', '气息', '香', '味', '甜', '苦', '涩', '辣', '烫', '凉', '湿', '润', '粗糙', '光滑', '温热', '冰凉', '鸟鸣', '蝉', '浪', '嗅', '尝', '触', '听']
const PSYCH_WORDS = ['想', '觉得', '感到', '回忆', '思念', '恐惧', '不安', '期待', '犹豫', '心跳', '忐忑', '酸涩', '温暖', '失落', '庆幸', '懊悔', '羡慕', '悸动', '怅然', '释然']
const ACTION_WORDS = ['走', '跑', '握', '抓', '推', '拉', '捡', '坐', '站', '转身', '抬头', '低头', '点头', '摇头', '抬手', '攥', '抱', '靠', '蹲', '迈', '踏', '闪']
const EMO_WORDS = ['啊', '哦', '嗯', '唉', '哼', '呀', '哇', '哈', '诶', '嘶', '吧', '呢', '吗', '嘛', '啦', '哟', '呵', '哎呀', '噗']

function countOf(text: string, words: string[]): number {
  let n = 0
  for (const w of words) {
    let i = 0
    while ((i = text.indexOf(w, i)) !== -1) {
      n++
      i += w.length
    }
  }
  return n
}

export interface TextStyleStats {
  sentLens: number[]
  paraLens: number[]
  sentVars: number[]
  diaRatios: number[]
  exclamRatios: number[]
  ellipsisDens: number[]
  punctDens: number[]
  actionDens: number[]
  psychDens: number[]
  sensoryDens: number[]
  colorDens: number[]
  idiomDens: number[]
  firstPersonRatios: number[]
  dialogueNext: Record<string, number>
}

export function textStats(text: string): TextStyleStats {
  const sents = text.split(/(?<=[。！？!?…；;])\s*/).map((s) => s.trim()).filter((s) => s.length > 0)
  const paras = text.split(/\n+/).map((p) => p.trim()).filter((p) => p.length > 0)
  const cnTotal = [...text].filter((c) => /[\u4e00-\u9fff]/.test(c)).length || 1

  const diaNext: Record<string, number> = { action: 0, psych: 0, sensory: 0, narrative: 0, none: 0 }
  const diaNextCount = { action: 0, psych: 0, sensory: 0, narrative: 0, none: 0 }
  const sentLens: number[] = []
  const paraLens: number[] = []
  const sentVars: number[] = []
  const diaRatios: number[] = []
  const exclamRatios: number[] = []
  const ellipsisDens: number[] = []
  const punctDens: number[] = []
  const actionDens: number[] = []
  const psychDens: number[] = []
  const sensoryDens: number[] = []
  const colorDens: number[] = []
  const idiomDens: number[] = []
  const firstPersonRatios: number[] = []

  const quoteRe = /["“「『]([^"”」』]{1,200})["”」』]/g
  let lastWasDialogue: boolean = false

  for (const p of paras) {
    paraLens.push([...p].length)
    const sentences = p.split(/(?<=[。！？!?…；;])\s*/).filter((s) => s.trim().length > 0)
    if (sentences.length === 0) continue
    let diaChars = 0
    let qm: RegExpExecArray | null
    quoteRe.lastIndex = 0
    while ((qm = quoteRe.exec(p))) diaChars += qm[1].length
    diaRatios.push(diaChars / ([...p].length || 1))
    exclamRatios.push((countOf(p, ['！', '!']) || 0) / (sentences.length || 1))
    ellipsisDens.push(((countOf(p, ['……', '...']) || 0) * 1000) / ([...p].length || 1))
    punctDens.push((countOf(p, ['，', '。', '！', '？', '；', '、', '：']) * 1000) / ([...p].length || 1))
    actionDens.push((countOf(p, ACTION_WORDS) * 1000) / ([...p].length || 1))
    psychDens.push((countOf(p, PSYCH_WORDS) * 1000) / ([...p].length || 1))
    sensoryDens.push((countOf(p, SENSORY_WORDS) * 1000) / ([...p].length || 1))
    colorDens.push((countOf(p, COLOR_WORDS) * 1000) / ([...p].length || 1))
    idiomDens.push(((p.match(/[\u4e00-\u9fff]{4}/g) ?? []).length * 1000) / ([...p].length || 1))
    const fp = countOf(p, ['我', '我们'])
    const tp = countOf(p, ['他', '她', '他们', '她们'])
    firstPersonRatios.push(fp + tp > 0 ? fp / (fp + tp) : 0)
    const lens = sentences.map((s) => [...s].length)
    sentLens.push(...lens)
    if (lens.length >= 2) {
      const m = lens.reduce((a, b) => a + b, 0) / lens.length
      const sd = Math.sqrt(lens.reduce((a, b) => a + (b - m) * (b - m), 0) / lens.length)
      sentVars.push(m > 0 ? sd / m : 0)
    }
    for (const s of sentences) {
      const isDia: boolean = /^[“"「『]/.test(s.trim()) || (lastWasDialogue && /^[”"」』]/.test(s.trim()))
      if (lastWasDialogue && !isDia) {
        const t = s.trim()
        if (countOf(t, ACTION_WORDS) > 0) diaNextCount.action++
        else if (countOf(t, PSYCH_WORDS) > 0) diaNextCount.psych++
        else if (countOf(t, SENSORY_WORDS) > 0) diaNextCount.sensory++
        else if (/[地着的]/.test(t) || t.length > 12) diaNextCount.narrative++
        else diaNextCount.none++
      }
      lastWasDialogue = isDia
    }
  }

  for (const k of Object.keys(diaNextCount) as (keyof typeof diaNextCount)[]) {
    const total = diaNextCount.action + diaNextCount.psych + diaNextCount.sensory + diaNextCount.narrative + diaNextCount.none
    diaNext[k] = total > 0 ? Math.round((diaNextCount[k] / total) * 1000) / 1000 : 0
  }

  return {
    sentLens,
    paraLens,
    sentVars,
    diaRatios,
    exclamRatios,
    ellipsisDens,
    punctDens,
    actionDens,
    psychDens,
    sensoryDens,
    colorDens,
    idiomDens,
    firstPersonRatios,
    dialogueNext: diaNext
  }
}

export function buildStylometryProfile(statsList: TextStyleStats[]): StylometryProfile {
  const join = (k: keyof TextStyleStats): number[] => {
    const arr: number[] = []
    for (const s of statsList) {
      const v = s[k]
      if (Array.isArray(v)) arr.push(...(v as number[]))
    }
    return arr
  }
  const diaNext: Record<string, number> = { action: 0, psych: 0, sensory: 0, narrative: 0, none: 0 }
  let dn = 0
  for (const s of statsList) {
    for (const k of Object.keys(diaNext)) dn += s.dialogueNext[k] ?? 0
  }
  for (const k of Object.keys(diaNext)) {
    let acc = 0
    for (const s of statsList) acc += s.dialogueNext[k] ?? 0
    diaNext[k] = dn > 0 ? acc / statsList.length : 0
  }
  return {
    sentenceLen: computeDistribution(join('sentLens')),
    paraLen: computeDistribution(join('paraLens')),
    sentenceVar: computeDistribution(join('sentVars')),
    dialogueRatio: computeDistribution(join('diaRatios')),
    exclamRatio: computeDistribution(join('exclamRatios')),
    ellipsisDensity: computeDistribution(join('ellipsisDens')),
    punctDensity: computeDistribution(join('punctDens')),
    actionDensity: computeDistribution(join('actionDens')),
    psychDensity: computeDistribution(join('psychDens')),
    sensoryDensity: computeDistribution(join('sensoryDens')),
    colorDensity: computeDistribution(join('colorDens')),
    idiomDensity: computeDistribution(join('idiomDens')),
    firstPersonRatio: computeDistribution(join('firstPersonRatios')),
    dialogueNext: diaNext
  }
}

// ==================== 示例检索（场景评分 + MMR 去冗余） ====================

export function retrieveExemplars(
  exemplars: ExemplarPair[],
  task: Pick<StyleGenTask, 'sceneType' | 'narrativeFunctions' | 'pov'>,
  k = 4
): ExemplarPair[] {
  const scored = exemplars
    .map((e) => {
      const sceneScore = e.sceneType === task.sceneType ? 1 : 0.3
      const fnScore = task.narrativeFunctions.filter((f) => e.narrativeFunctions.includes(f)).length / Math.max(1, task.narrativeFunctions.length)
      const povScore = task.pov === e.skeleton.pov ? 1 : 0.5
      const repr = Math.min(1, e.representativeness)
      const score = 0.3 * sceneScore + 0.2 * fnScore + 0.15 * povScore + 0.1 * Math.min(1, e.dialogueRatio) + 0.1 * repr - 0.15 * e.leakageRisk
      return { e, score }
    })
    .sort((a, b) => b.score - a.score)

  const picked: typeof scored = []
  for (const item of scored) {
    if (picked.length >= k) break
    const redundant = picked.some((p) => p.e.chunkId === item.e.chunkId || Math.abs(p.e.dialogueRatio - item.e.dialogueRatio) < 0.05)
    if (redundant) continue
    picked.push(item)
  }
  return picked.map((p) => p.e)
}

// ==================== 四路评分（本地） ====================

export function metricScore(value: number, dist: MetricDistribution): { z: number; score: number } {
  if (dist.n === 0 || dist.std === 0) return { z: 0, score: 1 }
  const z = (value - dist.mean) / dist.std
  return { z: Math.round(z * 100) / 100, score: Math.exp(-Math.abs(z)) }
}

export function scoreStylometry(text: string, profile: StylometryProfile): { evals: MetricEval[]; score: number } {
  const st = textStats(text)
  const mean = (v: number[]): number => (v.length ? v.reduce((a, b) => a + b, 0) / v.length : 0)
  const pairs: [string, number, MetricDistribution][] = [
    ['sentenceLen', mean(st.sentLens), profile.sentenceLen],
    ['paraLen', mean(st.paraLens), profile.paraLen],
    ['sentenceVar', mean(st.sentVars), profile.sentenceVar],
    ['dialogueRatio', mean(st.diaRatios), profile.dialogueRatio],
    ['exclamRatio', mean(st.exclamRatios), profile.exclamRatio],
    ['ellipsisDensity', mean(st.ellipsisDens), profile.ellipsisDensity],
    ['punctDensity', mean(st.punctDens), profile.punctDensity],
    ['actionDensity', mean(st.actionDens), profile.actionDensity],
    ['psychDensity', mean(st.psychDens), profile.psychDensity],
    ['sensoryDensity', mean(st.sensoryDens), profile.sensoryDensity],
    ['colorDensity', mean(st.colorDens), profile.colorDensity],
    ['idiomDensity', mean(st.idiomDens), profile.idiomDensity],
    ['firstPersonRatio', mean(st.firstPersonRatios), profile.firstPersonRatio]
  ]
  const evals: MetricEval[] = pairs.map(([metric, value, dist]) => {
    const r = metricScore(value, dist)
    return { metric, z: r.z, score: r.score }
  })
  const score = evals.reduce((a, e) => a + e.score, 0) / evals.length
  return { evals, score: Math.round(score * 1000) / 1000 }
}

export function scoreContent(text: string, requiredFacts: string[], forbiddenFacts: string[]): { score: number; missing: string[]; violated: string[] } {
  const missing = requiredFacts.filter((f) => !text.includes(f))
  const violated = forbiddenFacts.filter((f) => text.includes(f))
  const score = requiredFacts.length === 0 ? 1 : (requiredFacts.length - missing.length) / requiredFacts.length
  return { score, missing, violated }
}

export function scoreNovelty(
  text: string,
  sources: { text: string; sourceName: string }[],
  forbiddenPhrases: string[]
): { score: number; overlaps: OverlapFinding[]; leakedPhrases: string[]; hardFail: boolean } {
  const overlaps: OverlapFinding[] = []
  const leaked = forbiddenPhrases.filter((p) => p.length >= 3 && text.includes(p))
  let longest = 0
  for (const s of sources) {
    const clean = text.replace(/\s+/g, '')
    const src = s.text.replace(/\s+/g, '')
    if (clean.length < 12 || src.length < 12) continue
    for (let i = 0; i <= clean.length - 12; i++) {
      const gram = clean.slice(i, i + 12)
      if (src.includes(gram)) {
        let k = 12
        while (i + k < clean.length && src.includes(clean.slice(i, i + k + 1))) k++
        overlaps.push({ length: k, text: clean.slice(i, i + Math.min(k, 40)), sourceName: s.sourceName })
        longest = Math.max(longest, k)
        i += k - 1
      }
    }
  }
  const hardFail = longest >= 24 || leaked.length > 0
  const score = Math.max(0, 1 - longest / 100 - leaked.length * 0.1)
  return { score: Math.round(score * 1000) / 1000, overlaps: overlaps.slice(0, 10), leakedPhrases: leaked, hardFail }
}

export function scoreNaturalness(text: string): { score: number; flu: boolean } {
  const st = textStats(text)
  const lens = st.sentLens
  if (lens.length === 0) return { score: 0, flu: false }
  const mean = lens.reduce((a, b) => a + b, 0) / lens.length
  const sd = Math.sqrt(lens.reduce((a, b) => a + (b - mean) * (b - mean), 0) / lens.length)
  const cv = mean > 0 ? sd / mean : 0
  const starts = st.sentLens.length > 6
  const flu = cv > 0.25 && cv < 1.6
  const score = flu ? 1 - Math.abs(cv - 0.7) / 1.5 : 0.4
  void starts
  return { score: Math.round(Math.max(0, Math.min(1, score)) * 1000) / 1000, flu }
}

function realSpanOf(text: string, stripped: string): { start: number; end: number } {
  let start = -1
  for (let len = Math.min(12, stripped.length); len >= 2; len--) {
    start = text.indexOf(stripped.slice(0, len))
    if (start >= 0) break
  }
  if (start < 0) return { start: 0, end: Math.min(24, [...text].length) }
  let i = start
  let j = 0
  while (i < text.length && j < stripped.length) {
    if (text[i] === stripped[j]) {
      i++
      j++
    } else if (/\s/.test(text[i])) {
      i++
    } else {
      break
    }
  }
  return { start, end: i }
}

export function evaluateCandidate(
  text: string,
  opts: {
    profile: StylometryProfile
    requiredFacts: string[]
    forbiddenFacts: string[]
    sources: { text: string; sourceName: string }[]
    forbiddenPhrases: string[]
  }
): CandidateEvaluation {
  const sty = scoreStylometry(text, opts.profile)
  const content = scoreContent(text, opts.requiredFacts, opts.forbiddenFacts)
  const novelty = scoreNovelty(text, opts.sources, opts.forbiddenPhrases)
  const nat = scoreNaturalness(text)
  const hardGates = {
    content: content.missing.length === 0 && content.violated.length === 0,
    novelty: !novelty.hardFail,
    fluency: nat.flu
  }
  const failedSpans: FailedSpan[] = novelty.overlaps
    .filter((o) => o.length >= 24)
    .map((o) => {
      const p = realSpanOf(text, o.text)
      return { start: p.start, end: p.end, rule: `novelty_overlap_${o.sourceName || 'src'}` }
    })
  return {
    candidateId: '',
    hardGates,
    stylometry: sty.evals,
    stylometryScore: sty.score,
    contentScore: Math.round(content.score * 1000) / 1000,
    noveltyScore: novelty.score,
    naturalnessScore: nat.score,
    overlaps: novelty.overlaps,
    failedSpans
  }
}

export function rankCandidates(evaluations: CandidateEvaluation[]): CandidateEvaluation[] {
  return evaluations
    .map((e) => {
      const passesHard = e.hardGates.content && e.hardGates.novelty && e.hardGates.fluency
      // 修复：stylometry 不再重复计权（原 0.35+0.25 双计同一指标）；权重归一化总和 1.0
      const finalRank = passesHard ? 0.35 * e.stylometryScore + 0.25 * e.contentScore + 0.2 * e.naturalnessScore + 0.2 * e.noveltyScore : -1
      return { ...e, finalRank: Math.round(finalRank * 1000) / 1000 }
    })
    .sort((a, b) => (b.finalRank ?? -1) - (a.finalRank ?? -1))
}
