import { Icon } from "./icons";

const statusStyles = {
  online: "bg-[rgba(36,107,77,0.12)] text-[var(--ptg-success)]",
  success: "bg-[rgba(36,107,77,0.12)] text-[var(--ptg-success)]",
  active: "bg-[rgba(36,107,77,0.12)] text-[var(--ptg-success)]",
  busy: "bg-[rgba(143,95,0,0.14)] text-[var(--ptg-warning)]",
  warn: "bg-[rgba(143,95,0,0.14)] text-[var(--ptg-warning)]",
  warning: "bg-[rgba(143,95,0,0.14)] text-[var(--ptg-warning)]",
  error: "bg-[rgba(197,35,51,0.12)] text-[var(--ptg-error)]",
  conflict: "bg-[rgba(197,35,51,0.12)] text-[var(--ptg-error)]",
  danger: "bg-[rgba(197,35,51,0.12)] text-[var(--ptg-error)]",
  inactive: "bg-[var(--ptg-surface-container)] text-[var(--ptg-on-surface-variant)]",
  offline: "bg-[var(--ptg-surface-container)] text-[var(--ptg-on-surface-variant)]",
  neutral: "bg-[var(--ptg-surface-container)] text-[var(--ptg-on-surface-variant)]",
};

export function StatusPill({ status = "neutral", children = status }) {
  return (
    <span className={`inline-flex min-h-[22px] items-center rounded-full px-2 py-0.5 text-[11.5px] font-[680] ${statusStyles[status] || statusStyles.neutral}`}>
      {children}
    </span>
  );
}

export function Surface({ className = "", children }) {
  return <section className={`material-surface rounded-lg p-3 ${className}`}>{children}</section>;
}

export function SectionTitle({ title, meta, action }) {
  return (
    <div className="mb-2.5 flex min-h-8 items-center justify-between gap-3">
      <div className="min-w-0">
        <h3 className="truncate text-[13px] font-[760] text-[var(--ptg-on-surface)]">{title}</h3>
        {meta ? <p className="mt-0.5 truncate text-[11.5px] font-[560] text-[var(--ptg-on-surface-variant)]">{meta}</p> : null}
      </div>
      {action}
    </div>
  );
}

export function MetricCard({ icon, label, value }) {
  return (
    <Surface className="grid min-h-[74px] grid-cols-[30px_minmax(0,1fr)] content-center gap-x-2.5 gap-y-1">
      <span className="row-span-2 inline-flex h-7 w-7 items-center justify-center rounded-lg bg-[#eaf8fb] text-[var(--ptg-primary-dark)]">
        <Icon name={icon} className="h-4 w-4" />
      </span>
      <span className="truncate text-[11px] font-[700] text-[var(--ptg-on-surface-variant)]">{label}</span>
      <strong className="min-w-0 overflow-hidden text-ellipsis text-[17px] font-[780] leading-tight">{value}</strong>
    </Surface>
  );
}

export function AppButton({ variant = "outlined", icon, children, className = "", ...props }) {
  const Tag = variant === "filled" ? "md-filled-button" : "md-outlined-button";
  return (
    <Tag {...props} className={`material-button ${className}`}>
      {icon ? <Icon slot="icon" name={icon} className="h-4 w-4" /> : null}
      {children}
    </Tag>
  );
}

export function IconButton({ icon, label, className = "", ...props }) {
  return (
    <button aria-label={label} title={label} className={`state-layer inline-flex h-9 w-9 items-center justify-center rounded-lg border border-[var(--ptg-outline)] bg-[var(--ptg-surface)] text-[var(--ptg-on-surface)] ${className}`} {...props}>
      <Icon name={icon} className="h-4 w-4" />
    </button>
  );
}

export function UsageBar({ percent, className = "" }) {
  const safePercent = Math.max(0, Math.min(100, Number(percent) || 0));
  return (
    <span className={`inline-flex h-2 overflow-hidden rounded-full bg-[var(--ptg-surface-container)] align-middle ${className}`}>
      <span className="rounded-full bg-gradient-to-r from-[var(--ptg-secondary)] to-[var(--ptg-primary)]" style={{ width: `${safePercent}%` }} />
    </span>
  );
}

export function TextInput({ label, className = "", ...props }) {
  return (
    <label className={`grid gap-1.5 text-[12px] font-[700] text-[var(--ptg-on-surface-variant)] ${className}`}>
      <span>{label}</span>
      <input
        className="h-9 rounded-lg border border-[var(--ptg-outline)] bg-[var(--ptg-surface)] px-3 text-[13px] text-[var(--ptg-on-surface)] transition focus:border-[var(--ptg-primary)] focus:shadow-[0_0_0_3px_rgba(12,168,224,0.14)]"
        {...props}
      />
    </label>
  );
}

export function TextArea({ label, className = "", ...props }) {
  return (
    <label className={`grid gap-1.5 text-[12px] font-[700] text-[var(--ptg-on-surface-variant)] ${className}`}>
      <span>{label}</span>
      <textarea
        className="min-h-64 rounded-lg border border-[var(--ptg-outline)] bg-[var(--ptg-surface)] p-3 font-mono text-[12px] leading-relaxed text-[var(--ptg-on-surface)] transition focus:border-[var(--ptg-primary)] focus:shadow-[0_0_0_3px_rgba(12,168,224,0.14)]"
        {...props}
      />
    </label>
  );
}

export function SelectInput({ label, children, className = "", ...props }) {
  return (
    <label className={`grid gap-1.5 text-[12px] font-[700] text-[var(--ptg-on-surface-variant)] ${className}`}>
      <span>{label}</span>
      <select
        className="h-9 rounded-lg border border-[var(--ptg-outline)] bg-[var(--ptg-surface)] px-3 text-[13px] text-[var(--ptg-on-surface)] transition focus:border-[var(--ptg-primary)] focus:shadow-[0_0_0_3px_rgba(12,168,224,0.14)]"
        {...props}
      >
        {children}
      </select>
    </label>
  );
}
