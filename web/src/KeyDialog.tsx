/**
 * One source's setup, opened from the Connections panel.
 *
 * Says what the source contributes, how to get its key, and takes the key. Sources that need no
 * key still open, so every row in the panel does something. A provider with no entry in
 * SOURCE_GUIDES still works: the registry supplies its name, its description and its env vars,
 * so adding a provider to PROVIDERS cannot leave a row here that opens nothing.
 */
import { type FormEvent, useEffect, useRef, useState } from "react";
import type { ProviderStatus } from "../../backend/src/api/types.ts";
import { Button, Field, Notice } from "../../frontend/src/components/ui.tsx";
import { getKeys, KEYS, type KeyId, SOURCE_GUIDES, saveKeys } from "./settings.ts";

/** Steps carry this deploy's own URLs, so they can be copied without editing. */
function fill(step: string): string {
  return step
    .replace("{origin}", location.origin)
    .replace("{redirect}", location.origin + location.pathname);
}

const isKey = (name: string): name is KeyId => name in KEYS;

export function KeyDialog({
  sourceId,
  source,
  onClose,
  onSaved,
}: {
  sourceId: string;
  /** The row's own entry from /api/status, used when SOURCE_GUIDES has nothing for it. */
  source: ProviderStatus | undefined;
  onClose: () => void;
  onSaved: () => void;
}) {
  const guide = SOURCE_GUIDES[sourceId];
  const title = guide?.title ?? source?.label ?? sourceId;
  const blurb = guide?.blurb ?? source?.help ?? "";
  const steps = guide?.steps ?? [];
  const fields = guide?.fields ?? (source?.envVars ?? []).filter(isKey);

  const dialog = useRef<HTMLDialogElement>(null);
  const [draft, setDraft] = useState<Record<string, string>>(() => {
    const stored = getKeys();
    return Object.fromEntries(fields.map((id) => [id, stored[id] ?? ""]));
  });
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    dialog.current?.showModal();
  }, []);

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
          <h2 id="key-dialog-title">{title}</h2>
        </div>
        <div className="dialog-body">
          <p>{blurb}</p>

          {steps.length > 0 && (
            <ol className="steps">
              {steps.map((step) => (
                <li key={step}>
                  <span>{fill(step)}</span>
                </li>
              ))}
            </ol>
          )}
          {guide?.docsUrl && (
            <p className="hint">
              <a className="ext-link" href={guide.docsUrl} target="_blank" rel="noreferrer">
                {guide.docsLabel ?? "Open the service"}
              </a>
            </p>
          )}
          {steps.length === 0 && fields.length === 0 && <p className="hint">No key needed.</p>}

          {fields.length > 0 && (
            <div className="key-fields">
              {fields.map((id) => (
                <Field key={id} label={KEYS[id].label} help={KEYS[id].help}>
                  <input
                    type={KEYS[id].secret ? "password" : "text"}
                    value={draft[id] ?? ""}
                    autoComplete="off"
                    spellCheck={false}
                    placeholder="Leave blank to turn this source off"
                    onChange={(e) => {
                      setSaved(false);
                      setDraft((d) => ({ ...d, [id]: e.target.value }));
                    }}
                  />
                </Field>
              ))}
              <p className="hint">
                Kept in this browser's local storage and sent only to {title}. Anything that can run
                script on this page could read it, so use a key you are willing to keep in a browser
                and revoke it if you stop using this site.
              </p>
            </div>
          )}

          {saved && <Notice tone="good">Saved.</Notice>}
        </div>
        <div className="dialog-actions">
          <Button variant="ghost" onClick={() => dialog.current?.close()}>
            {fields.length > 0 ? "Cancel" : "Close"}
          </Button>
          {fields.length > 0 && (
            <Button type="submit" variant="primary">
              Save
            </Button>
          )}
        </div>
      </form>
    </dialog>
  );
}
