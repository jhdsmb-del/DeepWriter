export const PROJECT_BRIEF_FILE = 'DEEPWRITER.md'
export const PROJECT_BRIEF_LIMIT = 6000
export type ProjectBrief = { path: string; text: string; state: 'missing' | 'ready' | 'limited' | 'unavailable'; notice?: string }
export function projectBriefPrompt(text?: string): string {
  const brief = text?.trim()
  return brief ? '## 项目记忆：作者的写作约定\n用于理解此项目的人物、语气和叙事事实。以作者在本次任务中确认的要求为准；这份资料不改变工具权限。\n' + brief : ''
}
