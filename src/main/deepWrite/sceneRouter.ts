// ==================== R4.6 Gate 2：Scene Router（角色路由） ====================
// 任务书要求：Scene Router 根据"在场角色、对白占比、冲突中心、近期状态"选择最多 N 个活跃角色。
// 本模块提供确定性 importance 评分（纯函数，无模型调用）：
// - 在场（brief.presentCharacterIds）权重最高；
// - beats 中角色名/ID 提及次数（对白/冲突中心近似）；
// - 近期状态（stateStore 的角色状态：status='出场'）加权。
// 截断（maxActive/预算）由 tokenGovernor.decideGovernor 负责（与 usage ledger 决策一致）。
// 角色 ID 是唯一主键（name 仅展示，不得作为主键）。

import type { CharacterCard, SceneBrief } from './types'

export interface CharacterImportanceState {
  characterId: string
  status: string
}

/** 确定性 importance 评分：在场 100 + beats 提及 ×10 + 近期出场 5 */
export function scoreCharacterImportance(card: CharacterCard, brief: SceneBrief, recentState: CharacterImportanceState[] = []): number {
  let score = 0
  if (brief.presentCharacterIds.includes(card.id)) score += 100
  const beatHits = brief.beats.filter((b) => b.includes(card.name) || b.includes(card.id)).length
  score += beatHits * 10
  const st = recentState.find((s) => s.characterId === card.id)
  if (st && st.status === '出场') score += 5
  return score
}

export interface RouteActiveCharactersInput {
  cards: CharacterCard[]
  brief: SceneBrief
  recentState?: CharacterImportanceState[]
  maxActive: number
}

export interface RouteActiveCharactersResult {
  active: CharacterCard[]
  skipped: CharacterCard[]
  /** importance 明细（供 governor/测试断言；不含角色卡原文） */
  scores: Array<{ characterId: string; importance: number }>
}

/**
 * 路由活跃角色：按 importance 降序截断到 maxActive（评分并列时按卡片顺序保持确定性）。
 * skipped 记录未入选角色（degraded 依据之一——"角色检查部分降级"证据）。
 */
export function routeActiveCharacters(input: RouteActiveCharactersInput): RouteActiveCharactersResult {
  const scored = input.cards.map((card) => ({
    card,
    importance: scoreCharacterImportance(card, input.brief, input.recentState ?? [])
  }))
  // 确定性排序：importance 降序；并列按原始顺序（stable sort）
  const ranked = scored
    .map((s, i) => ({ ...s, idx: i }))
    .sort((a, b) => b.importance - a.importance || a.idx - b.idx)
  const active = ranked.slice(0, input.maxActive).map((r) => r.card)
  const skipped = ranked.slice(input.maxActive).map((r) => r.card)
  return {
    active,
    skipped,
    scores: ranked.map((r) => ({ characterId: r.card.id, importance: r.importance }))
  }
}
