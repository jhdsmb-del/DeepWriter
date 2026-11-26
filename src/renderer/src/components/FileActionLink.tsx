import type { ReactNode } from 'react'
import type { ChatFileAnchor } from '../../../shared/chatFiles'
import { useStore } from '../store'

/** The same native menu is reachable by right click, Menu key and Shift+F10. */
export default function FileActionLink({ anchor, children, className = '', title, canOpen = true }: { anchor: ChatFileAnchor; children: ReactNode; className?: string; title?: string; canOpen?: boolean }): ReactNode {
  const showToast = useStore(s => s.showToast)
  const act = async (menu: boolean): Promise<void> => {
    try {
      const result = menu ? await window.ds.chatFileMenu(anchor) : await window.ds.chatFileAction(anchor, 'open')
      if (!result.ok) showToast(result.message || '文件操作失败', 'error')
    } catch { showToast('文件操作失败，请重试', 'error') }
  }
  return <button type="button" className={`file-action-link ${className}`} title={title} aria-haspopup="menu"
    onClick={() => void act(!canOpen)} onContextMenu={event => { event.preventDefault(); event.stopPropagation(); void act(true) }}
    onKeyDown={event => {
      if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) {
        event.preventDefault(); event.stopPropagation(); void act(true)
      }
    }}>{children}</button>
}
