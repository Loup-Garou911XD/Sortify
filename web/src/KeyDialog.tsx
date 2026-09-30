/**
 * One source's setup, opened from the Connections panel.
 *
 * Says what the source contributes, how to get its key, and takes the key. Sources that need no
 * key still open, so every row in the panel does something.
 */
import { type FormEvent, useEffect, useRef, useState } from "react";
import { getKeys, KEYS, SOURCE_GUIDES, saveKeys } from "./settings.ts";

const FIELDS = new Map(KEYS.map((k) => [k.id, k]));

/** Steps carry this deploy's own URLs, so they can be copied without editing. */
function fill(step: string): string {
  return step
    .replace("{origin}", location.origin)
    .replace("{redirect}", location.origin + location.pathname);
}

export function KeyDialog({
  sourceId,
  onClose,
  onSaved,
}: {
  sourceId: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const guide = SOURCE_GUIDES[sourceId];
  const dialog = useRef<HTMLDialogElement>(null);
  const [draft, setDraft] = useState<Record<string, string>>(() => {
    const stored = getKeys();
    const out: Record<string, string> = {};
    for (const id of guide?.fields ?? []) out[id] = stored[id] ?? "";
    return out;
  });
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    dialog.current?.showModal();
  }, []);

  if (!guide) return null;

  const submit = (e: FormEvent) => {
    e.preventDefault();
    saveKeys(draft);
    setSaved(true);
    onSaved();
  };

  return (
    <dialog
      ref={dialog}
      className="dialog key-dialog"
      onClose={onClose}
      aria-labelledby="key-dialog-title"
    >
      <form onSubmit={submit}>
        <div className="dialog-head">
          <h2 id="key-dialog-title">{guide.title}</h2>
        </div>
        <div className="dialog-body">
          <p>{guide.blurb}</p>

          <ol className="steps">
            {guide.steps.map((step) => (
              <li key={step}>
                <span>{fill(step)}</span>
              </li>
            ))}
          </ol>
          {guide.docsUrl && (
            <p className="hint">
              <a className="ext-link" href={guide.docsUrl} target="_blank" rel="noreferrer">
                {guide.docsLabel ?? "Open the service"}
              </a>
            </p>
          )}

          {guide.fields.length > 0 && (
            <div className="key-fields">
              {guide.fields.map((id) => {
                const field = FIELDS.get(id);
                return (
                  <label className="control" key={id}>
                    <span className="eyebrow">{field?.label ?? id}</span>
                    <input
                      type={field && "secret" in field && field.secret ? "password" : "text"}
                      value={draft[id] ?? ""}
                      autoComplete="off"
                      spellCheck={false}
                      placeholder="Leave blank to turn this source off"
                      onChange={(e) => {
                        setSaved(false);
                        setDraft((d) => ({ ...d, [id]: e.target.value }));
                      }}
                    />
                    {field?.help && <span className="control-help">{field.help}</span>}
                  </label>
                );
              })}
              <p className="hint">
                Kept in this browser's local storage and sent only to {guide.title}. Anything that
                can run script on this page could read it, so use a key you are willing to keep in a
                browser and revoke it if you stop using this site.
              </p>
            </div>
          )}

          {saved && (
            <div className="notice notice-good">
              <div className="notice-body">Saved.</div>
            </div>
          )}
        </div>
        <div className="dialog-actions">
          <button type="button" className="btn btn-ghost" onClick={() => dialog.current?.close()}>
            {guide.fields.length > 0 ? "Cancel" : "Close"}
          </button>
          {guide.fields.length > 0 && (
            <button type="submit" className="btn btn-primary">
              Save
            </button>
          )}
        </div>
      </form>
    </dialog>
  );
}
