import { Icon } from "./icons";

const statusStyles = {
  online: "bg-[#e7f8f1] text-[var(--ptg-success)] ring-[#c7f0df]",
  success: "bg-[#e7f8f1] text-[var(--ptg-success)] ring-[#c7f0df]",
  active: "bg-[#e7f8f1] text-[var(--ptg-success)] ring-[#c7f0df]",
  busy: "bg-[#fff6e3] text-[#b96d00] ring-[#f7dfaa]",
  warn: "bg-[#fff6e3] text-[#b96d00] ring-[#f7dfaa]",
  warning: "bg-[#fff6e3] text-[#b96d00] ring-[#f7dfaa]",
  error: "bg-[#fff0ef] text-[var(--ptg-error)] ring-[#ffd2ce]",
  conflict: "bg-[#fff0ef] text-[var(--ptg-error)] ring-[#ffd2ce]",
  danger: "bg-[#fff0ef] text-[var(--ptg-error)] ring-[#ffd2ce]",
  disabled: "bg-[#f2f5f9] text-[var(--ptg-on-surface-variant)] ring-[#dfe7f1]",
  inactive: "bg-[#f2f5f9] text-[var(--ptg-on-surface-variant)] ring-[#dfe7f1]",
  offline: "bg-[#f2f5f9] text-[var(--ptg-on-surface-variant)] ring-[#dfe7f1]",
  neutral: "bg-[#f2f5f9] text-[var(--ptg-on-surface-variant)] ring-[#dfe7f1]",
};

export function StatusPill({ status = "neutral", children = status }) {
  return (
    <span className={`inline-flex min-h-5 max-w-full items-center overflow-hidden truncate whitespace-nowrap rounded-full px-2.5 py-0.5 text-[10.5px] font-[800] leading-none ring-1 ${statusStyles[status] || statusStyles.neutral}`}>
      {children}
    </span>
  );
}

export function Surface({ className = "", children }) {
  return <section className={`material-surface rounded-[14px] p-4 ${className}`}>{children}</section>;
}

export function ModalShell({ title, subtitle, width = "w-[min(760px,calc(100vw-32px))]", children, onClose }) {
  return (
    <div className="fixed inset-0 z-30 grid place-items-center bg-[#061225]/48 p-4 backdrop-blur-sm">
      <section className={`${width} max-h-[calc(100vh-32px)] overflow-hidden rounded-[14px] border border-[var(--ptg-outline)] bg-white shadow-[0_28px_80px_rgba(5,13,30,0.28)]`}>
        <header className="flex min-h-[64px] items-start justify-between gap-3 border-b border-[var(--ptg-outline)] bg-[var(--ptg-surface-container)] px-4 py-3">
          <div className="min-w-0">
            <h3 className="truncate text-[17px] font-[850] text-[var(--ptg-on-surface)]">{title}</h3>
            {subtitle ? <p className="mt-0.5 truncate text-[12px] font-[620] text-[var(--ptg-on-surface-variant)]">{subtitle}</p> : null}
          </div>
          <IconButton icon="close" label="Close" onClick={onClose} />
        </header>
        <div className="ptg-scrollbar max-h-[calc(100vh-98px)] overflow-auto p-4">
          {children}
        </div>
      </section>
    </div>
  );
}

export function SectionTitle({ title, meta, action }) {
  return (
    <div className="mb-3 flex min-h-8 items-center justify-between gap-3">
      <div className="min-w-0">
        <h3 className="truncate text-[14px] font-[850] text-[var(--ptg-on-surface)]">{title}</h3>
        {meta ? <p className="mt-1 text-[11.5px] font-[600] leading-snug text-[var(--ptg-on-surface-variant)]">{meta}</p> : null}
      </div>
      {action}
    </div>
  );
}

export function MetricCard({ icon, label, value }) {
  return (
    <Surface className="grid min-h-[98px] grid-cols-[44px_minmax(0,1fr)] content-center gap-x-3 gap-y-1.5">
      <span className="ptg-icon-well row-span-2 inline-flex h-11 w-11 items-center justify-center rounded-[12px]">
        <Icon name={icon} className="h-5 w-5" />
      </span>
      <span className="text-[11px] font-[760] leading-tight text-[var(--ptg-on-surface-variant)]">{label}</span>
      <strong className="min-w-0 overflow-hidden text-ellipsis text-[20px] font-[850] leading-tight">{value}</strong>
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
    <button aria-label={label} title={label} className={`state-layer inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-[10px] border border-[var(--ptg-outline)] bg-white text-[var(--ptg-on-surface-variant)] shadow-[0_1px_2px_rgba(10,26,51,0.04)] hover:border-[var(--ptg-outline-strong)] hover:text-[var(--ptg-primary)] ${className}`} {...props}>
      <Icon name={icon} className="h-4 w-4" />
    </button>
  );
}

export function UsageBar({ percent, className = "" }) {
  const safePercent = Math.max(0, Math.min(100, Number(percent) || 0));
  return (
    <span className={`inline-flex h-2 overflow-hidden rounded-full bg-[#e7edf5] align-middle ${className}`}>
      <span className="rounded-full bg-[var(--ptg-primary)]" style={{ width: `${safePercent}%` }} />
    </span>
  );
}

export function TextInput({ label, className = "", ...props }) {
  return (
    <label className={`grid gap-1.5 text-[11.5px] font-[750] text-[var(--ptg-on-surface-variant)] ${className}`}>
      <span>{label}</span>
      <input
        className="ptg-field h-10 rounded-[10px] border border-[var(--ptg-outline)] px-3 text-[13px] font-[650] text-[var(--ptg-on-surface)] transition focus:border-[var(--ptg-primary)] focus:shadow-[0_0_0_3px_rgba(11,115,246,0.12)]"
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
        className="min-h-64 rounded-[10px] border border-[var(--ptg-outline)] bg-white p-3 font-mono text-[12px] leading-relaxed text-[var(--ptg-on-surface)] transition focus:border-[var(--ptg-primary)] focus:shadow-[0_0_0_3px_rgba(11,115,246,0.12)]"
        {...props}
      />
    </label>
  );
}

export function SelectInput({ label, children, className = "", ...props }) {
  return (
    <label className={`grid gap-1.5 text-[11.5px] font-[750] text-[var(--ptg-on-surface-variant)] ${className}`}>
      <span>{label}</span>
      <span className="relative block">
        <select
          className="h-10 w-full appearance-none rounded-[10px] border border-[var(--ptg-outline)] bg-white px-3 pr-10 text-[13px] font-[650] text-[var(--ptg-on-surface)] transition focus:border-[var(--ptg-primary)] focus:shadow-[0_0_0_3px_rgba(11,115,246,0.12)] disabled:bg-[var(--ptg-surface-container)] disabled:text-[var(--ptg-on-surface-variant)]"
          {...props}
        >
          {children}
        </select>
        <Icon name="chevronDown" className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--ptg-on-surface-variant)]" />
      </span>
    </label>
  );
}
