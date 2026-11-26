export const CONVERSATION_SEARCH_TOOL = 'search_conversation'

export interface ConversationSearchHit {
  messageId: string
  seq: number
  role: 'user' | 'assistant'
  sourceHash: string
  span: { start: number; end: number }
  quote: string
}
export interface ConversationSearchPage {
  query: string
  historyHighWatermark: number
  totalHits: number
  offset: number
  nextOffset: number | null
  budgetLimited: boolean
  hits: ConversationSearchHit[]
}
