import { streamChat } from '../deepseek'
import type { ContentSkeleton, RevisionRequest } from '../../shared/styleV2'
import { isCreativeAuthError, type CreativeApi } from '../creativeModel'
import { injectUserPresetSystemMessage } from '../../shared/userPresetPrompt'

export interface ApiCtx extends CreativeApi {
  signal?: AbortSignal
}

export interface ModelResult {
  text: string
  usageTokens: number
}

async function callModel(ctx: ApiCtx, messages: { role: string; content: string }[], opts: { thinking: boolean; effort: string; temperature?: number; topP?: number }): Promise<ModelResult> {
  let text = ''
  let usage = 0
  await streamChat(
    {
      apiKey: ctx.apiKey,
      baseUrl: ctx.baseUrl,
      model: ctx.model,
      messages: injectUserPresetSystemMessage(messages as never, ctx.userPresetPrompt),
      thinking: ctx.thinking ?? { enabled: opts.thinking, effort: opts.effort as 'low' | 'medium' | 'high' | 'max' },
      maxTokens: ctx.maxTokens,
      temperature: ctx.temperature ?? opts.temperature,
      topP: ctx.topP ?? opts.topP,
      provider: ctx.provider
    },
    (ev) => {
      if (ev.type === 'text') text += ev.delta ?? ''
      if (ev.type === 'done' && ev.usage) {
        usage = ev.usage.prompt_tokens + ev.usage.completion_tokens
      }
    },
    ctx.signal
  )
  return { text, usageTokens: usage }
}

export function parseJsonLoose(raw: string): unknown {
  let t = raw.trim()
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/)
  if (fence) t = fence[1].trim()
  const start = t.indexOf('{')
  const end = t.lastIndexOf('}')
  if (start === -1 || end === -1 || end <= start) throw new Error('响应中未找到 JSON 对象')
  return JSON.parse(t.slice(start, end + 1))
}

const SKELETON_SYSTEM = `你是一个内容骨架抽取器，不创作正文。
把输入的来源片段还原为与文风无关的内容骨架：
- facts：片段中的事实（人物做了什么、发生了什么）
- eventOrder：事件顺序
- pov：叙述视角（第一/第三）
- emotionalArc：情绪变化序列
- paragraphFunctions：每段的叙述功能（对白/动作/心理/环境/信息释放）
- dialogueIntents：每句对白的意图（如：质问、试探、告白）
要求：
1. 删除原句措辞、比喻、节奏、专名和可识别短语
2. 不得补充片段中没有的事实
3. 只输出符合 ContentSkeleton schema 的 JSON，不要输出其他文字`

export async function extractSkeleton(ctx: ApiCtx, text: string): Promise<{ skeleton: ContentSkeleton; usageTokens: number }> {
  const r = await callModel(
    ctx,
    [
      { role: 'system', content: SKELETON_SYSTEM },
      { role: 'user', content: `来源片段：\n${text.slice(0, 3000)}` }
    ],
    { thinking: true, effort: 'high' }
  )
  const parsed = parseJsonLoose(r.text) as Partial<ContentSkeleton>
  return {
    skeleton: {
      facts: Array.isArray(parsed.facts) ? parsed.facts.map(String) : [],
      eventOrder: Array.isArray(parsed.eventOrder) ? parsed.eventOrder.map(String) : [],
      pov: typeof parsed.pov === 'string' ? parsed.pov : '第三',
      emotionalArc: Array.isArray(parsed.emotionalArc) ? parsed.emotionalArc.map(String) : [],
      paragraphFunctions: Array.isArray(parsed.paragraphFunctions) ? parsed.paragraphFunctions.map(String) : [],
      dialogueIntents: Array.isArray(parsed.dialogueIntents) ? parsed.dialogueIntents.map(String) : []
    },
    usageTokens: r.usageTokens
  }
}

const GENERATOR_SYSTEM = `你是受约束的小说场景生成器。
SCENE_SKELETON 决定事实、事件顺序和人物状态，不可改变。
STYLE_RULES 决定表达方式，只在各自适用条件下执行。
EXEMPLAR_PAIRS 展示"从内容骨架到作者表达"的映射方式，不得续写其中的人物、情节、专名，不得复用其独特短语。
FORBIDDEN 项不得出现。
优先级：安全/用户禁令 > 故事事实 > 人物一致性 > 场景功能 > 风格规则 > 字数目标。
只输出新场景正文，不输出分析、规则复述或评分。`

const VARIANT_INSTRUCTIONS: Record<'A' | 'B' | 'C', string> = {
  A: '本候选优化重点：严格执行统计与句法规则（句长/段长/标点密度/对白比例贴近作者分布），允许行文略规整。',
  B: '本候选优化重点：段落组织与叙事距离（对白后接动作/心理/环境的习惯、信息释放顺序、视角一致性）。',
  C: '本候选优化重点：示例映射与自然流动（从骨架到表达的方式贴近作者，语气最自然，允许节奏稍有起伏）。'
}

export interface GenerateCandidateInput {
  ctx: ApiCtx
  variant: 'A' | 'B' | 'C'
  task: { sceneType: string; narrativeFunctions: string[]; pov: string; emotionalArc: string[]; targetChars: number; userPrompt: string; outputFormat: string }
  skeleton: ContentSkeleton
  rules: string[]
  exemplarPairs: { skeleton: ContentSkeleton; surfaceText: string }[]
  forbiddenPhrases: string[]
}

export async function generateCandidate(input: GenerateCandidateInput): Promise<ModelResult> {
  const { ctx, variant, task, skeleton, rules, exemplarPairs, forbiddenPhrases } = input
  const parts: string[] = []
  parts.push(`## 任务\n场景类型：${task.sceneType}\n叙述功能：${task.narrativeFunctions.join('、')}\n视角：${task.pov}\n情绪弧：${task.emotionalArc.join(' → ')}\n目标字数：约 ${task.targetChars} 字\n输出格式：${task.outputFormat}\n用户要求：${task.userPrompt}`)
  parts.push(`## 内容骨架（不可改变）\n${JSON.stringify(skeleton, null, 1)}`)
  parts.push(`## 风格规则\n${rules.map((r, i) => `${i + 1}. ${r}`).join('\n')}`)
  parts.push(`## 示例映射（仅参考表达方式，禁止续写其人物/情节/专名）\n${exemplarPairs
    .map((p, i) => `--- 示例 ${i + 1} ---\n【骨架】${JSON.stringify(p.skeleton)}\n【作者表达】${p.surfaceText.slice(0, 1200)}`)
    .join('\n\n')}`)
  parts.push(`## 禁止出现（防复制词表）\n${forbiddenPhrases.slice(0, 20).join('、') || '（无）'}`)
  parts.push(`\n请直接输出正文。`)
  return callModel(
    ctx,
    [
      { role: 'system', content: `${GENERATOR_SYSTEM}\n${VARIANT_INSTRUCTIONS[variant]}` },
      { role: 'user', content: parts.join('\n\n') }
    ],
    { thinking: false, effort: 'high', temperature: 0.9, topP: 0.95 }
  )
}

const REVISER_SYSTEM = `你是一个局部修订器。
只改写 TARGET_SPAN 内的内容：
1. 保持与 leftContext/rightContext 的衔接
2. 保留 preserveFacts 中的事实
3. 只修复 failedRules 指出的问题，不重写其他段落、不新增事实
4. 不得使用 forbiddenPhrases 或来源专名
5. 只输出替换后的 span 文本，不要输出其他内容`

export async function reviseSpan(ctx: ApiCtx, req: RevisionRequest, spanText: string, forbiddenPhrases: string[]): Promise<ModelResult> {
  return callModel(
    ctx,
    [
      { role: 'system', content: REVISER_SYSTEM },
      {
        role: 'user',
        content: `TARGET_SPAN（待修订）：\n${spanText}\n\n前置上下文：\n${req.leftContext.slice(-300)}\n\n后置上下文：\n${req.rightContext.slice(0, 300)}\n\n必须保留的事实：${req.preserveFacts.join('；')}\n需要修复的问题：${req.failedRules.join('；')}\n禁止出现的短语：${forbiddenPhrases.slice(0, 15).join('、') || '（无）'}`
      }
    ],
    { thinking: false, effort: 'high', temperature: 0.7 }
  )
}

const EVALUATOR_SYSTEM = `你是风格差异评审器。
比较候选文本与作者风格证据（来自该作者的未参与生成片段），只评价表达方式，不评价题材是否相同。
分别判断：句法节奏、段落组织、对白处理、叙事距离、信息释放、修辞与自然度。
不要因候选复用人名、情节或原句而提高风格分，这应视为泄漏风险。
只输出 JSON：{"styleScore": 0-1, "naturalness": 0-1, "notes": "简短说明"}`

export async function evaluateWithModel(ctx: ApiCtx, text: string, evidenceChunks: string[]): Promise<{ styleScore: number; naturalness: number; notes: string } | null> {
  try {
    const r = await callModel(
      ctx,
      [
        { role: 'system', content: EVALUATOR_SYSTEM },
        {
          role: 'user',
          content: `作者风格证据（供参考，不参与生成的片段）：\n${evidenceChunks.slice(0, 2).join('\n---\n').slice(0, 3000)}\n\n候选文本：\n${text.slice(0, 4000)}`
        }
      ],
      { thinking: true, effort: 'high' }
    )
    const parsed = parseJsonLoose(r.text) as { styleScore?: number; naturalness?: number; notes?: string }
    return {
      styleScore: typeof parsed.styleScore === 'number' ? Math.max(0, Math.min(1, parsed.styleScore)) : 0.5,
      naturalness: typeof parsed.naturalness === 'number' ? Math.max(0, Math.min(1, parsed.naturalness)) : 0.5,
      notes: typeof parsed.notes === 'string' ? parsed.notes.slice(0, 300) : ''
    }
  } catch (error) {
    if (isCreativeAuthError(error)) throw error
    return null
  }
}
