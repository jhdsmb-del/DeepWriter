import { extname } from 'node:path'
import { checkModelReadPolicy, type FileRefRegistry } from './fileRef'
import { readProjectArchiveResult } from './projectArchive'
import type { FileSourceEvidence } from '../shared/fileEvidence'

interface ZipReference { name: string; fileRefId: string; hash?: string }
export function attachmentZipHandle(ref: ZipReference): string | null {
  return extname(ref.name).toLowerCase() === '.zip' && /^[a-f0-9]{32}$/.test(ref.fileRefId)
    ? 'attachment:' + ref.fileRefId : null
}

/** Only a file selected for this run can be addressed. A handle grants no access to its directory. */
export async function readAttachedZipResult(registry: FileRefRegistry, cfg: Record<string, unknown>, args: Record<string, unknown>, signal?: AbortSignal, readBudgetChars?: number): Promise<{ ok: boolean; message: string; sources?: FileSourceEvidence[] }> {
  const list = Array.isArray(cfg.attachments) ? cfg.attachments as ZipReference[] : []
  const att = list.find(item => item && typeof item.name === 'string' && attachmentZipHandle(item) === args.path)
  if (!att || typeof cfg.sessionId !== 'string') throw new Error('此 ZIP 不属于本次任务，请重新添加附件')
  if (!/^[a-f0-9]{64}$/.test(att.hash ?? '')) throw new Error('未能确认这份附件内容，请重新添加 ZIP')
  const ref = await registry.resolveForOperation(att.fileRefId, 'read-for-model', { kind: 'session', sessionId: cfg.sessionId, draftId: 'current' })
  if (!ref || ref.kind !== 'file' || extname(ref.realpath).toLowerCase() !== '.zip') throw new Error('附件已变化或不再可读，请重新选择 ZIP')
  const policy = checkModelReadPolicy(ref.realpath, ref.size)
  if (!policy.ok) throw new Error(policy.error)
  return readProjectArchiveResult(ref.realpath, args, signal, att.hash, attachmentZipHandle(att)!, att.name, readBudgetChars)
}

export async function readAttachedZip(registry: FileRefRegistry, cfg: Record<string, unknown>, args: Record<string, unknown>, signal?: AbortSignal): Promise<string> {
  return (await readAttachedZipResult(registry, cfg, args, signal)).message
}
