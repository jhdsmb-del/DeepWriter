import { useEffect, useRef } from 'react'
import Icon from './Icon'

export default function ConfirmDialog(props: {
  title: string
  description: string
  confirmLabel: string
  onConfirm: () => void
  onCancel: () => void
  destructive?: boolean
  secondaryLabel?: string
  onSecondary?: () => void
}): React.ReactNode {
  const cancelRef = useRef<HTMLButtonElement>(null)
  const { onCancel } = props

  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null
    cancelRef.current?.focus()
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onCancel()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      previous?.focus()
    }
  }, [onCancel])

  return (
    <div className="modal-overlay dw-dialog-overlay dw-confirm-overlay" onClick={(event) => event.stopPropagation()} onMouseDown={(event) => { event.stopPropagation(); if (event.target === event.currentTarget) props.onCancel() }}>
      <div className="dw-dialog dw-confirm-dialog" role="alertdialog" aria-modal="true" aria-labelledby="dw-confirm-title" aria-describedby="dw-confirm-description">
        <div className="modal-head">
          <h3 id="dw-confirm-title">{props.title}</h3>
          <button className="dw-settings-close" aria-label="取消" title="取消" onClick={props.onCancel}><Icon name="close" /></button>
        </div>
        <p id="dw-confirm-description">{props.description}</p>
        <div className="dw-dialog-actions">
          <button ref={cancelRef} className="ghost-btn" onClick={props.onCancel}>取消</button>
          {props.secondaryLabel && props.onSecondary ? <button className="btn danger" onClick={props.onSecondary}>{props.secondaryLabel}</button> : null}
          <button className={`btn${props.destructive ? ' danger' : ' primary'}`} onClick={props.onConfirm}>{props.confirmLabel}</button>
        </div>
      </div>
    </div>
  )
}
