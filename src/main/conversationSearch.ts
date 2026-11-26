import type { ToolDef } from './tools'
import { CONVERSATION_SEARCH_TOOL, type ConversationSearchPage } from '../shared/conversationSearch'
import type { ContextV2Service } from './contextV2'
import type { FrozenContextSnapshotV2 } from '../shared/contextV2'

/** Scope is host-owned frozen execution state, never a model-supplied argument. */
export function searchRunConversation(service: ContextV2Service | null | undefined, config: Record<string, unknown>, args: Record<string, unknown>, readBudgetChars?: number): ConversationSearchPage {
  const frozen = config.frozenContext as FrozenContextSnapshotV2 | undefined
  if (!service || config.runMode !== 'agent' || config.longMode === true || typeof config.sessionId !== 'string' || !frozen || frozen.schemaVersion !== 2 || !Number.isSafeInteger(frozen.historyHighWatermark) || frozen.historyHighWatermark! < 0) {
    throw new Error('conversation_scope_unavailable：本次运行没有冻结的同会话历史范围，未检索')
  }
  return service.searchConversation(config.sessionId, frozen.historyHighWatermark!, args, readBudgetChars)
}

export const conversationSearchTool: ToolDef = {
  name: CONVERSATION_SEARCH_TOOL,
  description: '按需查回本次运行开始前、同一会话的用户/助手原话。当前上下文缺少早期细节时使用，不要凭空补全或在简单对话中例行调用。返回来源 messageId、seq、role 和逐字摘录；冲突以较新用户原话及当前输入为准。literal 是精确关键词查询，related 使用本地 BM25；可用 offset 分页，不搜索其他会话或未来消息。',
  parameters: { type: 'object', additionalProperties: false, properties: {
    query: { type: 'string', minLength: 1, maxLength: 1000, description: '记得的关键词或原话；literal 不接受正则' },
    match: { type: 'string', enum: ['literal', 'related'], default: 'literal' },
    role: { type: 'string', enum: ['user', 'assistant'] },
    offset: { type: 'integer', minimum: 0, description: '上一页 nextOffset' },
    limit: { type: 'integer', minimum: 1, maximum: 20, default: 8 },
    maxChars: { type: 'integer', minimum: 256, maximum: 12000, default: 5000 }
  }, required: ['query'] },
  async execute(args, _defaultDir, env) {
    if (!env?.searchConversation) return { ok: false, message: 'conversation_scope_unavailable：没有本次运行的冻结会话检索能力' }
    const conversation = env.searchConversation(args, env.readBudgetChars)
    const message = conversation.budgetLimited && !conversation.hits.length ? '有匹配，但当前模型输入余量不足以展示原文；请缩小查询，不能据此认定没有记录。'
      : !conversation.totalHits ? '本次运行冻结的同会话历史中没有匹配原话。'
      : `已展示 ${conversation.hits.length} 条历史原话；共 ${conversation.totalHits} 条匹配。${conversation.nextOffset === null ? '' : '可用 nextOffset 继续查询。'}`
    return { ok: true, message, conversation }
  }
}
