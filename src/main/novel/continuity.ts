import type { StoryBible, SceneCard } from './storyState'
import { applySceneCommit, getContinuityContext } from './storyState'
import type { DraftStore } from './draftStore'

export interface ContinuityIssue {
  type: 'fact_missing' | 'contradiction' | 'foreshadow_unresolved' | 'char_state_error'
  message: string
  spanStart?: number
  spanEnd?: number
}

export function checkContinuity(opts: {
  bible: StoryBible
  scene: SceneCard
  sceneText: string
  requiredFacts: string[]
  forbiddenFacts: string[]
}): { ok: boolean; issues: ContinuityIssue[] } {
  const { sceneText, requiredFacts, forbiddenFacts } = opts
  const issues: ContinuityIssue[] = []
  for (const f of requiredFacts) {
    if (!sceneText.includes(f)) {
      issues.push({ type: 'fact_missing', message: `缺少必须事实：${f}` })
    }
  }
  for (const f of forbiddenFacts) {
    if (sceneText.includes(f)) {
      const idx = sceneText.indexOf(f)
      issues.push({ type: 'contradiction', message: `出现禁止事实：${f}`, spanStart: idx, spanEnd: idx + f.length })
    }
  }
  // 伏笔检查只作用于「应当回收的目标场景」（场景 facts 明确指向未回收伏笔），不阻塞所有后续场景
  const pending = opts.bible.foreshadows.filter((f) => !f.resolvedSceneId).slice(0, 5)
  const requiresRecovery = pending.some((p) => opts.scene.facts.some((f) => p.text.slice(0, 12) && f.includes(p.text.slice(0, 12))))
  if (requiresRecovery && sceneText.length > 100) {
    issues.push({ type: 'foreshadow_unresolved', message: `本场景应推进未回收伏笔：${pending.map((p) => p.text.slice(0, 20)).join('；')}` })
  }
  for (const name of opts.scene.chars) {
    const c = opts.bible.characters[name]
    if (c && c.status && c.status !== '出场' && c.status !== '参考') {
      const st = c.status.slice(0, 10)
      if (sceneText.includes(name) && !sceneText.slice(0, 2000).includes(st)) {
        // 人物状态词未出现不算硬错误，仅提示
        issues.push({ type: 'char_state_error', message: `${name} 当前状态「${st}」，请保持一致性` })
      }
    }
  }
  return { ok: issues.length === 0, issues }
}

export function buildScenePrompt(bible: StoryBible, scene: SceneCard, context: string, userPrompt: string): { system: string; user: string } {
  const system = `你是受约束的小说场景生成器。
规则：
1. SCENE 决定本场景事实、人物与情绪，不可改变
2. CONTINUITY 是故事当前状态（人物状态/最近事件/未回收伏笔/世界规则），必须保持一致
3. 目标字数约 ${scene.wordTarget} 字；场景结束时自然收束
4. 只输出本场景正文，不输出分析
优先级：用户禁令 > 故事事实 > 人物一致性 > 场景功能 > 文风 > 字数`
  const user = `## SCENE\n第${scene.sceneNo}章 ${scene.title}\n人物：${scene.chars.join('、') || '无'}\n情绪弧：${scene.emotionArc.join(' → ') || '自然发展'}\n\n## CONTINUITY\n${context}\n\n## 用户要求\n${userPrompt}`
  return { system, user }
}
