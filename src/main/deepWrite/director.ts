// ==================== R4.3 Gate 5 导演（director） ====================
// 纯 Node 模块（不 import electron）：把多个角色监护者的建议确定性合并为 ScenePacket。
// 冲突按 CONFLICT_PRIORITIES 仲裁（数值大者优先），仲裁过程与 oocRisks 汇总为 decisions；
// 绝不拼接多角色文本——writerInstructions 保持数组，characterGuidance 是逐角色摘要
// （每条 ≤120 token 语义），正文仍只由主笔产出。

import type { CharacterAdvice, SceneBrief, ScenePacket } from './types'

/**
 * 冲突合并优先级（编号 6→1，数值大者优先）：
 * 用户硬约束(6) > 世界事实(5) > 场景目标(4) > 角色知识边界(3) > 角色偏好(2) > 风格偏好(1)
 */
export const CONFLICT_PRIORITIES: Record<string, number> = {
  user_hard_constraint: 6,
  world_fact: 5,
  scene_goal: 4,
  character_knowledge: 3,
  character_preference: 2,
  style_preference: 1
}

/** oocRisk.code → 优先级类别名（确定性映射） */
const RISK_TO_PRIORITY: Record<string, string> = {
  ooc: 'user_hard_constraint', // 角色出戏 → 用户硬约束
  knowledge_leak: 'character_knowledge', // 知识泄露 → 角色知识边界
  voice_drift: 'style_preference', // 声音漂移 → 风格偏好
  motivation_gap: 'scene_goal' // 动机缺口 → 场景目标
}

/** oocRisk.code → 仲裁结果描述（resolved 字段用） */
const RISK_TO_RESOLVED: Record<string, string> = {
  ooc: '按角色设定修正行为，避免出戏',
  knowledge_leak: '该信息不得进入正文',
  voice_drift: '对白避开禁用表达',
  motivation_gap: '补充动机铺垫后再推进'
}

type RiskCode = CharacterAdvice['oocRisks'][number]['code']

/** 简易 token 估算（CJK≈1、其余≈0.25，与 shared/types.estimateTokens 同口径），保持模块自包含 */
function countTokens(text: string): number {
  if (!text) return 0
  let t = 0
  for (const ch of text) {
    const code = ch.codePointAt(0)!
    t += code >= 0x3000 && code <= 0x9fff ? 1 : 0.25
  }
  return Math.ceil(t)
}

/** 按 token 上限截断文本（截断时追加省略号） */
function truncateToTokens(text: string, maxTokens: number): string {
  if (countTokens(text) <= maxTokens) return text
  let acc = ''
  let t = 0
  for (const ch of text) {
    const code = ch.codePointAt(0)!
    const add = code >= 0x3000 && code <= 0x9fff ? 1 : 0.25
    if (t + add > maxTokens) break
    acc += ch
    t += add
  }
  return `${acc}…`
}

/** 每条 characterGuidance.summary ≤ 120 token 语义 */
const SUMMARY_TOKEN_CAP = 120

/** 归纳单条建议为角色摘要：intent + 首条对白注意，超 120 token 截断 */
function summarizeAdvice(a: CharacterAdvice): string {
  const note = a.dialogueNotes.length > 0 ? `；对白注意：${a.dialogueNotes[0]}` : ''
  return truncateToTokens(`${a.intent}${note}`, SUMMARY_TOKEN_CAP)
}

/** 取建议的优先级类别：以建议内最高优先级的 oocRisk 为准，其次看是否携带禁知事实，默认角色偏好 */
function advicePriorityClass(a: CharacterAdvice): string {
  let cls = 'character_preference'
  let best = CONFLICT_PRIORITIES[cls]
  for (const r of a.oocRisks) {
    const name = RISK_TO_PRIORITY[r.code]
    const v = CONFLICT_PRIORITIES[name]
    if (v > best) {
      best = v
      cls = name
    }
  }
  if (a.forbiddenKnowledge.length > 0 && CONFLICT_PRIORITIES.character_knowledge > best) {
    best = CONFLICT_PRIORITIES.character_knowledge
    cls = 'character_knowledge'
  }
  return cls
}

/**
 * 合并多个角色建议为 ScenePacket。
 * - 同一角色多份建议冲突时，按优先级类别裁决（数值大者优先，平局比 confidence），
 *   裁决记录进 decisions；失败方不进入 characterGuidance（不拼接文本）。
 * - 所有建议的 oocRisks 汇总为 decision 记录。
 * - writerInstructions 保持原数组（主笔指令），绝不拼接多角色文本。
 */
export function directScene(brief: SceneBrief, advices: CharacterAdvice[], writerInstructions: string[]): ScenePacket {
  const decisions: ScenePacket['decisions'] = []
  const guidance: ScenePacket['characterGuidance'] = []
  const conflictRecords: Array<{ priority: string; resolved: string; reason: string }> = []

  // 按角色分组（保持出现顺序）
  const byChar = new Map<string, CharacterAdvice[]>()
  for (const a of advices) {
    const list = byChar.get(a.characterId)
    if (list) list.push(a)
    else byChar.set(a.characterId, [a])
  }

  for (const [charId, list] of byChar) {
    // 同一角色的多份建议：按优先级仲裁出唯一胜者
    let winner = list[0]
    if (list.length > 1) {
      for (let i = 1; i < list.length; i++) {
        const cand = list[i]
        const wCls = advicePriorityClass(winner)
        const cCls = advicePriorityClass(cand)
        const wVal = CONFLICT_PRIORITIES[wCls]
        const cVal = CONFLICT_PRIORITIES[cCls]
        if (cVal > wVal || (cVal === wVal && cand.confidence > winner.confidence)) {
          conflictRecords.push({
            priority: cCls,
            resolved: `采用建议 ${i + 1}（${cand.intent}）`,
            reason: `同一角色「${charId}」两份建议冲突：按优先级「${cCls}」(${cVal}) > 「${wCls}」(${wVal}) 仲裁，采用 ${cand.intent}`
          })
          winner = cand
        } else {
          conflictRecords.push({
            priority: wCls,
            resolved: `采用建议 1（${winner.intent}）`,
            reason: `同一角色「${charId}」两份建议冲突：按优先级「${wCls}」(${wVal}) > 「${cCls}」(${cVal}) 仲裁，采用 ${winner.intent}`
          })
        }
      }
    }
    guidance.push({ characterId: charId, summary: summarizeAdvice(winner) })

    // oocRisks 汇总为 decision 记录
    let riskIdx = 0
    for (const a of list) {
      for (const r of a.oocRisks) {
        const code = r.code as RiskCode
        const priority = RISK_TO_PRIORITY[code]
        decisions.push({
          id: `ooc-${charId}-${riskIdx++}`,
          priority,
          resolved: RISK_TO_RESOLVED[code],
          reason: `监护者「${charId}」标记风险 ${code}：${r.evidence}`
        })
      }
    }
  }

  // 冲突仲裁记录附在 decisions 之后
  let conflictIdx = 0
  for (const c of conflictRecords) {
    decisions.push({ id: `conflict-${c.priority}-${conflictIdx++}`, ...c })
  }

  const conflict = conflictRecords.length > 0 ? `存在 ${conflictRecords.length} 处角色建议冲突，已按优先级仲裁` : `无显式冲突；目标：${brief.goal}`

  return {
    sceneId: brief.sceneId,
    goal: brief.goal,
    conflict,
    beats: [...brief.beats],
    characterGuidance: guidance,
    writerInstructions: [...writerInstructions],
    decisions
  }
}
