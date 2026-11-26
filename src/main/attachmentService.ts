// ==================== R4.2 A7：内容寻址附件服务（ATTACH-SAME-SIZE-MUTATION / LRU-BYTES / LEASE-CACHE） ====================
// - FileRef 仍负责每次操作复核（scope 必填、size/mtime 指纹、类型/大小 policy）；
// - 模型读取与解析缓存以内容 sha256 为唯一 key：同路径同大小内容变更（含 mtime 被恢复的
//   对抗场景）绝不命中旧缓存；
// - 大文本落盘对象库（文件名=hash，无用户路径），内存按字节预算 LRU；
// - 缓存命中也重新验证 FileRef lease（getText 内部强制）；
// - run terminal / chip 删除显式 releaseLease；
// - 错误与日志不泄露用户绝对路径或正文。

import type { FileRefRegistry, FileScope } from './fileRef'
import { checkModelReadPolicy } from './fileRef'
import type { ContentAssetStore } from './assetStore'
import type { DsMessage } from '../shared/types'

export interface AttachmentInput {
  name: string
  fileRefId: string
  size: number
}

export function createAttachmentService(registry: FileRefRegistry, store: ContentAssetStore) {
  async function read(att: AttachmentInput, sessionId: string, draftId: string): Promise<
    { ok: true; message: DsMessage; hash: string; text: string } | { ok: false; message: DsMessage }
  > {
    // R4-1：附件必须经 resolveForOperation('read-for-model')；scope 必填
    const scope: FileScope = { kind: 'session', sessionId, draftId }
    const ref = await registry.resolveForOperation(att.fileRefId, 'read-for-model', scope)
    if (!ref || ref.kind !== 'file') {
      return { ok: false, message: { role: 'user', content: `[附件] ${att.name}：读取被拒绝（附件无效、已过期、已撤销或内容已变化）` } }
    }
    // R4.1 S-05：模型读取与 preview 共用同一 policy（类型/大小不可绕过）
    const policy = checkModelReadPolicy(ref.realpath, ref.size)
    if (!policy.ok) {
      return { ok: false, message: { role: 'user', content: `[附件] ${att.name}：读取被拒绝（${policy.error}）` } }
    }
    // R4.2 A7：内容寻址导入——sha256(原始字节)；同路径同大小内容变更（含 mtime 恢复）→ hash 变 → 新文本
    let asset: { hash: string; text: string; source: string; size: number }
    try {
      asset = await store.import(ref.realpath, att.fileRefId)
    } catch (e) {
      // 模块保证错误不含路径/正文
      return { ok: false, message: { role: 'user', content: `[附件] ${att.name}：读取失败（${(e as Error).message}）` } }
    }
    // 缓存命中也验证 lease（getText 强制）；文本可能从磁盘对象库读回
    const got = await store.getText(asset.hash, att.fileRefId)
    const text = got ? got.text : asset.text
    return { ok: true, hash: asset.hash, text, message: { role: 'user', content: `[附件] ${att.name}（${asset.size} 字节，${asset.source}）\n${text}` } }
  }
  return {
    read,
    /** 既有普通聊天合同：失败仍返回模型可读的拒绝回执。 */
    async buildMessage(att: AttachmentInput, sessionId: string, draftId: string): Promise<DsMessage> {
      return (await read(att, sessionId, draftId)).message
    },
    /** run terminal / chip 删除时释放 asset lease（内容寻址缓存可被 LRU 逐出） */
    releaseLeases(refIds: string[]): void {
      for (const id of refIds) store.releaseLease(id)
    }
  }
}
