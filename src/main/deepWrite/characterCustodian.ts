// ==================== R4.3 Gate 5 角色监护者（characterCustodian） ====================
// 纯 Node 模块（不 import electron）：构造限定范围的监护者 prompt、解析模型结构化输出、
// 调用监护者模型（接口注入）。实验版定位：监护者只输出 CharacterAdvice 建议，
// 绝不直接产出正文（正文唯一来源是主笔，见 orchestrator 的 CHAR-SINGLE-WRITER 约束）。

import { z } from 'zod'
import type { CharacterAdvice, CharacterCard, CharacterModelCall, CharacterModelCallResult, SceneBrief } from './types'

/** 近期相关 spans 的默认字符上限（runCustodian 无 charLimit 参数时的兜底；buildCustodianPrompt 可另行指定） */
export const CUSTODIAN_SPAN_CHAR_LIMIT = 6000

/** 禁知/风险代码的固定枚举（与 types.CharacterAdvice.oocRisks.code 一致） */
const RISK_CODE_SCHEMA = z.enum(['ooc', 'knowledge_leak', 'voice_drift', 'motivation_gap'])

/** zod schema：与 CharacterAdvice 一一对应，类型由 tsc 在编译期校验一致 */
const oocRiskSchema = z.object({
  code: RISK_CODE_SCHEMA,
  evidence: z.string()
})

const adviceSchema: z.ZodType<CharacterAdvice> = z.object({
  characterId: z.string(),
  sceneId: z.string(),
  intent: z.string(),
  voiceConstraints: z.array(z.string()),
  knownFacts: z.array(z.string()),
  forbiddenKnowledge: z.array(z.string()),
  likelyActions: z.array(z.string()),
  oocRisks: z.array(oocRiskSchema),
  dialogueNotes: z.array(z.string()),
  confidence: z.number()
})

/** 把数组渲染为编号列表文本（空数组 → 占位说明） */
function renderList(items: string[], empty: string): string {
  if (items.length === 0) return empty
  return items.map((it, i) => `${i + 1}. ${it}`).join('\n')
}

/**
 * 截断近期 spans：按顺序保留能在 charLimit 内放下的完整 span（逐条 + 换行计入长度），
 * 超出部分整体丢弃并追加截断标记。保证 prompt 不会包含超限段落中的任何内容
 * （CHAR-SCOPE-01：无关章节全文不得进入 prompt）。
 */
function truncateSpans(spans: string[], charLimit: number): string[] {
  if (charLimit <= 0) return []
  const kept: string[] = []
  let used = 0
  for (const s of spans) {
    if (used + s.length + 1 > charLimit) break
    kept.push(s)
    used += s.length + 1
  }
  return kept
}

/**
 * 构造监护者 prompt。拼装顺序固定（CHAR-SCOPE-01）：
 * 角色卡 → 公开事实 → 该角色已知事实 → 禁知事实 → 场景 beats → 近期相关 spans。
 * 内容严格限定：只含 card / brief / recentSpans 中的信息，绝不包含整库/整书上下文。
 */
export function buildCustodianPrompt(card: CharacterCard, brief: SceneBrief, recentSpans: string[], charLimit: number): string {
  const kept = truncateSpans(recentSpans, charLimit)
  const truncated = kept.length < recentSpans.length
  const spansText =
    kept.length === 0
      ? '（无近期相关段落）'
      : kept.join('\n') + (truncated ? '\n…已截断（其余近期段落超出字符上限，省略）' : '')
  const lines: string[] = [
    `[角色监护任务] 你是角色「${card.name}」的监护者。`,
    '请仅依据以下限定信息，输出该角色在本场景的结构化建议 JSON（intent/voiceConstraints/knownFacts/forbiddenKnowledge/likelyActions/oocRisks/dialogueNotes/confidence）。',
    '不要输出正文、不要续写场景、不要引用本 prompt 之外的信息。',
    '',
    `【角色卡】\n${card.bible}`,
    `【公开事实】\n${renderList(brief.publicFacts, '（无公开事实）')}`,
    `【该角色已知事实】\n${renderList(card.knownFacts, '（无已知事实）')}`,
    `【该角色禁知事实】\n${renderList(card.forbiddenKnowledge, '（无禁知事实）')}`,
    `【场景节拍】\n${renderList(brief.beats, '（无节拍）')}`,
    `【近期相关段落】\n${spansText}`
  ]
  return lines.join('\n')
}

/**
 * 解析模型结构化输出为 CharacterAdvice。
 * 宽松容错：兼容 ```json 围栏与无围栏；JSON 提取失败（损坏/非 JSON）返回 null。
 * 提取成功后经 zod schema 校验，不合法同样返回 null。
 */
export function parseCharacterAdvice(raw: string): CharacterAdvice | null {
  if (!raw) return null
  let text = raw.trim()
  // 兼容 ```json … ``` / ``` … ``` 围栏
  const fence = text.match(/^```(?:json)?\s*([\s\S]*?)```\s*$/)
  if (fence) text = fence[1].trim()
  let obj: unknown
  try {
    obj = JSON.parse(text)
  } catch {
    // 宽松容错：尝试提取第一个 { 到最后一个 } 之间的内容
    const start = text.indexOf('{')
    const end = text.lastIndexOf('}')
    if (start === -1 || end <= start) return null
    try {
      obj = JSON.parse(text.slice(start, end + 1))
    } catch {
      return null
    }
  }
  const result = adviceSchema.safeParse(obj)
  return result.success ? result.data : null
}

/**
 * 调用监护者（模型接口注入）。prompt 由 buildCustodianPrompt 构造（spans 用
 * CUSTODIAN_SPAN_CHAR_LIMIT 截断）；输出经 schema 校验。模型抛错或解析失败一律
 * 返回 { advice: null }（调用方决定是否重试该小任务），绝不向上抛（CHAR-CRASH-01）。
 * R4.6 Gate 2：返回结构化结果（advice + 真实 usage；取消时 usage=null 不入账），
 * signal 透传 call（取消收敛在途调用）。
 */
export async function runCustodian(
  card: CharacterCard,
  brief: SceneBrief,
  recentSpans: string[],
  call: CharacterModelCall,
  signal?: AbortSignal
): Promise<{ advice: CharacterAdvice | null; usage: { inputTokens: number; outputTokens: number } | null }> {
  const prompt = buildCustodianPrompt(card, brief, recentSpans, CUSTODIAN_SPAN_CHAR_LIMIT)
  let result: CharacterModelCallResult
  try {
    result = await call(prompt, signal)
  } catch {
    return { advice: null, usage: null }
  }
  const usage = signal?.aborted ? null : (result.usage ?? null)
  return { advice: parseCharacterAdvice(result.text), usage }
}
