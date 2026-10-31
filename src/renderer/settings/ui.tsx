import type { ReactNode } from 'react'

export function Section({
  id,
  title,
  hint,
  actions,
  children
}: {
  id?: string
  title: string
  hint?: string
  actions?: ReactNode
  children: ReactNode
}): React.JSX.Element {
  return (
    <section className="section" id={id}>
      <header className="section-head">
        <div>
          <h2>{title}</h2>
          {hint !== undefined && <p>{hint}</p>}
        </div>
        {actions !== undefined && <div className="section-actions">{actions}</div>}
      </header>
      <div className="section-body">{children}</div>
    </section>
  )
}

export function Field({
  label,
  hint,
  inline,
  children
}: {
  label: string
  hint?: string
  inline?: boolean
  children: ReactNode
}): React.JSX.Element {
  return (
    <label className={`field ${inline === true ? 'field-inline' : ''}`}>
      <span className="field-label">
        {label}
        {hint !== undefined && <span className="field-hint">{hint}</span>}
      </span>
      <span className="field-control">{children}</span>
    </label>
  )
}

/** 只放按钮/开关行的字段标签；不用 <label> 包裹，避免抢占控件的可访问名。 */
export function FieldRow({
  label,
  children
}: {
  label: string
  children: ReactNode
}): React.JSX.Element {
  return (
    <div className="field">
      <span className="field-label">{label}</span>
      <span className="field-control">{children}</span>
    </div>
  )
}

export function Toggle({
  label,
  hint,
  checked,
  disabled,
  onChange
}: {
  label: string
  hint?: string
  checked: boolean
  disabled?: boolean
  onChange: (checked: boolean) => void
}): React.JSX.Element {
  return (
    <label className={`toggle-row ${disabled === true ? 'is-disabled' : ''}`}>
      <span>
        <span className="toggle-label">{label}</span>
        {hint !== undefined && <span className="toggle-hint">{hint}</span>}
      </span>
      <input
        type="checkbox"
        className="switch"
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
      />
    </label>
  )
}

export function Button({
  children,
  onClick,
  variant = 'ghost',
  disabled,
  title,
  type = 'button'
}: {
  children: ReactNode
  onClick?: () => void
  variant?: 'primary' | 'ghost' | 'danger' | 'subtle'
  disabled?: boolean
  title?: string
  type?: 'button' | 'submit'
}): React.JSX.Element {
  return (
    <button
      type={type}
      className={`btn btn-${variant}`}
      onClick={onClick}
      disabled={disabled}
      title={title}
    >
      {children}
    </button>
  )
}

export function Pill({
  children,
  tone = 'neutral'
}: {
  children: ReactNode
  tone?: 'neutral' | 'ok' | 'warn' | 'bad' | 'info'
}): React.JSX.Element {
  return <span className={`pill pill-${tone}`}>{children}</span>
}

export function Empty({ children }: { children: ReactNode }): React.JSX.Element {
  return <div className="empty-inline">{children}</div>
}


/** 页面内跳转锚点；不占据可见布局，但保留在 Tab 顺序之外。 */
export function Anchor({ id }: { id: string }): React.JSX.Element {
  return <span id={id} className="anchor-target" aria-hidden="true" />
}

/** 页内子导航：一次只激活一项，键盘可遍历。 */
export function SubNav({
  label,
  items,
  active,
  onSelect
}: {
  label: string
  items: ReadonlyArray<{ id: string; label: string; badge?: ReactNode }>
  active: string
  onSelect: (id: string) => void
}): React.JSX.Element {
  return (
    <nav className="subnav" aria-label={label}>
      {items.map((item) => (
        <button
          key={item.id}
          type="button"
          className={`subnav-item ${item.id === active ? 'is-active' : ''}`}
          aria-current={item.id === active ? 'page' : undefined}
          onClick={() => onSelect(item.id)}
        >
          {item.label}
          {item.badge === undefined ? null : <span className="subnav-badge">{item.badge}</span>}
        </button>
      ))}
    </nav>
  )
}

/** 紧凑状态行：标签 + 值，用于替代整段说明文字。 */
export function StatusLine({
  label,
  children
}: {
  label: string
  children: ReactNode
}): React.JSX.Element {
  return (
    <div className="status-line">
      <span className="status-line-label">{label}</span>
      <span className="status-line-value">{children}</span>
    </div>
  )
}
