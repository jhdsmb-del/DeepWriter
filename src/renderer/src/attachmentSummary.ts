import type { ImportedFileInfo } from '../../shared/types'

export interface AttachmentNotice { label: string; detail: string; excerpt?: { name: string; text: string } }

/** A small local readback of the parser's actual bounded preview, not another extraction. */
export function attachmentNotice(info: Pick<ImportedFileInfo, 'source' | 'text' | 'truncated'>): AttachmentNotice | undefined {
  if (info.source === 'image') return { label: '图片引用', detail: '模型仅收到图片文件引用，不会识别图中内容。' }
  if (info.source === 'zip') {
    const total = /^ZIP 工程目录：(\d+)条/u.exec(info.text)?.[1]
    const coverage = [...info.text.matchAll(/读取覆盖：尝试(\d+)\/(\d+)个文本候选；失败(\d+)条/gu)].at(-1)
    const successes = coverage ? Math.max(0, Number(coverage[1]) - Number(coverage[3])) : null
    const entries = [...info.text.matchAll(/^--- ZIP条目 ("(?:[^"\\]|\\.)*")[^\n]*\n([\s\S]*?)(?=\n--- ZIP条目 |\n读取覆盖：|$)/gmu)]
    const chosen = entries.find(entry => /readme/i.test(entry[1])) ?? entries[0]
    let excerpt: AttachmentNotice['excerpt']
    if (chosen) {
      try { excerpt = { name: JSON.parse(chosen[1]), text: Array.from(chosen[2].trim()).slice(0, 240).join('') } } catch { /* A malformed preview name is not rendered as a source label. */ }
    }
    return {
      label: total && successes !== null ? `${total} 个条目 · 已摘录 ${successes} 个文本` : '工程包内容概览',
      detail: coverage ? `文本候选 ${coverage[2]} 个；本次成功摘录 ${successes} 个${info.truncated ? '，未展示部分尚未读取' : '，其他类型未读取'}。` : info.text.split('\n')[0].slice(0, 180),
      ...(excerpt ? { excerpt } : {})
    }
  }
  return info.truncated ? { label: '文本已截取', detail: '材料文字超出本次读取范围，正文只会带入已提取的部分。' } : undefined
}
