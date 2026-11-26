export interface ManuscriptDraftInfo { acceptedChars: number }
export type ManuscriptDraftSaveResult =
  | { ok: true; cancelled: true }
  | { ok: true; cancelled: false; path: string; acceptedChars: number; bytes: number }
