import { useEffect, useId, useRef, useState } from 'react'
import Icon from './Icon'

export interface SelectOption<T extends string> {
  value: T
  label: string
  description?: string
  disabled?: boolean
}

export default function SelectControl<T extends string>({
  value,
  options,
  onChange,
  ariaLabel,
  disabled = false,
  compact = false
}: {
  value: T
  options: readonly SelectOption<T>[]
  onChange: (value: T) => void
  ariaLabel: string
  disabled?: boolean
  compact?: boolean
}): React.ReactNode {
  const [open, setOpen] = useState(false)
  const [activeIndex, setActiveIndex] = useState(() => Math.max(0, options.findIndex((option) => option.value === value)))
  const rootRef = useRef<HTMLDivElement>(null)
  const buttonRef = useRef<HTMLButtonElement>(null)
  const listId = useId()
  const selected = options.find((option) => option.value === value) ?? options.find((option) => !option.disabled) ?? options[0]
  const firstEnabledIndex = options.findIndex((option) => !option.disabled)
  const selectedIndex = options.findIndex((option) => option.value === value && !option.disabled)
  const optionSignature = options.map((option) => `${option.value}:${option.disabled ? 'disabled' : 'enabled'}`).join('\u0001')

  useEffect(() => {
    setActiveIndex(selectedIndex >= 0 ? selectedIndex : Math.max(0, firstEnabledIndex))
  }, [firstEnabledIndex, optionSignature, selectedIndex])

  useEffect(() => {
    if (!open) return
    const closeOutside = (event: PointerEvent): void => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false)
    }
    window.addEventListener('pointerdown', closeOutside)
    return () => window.removeEventListener('pointerdown', closeOutside)
  }, [open])

  const choose = (index: number): void => {
    const option = options[index]
    if (!option || option.disabled) return
    onChange(option.value)
    setOpen(false)
    buttonRef.current?.focus()
  }

  const move = (delta: number): void => {
    if (options.length === 0) return
    setActiveIndex((current) => {
      let next = current
      for (let i = 0; i < options.length; i += 1) {
        next = (next + delta + options.length) % options.length
        if (!options[next]?.disabled) return next
      }
      return current
    })
  }

  return (
    <div className={`dw-select${compact ? ' compact' : ''}${open ? ' open' : ''}`} ref={rootRef}>
      <button
        ref={buttonRef}
        type="button"
        className="dw-select-trigger"
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        disabled={disabled}
        onClick={() => setOpen((current) => !current)}
        onKeyDown={(event) => {
          if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault()
            if (!open) setOpen(true)
            else move(event.key === 'ArrowDown' ? 1 : -1)
          } else if ((event.key === 'Enter' || event.key === ' ') && open) {
            event.preventDefault()
            choose(activeIndex)
          } else if (event.key === 'Escape' && open) {
            event.preventDefault()
            event.stopPropagation()
            setOpen(false)
          }
        }}
      >
        <span className="dw-select-value">{selected?.label ?? value}</span>
        <Icon name="chevronDown" size={14} />
      </button>
      {open && (
        <div id={listId} className="dw-select-menu" role="listbox" aria-label={ariaLabel}>
          {options.map((option, index) => (
            <button
              type="button"
              role="option"
              aria-selected={option.value === value}
              aria-disabled={option.disabled || undefined}
              disabled={option.disabled}
              key={option.value}
              className={`dw-select-option${option.value === value ? ' selected' : ''}${index === activeIndex ? ' focused' : ''}`}
              onMouseEnter={() => setActiveIndex(index)}
              onClick={() => choose(index)}
            >
              <span className="dw-select-check" aria-hidden="true">{option.value === value && <Icon name="check" size={16} />}</span>
              <span className="dw-select-copy">
                <b>{option.label}</b>
                {option.description && <small>{option.description}</small>}
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
