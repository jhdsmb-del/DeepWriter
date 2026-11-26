import * as path from 'node:path'
import type { Repository } from './db/repository'
import { readRunManuscript } from './manuscriptView'
import { publishUtf8Exclusive } from './exclusiveFile'
import type { ManuscriptDraftInfo, ManuscriptDraftSaveResult } from '../shared/manuscriptDraft'

const AVAILABLE_STATES = new Set(['waiting_user', 'recoverable', 'recovery_required', 'failed', 'cancelled'])
export function manuscriptDraftInfo(repository: Repository, runId: string): ManuscriptDraftInfo | null {
  if (!AVAILABLE_STATES.has(repository.getRun(runId)?.status ?? '')) return null
  try { return { acceptedChars: readRunManuscript(repository, runId, 'draft').acceptedChars } } catch { return null }
}

/** chooseFile is main's native dialog; no renderer path crosses this port. */
export async function saveManuscriptDraft(repository: Repository, runId: string, chooseFile: (defaultName: string) => Promise<{ canceled: boolean; filePath?: string }>): Promise<ManuscriptDraftSaveResult> {
  if (!AVAILABLE_STATES.has(repository.getRun(runId)?.status ?? '')) throw new Error('请在任务暂停或结束后另存已收稿部分')
  const view = readRunManuscript(repository, runId, 'draft')
  const selected = await chooseFile(`长文草稿-${runId.replace(/[^a-zA-Z0-9_-]/gu, '_').slice(0, 24)}.md`)
  if (selected.canceled || !selected.filePath) return { ok: true, cancelled: true }
  if (!path.isAbsolute(selected.filePath)) throw new Error('保存对话框未返回有效文件路径')
  try { await publishUtf8Exclusive(selected.filePath, view.content) }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new Error('该文件已存在，未覆盖；请换一个草稿文件名')
    throw new Error('草稿未保存；请检查目录是否可写后重试')
  }
  return { ok: true, cancelled: false, path: selected.filePath, acceptedChars: view.acceptedChars, bytes: Buffer.byteLength(view.content) }
}
