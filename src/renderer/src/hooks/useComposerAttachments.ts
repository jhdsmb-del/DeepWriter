import { useStore, type PendingAttachment } from '../store'
import { attachmentPreviewFailure, type AttachmentPreviewResult } from '../../../shared/attachmentPreview'
import { attachmentNotice } from '../attachmentSummary'

type FileChoice = { fileRefId: string; displayName: string; size: number }

/** Resolve and preview scoped file references; every async update belongs to its originating session. */
export function useComposerAttachments() {
  const setPendingAttachments = useStore((state) => state.setPendingAttachments)
  const showToast = useStore((state) => state.showToast)
  const previewAttachment = async (ref: FileChoice, sessionId: string): Promise<void> => {
    try {
      const result: AttachmentPreviewResult | undefined = await window.ds?.attachmentPreview?.(ref.fileRefId, sessionId)
      setPendingAttachments((items) => items.map((item) => item.fileRefId !== ref.fileRefId ? item : !result || result.ok === false
        ? { ...item, state: 'failed', failure: result?.ok === false && result.category ? result : attachmentPreviewFailure(result?.ok === false ? result.error : '未收到附件解析结果'), notice: undefined }
        : { ...item, state: 'ready', failure: undefined, name: result.info.name ?? item.name, size: result.info.size ?? item.size, source: result.info.source ?? item.source,
          notice: attachmentNotice(result.info) }), sessionId)
    } catch {
      setPendingAttachments((items) => items.map((item) => item.fileRefId === ref.fileRefId ? { ...item, state: 'failed', failure: attachmentPreviewFailure('附件预览暂未完成'), notice: undefined } : item), sessionId)
    }
  }

  const acceptFiles = async (refs: FileChoice[], sessionId: string): Promise<void> => {
    const state = useStore.getState()
    if (state.currentSessionId !== sessionId && !state.composerDrafts[sessionId]) {
      await Promise.all(refs.map((ref) => (window as any).ds?.attachmentRemove?.(ref.fileRefId, sessionId)?.catch(() => undefined)))
      return
    }
    setPendingAttachments((items) => {
      const existing = new Set(items.map((item) => item.fileRefId))
      return [...items, ...refs.filter((ref) => !existing.has(ref.fileRefId)).map((ref) => ({ name: ref.displayName, fileRefId: ref.fileRefId, size: ref.size, state: 'parsing' as const }))]
    }, sessionId)
    // Register chips before previewing so removal, another selection, or a
    // session switch cannot be overwritten by a captured attachment array.
    for (const ref of refs) await previewAttachment(ref, sessionId)
  }

  const addFiles = async (files: File[]): Promise<void> => {
    const ds = (window as any).ds
    if (!ds?.registerDroppedFiles) {
      showToast('当前环境不支持拖入文件', 'error')
      return
    }
    const sessionId = useStore.getState().ensureSessionId()
    try {
      // The bridge resolves native paths; the renderer receives scoped refs.
      const refs: FileChoice[] = (await ds.registerDroppedFiles(files, sessionId)) ?? []
      if (!refs.length) { showToast('未能取得文件引用，请使用“添加附件”重新选择', 'error'); return }
      await acceptFiles(refs, sessionId)
    } catch {
      showToast('添加文件失败，请重试', 'error')
    }
  }

  const addViaDialog = async (): Promise<void> => {
    const ds = (window as any).ds
    if (!ds?.openFiles) {
      showToast('当前环境不支持选择文件', 'error')
      return
    }
    const sessionId = useStore.getState().ensureSessionId()
    try {
      const refs: FileChoice[] = (await ds.openFiles(sessionId)) ?? []
      await acceptFiles(refs, sessionId)
    } catch {
      showToast('选择文件失败', 'error')
    }
  }

  const retryAtt = (attachment: PendingAttachment): void => {
    const sessionId = useStore.getState().ensureSessionId()
    setPendingAttachments((items) => items.map((item) => item.fileRefId === attachment.fileRefId ? { ...item, state: 'parsing', failure: undefined } : item), sessionId)
    void previewAttachment({ fileRefId: attachment.fileRefId, displayName: attachment.name, size: attachment.size }, sessionId)
  }

  const reselectAtt = async (attachment: PendingAttachment): Promise<void> => {
    const sessionId = useStore.getState().ensureSessionId()
    try {
      const refs = await window.ds.openFiles(sessionId)
      if (!refs.length) return
      await acceptFiles(refs, sessionId)
      setPendingAttachments(items => items.filter(item => item.fileRefId !== attachment.fileRefId), sessionId)
      void window.ds.attachmentRemove(attachment.fileRefId, sessionId).catch(() => undefined)
    } catch { showToast('重新选择未完成，请检查附件列表后重试', 'error') }
  }

  const removeAtt = (attachment: PendingAttachment): void => {
    const sessionId = useStore.getState().ensureSessionId()
    setPendingAttachments((items) => items.filter((item) => item.fileRefId !== attachment.fileRefId), sessionId)
    void (window as any).ds?.attachmentRemove?.(attachment.fileRefId, sessionId)?.catch(() => undefined)
  }

  const openFileMenu = (a: PendingAttachment): void => {
    // R4-1：只提交 FileRef id；主进程解析真实路径并执行动作
    const ds = (window as any).ds
    const sessionId = useStore.getState().ensureSessionId()
    ds?.fileContextMenuOpen?.({ fileRefId: a.fileRefId, anchorKind: 'attachment', sessionId }).catch(() => undefined)
  }

  return { addFiles, addViaDialog, retryAtt, reselectAtt, removeAtt, openFileMenu }
}
