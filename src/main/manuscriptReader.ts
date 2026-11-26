import type { Repository, ManuscriptReaderSegment } from './db/repository'
import { MANUSCRIPT_READER_PAGE_CHARS, type ManuscriptReaderInput, type ManuscriptReaderView } from '../shared/manuscriptReader'

type ReaderRepository = Pick<Repository, 'getRun' | 'listRunsBySession' | 'getManuscriptReaderSegments' | 'getManuscriptReaderSlices'>

function chapterKey(segment: ManuscriptReaderSegment): string {
  return segment.section_id ? `section:${segment.section_id}` : segment.scene_id ? `scene:${segment.scene_id}` : 'body'
}

/** Only metadata crosses the initial IPC. Body reads are bounded Unicode slices
 * from accepted rows; neither the full manuscript nor candidates enter the UI. */
export function readManuscriptReader(repository: ReaderRepository, input: ManuscriptReaderInput): ManuscriptReaderView | null {
  const run = input.runId ? repository.getRun(input.runId) : repository.listRunsBySession(input.sessionId!).find(row => {
    const config = JSON.parse(row.config_json || '{}')
    return config.runMode === 'longwrite' && config.longMode === true
  })
  if (!run) return null
  const config = JSON.parse(run.config_json || '{}')
  if (config.runMode !== 'longwrite' || config.longMode !== true) return null
  const segments = repository.getManuscriptReaderSegments(run.run_id)
  const accepted = segments.filter(segment => segment.status === 'accepted')
  const groups = new Map<string, ManuscriptReaderSegment[]>()
  for (const segment of accepted) {
    const key = chapterKey(segment)
    const group = groups.get(key) ?? []
    group.push(segment)
    groups.set(key, group)
  }
  const sections = config.grillMe?.approvedOutline?.sections ?? []
  const scenes = config.sceneContracts?.contracts ?? []
  const chapters = [...groups].map(([id, rows], index) => {
    const section = Array.isArray(sections) ? sections.find(item => item?.id === rows[0].section_id) : null
    const scene = Array.isArray(scenes) ? scenes.find(item => item?.sceneId === rows[0].scene_id) : null
    const acceptedChars = rows.reduce((sum, row) => sum + row.char_count, 0)
    const title = section?.title || scene?.title || (id === 'body' ? '正文' : `第 ${index + 1} 节`)
    return { id, title: String(title), acceptedChars, pages: Math.max(1, Math.ceil(acceptedChars / MANUSCRIPT_READER_PAGE_CHARS)) }
  })
  let page: ManuscriptReaderView['page'] = null
  if (input.chapterId !== undefined) {
    const chapter = chapters.find(item => item.id === input.chapterId)
    if (!chapter) throw new Error('这一章尚无已收稿正文，请刷新目录。')
    const number = Math.min(input.page ?? 0, chapter.pages - 1)
    const start = number * MANUSCRIPT_READER_PAGE_CHARS
    const end = start + MANUSCRIPT_READER_PAGE_CHARS
    let cursor = 0
    const slices = (groups.get(chapter.id) ?? []).flatMap(row => {
      const rowStart = cursor
      cursor += row.char_count
      if (cursor <= start || rowStart >= end) return []
      return [{ segmentId: row.segment_id, start: Math.max(0, start - rowStart), length: Math.min(cursor, end) - Math.max(rowStart, start) }]
    })
    const bodies = repository.getManuscriptReaderSlices(run.run_id, slices)
    if (bodies.length !== slices.length) throw new Error('收稿记录已变化，请刷新目录。')
    page = { chapterId: chapter.id, number, content: bodies.map(row => row.content).join(''), sourceSegmentIds: slices.map(slice => slice.segmentId) }
  }
  return {
    runId: run.run_id, sessionId: run.session_id, runStatus: run.status,
    title: typeof config.grillMe?.approvedOutline?.title === 'string' ? config.grillMe.approvedOutline.title : '稿件阅读',
    acceptedChars: chapters.reduce((sum, chapter) => sum + chapter.acceptedChars, 0),
    unacceptedSegments: segments.filter(segment => segment.status === 'partial' || segment.status === 'candidate').length,
    chapters, page
  }
}
