import type { DsMessage } from './types'

/** Upper bound for the persisted current-Agent instruction. */
export const USER_PRESET_PROMPT_MAX_CHARS = 20000
export const USER_PRESET_PROMPT_HEADER = '## 当前 Agent 用户预设提示词'
export interface UserPresetSystemMessage {
  role: 'system'
  content: string
}

/**
 * Normalize the user-owned instruction at every trust boundary.  Keeping the
 * value bounded and trimming only the edges makes the frozen prompt stable
 * without changing intentional line breaks inside it.
 */
export function normalizeUserPresetPrompt(value: unknown): string {
  if (typeof value !== 'string') return ''
  return Array.from(value.trim()).slice(0, USER_PRESET_PROMPT_MAX_CHARS).join('')
}

export function buildUserPresetSystemMessage(value: unknown): UserPresetSystemMessage | null {
  const prompt = normalizeUserPresetPrompt(value)
  return prompt ? { role: 'system', content: `${USER_PRESET_PROMPT_HEADER}\n${prompt}` } : null
}

/** Add the preset exactly once when an auxiliary stage does not use the writer prefix. */
export function injectUserPresetSystemMessage(messages: DsMessage[], value: unknown): DsMessage[] {
  const message = buildUserPresetSystemMessage(value)
  if (!message) return messages
  if (messages.some((item) => item.role === 'system' && item.content === message.content)) return messages
  return [message, ...messages]
}
