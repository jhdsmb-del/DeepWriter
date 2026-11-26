import type { PendingAttachment } from './store'

export interface ComposerDraft {
  text: string
  attachments: PendingAttachment[]
  updatedAt: number
}

export interface ComposerDraftState {
  currentSessionId: string | null
  composerText: string
  pendingAttachments: PendingAttachment[]
  /** Only inactive sessions are stored here; the current draft lives above. */
  composerDrafts: Record<string, ComposerDraft>
}

/** Attachment capabilities stay in memory; draft text also has a durable copy. */
export function changeComposerSession(state: ComposerDraftState, nextId: string | null): Pick<ComposerDraftState, 'composerText' | 'pendingAttachments' | 'composerDrafts'> {
  const drafts = { ...state.composerDrafts }
  if (state.currentSessionId && (state.composerText || state.pendingAttachments.length)) {
    drafts[state.currentSessionId] = { text: state.composerText, attachments: state.pendingAttachments, updatedAt: Date.now() }
  } else if (state.currentSessionId) {
    delete drafts[state.currentSessionId]
  }
  const next = nextId ? drafts[nextId] : undefined
  if (nextId) delete drafts[nextId]
  return { composerText: next?.text ?? '', pendingAttachments: next?.attachments ?? [], composerDrafts: drafts }
}

export function updateComposerAttachments(state: ComposerDraftState, sessionId: string, update: (items: PendingAttachment[]) => PendingAttachment[]): Partial<ComposerDraftState> {
  if (sessionId === state.currentSessionId) return { pendingAttachments: update(state.pendingAttachments) }
  const draft = state.composerDrafts[sessionId]
  // A late preview must not recreate a deleted or already empty session.
  if (!draft) return {}
  return { composerDrafts: { ...state.composerDrafts, [sessionId]: { ...draft, attachments: update(draft.attachments) } } }
}

/** An acknowledgement may clear only the text that was actually submitted. */
export function clearAcceptedComposerText(state: ComposerDraftState, sessionId: string, submittedText: string): Partial<ComposerDraftState> {
  if (sessionId === state.currentSessionId) return state.composerText === submittedText ? { composerText: '' } : {}
  const draft = state.composerDrafts[sessionId]
  if (!draft || draft.text !== submittedText) return {}
  return { composerDrafts: { ...state.composerDrafts, [sessionId]: { ...draft, text: '' } } }
}
