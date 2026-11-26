import { app, dialog } from 'electron'
import { promises as fs } from 'fs'
import * as path from 'path'
import { longGenerate } from './deepseek'
import { codePointLength } from '../shared/textMetrics'
import type { ActivityEventType, ActivityPayload, RunPhase } from '../shared/activity'
import type { DsMessage, NovelExportEvent, NovelExportFormat, Usage } from '../shared/types'

// Compatibility-only material/export helpers retained for the historical R19–R21
// partial-artifact evidence and its regression scripts.  The production long-form
// UI no longer exposes a direct novel IPC entry: confirmed Grill Me runs enter
// chat:start → AgentRunEngine → CompletionController → R42 writing pipeline.
// Do not wire these helpers back into renderer actions or add a novel:direct IPC.
import { buildDefaultDocumentPath } from './novelSession'

export interface NovelActivitySink {
  setPhase(phase: RunPhase, title?: string, detail?: string): Promise<void>
  emitActivity(type: ActivityEventType, phase: RunPhase, title?: string, detail?: string, payload?: ActivityPayload): Promise<void>
}

const NOVEL_SYSTEM = `你是一名小说整理专家。下面是用户与 AI 通过多轮对话积累的创作素材（含人设、设定讨论、片段草稿、非线性情节），内容可能跳跃、重复、含有对话讨论痕迹。
任务：将其整理成一部结构完整、排版精良的小说：
1. 通读全部素材，提取人物、关系、情节线、伏笔与结局
2. 重新组织叙事顺序，对跳跃处补齐过渡与衔接润色（不得机械拼接）
3. 统一叙述视角与人称，删除"这样写行吗"等元讨论痕迹
4. 自动分章（每章约 2000-4000 字），章节标题切题且不剧透关键反转
5. 排版规范：Markdown；一级标题为书名；二级标题为章节；正文段落间空行；人物首次出场用全名并带一句外貌/气质描写；对话用中文引号；心理活动单独成段
6. 保留素材中的伏笔与呼应收束；若素材不足以成书，开头输出「素材评估」小节说明缺失内容
直接输出小说正文，不要解释过程。`

export interface NovelMaterialKeptInterval {
  /** 原文 code-point offset（含） */
  from: number
  /** 原文 code-point offset（不含） */
  to: number
  reason: string
}

export interface NovelMaterialInsertedSegment {
  /** 插入到最终 material 的 code-point 位置（相对拼接后的 kept 原文文本） */
  at: number
  /** 插入的标签/分隔符文本（"【开局锚点】"/"【人物锚点】"/"\n" 等，不计入原文保留量） */
  text: string
}

export interface NovelMaterialEvidence {
  originalChars: number
  maxChars: number
  /** R21：真实原文 code-point 区间（互不重叠、升序、不含插入标签长度） */
  keptIntervals: NovelMaterialKeptInterval[]
  /** R21：插入的标签/分隔符作为 transform metadata 单独记录 */
  insertedSegments: NovelMaterialInsertedSegment[]
  /** 原文未保留 code points 数 = totalCp - Σ(keptIntervals 长度)；不含 insertedSegments */
  droppedChars: number
  // ---- 向后兼容字段（R20 writing-core C5/C6 依赖）----
  anchorsKept: boolean
  wellFormed: boolean
  /** 保留的最近内容字数（尾部回填部分，code points） */
  keptTailChars: number
}

/** 判定孤立代理项：UTF-16 字符串里，高代理项之后必须是低代理项 */
function hasLoneSurrogate(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)
    if (c >= 0xd800 && c <= 0xdbff) {
      const next = s.charCodeAt(i + 1)
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true
      i++
    } else if (c >= 0xdc00 && c <= 0xdfff) {
      return true
    }
  }
  return false
}

/**
 * R21-R07：由原文 + evidence 严格重建最终 material。
 * keptIntervals 是原文 code-point 区间（升序、互不重叠），先按区间拼接保留的原文文本，
 * 再按 insertedSegments.at（相对拼接后文本的 code-point 位置，升序）依次插入标签文本。
 * 返回与 buildNovelMaterial 的 material 逐 code point 相等。
 */
export function reconstructMaterial(
  original: string,
  keptIntervals: NovelMaterialKeptInterval[],
  insertedSegments: NovelMaterialInsertedSegment[]
): string {
  const src = Array.from(original)
  // 1) 拼接保留区间（升序）
  const keptChars: string[] = []
  for (const iv of keptIntervals) {
    for (let i = iv.from; i < iv.to && i < src.length; i++) keptChars.push(src[i])
  }
  // 2) 按 at 升序插入标签
  const sortedSegs = [...insertedSegments].sort((a, b) => a.at - b.at)
  const out: string[] = []
  let keptIdx = 0
  let keepPos = 0 // 已插入到 out 的 kept 原文 code-point 数
  for (const seg of sortedSegs) {
    while (keepPos < seg.at && keptIdx < keptChars.length) {
      out.push(keptChars[keptIdx])
      keptIdx++
      keepPos++
    }
    for (const ch of Array.from(seg.text)) out.push(ch)
  }
  // 尾部剩余 kept 文本
  while (keptIdx < keptChars.length) {
    out.push(keptChars[keptIdx])
    keptIdx++
  }
  return out.join('')
}

export function buildNovelMaterial(
  messages: { role: string; content: string }[],
  maxChars = 400000
): { material: string; truncated: boolean; evidence: NovelMaterialEvidence } {
  const parts: string[] = []
  for (const m of messages) {
    if (m.role !== 'user' && m.role !== 'assistant') continue
    const content = String(m.content ?? '').trim()
    if (!content) continue
    parts.push(`【${m.role === 'user' ? '用户' : 'AI'}】${content}`)
  }
  const full = parts.join('\n')
  const originalChars = Array.from(full).length

  if (originalChars <= maxChars) {
    return {
      material: full,
      truncated: false,
      evidence: {
        originalChars,
        maxChars,
        keptIntervals: [{ from: 0, to: originalChars, reason: 'full' }],
        insertedSegments: [],
        droppedChars: 0,
        anchorsKept: false,
        wellFormed: !hasLoneSurrogate(full),
        keptTailChars: originalChars
      }
    }
  }

  // ---- 截断策略：保留最近内容（尾部回填）+ 锚点 ----
  // 设计（R21-R07）：keptIntervals 为互不重叠、升序的真实原文 code-point 区间；
  //   insertedSegments 单独记录标签/分隔符；reconstructMaterial(original, keptIntervals, insertedSegments) === final。
  // 段顺序（final 内的排列）恒为：开局锚点原文 → 人物锚点原文 → 尾部回填原文；
  //   为避免区间重叠（极小 maxChars 使尾部前移到开局内），开局区间尾部与人物/尾部区间夹紧、宁可不重复保留。
  const chars = Array.from(full)
  const totalCp = chars.length

  const labelOpening = '【开局锚点】'
  const labelChar = '【人物锚点】'
  const sep = '\n'
  const labelOpeningLen = Array.from(labelOpening).length
  const labelCharLen = Array.from(labelChar).length
  // 固定插入项：开局标签、人物标签(+前置换行)、尾部换行。三者长度之和从 maxChars 预算中扣除。
  const fixedInsertLen = labelOpeningLen + sep.length + labelCharLen + sep.length
  const tailBudget = maxChars - fixedInsertLen
  const validTailBudget = Math.max(0, tailBudget)
  const tailStart = Math.max(0, totalCp - validTailBudget)

  // 开局锚点：保留原文开头，上限 500 cp，且不得超过 tailStart（避免与尾部区间重叠）
  const openingAnchorEnd = Math.min(500, tailStart)
  const openingAnchor = chars.slice(0, openingAnchorEnd).join('')

  // 人物锚点：在 [openingAnchorEnd, tailStart) 中段寻找名字句（尽力 ≤1000），填入开局之后、尾部之前
  let characterAnchor = ''
  let charAnchorFrom = -1
  const charAnchorLen = (): number => (characterAnchor ? Array.from(characterAnchor).length : 0)
  if (tailStart > openingAnchorEnd) {
    const midHead = chars.slice(openingAnchorEnd, tailStart).join('')
    const nameMarkRe = /[^\n。！？!?]*(?:名字|叫|称呼|角色名|姓名)[^\n。！？!?]*[。！？!?\n]?/g
    // P1-03：RegExp m.index 是 UTF-16 code-unit 偏移；midHead 若含 astral code point（emoji/扩展汉字），
    // 直接当作 code-point offset 会错切一位。此处显式转换：匹配前子串的 code-point 长度。
    const hits: { text: string; offset: number }[] = []
    let m: RegExpExecArray | null
    while ((m = nameMarkRe.exec(midHead)) !== null) {
      if (m[0]) hits.push({ text: m[0], offset: Array.from(midHead.slice(0, m.index)).length })
    }
    if (hits.length > 0) {
      const hit = hits[hits.length - 1] // 取最靠后命中 → 更贴近最新剧情
      let cand = hit.text
      if (Array.from(cand).length > 1000) cand = Array.from(cand).slice(0, 1000).join('')
      characterAnchor = cand
      charAnchorFrom = openingAnchorEnd + hit.offset
    }
  }

  // ---- 互不重叠、升序的 kept intervals ----
  const keptIntervals: NovelMaterialKeptInterval[] = []
  if (openingAnchorEnd > 0) {
    keptIntervals.push({ from: 0, to: openingAnchorEnd, reason: 'opening-anchor' })
  }
  if (characterAnchor) {
    keptIntervals.push({ from: charAnchorFrom, to: charAnchorFrom + charAnchorLen(), reason: 'character-anchor' })
  }
  const tailLen = totalCp - tailStart
  if (tailLen > 0) {
    keptIntervals.push({ from: tailStart, to: totalCp, reason: 'tail-kept' })
  }
  const keptCp = keptIntervals.reduce((acc, iv) => acc + (iv.to - iv.from), 0)

  // ---- insertedSegments：at 相对拼接后的 kept 原文 code-point 位置（升序）----
  const insertedSegments: NovelMaterialInsertedSegment[] = []
  insertedSegments.push({ at: 0, text: labelOpening })
  let insertAt = openingAnchorEnd
  if (characterAnchor) {
    insertedSegments.push({ at: insertAt, text: sep + labelChar })
    insertAt += charAnchorLen()
  }
  insertedSegments.push({ at: insertAt, text: sep })

  // ---- 以 reconstructMaterial 为唯一真源生成 final（保证严格可复算）----
  let final = reconstructMaterial(full, keptIntervals, insertedSegments)

  // 二次兜底：预算极小导致锚点+尾部仍超 maxChars（如 maxChars≈标签长度）。此时裁掉尾部最末 cp。
  // 保持「reconstruct === final」不变式：裁剪即缩减 tail 区间 to（若仍超，则进一步裁掉已插入的换行等）。
  while (Array.from(final).length > maxChars) {
    // 优先缩短最后一个 kept 区间（tail-kept）
    let done = false
    for (let i = keptIntervals.length - 1; i >= 0; i--) {
      const iv = keptIntervals[i]
      if (iv.to > iv.from) {
        iv.to -= 1
        done = true
        break
      }
    }
    if (!done) {
      // kept 已空仍超：裁掉最后一个 inserted segment 的一个 cp（罕见极值）
      const lastSeg = insertedSegments[insertedSegments.length - 1]
      if (lastSeg && Array.from(lastSeg.text).length > 0) {
        lastSeg.text = Array.from(lastSeg.text).slice(0, -1).join('')
      } else {
        break
      }
    }
    final = reconstructMaterial(full, keptIntervals, insertedSegments)
  }

  const finalKeptCp = keepCp(keptIntervals)
  const droppedChars = totalCp - finalKeptCp

  // keptTailChars = 最终 tail-kept 区间的实际长度（二次兜底裁剪后可能与 totalCp - tailStart 不同）。
  // P1-03 复核：保证「keptTailChars == 最终 tail interval 长度」一致（均为 code-point 口径）。
  const finalTailIv = keptIntervals[keptIntervals.length - 1]
  const keptTailChars =
    finalTailIv && finalTailIv.reason === 'tail-kept' ? finalTailIv.to - finalTailIv.from : 0

  return {
    material: final,
    truncated: true,
    evidence: {
      originalChars,
      maxChars,
      keptIntervals,
      insertedSegments,
      droppedChars,
      anchorsKept: true,
      wellFormed: !hasLoneSurrogate(final),
      keptTailChars
    }
  }
}

/** ∑(区间长度)，code points */
function keepCp(intervals: NovelMaterialKeptInterval[]): number {
  return intervals.reduce((acc, iv) => acc + (iv.to - iv.from), 0)
}

export function buildNovelRequest(material: string): DsMessage[] {
  return [
    { role: 'system', content: NOVEL_SYSTEM },
    { role: 'user', content: material }
  ]
}

/** 对话成书模式：开启后注入的创作累积提示词（不改变正常对话，只提示 AI 以创作协作者身份对话） */
export function buildNovelModeSystem(): string {
  return `## 创作累积模式（对话成书）
当前会话处于创作累积模式：用户正在与你讨论一部作品的创作（人设、剧情、片段、设定）。
规则：
1. 以创作协作者身份对话：帮用户推敲设定、提供片段草稿、讨论情节走向，写作质量优先
2. 每次涉及新设定（人物/地点/事件/伏笔）时，自然地确认并保持一致性，避免前后矛盾
3. 会话内容将被用于最终整理成小说：所以对话中的创作内容（设定、片段、描写）请尽量完整、可直接复用
4. 用户明确要求"直接输出正文"时，按剧情引擎规范输出完整正文`
}

/** 直接生成模式：剧情简介 → 完整小说请求构造（system 为剧情引擎 prompt，user 为剧情简介） */
export function buildDirectNovelRequest(storyPrompt: string, userPrompt: string): DsMessage[] {
  return [
    { role: 'system', content: storyPrompt },
    { role: 'user', content: userPrompt }
  ]
}

export interface RunNovelExportOpts {
  sessionId: string
  format: NovelExportFormat
  /** 完整请求消息（对话成书：buildNovelRequest；直接生成：buildDirectNovelRequest） */
  request: DsMessage[]
  /** 可选的素材说明（对话成书传素材字数，直接生成传目标篇幅） */
  materialNote?: string
  /** 默认保存文件名（不含扩展名） */
  suggestedName: string
  apiKey: string
  baseUrl: string
  model: string
  maxTokens: number
  /** User-configured document directory used as the save dialog's starting location. */
  defaultSaveDir?: string
  targetChars?: number
  activity?: NovelActivitySink
  onEvent: (ev: NovelExportEvent) => void
  signal?: AbortSignal
  /** R20 主代理整合：测试注入缝（S5 writing-core 红灯 2 用 mock 驱动；缺省=真实 longGenerate） */
  longGenerateImpl?: typeof longGenerate
  /**
   * R21-R08：继续写作。非空时表示基于已有草稿续写：请求构造只注入草稿尾部（
   * 默认尾 200 字）+ 继续指令，不整段重复草稿全文；缺省 = 全新生成。
   */
  continueFrom?: { partialContent: string } | null
}

/** R21-R08：runNovelExport 的返回结构（向后兼容：path/usage 原字段不变，新增 partial* 字段） */
export interface RunNovelExportResult {
  ok: boolean
  path?: string
  usage?: Usage | null
  /** true=流中途失败，partialContent 为已生成正文（可恢复草稿） */
  partial?: boolean
  /** 流中断前累计的正文（经 onEvent text 累计） */
  partialContent?: string
  /** partialContent 的 code-point 字数 */
  partialChars?: number
  /** 草稿落盘路径（userData/deepwriter-partial/<sessionId>-<ts>.md） */
  draftPath?: string
}

function formatTs(d: Date): string {
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
}

/** R21-R08：把草稿正文落盘到 userData/deepwriter-partial/<sessionId>-<ts>.md，返回绝对路径。 */
async function writePartialDraft(sessionId: string, content: string): Promise<string> {
  const dir = path.join(app.getPath('userData'), 'deepwriter-partial')
  await fs.mkdir(dir, { recursive: true })
  const safeSession = sessionId.replace(/[^\w.-]/g, '_')
  const filePath = path.join(dir, `${safeSession}-${formatTs(new Date())}.md`)
  await fs.writeFile(filePath, content, 'utf-8')
  return filePath
}

/** R21-R08：继续写作请求——只注入草稿尾部 200 字 + 继续指令，不整段重复草稿原文。 */
export function buildContinueRequest(baseRequest: DsMessage[], partialContent: string, tailChars = 200): DsMessage[] {
  const tail = Array.from(partialContent).slice(-tailChars).join('')
  const continuePrompt = `【继续写作】上文已写到如下结尾，请从结尾处自然接续，不要重复已有正文：\n\n${tail}\n\n请继续。`
  const req = baseRequest.map((m) => ({ ...m }))
  // 在最后一条 user 消息后追加继续指令（若无 user 消息则新起一条）
  const lastUserIdx = req.map((m) => m.role).lastIndexOf('user')
  if (lastUserIdx >= 0) {
    req[lastUserIdx] = { ...req[lastUserIdx], content: req[lastUserIdx].content + '\n\n' + continuePrompt }
  } else {
    req.push({ role: 'user', content: continuePrompt })
  }
  return req
}

async function renderDocx(md: string): Promise<Buffer> {
  const { Document, Packer, Paragraph, TextRun, HeadingLevel } = await import('docx')
  const children: any[] = []
  for (const raw of md.split('\n')) {
    const line = raw.trimEnd()
    if (/^#\s+/.test(line)) {
      children.push(
        new Paragraph({
          heading: HeadingLevel.HEADING_1,
          children: [new TextRun({ text: line.replace(/^#\s+/, ''), bold: true, size: 32, font: { name: '微软雅黑', eastAsia: '微软雅黑' } })]
        })
      )
    } else if (/^##\s+/.test(line)) {
      children.push(
        new Paragraph({
          heading: HeadingLevel.HEADING_2,
          children: [new TextRun({ text: line.replace(/^##\s+/, ''), bold: true, size: 28, font: { name: '微软雅黑', eastAsia: '微软雅黑' } })]
        })
      )
    } else if (line.trim()) {
      children.push(new Paragraph({ children: [new TextRun({ text: line.trim(), size: 24, font: { name: '微软雅黑', eastAsia: '微软雅黑' } })] }))
    }
  }
  const doc = new Document({ sections: [{ children }] })
  return Buffer.from(await Packer.toBuffer(doc))
}

export async function runNovelExport(opts: RunNovelExportOpts): Promise<RunNovelExportResult> {
  const { sessionId } = opts
  const emit = (ev: NovelExportEvent): void => opts.onEvent(ev)
  const act = opts.activity
  // R21-R08：继续写作时基于草稿重构请求（只注入尾部，不重复全文）
  const effectiveRequest = opts.continueFrom?.partialContent
    ? buildContinueRequest(opts.request, opts.continueFrom.partialContent)
    : opts.request

  await act?.setPhase('reading', '正在收集素材')
  emit({ sessionId, stage: 'collecting' })
  if (opts.materialNote != null) {
    emit({ sessionId, stage: 'material', message: opts.materialNote })
  }
  const hasContent = effectiveRequest.some((m) => String(m.content ?? '').trim())
  if (!hasContent) {
    emit({ sessionId, stage: 'error', error: '没有可生成的内容' })
    return { ok: false }
  }

  await act?.setPhase('writing', '正在创作正文')
  await act?.emitActivity('artifact.started', 'writing', '开始创作正文', '', {
    kind: 'artifact',
    artifactId: 'novel',
    artifactType: 'chapter',
    displayName: '小说正文',
    status: 'started'
  })
  emit({ sessionId, stage: 'exporting' })
  let text = ''
  let usage: Usage | null = null
  let reachedTarget = true
  let needsContinuation = false
  let partial = false
  try {
    const lg = opts.longGenerateImpl ?? longGenerate
    const result = await lg({
      params: {
        apiKey: opts.apiKey,
        model: opts.model,
        baseUrl: opts.baseUrl,
        thinking: { enabled: false, effort: 'low' },
        maxTokens: opts.maxTokens,
        temperature: 0.8,
        topP: 1
      },
      messages: effectiveRequest,
      signal: opts.signal,
      // C2：maxRounds 与 targetChars 关联（长文按每轮约 5000 字估算轮数，下限 4）
      maxRounds: opts.targetChars && opts.targetChars > 0 ? Math.max(4, Math.ceil(opts.targetChars / 5000)) : 12,
      targetChars: opts.targetChars ?? 0,
      onEvent: (ev) => {
        if (ev.type === 'text') text += ev.delta ?? ''
      },
      onRound: () => {
        if (act) {
          void act.emitActivity('artifact.progress', 'writing', '正在创作正文', `已生成 ${codePointLength(text)} 字`, {
            kind: 'artifact',
            artifactId: 'novel',
            artifactType: 'chapter',
            displayName: '小说正文',
            status: 'progress',
            completedChars: codePointLength(text),
            ...(opts.targetChars ? { targetChars: opts.targetChars } : {})
          })
        }
      }
    })
    usage = result.totalUsage
    reachedTarget = result.reachedTarget
    needsContinuation = result.needsContinuation
    partial = result.partial
  } catch (e) {
    const err = e as Error
    const msg = err.name === 'AbortError' ? '已停止' : `生成失败: ${err.message}`
    // R21-R08：活路径 partial 恢复——longGenerateImpl 抛错前已产出的正文（text 已累计），
    // 落盘为用户可恢复草稿，并返回 partial 语义；不 emit done。
    const partialContent = text
    const partialChars = codePointLength(partialContent)
    let draftPath: string | undefined
    if (partialContent.trim()) {
      try {
        draftPath = await writePartialDraft(sessionId, partialContent)
      } catch (writeErr) {
        draftPath = undefined
        void writeErr
      }
    }
    const note = draftPath
      ? `生成中断（已保留 ${partialChars} 字正文，草稿已保存：${draftPath}，可继续写作）`
      : `生成中断（已保留 ${partialChars} 字正文，但草稿保存失败）`
    emit({ sessionId, stage: 'error', message: note, error: msg })
    return { ok: false, partial: true, partialContent, partialChars, draftPath, usage }
  }

  // C2：未达标/部分完成不得 emit stage='done'/ok:true——改发明确「未完成/部分完成」事件。
  // 复用现有 stage 字段（shared 契约不改），partial/needs_continuation 语义经 message 透出。
  if (needsContinuation || !reachedTarget || partial) {
    const done = codePointLength(text)
    const target = opts.targetChars ?? 0
    const note = partial
      ? `生成中断（保留已生成 ${done} 字正文，未完成）`
      : needsContinuation || !reachedTarget
        ? `未完成：已生成 ${done} 字 / 目标 ${target} 字，需要继续写作`
        : `未完成`
    emit({ sessionId, stage: 'error', message: note, error: note })
    return { ok: false, usage }
  }

  const ext = opts.format === 'docx' ? 'docx' : opts.format === 'txt' ? 'txt' : 'md'
  const filters =
    opts.format === 'md'
      ? [{ name: 'Markdown', extensions: ['md'] }]
      : opts.format === 'txt'
        ? [{ name: '文本文件', extensions: ['txt'] }]
        : [{ name: 'Word 文档', extensions: ['docx'] }]
  const saveResult = await dialog.showSaveDialog({
    title: '保存小说',
    defaultPath: buildDefaultDocumentPath(opts.defaultSaveDir ?? app.getPath('documents'), opts.suggestedName, ext, formatTs(new Date())),
    filters
  })
  if (saveResult.canceled || !saveResult.filePath) {
    emit({ sessionId, stage: 'error', error: '用户取消了保存' })
    return { ok: false }
  }
  try {
    await fs.mkdir(path.dirname(saveResult.filePath), { recursive: true })
    if (opts.format === 'docx') {
      const buffer = await renderDocx(text)
      await fs.writeFile(saveResult.filePath, buffer)
    } else {
      await fs.writeFile(saveResult.filePath, text, 'utf-8')
    }
    await act?.emitActivity('artifact.completed', 'writing', '创作完成', `已保存 ${saveResult.filePath}`, {
      kind: 'artifact',
      artifactId: 'novel',
      artifactType: 'chapter',
      displayName: '小说正文',
      status: 'completed',
      completedChars: codePointLength(text),
      ...(opts.targetChars ? { targetChars: opts.targetChars } : {}),
      relativePath: saveResult.filePath
    })
    emit({ sessionId, stage: 'done', path: saveResult.filePath, usage })
    return { ok: true, path: saveResult.filePath, usage }
  } catch (e) {
    emit({ sessionId, stage: 'error', error: `写入文件失败: ${(e as Error).message}` })
    return { ok: false }
  }
}

/**
 * R21-R08：继续一个已中断的导出——基于草稿续写，请求只注入草稿尾部（不重复全文）。
 * 等价于 runNovelExport(..., continueFrom: { partialContent })。
 */
export async function continueNovelExport(
  opts: RunNovelExportOpts,
  partialContent: string
): Promise<RunNovelExportResult> {
  return runNovelExport({ ...opts, continueFrom: { partialContent } })
}
