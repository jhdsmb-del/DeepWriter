/** Official native stops and compatibility aliases, checked 2026-10-03.
 * https://api-docs.deepseek.com/guides/thinking_mode/ */
export const DEEPSEEK_REASONING_EFFORTS = ['low', 'high', 'max'] as const
export type DeepSeekReasoningEffort = typeof DEEPSEEK_REASONING_EFFORTS[number]
export function normalizeDeepSeekReasoningEffort(value: string | null | undefined): DeepSeekReasoningEffort | 'none' | null {
  if (value == null || value === '' || value === 'default') return 'high'
  if (value === 'none') return 'none'
  if (value === 'minimal' || value === 'low') return 'low'
  if (value === 'medium' || value === 'high' || value === 'xhigh') return 'high'
  if (value === 'max' || value === 'ultra') return 'max'
  return null
}
