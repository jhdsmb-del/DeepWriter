import * as path from 'node:path'

export interface NovelSessionMessage {
  role: 'user' | 'assistant'
  content: string
}

/** Canonical SQLite session rows → novel material input. Tool rows are not prose. */
export function canonicalMessagesForNovel(messages: readonly { role?: unknown; content?: unknown }[]): NovelSessionMessage[] {
  return messages.flatMap((message) => {
    if (message.role !== 'user' && message.role !== 'assistant') return []
    if (typeof message.content !== 'string' || !message.content.trim()) return []
    return [{ role: message.role, content: message.content }]
  })
}

/** Use the first user request as the default session title instead of a list of identical placeholders. */
export function sessionTitleFromFirstMessage(text: string, maxChars = 30): string {
  const clean = text.replace(/\s+/gu, ' ').trim()
  return Array.from(clean).slice(0, maxChars).join('') || '新会话'
}

/** Shared default for document-like exports. The save dialog still owns the final destination. */
export function buildDefaultDocumentPath(baseDir: string, suggestedName: string, extension: string, timestamp: string): string {
  const safeName = suggestedName.replace(/[\\/:*?"<>|]/g, '_').trim().slice(0, 80) || '文档'
  const safeExt = extension.replace(/[^a-z0-9]/gi, '').toLowerCase() || 'md'
  return path.join(baseDir, `${safeName}_${timestamp}.${safeExt}`)
}
