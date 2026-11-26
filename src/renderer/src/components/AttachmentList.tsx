import type { PendingAttachment } from '../store'
import { ATTACHMENT_FAILURE_LABELS } from '../../../shared/attachmentPreview'
import Icon from './Icon'

const sizeLabel = (size: number): string => size < 1024 ? `${size} B` : size < 1024 * 1024 ? `${(size / 1024).toFixed(1)} KB` : `${(size / 1024 / 1024).toFixed(1)} MB`

export default function AttachmentList({ attachments, onRetry, onReselect, onRemove, onContextMenu }: {
  attachments: PendingAttachment[]
  onRetry: (attachment: PendingAttachment) => void
  onReselect: (attachment: PendingAttachment) => void | Promise<void>
  onRemove: (attachment: PendingAttachment) => void
  onContextMenu?: (attachment: PendingAttachment) => void
}): React.ReactNode {
  if (!attachments.length) return null
  return <ul className="attach-chips attachment-list" aria-label="已选附件">{attachments.map(item => <li key={item.fileRefId} className={`attach-chip attachment-item${item.state === 'failed' ? ' failed' : ''}`} onContextMenu={onContextMenu ? event => { event.preventDefault(); onContextMenu(item) } : undefined}>
    <div className="attach-main">
      <span className="attach-name" title={item.name}><Icon name="paperclip" size={14} />{item.name}</span>
      <span className="attach-size">{sizeLabel(item.size)}</span>
      {item.state === 'parsing' && <span className="attach-state" role="status">解析中…</span>}
      {item.state === 'failed' && <>
        <span className="attach-state">{item.failure ? ATTACHMENT_FAILURE_LABELS[item.failure.category] : '读取未完成'}</span>
        {(!item.failure || item.failure.retryable) && <button type="button" className="attach-retry" onClick={() => onRetry(item)} aria-label={`重试附件：${item.name}`}>重试</button>}
        <button type="button" className="attach-reselect" onClick={() => void onReselect(item)} aria-label={`重新选择附件：${item.name}`}>重新选择</button>
      </>}
      <button type="button" className="attach-remove" aria-label={`移除附件 ${item.name}`} title={`移除附件 ${item.name}`} onClick={() => onRemove(item)}><Icon name="close" size={14} /></button>
    </div>
    {item.state === 'failed' && item.failure && <details className="attach-details"><summary>查看原因</summary><p role="status">{item.failure.error}</p></details>}
    {item.state === 'ready' && item.notice && <details className="attach-details"><summary>{item.notice.label}</summary><p>{item.notice.detail}</p>{item.notice.excerpt && <div className="attach-excerpt"><b>{item.notice.excerpt.name}</b><p>{item.notice.excerpt.text}</p></div>}</details>}
  </li>)}</ul>
}
