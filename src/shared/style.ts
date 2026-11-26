// ==================== 风格参照模式（Style Mode） ====================

export interface StyleSourceMeta {
  id: string
  displayName: string
  path: string
  sha256: string
  size: number
  charCount: number
  weight: number
  status: 'indexed' | 'analyzed' | 'failed'
}

export interface StyleStatsRaw {
  sentenceLenMean: number
  sentenceLenMedian: number
  sentenceVar: number
  paraLenMean: number
  dialogueRatio: number
  dialogueLenMean: number
  punctuationDensity: number
  exclamRatio: number
  ellipsisDensity: number
  emoRatio: number
  descColor: number
  descSensory: number
  descPsych: number
  descAction: number
  idiomDensity: number
  firstPersonRatio: number
  paraOpenPatterns: string[]
  topWords: string[]
}

export interface StyleDimension {
  id: string
  label: string
  value: number | string
  unit?: string
  confidence: number
  lockedByUser: boolean
}

export interface StyleProfile {
  id: string
  name: string
  version: number
  sourceHashes: string[]
  dimensions: StyleDimension[]
  positiveRules: string[]
  negativeRules: string[]
  forbiddenPhrases: string[]
  createdAt: number
}

export interface StyleOverlapMatch {
  startIdx: number
  endIdx: number
  length: number
  text: string
}

export interface StyleOverlapReport {
  profileId: string
  sourceName: string
  matches: StyleOverlapMatch[]
  longestMatch: number
  similarity: number
}

// ==================== 词典（零 Token 统计） ====================

const COLOR_WORDS = ['红', '黄', '蓝', '绿', '白', '黑', '粉', '紫', '金', '灰', '青', '橙', '褐', '绯', '碧', '靛', '赭', '玫', '天蓝', '墨绿', '雪白', '漆黑', '湛蓝', '嫣红']
const SENSORY_WORDS = ['声', '音', '风', '雨', '气息', '香', '味', '甜', '苦', '涩', '辣', '烫', '凉', '湿', '润', '粗糙', '光滑', '温热', '冰凉', '鸟鸣', '蝉', '浪', '嗅', '尝', '触', '听']
const PSYCH_WORDS = ['想', '觉得', '感到', '回忆', '思念', '恐惧', '不安', '期待', '犹豫', '心跳', '忐忑', '酸涩', '温暖', '失落', '庆幸', '懊悔', '羡慕', '悸动', '怅然', '释然']
const ACTION_WORDS = ['走', '跑', '握', '抓', '推', '拉', '捡', '坐', '站', '转身', '抬头', '低头', '点头', '摇头', '抬手', '攥', '抱', '靠', '蹲', '迈', '踏', '闪']
const EMO_WORDS = ['啊', '哦', '嗯', '唉', '哼', '呀', '哇', '哈', '诶', '嘶', '吧', '呢', '吗', '嘛', '啦', '哟', '呵', '哎呀', '噗']
const STOP_WORDS = new Set(['的', '了', '是', '在', '我', '你', '他', '她', '它', '们', '这', '那', '也', '都', '就', '又', '还', '而', '与', '和', '或', '及', '但', '却', '把', '被', '让', '给', '对', '从', '到', '向', '往', '于', '之', '其', '个', '一', '不', '没', '有', '着', '过', '地', '得', '说', '道', '会', '能', '要', '想', '很', '更', '最', '太', '真', '像', '如', '仿佛', '好像', '然后', '但是', '因为', '所以', '如果', '虽然', '不过', '于是', '接着', '突然', '终于', '开始', '起来', '出来', '过来', '什么', '怎么', '这样', '那样', '自己', '时候', '现在', '已经', '没有', '这个', '那个', '一下', '一个', '一天', '一年', '一样', '一般', '一声', '一眼', '一回'])

// ==================== 文本统计 ====================

const SENT_SPLIT = /(?<=[。！？!?…；;])\s*(?=[“”"']?\s*[^。！？!?…；;])/g
const CN = /[\u4e00-\u9fff]/
const CN4 = /[\u4e00-\u9fff]{4}/g

function countIn(text: string, words: string[]): number {
  let n = 0
  for (const w of words) n += countOccurrences(text, w)
  return n
}

function countOccurrences(text: string, sub: string): number {
  if (!sub) return 0
  let n = 0
  let i = 0
  while ((i = text.indexOf(sub, i)) !== -1) {
    n++
    i += sub.length
  }
  return n
}

function median(arr: number[]): number {
  if (arr.length === 0) return 0
  const s = [...arr].sort((a, b) => a - b)
  const m = Math.floor(s.length / 2)
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}

function mean(arr: number[]): number {
  if (arr.length === 0) return 0
  return arr.reduce((a, b) => a + b, 0) / arr.length
}

function stdev(arr: number[]): number {
  if (arr.length < 2) return 0
  const m = mean(arr)
  return Math.sqrt(arr.reduce((a, b) => a + (b - m) * (b - m), 0) / (arr.length - 1))
}

export function analyzeText(text: string): StyleStatsRaw {
  const sentences = text.split(SENT_SPLIT).map((s) => s.trim()).filter((s) => s.length > 0)
  const paras = text.split(/\n+/).map((p) => p.trim()).filter((p) => p.length > 0)
  const sentLens = sentences.map((s) => [...s].length)
  const paraLens = paras.map((p) => [...p].length)
  const totalChars = [...text].filter((c) => CN.test(c)).length || 1

  let dialogueChars = 0
  let dialogueSents = 0
  const diaLens: number[] = []
  const quoteRe = /["“「『]([^"”」』]{1,200})["”」』]/g
  let qm: RegExpExecArray | null
  while ((qm = quoteRe.exec(text))) {
    dialogueChars += qm[1].length
    dialogueSents++
    diaLens.push(qm[1].length)
  }
  const dialogueRatio = totalChars > 0 ? dialogueChars / totalChars : 0
  const dialogueLenMean = diaLens.length > 0 ? mean(diaLens) : 0

  const punctCount = countOccurrences(text, '，') + countOccurrences(text, '。') + countOccurrences(text, '！') + countOccurrences(text, '？') + countOccurrences(text, '；') + countOccurrences(text, '、') + countOccurrences(text, '：')
  const punctuationDensity = (punctCount * 1000) / totalChars
  const exclamCount = countOccurrences(text, '！') + countOccurrences(text, '!')
  const exclamRatio = sentences.length > 0 ? exclamCount / sentences.length : 0
  const ellipsisCount = countOccurrences(text, '……') + countOccurrences(text, '...')
  const ellipsisDensity = (ellipsisCount * 1000) / totalChars
  const emoRatio = (countIn(text, EMO_WORDS) * 1000) / totalChars
  const descColor = (countIn(text, COLOR_WORDS) * 1000) / totalChars
  const descSensory = (countIn(text, SENSORY_WORDS) * 1000) / totalChars
  const descPsych = (countIn(text, PSYCH_WORDS) * 1000) / totalChars
  const descAction = (countIn(text, ACTION_WORDS) * 1000) / totalChars
  const cn4Count = (text.match(CN4) ?? []).length
  const idiomDensity = (cn4Count * 1000) / totalChars

  const firstPerson = countOccurrences(text, '我') + countOccurrences(text, '我们')
  const thirdPerson = countOccurrences(text, '他') + countOccurrences(text, '她') + countOccurrences(text, '他们') + countOccurrences(text, '她们')
  const firstPersonRatio = firstPerson + thirdPerson > 0 ? firstPerson / (firstPerson + thirdPerson) : 0

  const paraOpenPatterns: string[] = []
  const openCount = new Map<string, number>()
  for (const p of paras) {
    const first = [...p].slice(0, 2).join('')
    if (!/[\u4e00-\u9fff]/.test(first)) continue
    openCount.set(first, (openCount.get(first) ?? 0) + 1)
  }
  for (const [k, v] of [...openCount.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6)) {
    if (v >= Math.max(2, paras.length * 0.1)) paraOpenPatterns.push(k)
  }

  const bigrams = new Map<string, number>()
  const cnChars = [...text].filter((c) => CN.test(c))
  for (let i = 0; i < cnChars.length - 1; i++) {
    const bg = cnChars[i] + cnChars[i + 1]
    if (STOP_WORDS.has(bg)) continue
    bigrams.set(bg, (bigrams.get(bg) ?? 0) + 1)
  }
  const topWords = [...bigrams.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([k]) => k)

  const sentVar = sentLens.length > 0 && mean(sentLens) > 0 ? stdev(sentLens) / mean(sentLens) : 0

  return {
    sentenceLenMean: mean(sentLens),
    sentenceLenMedian: median(sentLens),
    sentenceVar: Math.round(sentVar * 100) / 100,
    paraLenMean: mean(paraLens),
    dialogueRatio: Math.round(dialogueRatio * 1000) / 1000,
    dialogueLenMean: Math.round(dialogueLenMean * 10) / 10,
    punctuationDensity: Math.round(punctuationDensity * 10) / 10,
    exclamRatio: Math.round(exclamRatio * 1000) / 1000,
    ellipsisDensity: Math.round(ellipsisDensity * 10) / 10,
    emoRatio: Math.round(emoRatio * 10) / 10,
    descColor: Math.round(descColor * 10) / 10,
    descSensory: Math.round(descSensory * 10) / 10,
    descPsych: Math.round(descPsych * 10) / 10,
    descAction: Math.round(descAction * 10) / 10,
    idiomDensity: Math.round(idiomDensity * 10) / 10,
    firstPersonRatio: Math.round(firstPersonRatio * 1000) / 1000,
    paraOpenPatterns,
    topWords
  }
}

// ==================== 防复制词表提取 ====================

export function extractForbiddenPhrases(text: string, minCount = 3, maxPhrases = 40): string[] {
  const cnChars = [...text].filter((c) => CN.test(c))
  const grams = new Map<string, { count: number; len: number }>()
  for (const len of [4, 3, 2]) {
    for (let i = 0; i <= cnChars.length - len; i++) {
      const g = cnChars.slice(i, i + len).join('')
      if (STOP_WORDS.has(g)) continue
      const cur = grams.get(g)
      if (cur) cur.count++
      else grams.set(g, { count: 1, len })
    }
  }
  const candidates = [...grams.entries()]
    .filter(([, v]) => v.count >= minCount)
    .sort((a, b) => b[1].count - a[1].count)
    .slice(0, maxPhrases)
  const result: string[] = []
  for (const [g] of candidates) {
    if (result.some((r) => r.includes(g) || g.includes(r))) continue
    result.push(g)
    if (result.length >= 30) break
  }
  return result
}

// ==================== 画像构建 ====================

export interface ProfileSourceInput {
  name: string
  stats: StyleStatsRaw
  weight: number
}

function ruleFor(label: string, value: number, threshold: number, highText: string, lowText: string): string {
  return value >= threshold ? highText : lowText
}

export function buildProfile(input: { name: string; sources: ProfileSourceInput[]; sourceHashes: string[] }): StyleProfile {
  const { name, sources } = input
  const wsum = sources.reduce((a, s) => a + s.weight, 0) || 1
  const weighted = <T extends keyof StyleStatsRaw>(key: T): number => {
    let v = 0
    for (const s of sources) v += (s.stats[key] as number) * s.weight
    return Math.round((v / wsum) * 100) / 100
  }

  const dims: StyleDimension[] = [
    { id: 'sentence_len', label: '句子长度', value: weighted('sentenceLenMean'), unit: '字/句', confidence: 0.9, lockedByUser: false },
    { id: 'sentence_var', label: '长短句交替', value: weighted('sentenceVar'), confidence: 0.85, lockedByUser: false },
    { id: 'para_len', label: '段落长度', value: weighted('paraLenMean'), unit: '字/段', confidence: 0.9, lockedByUser: false },
    { id: 'dialogue_ratio', label: '对白占比', value: weighted('dialogueRatio'), confidence: 0.85, lockedByUser: false },
    { id: 'dialogue_len', label: '对白长度', value: weighted('dialogueLenMean'), unit: '字/句', confidence: 0.8, lockedByUser: false },
    { id: 'punct', label: '标点密度', value: weighted('punctuationDensity'), unit: '千字', confidence: 0.8, lockedByUser: false },
    { id: 'exclam', label: '感叹强度', value: weighted('exclamRatio'), confidence: 0.85, lockedByUser: false },
    { id: 'ellipsis', label: '省略号密度', value: weighted('ellipsisDensity'), unit: '千字', confidence: 0.8, lockedByUser: false },
    { id: 'emo', label: '语气词', value: weighted('emoRatio'), unit: '千字', confidence: 0.75, lockedByUser: false },
    { id: 'desc_color', label: '色彩描写', value: weighted('descColor'), unit: '千字', confidence: 0.7, lockedByUser: false },
    { id: 'desc_sensory', label: '感官描写', value: weighted('descSensory'), unit: '千字', confidence: 0.7, lockedByUser: false },
    { id: 'desc_psych', label: '心理描写', value: weighted('descPsych'), unit: '千字', confidence: 0.7, lockedByUser: false },
    { id: 'desc_action', label: '动作描写', value: weighted('descAction'), unit: '千字', confidence: 0.7, lockedByUser: false },
    { id: 'first_person', label: '第一人称', value: weighted('firstPersonRatio'), confidence: 0.8, lockedByUser: false }
  ]

  const positiveRules: string[] = []
  const sl = weighted('sentenceLenMean')
  positiveRules.push(sl < 14 ? '句子偏短促，平均约 14 字以内' : sl > 26 ? '句子偏长，平均超过 26 字，善用复合长句' : `句子长度中等，平均约 ${Math.round(sl)} 字`)
  const sv = weighted('sentenceVar')
  positiveRules.push(sv > 0.7 ? '长短句交替明显，节奏起伏大' : '句式节奏平稳')
  const pl = weighted('paraLenMean')
  positiveRules.push(pl < 40 ? '段落短小，推进快' : pl > 90 ? '段落绵长，描写铺陈充分' : `段落中等，约 ${Math.round(pl)} 字`)
  const dr = weighted('dialogueRatio')
  positiveRules.push(dr > 0.4 ? '对白密集，靠对话推动情节' : dr > 0.2 ? '对白与叙述并重' : '以叙述描写为主，对白克制')
  const ex = weighted('exclamRatio')
  positiveRules.push(ex > 0.2 ? '感叹句频繁，情绪外放' : '感叹句克制，情绪内敛')
  const ep = weighted('ellipsisDensity')
  if (ep > 3) positiveRules.push('大量使用省略号，留白与欲言又止')
  const fp = weighted('firstPersonRatio')
  positiveRules.push(fp > 0.7 ? '第一人称视角（我）' : fp < 0.3 ? '第三人称视角（他/她）' : '人称使用混合灵活')
  if (weighted('descPsych') > 4) positiveRules.push('心理描写比重高，注重内心活动')
  if (weighted('descSensory') > 3) positiveRules.push('感官描写细腻（声音/气味/触感）')
  if (weighted('descColor') > 3) positiveRules.push('色彩描写丰富，画面感强')
  if (weighted('emoRatio') > 8) positiveRules.push('语气词丰富，口语化亲切')
  const opens = sources.map((s) => s.stats.paraOpenPatterns[0]).filter(Boolean)
  if (opens.length > 0) positiveRules.push(`段落常以「${[...new Set(opens)].slice(0, 3).join('、')}」等开头`)

  const negativeRules: string[] = []
  if (sl < 14) negativeRules.push('避免动辄 40 字以上的超长句')
  if (pl < 40) negativeRules.push('避免大段连续铺陈的议论性文字')
  if (dr > 0.4) negativeRules.push('避免长时间无对白的纯叙述段落')

  return {
    id: `sp_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
    name,
    version: 1,
    sourceHashes: input.sourceHashes,
    dimensions: dims,
    positiveRules,
    negativeRules,
    forbiddenPhrases: [],
    createdAt: Date.now()
  }
}

// ==================== 画像 → prompt（稳定前缀，命中 KV 缓存） ====================

export function buildStylePrompt(profile: StyleProfile): string {
  const lines: string[] = []
  lines.push('# 风格参照画像（Style Profile）')
  lines.push(`来源：${profile.name}（版本 ${profile.version}）`)
  lines.push('写作要求（尽量贴近，但不得复制原文）：')
  for (const r of profile.positiveRules) lines.push(`- ${r}`)
  if (profile.negativeRules.length > 0) {
    lines.push('禁止：')
    for (const r of profile.negativeRules) lines.push(`- ${r}`)
  }
  lines.push('防抄袭纪律：不得使用来源中的专名、独特短语、情节与连续表达；以下短语禁止出现：')
  lines.push(profile.forbiddenPhrases.length > 0 ? profile.forbiddenPhrases.slice(0, 20).join('、') : '（由来源文本自动提取，若生成文本与来源高度重叠将被检测标记）')
  return lines.join('\n')
}

// ==================== 防复制检测 ====================

const OVERLAP_MIN = 12
const GRAM = 6

/**
 * 防复制检测（n-gram 哈希匹配 + 双向扩展，线性复杂度）：
 * 对 source 建立 6-gram → 位置索引，在 text 中滑动查找命中后向两侧扩展成连续匹配段。
 */
export function checkOverlap(text: string, sourceText: string): StyleOverlapReport {
  const t = [...text]
  const s = [...sourceText]
  if (t.length < GRAM || s.length < GRAM) {
    return { profileId: '', sourceName: '', matches: [], longestMatch: 0, similarity: 0 }
  }
  const gramSet = new Map<string, number[]>()
  for (let j = 0; j <= s.length - GRAM; j++) {
    const g = s.slice(j, j + GRAM).join('')
    const arr = gramSet.get(g)
    if (arr) {
      if (arr.length < 80) arr.push(j)
    } else {
      gramSet.set(g, [j])
    }
  }

  const raw: StyleOverlapMatch[] = []
  let longest = 0
  let common = 0
  let skipTo = -1
  for (let i = 0; i <= t.length - GRAM; i++) {
    if (skipTo > 0 && i < skipTo - GRAM + 1) continue
    const g = t.slice(i, i + GRAM).join('')
    const poss = gramSet.get(g)
    if (!poss) continue
    const maxCheck = Math.min(poss.length, 40)
    for (let pi = 0; pi < maxCheck; pi++) {
      const j0 = poss[pi]
      let k = GRAM
      let li = i - 1
      let lj = j0 - 1
      while (li >= 0 && lj >= 0 && t[li] === s[lj]) {
        k++
        li--
        lj--
      }
      let ri = i + GRAM
      let rj = j0 + GRAM
      while (ri < t.length && rj < s.length && t[ri] === s[rj]) {
        k++
        ri++
        rj++
      }
      const start = li + 1
      if (k >= OVERLAP_MIN) {
        raw.push({ startIdx: start, endIdx: start + k, length: k, text: t.slice(start, start + k).join('') })
        longest = Math.max(longest, k)
        if (ri - GRAM > skipTo) skipTo = ri - GRAM
      }
      if (k > 1) common += k
    }
  }

  raw.sort((a, b) => a.startIdx - b.startIdx)
  const merged: StyleOverlapMatch[] = []
  for (const m of raw) {
    const last = merged[merged.length - 1]
    if (last && m.startIdx <= last.endIdx) {
      if (m.endIdx > last.endIdx) {
        last.endIdx = m.endIdx
        last.length = last.endIdx - last.startIdx
        last.text = t.slice(last.startIdx, last.endIdx).join('')
      }
    } else {
      merged.push({ ...m })
    }
  }

  const similarity = t.length > 0 ? Math.min(1, common / t.length) : 0
  return {
    profileId: '',
    sourceName: '',
    matches: merged.slice(0, 20),
    longestMatch: longest,
    similarity: Math.round(similarity * 1000) / 1000
  }
}
