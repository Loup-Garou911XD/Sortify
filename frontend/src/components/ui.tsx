import type { ButtonHTMLAttributes, ReactNode } from "react";
import type { Dimension, TrackTagView } from "../../../backend/src/api/types.ts";
import { useApp } from "../App.tsx";

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
      className={`btn btn-${variant} ${className}`}
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
      className={`progress progress-${tone}`}
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={max}
      aria-valuenow={value}
      aria-label={label}
    >
      <div className="progress-fill" style={{ width: `${width}%` }} />
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
  if (unique.length === 0) return <span className="muted">—</span>;
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
    applying: "In progress",
    paused: "Paused",
    done: "Done",
  };
  return <span className={`pill pill-${status}`}>{label[status] ?? status}</span>;
}

export function Notice({
  tone = "info",
  children,
}: {
  tone?: "info" | "warn" | "error" | "good";
  children: ReactNode;
}) {
  return (
    <div className={`notice notice-${tone}`} role={tone === "error" ? "alert" : undefined}>
      {children}
    </div>
  );
}

export function Stat({ label, value, sub }: { label: string; value: ReactNode; sub?: ReactNode }) {
  return (
    <div className="stat">
      <div className="stat-label">{label}</div>
      <div className="stat-value">{value}</div>
      {sub && <div className="stat-sub">{sub}</div>}
    </div>
  );
}
