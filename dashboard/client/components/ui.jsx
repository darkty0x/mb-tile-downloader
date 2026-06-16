import { Icon } from "./icons";

const statusStyles = {
  online: "bg-[rgba(69,230,168,0.14)] text-[var(--ptg-success)]",
  success: "bg-[rgba(69,230,168,0.14)] text-[var(--ptg-success)]",
  active: "bg-[rgba(69,230,168,0.14)] text-[var(--ptg-success)]",
  busy: "bg-[rgba(255,194,74,0.14)] text-[var(--ptg-warning)]",
  warn: "bg-[rgba(255,194,74,0.14)] text-[var(--ptg-warning)]",
  warning: "bg-[rgba(255,194,74,0.14)] text-[var(--ptg-warning)]",
  error: "bg-[rgba(255,90,117,0.14)] text-[var(--ptg-error)]",
  conflict: "bg-[rgba(255,90,117,0.14)] text-[var(--ptg-error)]",
  danger: "bg-[rgba(255,90,117,0.14)] text-[var(--ptg-error)]",
  disabled: "bg-[rgba(148,163,184,0.12)] text-[var(--ptg-on-surface-variant)]",
  inactive: "bg-[var(--ptg-surface-container)] text-[var(--ptg-on-surface-variant)]",
  offline: "bg-[var(--ptg-surface-container)] text-[var(--ptg-on-surface-variant)]",
  neutral: "bg-[var(--ptg-surface-container)] text-[var(--ptg-on-surface-variant)]",
};

export function StatusPill({ status = "neutral", children = status }) {
  return (
    <span className={`inline-flex min-h-5 max-w-full items-center overflow-hidden truncate whitespace-nowrap rounded-full px-2.5 py-0.5 text-[10.5px] font-[800] leading-none ring-1 ring-white/5 ${statusStyles[status] || statusStyles.neutral}`}>
      {children}
    </span>
  );
}

export function Surface({ className = "", children }) {
  return <section className={`material-surface rounded-[20px] p-3.5 ${className}`}>{children}</section>;
}

export function SectionTitle({ title, meta, action }) {
  return (
    <div className="mb-3 flex min-h-8 items-center justify-between gap-3">
      <div className="min-w-0">
        <h3 className="truncate text-[13px] font-[850] text-[var(--ptg-on-surface)]">{title}</h3>
        {meta ? <p className="mt-1 text-[11.5px] font-[600] leading-snug text-[var(--ptg-on-surface-variant)]">{meta}</p> : null}
      </div>
      {action}
    </div>
  );
}

export function MetricCard({ icon, label, value }) {
  return (
    <Surface className="grid min-h-[86px] grid-cols-[38px_minmax(0,1fr)] content-center gap-x-3 gap-y-1.5">
      <span className="ptg-icon-well row-span-2 inline-flex h-9 w-9 items-center justify-center rounded-xl">
        <Icon name={icon} className="h-[17px] w-[17px]" />
      </span>
      <span className="text-[10.5px] font-[750] leading-tight text-[var(--ptg-on-surface-variant)]">{label}</span>
      <strong className="min-w-0 overflow-hidden text-ellipsis text-[18px] font-[800] leading-tight tracking-[-0.01em]">{value}</strong>
    </Surface>
  );
}

export function AppButton({ variant = "outlined", icon, children, className = "", ...props }) {
  return (
    <button
      {...props}
      className={`state-layer ptg-button inline-flex max-w-full shrink-0 items-center justify-center gap-2 px-3.5 ${variant === "filled" ? "ptg-button-primary" : "ptg-button-secondary"} ${className}`}
    >
      {icon ? <Icon name={icon} className="h-4 w-4" /> : null}
      {children}
    </button>
  );
}

export function IconButton({ icon, label, className = "", ...props }) {
  return (
    <button aria-label={label} title={label} className={`state-layer inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border border-[var(--ptg-outline)] bg-[rgba(20,28,42,0.78)] text-[var(--ptg-on-surface-variant)] hover:text-white ${className}`} {...props}>
      <Icon name={icon} className="h-4 w-4" />
    </button>
  );
}

export function UsageBar({ percent, className = "" }) {
  const safePercent = Math.max(0, Math.min(100, Number(percent) || 0));
  return (
    <span className={`inline-flex h-2 overflow-hidden rounded-full bg-[rgba(255,255,255,0.08)] align-middle ${className}`}>
      <span className="rounded-full bg-gradient-to-r from-[#18d8a0] via-[#31b7ff] to-[#a333f6]" style={{ width: `${safePercent}%` }} />
    </span>
  );
}

export function TextInput({ label, className = "", ...props }) {
  return (
    <label className={`grid gap-1.5 text-[11.5px] font-[750] text-[var(--ptg-on-surface-variant)] ${className}`}>
      <span>{label}</span>
      <input
        className="ptg-field h-10 rounded-xl border border-transparent px-3 text-[13px] font-[650] text-[var(--ptg-on-surface)] shadow-[inset_0_0_0_1px_var(--ptg-outline)] transition focus:shadow-[inset_0_0_0_1px_var(--ptg-primary),0_0_0_3px_rgba(163,51,246,0.18)]"
        {...props}
      />
    </label>
  );
}

export function TextArea({ label, className = "", ...props }) {
  return (
    <label className={`grid gap-1.5 text-[11.5px] font-[750] text-[var(--ptg-on-surface-variant)] ${className}`}>
      <span>{label}</span>
      <textarea
        className="min-h-64 rounded-xl border border-[var(--ptg-outline)] bg-[var(--ptg-surface-container)] p-3 font-mono text-[12px] leading-relaxed text-[var(--ptg-on-surface)] transition focus:border-[var(--ptg-primary)] focus:shadow-[0_0_0_3px_rgba(163,51,246,0.18)]"
        {...props}
      />
    </label>
  );
}

export function SelectInput({ label, children, className = "", ...props }) {
  return (
    <label className={`grid gap-1.5 text-[11.5px] font-[750] text-[var(--ptg-on-surface-variant)] ${className}`}>
      <span>{label}</span>
      <select
        className="h-10 rounded-xl border border-[var(--ptg-outline)] bg-[var(--ptg-surface-container)] px-3 text-[13px] font-[650] text-[var(--ptg-on-surface)] transition focus:border-[var(--ptg-primary)] focus:shadow-[0_0_0_3px_rgba(163,51,246,0.18)]"
        {...props}
      >
        {children}
      </select>
    </label>
  );
}
