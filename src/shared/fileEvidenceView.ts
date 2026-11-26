import type { FileSourceRange } from './fileEvidence'

/** A display-only projection of a completed tool's stored evidence, never a file capability. */
export interface FileEvidenceEntry {
  runId: string
  toolCallId: string
  sourceIndex: number
  path: string
  displayName: string
  kind: 'read' | 'search' | 'found'
  range: FileSourceRange
  locator: string
  excerpt: string
  truncated: boolean
  archiveEntry?: string
}

export interface FileEvidencePage { entries: FileEvidenceEntry[]; nextOffset: number | null }
