import {
  type ButtonHTMLAttributes,
  type ReactNode,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";
import type { Dimension, TrackTagView } from "../../../backend/src/api/types.ts";
import { useApp } from "../App.tsx";
import { IconAlert, IconCheckCircle, IconChevronDown, IconInbox, IconInfo } from "./icons.tsx";

type Variant = "primary" | "secondary" | "ghost" | "danger";

export function Button({
  variant = "secondary",
  busy = false,
  className = "",
  children,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; busy?: boolean }) {
  return (
    <button
      type="button"
      className={`btn btn-${variant} ${className}`.trim()}
      disabled={busy || rest.disabled}
      {...rest}
    >
      {busy && <span className="spinner" aria-hidden />}
      {children}
    </button>
  );
}

export function Progress({
  value,
  max,
  tone = "accent",
  label,
}: {
  value: number;
  max: number;
  tone?: "accent" | "good" | "muted";
  label?: string;
}) {
  const width = max === 0 ? 0 : Math.min(100, (100 * value) / max);
  return (
    <div
      className={`meter meter-${tone}`}
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={max}
      aria-valuenow={value}
      aria-label={label}
    >
      <div className="meter-fill" style={{ width: `${width}%` }} />
    </div>
  );
}

export function Skeleton({ height = 16, width = "100%" }: { height?: number; width?: string }) {
  return <div className="skeleton" style={{ height, width }} aria-hidden />;
}

/** Placeholder with the shape of a page, so a slow load does not collapse the layout. */
export function PageSkeleton({ label }: { label: string }) {
  return (
    <div className="skeleton-stack" role="status" aria-label={label}>
      <Skeleton height={26} width="42%" />
      <Skeleton height={14} width="28%" />
      <div style={{ height: 10 }} />
      <Skeleton height={78} />
      <Skeleton height={340} />
    </div>
  );
}

export function EmptyState({
  title,
  children,
  action,
}: {
  title: string;
  children?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="empty-state">
      <IconInbox />
      <p>
        <strong>{title}</strong>
      </p>
      {children && <p className="muted">{children}</p>}
      {action && <div className="step-action">{action}</div>}
    </div>
  );
}

export function TagChip({ tag }: { tag: TrackTagView }) {
  const { status } = useApp();
  const source =
    status?.sources.find((s) => s.id === tag.source)?.label ??
    (tag.source === "rule" ? "title rule" : tag.source);
  return (
    <span
      className={`chip chip-${tag.dimension}`}
      title={`${source}: “${tag.rawTag}” (weight ${tag.weight.toFixed(2)})`}
    >
      {tag.value}
    </span>
  );
}

/** One chip per distinct value, strongest first. */
export function TagChips({ tags, dimension }: { tags: TrackTagView[]; dimension: Dimension }) {
  const seen = new Set<string>();
  const unique = tags.filter((t) => {
    if (t.dimension !== dimension || seen.has(t.value)) return false;
    seen.add(t.value);
    return true;
  });
  if (unique.length === 0) return <span className="faint">—</span>;
  return (
    <span className="chips">
      {unique.map((t) => (
        <TagChip key={t.value} tag={t} />
      ))}
    </span>
  );
}

export function Segmented<T extends string>({
  value,
  options,
  onChange,
  label,
}: {
  value: T;
  options: { value: T; label: string }[];
  onChange: (value: T) => void;
  label: string;
}) {
  return (
    <fieldset className="segmented">
      <legend className="sr-only">{label}</legend>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          aria-pressed={o.value === value}
          className={o.value === value ? "active" : ""}
          onClick={() => onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </fieldset>
  );
}

export function StatusPill({ status }: { status: string }) {
  const label: Record<string, string> = {
    planned: "Not started",
    applying: "Creating",
    paused: "Paused",
    done: "Done",
  };
  return (
    <span className={`pill pill-${status}`}>
      <span className="dot" aria-hidden />
      {label[status] ?? status}
    </span>
  );
}

const NOTICE_ICON = {
  info: IconInfo,
  warn: IconAlert,
  error: IconAlert,
  good: IconCheckCircle,
} as const;

export function Notice({
  tone = "info",
  children,
}: {
  tone?: "info" | "warn" | "error" | "good";
  children: ReactNode;
}) {
  const Glyph = NOTICE_ICON[tone];
  return (
    <div className={`notice notice-${tone}`} role={tone === "error" ? "alert" : undefined}>
      <Glyph />
      <div className="notice-body">{children}</div>
    </div>
  );
}

export function Stat({ label, value, sub }: { label: string; value: ReactNode; sub?: ReactNode }) {
  return (
    <div className="stat">
      <span className="eyebrow">{label}</span>
      <div className="stat-value">{value}</div>
      {sub}
    </div>
  );
}

/** A labelled form control: the label sits above the input as a small caps eyebrow. */
export function Field({
  label,
  help,
  children,
}: {
  label: string;
  help?: string;
  children: ReactNode;
}) {
  return (
    // biome-ignore lint/a11y/noLabelWithoutControl: the control is the caller's child
    <label className="control">
      <span className="eyebrow">{label}</span>
      {children}
      {help && <span className="control-help">{help}</span>}
    </label>
  );
}

/**
 * A popover menu. Closes on Escape, on an outside click, and whenever the caller calls `close`
 * from the render prop.
 */
export function Menu({
  trigger,
  children,
  label,
  wide = false,
}: {
  trigger: ReactNode;
  children: (close: () => void) => ReactNode;
  label: string;
  wide?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  const id = useId();

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!wrap.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div className="menu-wrap" ref={wrap}>
      <button
        type="button"
        className="menu-trigger"
        aria-expanded={open}
        aria-haspopup="true"
        aria-controls={open ? id : undefined}
        aria-label={label}
        onClick={() => setOpen((v) => !v)}
      >
        {trigger}
        <IconChevronDown className="chev" />
      </button>
      {open && (
        <div className={wide ? "menu-pop wide" : "menu-pop"} id={id}>
          {children(() => setOpen(false))}
        </div>
      )}
    </div>
  );
}

export function MenuItem({ children, onClick }: { children: ReactNode; onClick: () => void }) {
  return (
    <button type="button" className="menu-item" onClick={onClick}>
      {children}
    </button>
  );
}
