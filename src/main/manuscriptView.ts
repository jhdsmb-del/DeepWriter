import { createHash } from 'node:crypto'
import type { Repository } from './db/repository'
import { editorialManuscriptMarkdown } from './writingContext'
import { codePointLength } from '../shared/textMetrics'

export interface ManuscriptView {
  kind: 'draft' | 'manuscript'
  content: string
  acceptedChars: number
  runStatus: string
}

/** Read the accepted ledger, never assistant candidates or a model's claim
 * of completion. The final view must match the registered delivered bytes;
 * a draft is an explicit read-only view and creates no completion artifact. */
export function readRunManuscript(repository: Pick<Repository, 'getRun' | 'getManuscriptSegmentsByRun' | 'getArtifactsByRun'>, runId: string, kind: ManuscriptView['kind'], readArtifact?: (hash: string) => string | null): ManuscriptView {
  const run = repository.getRun(runId)
  if (!run) throw new Error('运行不存在')
  const config = JSON.parse(run.config_json) as Record<string, unknown>
  if (config.runMode !== 'longwrite' || config.longMode !== true) throw new Error('仅长文运行支持已收稿视图')
  if (kind === 'manuscript' && run.status !== 'completed') throw new Error('运行尚未完成；可用 export RUN --draft 取回已收稿部分，不含未接纳草稿')
  const accepted = repository.getManuscriptSegmentsByRun(runId).filter(segment => segment.status === 'accepted' && segment.kind === 'prose')
  if (!accepted.length) throw new Error('尚无已接纳正文；未提交草稿仍保留在运行记录中，不能冒充已收稿导出')
  const segments = accepted.map(segment => ({ content: segment.content, sectionId: segment.section_id ?? undefined }))
  const raw = segments.map(segment => segment.content).join('')
  let content = editorialManuscriptMarkdown(config, segments)
  if (kind === 'manuscript') {
    const artifact = repository.getArtifactsByRun(runId).find(item => item.artifact_type === 'manuscript' && item.status === 'completed')
    if (artifact) {
      if (typeof artifact.hash !== 'string' || !/^[0-9a-f]{64}$/u.test(artifact.hash)) throw new Error('稿件交付身份无效，未导出')
      const matches = (text: string): boolean => codePointLength(text) === artifact.char_count && createHash('sha256').update(text).digest('hex') === artifact.hash
      const saved = readArtifact?.(artifact.hash)
      if (saved != null) {
        if (!matches(saved)) throw new Error('已交付稿件对象损坏，未导出；已收稿正文仍可用 --draft 取回')
        content = saved
      } else if (!matches(content)) {
        // Older delivered editorial runs used a raw join. Preserve their
        // actual artifact identity rather than silently reformatting them.
        if (matches(raw)) content = raw
        else throw new Error('已收稿正文与交付身份不一致，未导出')
      }
    } else if ((config.deliveryContract as { manuscriptFile?: unknown } | undefined)?.manuscriptFile === true) throw new Error('未找到已完成的稿件交付记录；可用 --draft 取回已收稿正文')
  }
  return { kind, content, acceptedChars: codePointLength(raw), runStatus: run.status }
}
