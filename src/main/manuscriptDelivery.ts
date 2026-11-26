import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import * as path from 'node:path'
import { publishUtf8Exclusive } from './exclusiveFile'

export interface ManuscriptDelivery {
  runId: string
  content: string
  contentHash: string
  config: Record<string, unknown>
}
type Host = 'desktop' | 'terminal'

/** Preserve the filename convention of existing runs on each host. */
function manuscriptName(input: ManuscriptDelivery, host: Host, sessionTitle: string): string {
  const grill = input.config.grillMe as { approvedOutline?: { title?: unknown } } | undefined
  const title = grill?.approvedOutline?.title
  const fallback = host === 'desktop' && sessionTitle !== '新会话' ? sessionTitle : ''
  const raw = typeof title === 'string' && title.trim() ? title : fallback
  const illegal = /[<>:"/\\|?*\u0000-\u001f]/g
  let stem = host === 'desktop'
    ? Array.from(raw.normalize('NFKC').replace(illegal, ' ').replace(/\s+/g, ' ').trim().replace(/[. ]+$/g, '')).slice(0, 72).join('')
    : raw.replace(illegal, '-').trim().replace(/[. ]+$/g, '').slice(0, 70).replace(/[\uD800-\uDBFF]$/, '')
  stem ||= '长文稿件'
  // A Windows device name stays reserved even before an extension (e.g. CON.notes).
  if (/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])\./i.test(stem)
    || (host === 'desktop' && /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(stem))) stem = 'DeepWriter-' + stem
  const suffix = host === 'desktop' ? input.runId.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 8)
    : createHash('sha256').update(input.runId).digest('hex').slice(0, 12)
  return `${stem}-${suffix}.md`
}

const digest = (content: string | Buffer): string => createHash('sha256').update(content).digest('hex')
function code(error: unknown): string | undefined { return (error as NodeJS.ErrnoException)?.code }
const destinationConflict = (message: string): Error => Object.assign(new Error(message), { code: 'manuscript_destination_conflict' })
/** Only destination/I/O problems can be retried by a user without changing
 * the manuscript contract. Missing publishers and identity mismatches cannot. */
export function recoverableManuscriptDeliveryError(error: unknown): boolean {
  return ['manuscript_destination_conflict', 'EACCES', 'EPERM', 'ENOSPC', 'EBUSY', 'ENOENT', 'EEXIST', 'ENOTDIR', 'EIO'].includes(code(error) ?? '')
}

/** Publish complete bytes once. A retry can reuse an identical manuscript but
 * never replaces an existing file. The engine persists the returned absolute path. */
export async function deliverManuscript(input: ManuscriptDelivery, host: Host, sessionTitle = ''): Promise<{ displayName: string; relativePath: string }> {
  const docDir = input.config.docDir
  if (typeof docDir !== 'string' || !path.isAbsolute(docDir)) throw new Error('文档目录必须是绝对路径')
  if (digest(input.content) !== input.contentHash) throw new Error('稿件内容与交付哈希不一致')
  const displayName = manuscriptName(input, host, sessionTitle)
  await fs.mkdir(docDir, { recursive: true })
  const target = path.join(await fs.realpath(docDir), displayName)
  const verify = async (): Promise<void> => {
    const file = await fs.lstat(target)
    if (!file.isFile()) throw destinationConflict('同名稿件不是普通文件，拒绝覆盖或读取')
    if (file.size !== Buffer.byteLength(input.content)) throw destinationConflict('同名稿件已存在且内容不同，拒绝覆盖')
    const handle = await fs.open(target, 'r')
    try {
      const opened = await handle.stat()
      if (!opened.isFile() || opened.dev !== file.dev || opened.ino !== file.ino || digest(await handle.readFile()) !== input.contentHash) {
        throw destinationConflict('同名稿件已存在且内容不同，拒绝覆盖')
      }
    } finally { await handle.close() }
  }
  try { await verify(); return { displayName, relativePath: target } }
  catch (error) { if (code(error) !== 'ENOENT') throw error }
  try { await publishUtf8Exclusive(target, input.content) }
  catch (error) { if (code(error) !== 'EEXIST') throw error }
  await verify()
  return { displayName, relativePath: target }
}
