/**
 * The keys screen.
 *
 * The local server reads keys from a `.env` file, so the shared UI has nowhere to type them.
 * This is the static build's answer: a dialog mounted beside the app, using the app's own
 * stylesheet so it does not look bolted on.
 */
import { type FormEvent, useState } from "react";
import { getKeys, KEYS, saveKeys } from "./settings.ts";

export function Settings({ onSaved }: { onSaved: () => void }) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<Record<string, string>>(getKeys);
  const [saved, setSaved] = useState(false);

  const show = () => {
    setDraft(getKeys());
    setSaved(false);
    setOpen(true);
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    saveKeys(draft);
    setSaved(true);
    onSaved();
  };

  if (!open) {
    return (
      <button type="button" className="btn btn-secondary settings-launcher" onClick={show}>
        Settings
      </button>
    );
  }

  return (
    <div className="settings-backdrop">
      <form className="dialog settings-dialog" onSubmit={submit}>
        <div className="dialog-head">
          <h2>Your keys</h2>
        </div>
        <div className="dialog-body">
          <p>
            This build runs entirely in your browser, so it uses your own API keys. They are kept in
            this browser's local storage and are sent only to the service each one belongs to.
            Anything that can run script on this page could read them, so use keys you are willing
            to keep in a browser, and revoke them if you stop using this site.
          </p>
          <div className="settings-fields">
            {KEYS.map((k) => (
              <label className="control" key={k.id}>
                <span className="eyebrow">
                  {k.label}
                  {"required" in k && k.required ? " · required" : ""}
                </span>
                <input
                  type={"secret" in k && k.secret ? "password" : "text"}
                  value={draft[k.id] ?? ""}
                  autoComplete="off"
                  spellCheck={false}
                  onChange={(e) => setDraft((d) => ({ ...d, [k.id]: e.target.value }))}
                />
                <span className="control-help">{k.help}</span>
              </label>
            ))}
          </div>
          <p className="hint">
            The Google client must be of type <strong>Web application</strong>, with{" "}
            <code>{location.origin + location.pathname}</code> listed under both Authorized
            JavaScript origins and Authorized redirect URIs. Leave a provider blank to turn it off.
          </p>
          {saved && (
            <div className="notice notice-good">
              <div className="notice-body">Keys saved.</div>
            </div>
          )}
        </div>
        <div className="dialog-actions">
          <button type="button" className="btn btn-ghost" onClick={() => setOpen(false)}>
            Close
          </button>
          <button type="submit" className="btn btn-primary">
            Save keys
          </button>
        </div>
      </form>
    </div>
  );
}
