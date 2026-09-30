import type { Toast } from "../App.tsx";
import { IconAlert, IconCheckCircle, IconClose } from "./icons.tsx";

/** Transient messages, stacked below the top bar. Errors stay until dismissed. */
export function Toasts({
  toasts,
  onDismiss,
}: {
  toasts: Toast[];
  onDismiss: (id: number) => void;
}) {
  if (toasts.length === 0) return null;
  return (
    <div className="toasts" aria-live="polite">
      {toasts.map((t) => (
        <div
          key={t.id}
          className={`toast toast-${t.tone}`}
          role={t.tone === "error" ? "alert" : undefined}
        >
          {t.tone === "good" ? <IconCheckCircle /> : <IconAlert />}
          <span className="toast-text">{t.text}</span>
          <button
            type="button"
            className="row-btn"
            style={{ opacity: 1 }}
            aria-label="Dismiss"
            onClick={() => onDismiss(t.id)}
          >
            <IconClose size={13} />
          </button>
        </div>
      ))}
    </div>
  );
}
