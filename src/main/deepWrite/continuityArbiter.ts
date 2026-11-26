// ==================== R4.3 Gate 5 连续性仲裁（continuityArbiter） ====================
// 纯 Node 模块（不 import electron）：确定性规则优先，零模型调用。
// - checkCharacterKnowledge：正文不得使用角色禁知信息 → knowledge_leak（hard）
// - checkVoice：bible 中禁用的表达出现在对白 → voice_drift（soft）
// timeline 冲突检查依赖时间线数据（本轮实验版角色卡/场景 brief 无时间线字段，
// 留待时间线模块接入后扩展）。

import type { CharacterCard, ContinuityFinding } from './types'

/**
 * 角色知识边界检查（确定性）：draft 中出现 forbiddenKnowledge 任一条 →
 * knowledge_leak（hard）。无时间线数据时不做 timeline 检查。
 */
export function checkCharacterKnowledge(card: CharacterCard, draft: string): ContinuityFinding[] {
  if (!draft || card.forbiddenKnowledge.length === 0) return []
  const findings: ContinuityFinding[] = []
  for (const f of card.forbiddenKnowledge) {
    if (draft.includes(f)) {
      findings.push({
        code: 'knowledge_leak',
        characterId: card.id,
        span: f,
        evidence: `正文出现禁知信息「${f}」，角色「${card.name}」绝不该知道`,
        severity: 'hard'
      })
    }
  }
  return findings
}

/** 从 bible 中提取禁用表达：匹配「禁用/禁止/禁忌/不许/不能/避免…：<表达>」约定（支持「」引号形式） */
const BANNED_PHRASE_RE = /(?:禁用|禁止|禁忌|不许|不能|避免)[^：:\n]{0,20}[：:]\s*["「『“]?([^。！？\n"」』”]{1,40})/g

/**
 * 声音检查（确定性）：bible 中禁用的表达出现在对白/正文 → voice_drift（soft）。
 * 提取规则：bible 中以「禁用口头禅：呵呵」等格式声明的表达；命中则按角色记一条软发现。
 */
export function checkVoice(card: CharacterCard, draft: string): ContinuityFinding[] {
  if (!draft || !card.bible) return []
  const findings: ContinuityFinding[] = []
  const seen = new Set<string>()
  let m: RegExpExecArray | null
  const re = new RegExp(BANNED_PHRASE_RE.source, 'g')
  while ((m = re.exec(card.bible)) !== null) {
    const phrase = m[1].trim()
    if (!phrase || seen.has(phrase)) continue
    seen.add(phrase)
    if (draft.includes(phrase)) {
      findings.push({
        code: 'voice_drift',
        characterId: card.id,
        span: phrase,
        evidence: `对白出现禁用表达「${phrase}」（bible 声明：禁用），角色「${card.name}」声音漂移`,
        severity: 'soft'
      })
    }
  }
  return findings
}
