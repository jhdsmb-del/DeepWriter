import type { ModelFinishReason } from './jobs/types'
import type { ContextManifest } from './contextAssembler'
import { estimateTokens, type DsMessage, type DsTool } from '../shared/types'
import { codePointLength } from '../shared/textMetrics'

export interface WriterApiShape {
  outputTokenLimit?: number | null
  modelMaxOutputTokens?: number | null
  protocol?: string
  maxTokens: number
  thinking: { enabled: boolean; effort: 'default' | 'low' | 'medium' | 'high' | 'max' }
}

/** New ordinary Agents delegate wire defaults without expanding their local
 * input reserve to a model's maximum output. Required protocol parameters and
 * accounting bounds use the final input envelope's remaining context space. */
export function deriveAgentOutputPlan(config: Record<string, unknown>, api: WriterApiShape, messages: DsMessage[], tools: DsTool[] | undefined, manifest: ContextManifest | null) {
  if (config.runMode !== 'agent' || config.longMode === true || api.outputTokenLimit === undefined) return null
  const policy = config.contextPolicy as { contextWindowTokens?: number; source?: string } | undefined
  const window = manifest?.contextWindowTokens ?? policy?.contextWindowTokens
  const input = manifest?.totalTokens ?? estimateTokens(JSON.stringify({ model: config.model, messages, tools })) + 256
  const available = typeof window === 'number' && Number.isFinite(window) ? Math.max(0, Math.floor(window - input)) : null
  if (available !== null && available < 1) throw new Error('上下文没有剩余输出空间，未发送请求')
  const declared = typeof api.modelMaxOutputTokens === 'number' && api.modelMaxOutputTokens > 0 ? api.modelMaxOutputTokens : null
  const required = api.protocol === 'anthropic-messages'
  const requested = api.outputTokenLimit
  const bound = Math.min(requested ?? declared ?? available ?? api.maxTokens, declared ?? Number.MAX_SAFE_INTEGER, available ?? Number.MAX_SAFE_INTEGER)
  const wireMaxTokens = requested !== null || required ? Math.floor(Math.min(requested ?? declared ?? api.maxTokens, bound)) : undefined
  const knownContext = ['model_declaration', 'settings_override', 'trusted_builtin'].includes(policy?.source ?? '') && available !== null
  const accountingBound = wireMaxTokens ?? (declared !== null || knownContext ? Math.floor(bound) : Number.NaN)
  return { wireMaxTokens, outputTokenUpperBound: accountingBound, omitOutputTokenLimit: wireMaxTokens === undefined,
    outputLimitSource: requested !== null ? 'user_explicit' : required ? declared !== null ? 'model_declaration' : 'protocol_required_fallback' : 'provider_default' }
}

export interface WriterRequestPlan {
  maxTokens: number
  thinking: WriterApiShape['thinking']
  remainingChars: number
  contextAvailableTokens: number | null
}

const FINISH_MAP: Record<string, ModelFinishReason> = {
  stop: 'stop',
  tool_calls: 'tool_calls',
  length: 'length',
  content_filter: 'error',
  error: 'error'
}

/** Provider 的 transport 结束标志不是完成证明；未知值必须 fail-closed。 */
export function mapProviderFinishReason(reason: string | null | undefined): { finishReason: ModelFinishReason; errorCode?: string; errorMessage?: string } {
  const mapped = typeof reason === 'string' ? FINISH_MAP[reason] : undefined
  if (mapped) {
    return mapped === 'error'
      ? { finishReason: 'error', errorCode: reason === 'content_filter' ? 'content_filter' : 'model_error', errorMessage: reason === 'content_filter' ? 'provider 因内容过滤结束，正文未被证明完成' : 'provider 返回错误结束原因' }
      : { finishReason: mapped }
  }
  return { finishReason: 'error', errorCode: 'incomplete_stream', errorMessage: 'provider 未返回可识别的 finish_reason，拒绝把流当作 stop 完成' }
}

/**
 * 长文 writer 的请求上限不能把用户配置的 8192 误当成“可见正文 8192 字”。
 * Profile maxTokens 是用户/provider 的硬上限，模型声明和上下文余量只能进一步收窄；
 * writer 默认关闭思考旁路，把有限输出预算优先留给可见正文。critic/editor 不受此策略影响。
 */
export function deriveWriterRequestPlan(
  config: Record<string, unknown>,
  api: WriterApiShape,
  messages: DsMessage[],
  manifest: ContextManifest | null,
  purpose: 'writer' | 'critic' | 'editor'
): WriterRequestPlan {
  const longwrite = purpose === 'writer' && config.runMode === 'longwrite' && config.longMode === true
  const requested = longwrite && typeof api.outputTokenLimit === 'number' ? api.outputTokenLimit : api.maxTokens
  const baseMax = Number.isFinite(requested) && requested > 0 ? Math.floor(requested) : 8192
  // `messages` is the current run's live history. Do not count context-selected
  // session history here: it may belong to an earlier task and is not progress
  // toward this run's exact target.
  const target = typeof config.targetChars === 'number' && Number.isFinite(config.targetChars) ? Math.max(0, config.targetChars) : 0
  const assistantChars = messages.filter((message) => message.role === 'assistant').reduce((sum, message) => sum + codePointLength(message.content ?? ''), 0)
  const remainingChars = Math.max(0, target - assistantChars)
  if (!longwrite) return { maxTokens: baseMax, thinking: api.thinking, remainingChars, contextAvailableTokens: null }

  const snapshots = config.providerProfileSnapshots as { draft?: { model?: { maxOutputTokens?: number | null } } } | undefined
  const declaredModelCap = Number(snapshots?.draft?.model?.maxOutputTokens)
  const modelCap = Number.isFinite(declaredModelCap) && declaredModelCap >= 256 ? Math.floor(declaredModelCap) : baseMax
  // Never widen a user's/profile's requested cap merely because the model can do more.
  let maxTokens = Math.min(baseMax, modelCap)
  let contextAvailableTokens: number | null = null
  if (manifest && Number.isFinite(manifest.contextWindowTokens) && Number.isFinite(manifest.totalTokens)) {
    contextAvailableTokens = Math.max(0, Math.floor(manifest.contextWindowTokens - manifest.totalTokens - 256))
    if (contextAvailableTokens < 256) throw new Error('上下文硬预算不足：剩余输出空间低于安全最小值，未发送')
    maxTokens = Math.min(maxTokens, contextAvailableTokens)
  }
  if (maxTokens < 256) throw new Error('provider 输出能力低于安全最小值，未发送')
  return { maxTokens: Math.floor(maxTokens), thinking: { ...api.thinking, enabled: false }, remainingChars, contextAvailableTokens }
}
