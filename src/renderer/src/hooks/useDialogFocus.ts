import { useEffect, useRef } from 'react'

const FOCUSABLE = 'button:not([disabled]), [href], input:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

/** 统一弹窗键盘约束：初始焦点、Tab 循环、Escape 关闭与关闭后焦点恢复。 */
export function useDialogFocus<T extends HTMLElement>(open: boolean, onClose: () => void, escapeEnabled = true): React.RefObject<T | null> {
  const ref = useRef<T>(null)

  useEffect(() => {
    if (!open) return
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const frame = requestAnimationFrame(() => {
      const root = ref.current
      // Fast panels can already receive a click/Tab before this frame. Do
      // not steal focus back from the control the user just started using.
      if (root && !root.contains(document.activeElement)) root.focus()
    })
    const onKeyDown = (event: KeyboardEvent): void => {
      const root = ref.current
      if (!root) return
      if (event.key === 'Escape' && escapeEnabled) {
        if (document.querySelector('.dw-select.open, .mode-popover, .command-menu')) return
        event.preventDefault()
        onClose()
        return
      }
      if (event.key !== 'Tab') return
      const items = [...root.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((item) => item.offsetParent !== null)
      if (items.length === 0) {
        event.preventDefault()
        root.focus()
        return
      }
      const first = items[0]
      const last = items[items.length - 1]
      if (event.shiftKey && (document.activeElement === first || document.activeElement === root)) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first.focus()
      }
    }
    document.addEventListener('keydown', onKeyDown, true)
    return () => {
      cancelAnimationFrame(frame)
      document.removeEventListener('keydown', onKeyDown, true)
      previous?.focus()
    }
  }, [escapeEnabled, onClose, open])

  return ref
}
