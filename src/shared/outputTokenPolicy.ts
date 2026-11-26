/** Local input planning is separate from a provider's output parameter. */
export function storedOutputTokenLimit(raw: Record<string, unknown>, factoryDefault = 8192): number | null {
  if (Object.hasOwn(raw, 'outputTokenLimit')) return raw.outputTokenLimit === null ? null : validOutputTokens(raw.outputTokenLimit)
  return typeof raw.maxTokens === 'number' && raw.maxTokens !== factoryDefault ? validOutputTokens(raw.maxTokens) : null
}
export function validOutputTokens(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1 || value > 1_000_000) throw new Error('单次输出上限必须为 1–1000000 的整数，或使用模型默认')
  return value
}
