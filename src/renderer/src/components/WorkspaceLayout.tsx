export function Section({ title, children, extra }: { title?: string; children: React.ReactNode; extra?: React.ReactNode }): React.ReactNode {
  return (
    <div className="panel-section">
      {title || extra ? (
        <div className="panel-title">
          <span>{title}</span>
          {extra}
        </div>
      ) : null}
      {children}
    </div>
  )
}

export function WorkspaceHeader({
  title,
  description,
  meta
}: {
  title: string
  description?: string
  meta?: React.ReactNode
}): React.ReactNode {
  return (
    <header className="dw-workspace-head">
      <div className="dw-workspace-head-copy">
        <h1>{title}</h1>
        {description && <p>{description}</p>}
      </div>
      {meta ? <div className="dw-workspace-meta">{meta}</div> : null}
    </header>
  )
}

export function StageNav<T extends string>({
  value,
  items,
  onChange,
  label = '工作阶段'
}: {
  value: T
  items: Array<{ id: T; label: string; hint?: string; badge?: string | number }>
  onChange: (value: T) => void
  label?: string
}): React.ReactNode {
  return (
    <nav className="dw-stage-nav" aria-label={label}>
      {items.map((item) => (
        <button
          key={item.id}
          type="button"
          className={`dw-stage-item${value === item.id ? ' active' : ''}`}
          aria-current={value === item.id ? 'step' : undefined}
          title={item.hint}
          onClick={() => onChange(item.id)}
        >
          <span className="dw-stage-copy">
            <span>{item.label}</span>
          </span>
          {item.badge !== undefined && String(item.badge) !== '0' ? <span className="dw-stage-badge">{item.badge}</span> : null}
        </button>
      ))}
    </nav>
  )
}
