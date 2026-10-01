/**
 * Bulk key entry from a `.env` file.
 *
 * Typing six keys one dialog at a time is tedious when they already sit in the repo's `.env`,
 * so this reads that file whole. File pickers hide dotfiles on most systems, so pasting the
 * contents works too. Values are never displayed — only the names of what was recognised.
 */
import { type ChangeEvent, useEffect, useRef, useState } from "react";
import { Button, Field, Notice } from "../../frontend/src/components/ui.tsx";
import { KEYS, type KeyId, type ParsedEnv, parseEnv, saveKeys } from "./settings.ts";

const keyCount = (n: number): string => (n === 1 ? "1 key" : `${n} keys`);

export function ImportDialog({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [text, setText] = useState("");
  const [result, setResult] = useState<ParsedEnv>();
  const [error, setError] = useState<string>();
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    dialog.current?.showModal();
  }, []);

  const read = (value: string) => {
    setText(value);
    setError(undefined);
    setSaved(false);
    setResult(value.trim() ? parseEnv(value) : undefined);
  };

  const pickFile = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      read(await file.text());
    } catch {
      setError("That file could not be read.");
    }
  };

  const save = () => {
    const keys = result?.keys;
    if (!keys) return;
    saveKeys(keys as Record<string, string>);
    setSaved(true);
    onSaved();
  };

  const count = result ? Object.keys(result.keys).length : 0;

  return (
    <dialog
      ref={dialog}
      className="dialog key-dialog"
      onClose={onClose}
      aria-labelledby="import-title"
    >
      <div className="dialog-head">
        <h2 id="import-title">Import from a .env file</h2>
      </div>
      <div className="dialog-body">
        <p>
          Reads the keys straight out of a <code>.env</code> file, under the same names the backend
          uses, so you do not have to enter them one at a time. Nothing leaves this browser.
        </p>

        <Field
          label="Choose the file"
          help="File pickers usually hide dotfiles — press ⌘⇧. on macOS or Ctrl+H on Linux, or paste the contents below instead."
        >
          <span className="btn btn-secondary file-button">
            Choose a file
            <input type="file" className="sr-only" onChange={pickFile} />
          </span>
        </Field>

        <Field label="Or paste its contents">
          <span className="import-paste">
            <textarea
              rows={6}
              value={text}
              spellCheck={false}
              placeholder={"DISCOGS_TOKEN=…\nLASTFM_API_KEY=…"}
              onChange={(e) => read(e.target.value)}
            />
          </span>
        </Field>

        {error && <Notice tone="error">{error}</Notice>}

        {result && (
          <div className="import-summary">
            {count === 0 ? (
              <Notice tone="warn">No keys Sortify recognises were found.</Notice>
            ) : (
              <p className="hint">
                <strong>Will set {keyCount(count)}:</strong>{" "}
                {Object.keys(result.keys)
                  .map((id) => KEYS[id as KeyId].label)
                  .join(", ")}
                .
              </p>
            )}
            {result.desktopClient && (
              <Notice tone="warn">
                <code>SORTIFY_CLIENT_SECRETS</code> holds a <strong>Desktop app</strong> OAuth
                client. A browser cannot sign in with one — create a{" "}
                <strong>Web application</strong> client and add it under Connections → YouTube.
              </Notice>
            )}
            {result.clientSecretsPath && (
              <p className="hint">
                <code>SORTIFY_CLIENT_SECRETS</code> names a file, which a browser cannot open. Paste
                that file's JSON in as the value instead, or set <code>GOOGLE_CLIENT_ID</code> and{" "}
                <code>GOOGLE_CLIENT_SECRET</code> directly.
              </p>
            )}
            {result.ignored.length > 0 && (
              <p className="hint">Ignored: {result.ignored.join(", ")}.</p>
            )}
            {saved && <Notice tone="good">Saved {keyCount(count)}.</Notice>}
          </div>
        )}
      </div>
      <div className="dialog-actions">
        <Button variant="ghost" onClick={() => dialog.current?.close()}>
          {saved ? "Close" : "Cancel"}
        </Button>
        <Button variant="primary" disabled={count === 0} onClick={save}>
          Import
        </Button>
      </div>
    </dialog>
  );
}
