/** A user action addresses the durable edit, never an arbitrary path or backup. */
export interface UndoFileEditInput {
  sessionId: string
  runId: string
  toolCallId: string
}

export interface FileEditUndoRef extends UndoFileEditInput {
  status: 'available' | 'undone' | 'blocked'
}

export interface UndoFileEditResult {
  ok: boolean
  status: 'undone' | 'already_undone' | 'blocked'
  code: string
  message: string
  path?: string
}

/** Backend-only durable identity, not a renderer-supplied restore authority. */
export interface FileEditUndoMetadata extends UndoFileEditInput {
  schemaVersion: 1
  backupId: string
  checkpointRoot: string
  requestedPath: string
  targetPath: string
  authorizedRoot: 'workDir' | 'docDir'
  roots: { workDir: string; docDir: string; realWorkDir: string | null; realDocDir: string | null }
  before: { sha256: string; bytes: number }
  after: { sha256: string; bytes: number }
}
