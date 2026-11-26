export default function Switch({
  checked,
  onChange,
  label,
  description,
  disabled = false,
  compact = false
}: {
  checked: boolean
  onChange: (checked: boolean) => void
  label: string
  description?: string
  disabled?: boolean
  /** 用于标题栏和横向控制条；仍保留可见标签与完整可访问名称。 */
  compact?: boolean
}): React.ReactNode {
  return (
    <label className={`dw-switch${compact ? ' compact' : ''}${disabled ? ' disabled' : ''}`}>
      <span className="dw-switch-copy">
        <b>{label}</b>
        {description && <small>{description}</small>}
      </span>
      <input type="checkbox" checked={checked} disabled={disabled} onChange={(event) => onChange(event.target.checked)} />
      <span className="dw-switch-track" aria-hidden="true"><span /></span>
    </label>
  )
}
