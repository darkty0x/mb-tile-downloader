"use client";

import { useState } from "react";
import { Icon } from "./icons";

const statusStyles = {
  online: "bg-[#e7f8f1] text-[var(--ptg-success)] ring-[#c7f0df]",
  success: "bg-[#e7f8f1] text-[var(--ptg-success)] ring-[#c7f0df]",
  active: "bg-[#e7f8f1] text-[var(--ptg-success)] ring-[#c7f0df]",
  busy: "bg-[#fff6e3] text-[#b96d00] ring-[#f7dfaa]",
  warn: "bg-[#fff6e3] text-[#b96d00] ring-[#f7dfaa]",
  warning: "bg-[#fff6e3] text-[#b96d00] ring-[#f7dfaa]",
  error: "bg-[#fff0ef] text-[var(--ptg-error)] ring-[#ffd2ce]",
  invalid: "bg-[#fff0ef] text-[var(--ptg-error)] ring-[#ffd2ce]",
  conflict: "bg-[#fff0ef] text-[var(--ptg-error)] ring-[#ffd2ce]",
  danger: "bg-[#fff0ef] text-[var(--ptg-error)] ring-[#ffd2ce]",
  exhausted: "bg-[#fff6e3] text-[#b96d00] ring-[#f7dfaa]",
  disabled: "bg-[#f2f5f9] text-[var(--ptg-on-surface-variant)] ring-[#dfe7f1]",
  inactive: "bg-[#f2f5f9] text-[var(--ptg-on-surface-variant)] ring-[#dfe7f1]",
  offline: "bg-[#f2f5f9] text-[var(--ptg-on-surface-variant)] ring-[#dfe7f1]",
  neutral: "bg-[#f2f5f9] text-[var(--ptg-on-surface-variant)] ring-[#dfe7f1]",
};

export function StatusPill({ status = "neutral", children = status }) {
  return (
    <span className={`inline-flex min-h-6 max-w-full items-center overflow-hidden truncate whitespace-nowrap rounded-full px-2.5 py-0.5 text-[10.5px] font-[760] leading-none ring-1 ${statusStyles[status] || statusStyles.neutral}`}>
      {children}
    </span>
  );
}

export function Surface({ className = "", children }) {
  return <section className={`material-surface rounded-[22px] p-4 ${className}`}>{children}</section>;
}

export function ModalShell({ title, subtitle, width = "w-[min(760px,calc(100vw-32px))]", children, onClose }) {
  return (
    <div className="ptg-modal-backdrop fixed inset-0 z-30 grid place-items-center bg-[#1d1b20]/46 p-4 backdrop-blur-sm">
      <section className={`ptg-modal-panel ${width} max-h-[calc(100vh-32px)] overflow-hidden rounded-[28px] border border-[var(--ptg-outline)] bg-[var(--ptg-surface)] shadow-[0_28px_80px_rgba(29,27,32,0.28)]`}>
        <header className="flex min-h-[72px] items-start justify-between gap-3 border-b border-[var(--ptg-outline)] bg-[var(--ptg-surface-container-low)] px-5 py-4">
          <div className="min-w-0">
            <h3 className="truncate text-[18px] font-[820] text-[var(--ptg-on-surface)]">{title}</h3>
            {subtitle ? <p className="mt-0.5 truncate text-[12px] font-[620] text-[var(--ptg-on-surface-variant)]">{subtitle}</p> : null}
          </div>
          <IconButton icon="close" label="닫기" onClick={onClose} />
        </header>
        <div className="ptg-scrollbar max-h-[calc(100vh-104px)] overflow-auto p-5">
          {children}
        </div>
      </section>
    </div>
  );
}

export function SectionTitle({ title, meta, action }) {
  return (
    <div className="mb-3 flex min-h-8 flex-wrap items-center justify-between gap-3">
      <div className="min-w-0">
        <h3 className="truncate text-[14px] font-[850] text-[var(--ptg-on-surface)]">{title}</h3>
        {meta ? <p className="mt-1 text-[11.5px] font-[600] leading-snug text-[var(--ptg-on-surface-variant)]">{meta}</p> : null}
      </div>
      {action ? <div className="max-w-full shrink-0">{action}</div> : null}
    </div>
  );
}

function metricValueClass(value) {
  const length = String(value ?? "").length;
  if (length > 18) return "text-[16px]";
  if (length > 12) return "text-[19px]";
  return "text-[24px]";
}

export function MetricCard({ icon, label, value, palette = "lilac" }) {
  return (
    <Surface className={`ptg-metric-tile grid min-h-[108px] grid-cols-[56px_minmax(0,1fr)] content-center gap-x-3 gap-y-1.5 p-4 ptg-palette-${palette}`}>
      <span className="ptg-icon-well row-span-2 inline-flex h-14 w-14 items-center justify-center rounded-[20px]">
        <Icon name={icon} className="h-7 w-7" />
      </span>
      <span className="text-[11px] font-[650] leading-tight text-[var(--ptg-on-surface-variant)]">{label}</span>
      <strong className={`min-w-0 break-words ${metricValueClass(value)} font-[475] leading-tight`}>{value}</strong>
    </Surface>
  );
}

export function AppButton({ variant = "outlined", icon, children, className = "", loading = false, ...props }) {
  const { onClick, disabled, ...buttonProps } = props;
  const [pending, setPending] = useState(false);
  const busy = Boolean(loading || pending);
  const variantClass = variant === "filled"
    ? "ptg-button-primary"
    : variant === "tonal"
      ? "ptg-button-tonal"
      : variant === "danger"
        ? "ptg-button-danger"
        : "ptg-button-secondary";

  const handleClick = (event) => {
    if (disabled || busy) {
      event.preventDefault();
      return;
    }
    const result = onClick?.(event);
    if (result && typeof result.finally === "function") {
      setPending(true);
      result.finally(() => setPending(false));
    }
  };

  return (
    <button
      {...buttonProps}
      disabled={disabled || busy}
      data-pending={busy ? "true" : "false"}
      onClick={handleClick}
      className={`state-layer ptg-button inline-flex max-w-full shrink-0 items-center justify-center gap-2 whitespace-nowrap ${variantClass} ${className}`}
    >
      {busy ? <LoadingSpinner /> : icon ? <Icon name={icon} className="h-4 w-4" /> : null}
      <span className="min-w-0 truncate">{children}</span>
    </button>
  );
}

export function IconButton({ icon, label, className = "", loading = false, ...props }) {
  const { onClick, disabled, ...buttonProps } = props;
  const [pending, setPending] = useState(false);
  const busy = Boolean(loading || pending);

  const handleClick = (event) => {
    if (disabled || busy) {
      event.preventDefault();
      return;
    }
    const result = onClick?.(event);
    if (result && typeof result.finally === "function") {
      setPending(true);
      result.finally(() => setPending(false));
    }
  };

  return (
    <button
      aria-label={label}
      title={label}
      data-pending={busy ? "true" : "false"}
      disabled={disabled || busy}
      onClick={handleClick}
      className={`state-layer inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-full border border-[var(--ptg-outline)] bg-[var(--ptg-surface)] text-[var(--ptg-on-surface-variant)] hover:border-[var(--ptg-outline-strong)] hover:bg-[var(--ptg-primary-soft)] hover:text-[var(--ptg-primary)] ${className}`}
      {...buttonProps}
    >
      {busy ? <LoadingSpinner /> : <Icon name={icon} className="h-5 w-5" />}
    </button>
  );
}

export function LoadingSpinner({ className = "" }) {
  return <span aria-hidden="true" className={`ptg-spinner h-4 w-4 shrink-0 ${className}`} />;
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
        className="ptg-field h-10 rounded-[10px] border border-[var(--ptg-outline)] px-3 text-[13px] font-[650] text-[var(--ptg-on-surface)] transition focus:border-[var(--ptg-primary)] focus:shadow-[0_0_0_3px_rgba(96,64,239,0.14)]"
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
        className="min-h-64 rounded-[10px] border border-[var(--ptg-outline)] bg-white p-3 font-mono text-[12px] leading-relaxed text-[var(--ptg-on-surface)] transition focus:border-[var(--ptg-primary)] focus:shadow-[0_0_0_3px_rgba(96,64,239,0.14)]"
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
          className="h-10 w-full appearance-none rounded-[10px] border border-[var(--ptg-outline)] bg-white px-3 pr-10 text-[13px] font-[650] text-[var(--ptg-on-surface)] transition focus:border-[var(--ptg-primary)] focus:shadow-[0_0_0_3px_rgba(96,64,239,0.14)] disabled:bg-[var(--ptg-surface-container)] disabled:text-[var(--ptg-on-surface-variant)]"
          {...props}
        >
          {children}
        </select>
        <Icon name="chevronDown" className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--ptg-on-surface-variant)]" />
      </span>
    </label>
  );
}

export function SwitchField({ label, description, className = "", inputClassName = "", ...props }) {
  return (
    <label className={`state-layer flex min-h-12 items-center justify-between gap-3 rounded-xl border border-[var(--ptg-outline)] bg-white px-3 py-2.5 text-left transition hover:border-[var(--ptg-outline-strong)] ${props.disabled ? "opacity-60" : "cursor-pointer"} ${className}`}>
      <span className="min-w-0">
        <span className="block truncate text-[12px] font-[780] text-[var(--ptg-on-surface)]">{label}</span>
        {description ? <span className="mt-0.5 block truncate text-[11px] font-[560] text-[var(--ptg-on-surface-variant)]">{description}</span> : null}
      </span>
      <span className="relative inline-flex h-7 w-12 shrink-0">
        <input
          className={`peer absolute inset-0 z-10 cursor-pointer opacity-0 disabled:cursor-not-allowed ${inputClassName}`}
          type="checkbox"
          {...props}
        />
        <span className="absolute inset-0 rounded-full bg-[#dfe5ee] transition peer-checked:bg-[var(--ptg-primary)] peer-focus-visible:shadow-[0_0_0_3px_rgba(96,64,239,0.2)]" />
        <span className="absolute left-1 top-1 h-5 w-5 rounded-full bg-white shadow-[0_1px_4px_rgba(10,26,51,0.24)] transition peer-checked:translate-x-5" />
      </span>
    </label>
  );
}
