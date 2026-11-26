import type { StoryConfig } from './types'

export interface DeepWriteCharacterInput {
  id: string
  name: string
  bible: string
  knownFacts: string[]
  forbiddenKnowledge: string[]
}

export interface DeepWriteExperimentInput {
  enabled: true
  maxConcurrent: number
  subagentTokenRatio: number
  characters: DeepWriteCharacterInput[]
}

/**
 * Renderer → main 的深度写作实验输入边界。
 * 角色卡属于用户本地创作资料：只有在长文深写、故事设定启用且用户逐次明确同意时才发送。
 */
export function buildDeepWriteExperimentInput(input: {
  mode: string
  longMode: boolean
  experimentEnabled: boolean
  characterConsent: boolean
  story: StoryConfig
}): DeepWriteExperimentInput | undefined {
  if (input.mode !== 'longwrite' || !input.longMode || !input.experimentEnabled) return undefined
  const characters = input.characterConsent && input.story.enabled
    ? input.story.characters
        .filter((character) => character.name.trim())
        .slice(0, 8)
        .map((character, index) => ({
          id: `character-${index + 1}`,
          name: character.name.trim().slice(0, 100),
          bible: [
            character.role && `身份：${character.role}`,
            character.traits && `性格：${character.traits}`,
            character.motivation && `动机：${character.motivation}`,
            character.voice && `语言特征：${character.voice}`
          ].filter(Boolean).join('\n').slice(0, 2000) || '保持角色既有设定与语言一致性。',
          knownFacts: [],
          forbiddenKnowledge: []
        }))
    : []
  return { enabled: true, maxConcurrent: 3, subagentTokenRatio: 0.35, characters }
}
