import type { AttachmentRef, DsMessage } from '../shared/types'
import type { GrillMeAttachment, GrillMeAttachmentStatus, GrillMeState } from '../shared/grillMe'
import type { FileRefRegistry } from './fileRef'
import type { createAttachmentService } from './attachmentService'

type AttachmentService = ReturnType<typeof createAttachmentService>
const scope = (sessionId: string) => ({ kind: 'session' as const, sessionId, draftId: 'current' })
export class GrillAttachmentError extends Error {
  readonly code = 'grill_material_unavailable'
}
const unavailable = (name: string) => new GrillAttachmentError(`素材「${name}」已失效、内容变化或需要重新授权。请在本次梳理的“已选素材”中重新选择原文件。`)

/** FileRef leases remain the authority. A saved excerpt/hash never reopens a path. */
export async function captureGrillAttachments(registry: FileRefRegistry, service: AttachmentService, sessionId: string, selected: AttachmentRef[]): Promise<GrillMeAttachment[]> {
  const result: GrillMeAttachment[] = []
  const excerptBudget = Math.min(4000, Math.floor(16000 / Math.max(1, selected.length)))
  for (const input of selected) {
    if (result.some(item => item.fileRefId === input.fileRefId)) continue
    const view = registry.inspect(input.fileRefId, scope(sessionId))
    if (!view || view.kind !== 'file') throw unavailable(input.name)
    const ref = { fileRefId: view.fileRefId, name: view.displayName, size: view.size }
    const read = await service.read(ref, sessionId, 'current')
    if (!read.ok) throw new GrillAttachmentError(`素材「${ref.name}」读取或解析失败。请移除并重新选择可用的原文件后重试；当前梳理不会采用其他素材。`)
    const excerpt = read.text.slice(0, excerptBudget)
    result.push({ ...ref, contentHash: read.hash, excerpt })
  }
  return result
}

export async function readFrozenGrillAttachment(service: AttachmentService, sessionId: string, item: AttachmentRef & { hash?: string }): Promise<DsMessage> {
  const read = await service.read(item, sessionId, 'current')
  if (!read.ok || !item.hash || read.hash !== item.hash) throw unavailable(item.name)
  return read.message
}

export async function grillAttachmentStatuses(registry: FileRefRegistry, state: GrillMeState): Promise<GrillMeAttachmentStatus[]> {
  return Promise.all((state.attachments ?? []).map(async item => ({
    fileRefId: item.fileRefId, name: item.name,
    available: Boolean(await registry.resolveForOperation(item.fileRefId, 'read-for-model', scope(state.sessionId)))
  })))
}

/** A fresh explicit selection can renew the same bytes, never substitute another draft's file. */
export async function rebindGrillAttachment(registry: FileRefRegistry, service: AttachmentService, state: GrillMeState, oldRefId: string, selected: AttachmentRef): Promise<GrillMeState> {
  const original = state.attachments?.find(item => item.fileRefId === oldRefId)
  if (!original) throw new GrillAttachmentError('本次梳理没有这份素材，请重新打开素材列表')
  const [fresh] = await captureGrillAttachments(registry, service, state.sessionId, [selected])
  if (!fresh || fresh.contentHash !== original.contentHash) throw new GrillAttachmentError(`所选文件不是素材「${original.name}」的原内容。请选择原文件；若要采用新素材，请新建会话，当前大纲未改变。`)
  return { ...state, attachments: state.attachments!.map(item => item.fileRefId === oldRefId ? { ...item, fileRefId: fresh.fileRefId } : item), updatedAt: Date.now() }
}
