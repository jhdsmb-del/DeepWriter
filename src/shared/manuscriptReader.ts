/** The reader displays accepted ledger text, not unreviewed drafts or a new delivery. */
export const MANUSCRIPT_READER_PAGE_CHARS = 6000

export type ManuscriptReaderInput = {
  runId?: string
  sessionId?: string
  chapterId?: string
  page?: number
}

export interface ManuscriptReaderChapter {
  id: string
  title: string
  acceptedChars: number
  pages: number
}

export interface ManuscriptReaderView {
  runId: string
  sessionId: string
  runStatus: string
  title: string
  acceptedChars: number
  unacceptedSegments: number
  chapters: ManuscriptReaderChapter[]
  page: {
    chapterId: string
    number: number
    content: string
    sourceSegmentIds: string[]
  } | null
}
