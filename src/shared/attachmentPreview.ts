import type { ImportedFileInfo } from './types'

export type AttachmentFailureCategory = 'unsupported' | 'limit' | 'unavailable' | 'locked' | 'encrypted' | 'corrupt' | 'no_text' | 'read_failed'
export interface AttachmentPreviewFailure {
  ok: false
  error: string
  category: AttachmentFailureCategory
  retryable: boolean
}
export type AttachmentPreviewResult = { ok: true; info: ImportedFileInfo } | AttachmentPreviewFailure

export const ATTACHMENT_PICKER_HINT = '添加 ZIP、DOCX/XLSX/PPTX、PDF/EPUB、文本或代码资料；图片仅作文件引用'

/** Parser diagnostics can contain OS paths. Keep the actual reason, not a user's directories. */
export function attachmentPreviewFailure(raw: string): AttachmentPreviewFailure {
  const detail = raw.replace(/['"]?(?:[A-Za-z]:[\\/]|\\\\|\/(?:Users|home|tmp|var|private)\/)[^\r\n'"；]*['"]?/g, '（文件路径已隐藏）').slice(0, 300).trim()
  let category: AttachmentFailureCategory = 'read_failed'
  let action = '请重试；如果仍失败，请重新选择文件。'
  if (/password|encrypt|加密|密码/iu.test(raw)) { category = 'encrypted'; action = '请解密或另存为未加密的副本，再重新选择。' }
  else if (/EACCES|EPERM|EBUSY|permission denied|sharing violation|占用|锁定|拒绝访问/iu.test(raw)) { category = 'locked'; action = '请关闭占用文件的程序或确认读取权限，再重试。' }
  else if (/超过|过大|过多|压缩比|zip bomb|too (?:large|many)|limit.*exceed/iu.test(raw)) { category = 'limit'; action = '请拆分或缩小文件，再重新选择。' }
  else if (/不支持|unsupported|not supported/iu.test(raw)) { category = 'unsupported'; action = '请将需要的内容导出为可读文档或文本，再重新选择。' }
  else if (/已变化|内容.*变化|已过期|已撤销|附件无效|失效|不存在|ENOENT|ENOTDIR/iu.test(raw)) { category = 'unavailable'; action = '请重新选择文件以更新引用。' }
  else if (/损坏|无效|invalid|central directory|CRC|corrupt|未找到.*目录|不是有效|Office.*(?:缺少|缺失|不唯一|不一致)|Excel.*(?:缺少|不是工作簿)/iu.test(raw)) { category = 'corrupt'; action = '请确认文件可以正常打开，修复或重新导出后再选择。' }
  else if (/未提取|没有.*(?:文字|文本)|no.*text|empty/iu.test(raw)) { category = 'no_text'; action = '请导出带文字的文档或文本后重新选择；扫描件需先转成文字。' }
  return { ok: false, error: `${detail || '附件读取未完成'}${/[。！？]$/u.test(detail) ? '' : '。'}${action}`, category, retryable: category === 'read_failed' || category === 'locked' }
}

export const ATTACHMENT_FAILURE_LABELS: Record<AttachmentFailureCategory, string> = {
  unsupported: '格式不支持', limit: '超过读取限制', unavailable: '引用已失效或变化', locked: '文件被占用或无权限', encrypted: '文件已加密', corrupt: '文件结构损坏', no_text: '未提取到文字', read_failed: '读取未完成'
}
