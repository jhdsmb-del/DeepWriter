/** Draft text stays local, separate from canonical messages and runs. */
export interface PersistedComposerDraft {
  sessionId: string
  text: string
  revision: number
  updatedAt: number
}

export interface ComposerDraftWrite {
  sessionId: string
  text: string
  expectedRevision: number
}

export type ComposerDraftWriteResult =
  | { ok: true; draft: PersistedComposerDraft }
  | { ok: false; reason: 'conflict'; draft: PersistedComposerDraft }

export const COMPOSER_DRAFT_MAX_CHARS = 200_000
export const COMPOSER_DRAFT_MAX_COUNT = 200
export const COMPOSER_DRAFT_MAX_BYTES = 20 * 1024 * 1024
