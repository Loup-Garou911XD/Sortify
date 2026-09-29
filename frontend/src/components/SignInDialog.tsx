import { type FormEvent, useEffect, useRef, useState } from "react";
import type { StatusResponse } from "../../../backend/src/api/types.ts";
import { useApp } from "../App.tsx";
import { api } from "../api.ts";
import { useInterval } from "../hooks.ts";
import { Button, Notice } from "./ui.tsx";

export function SignInDialog({
  onClose,
  onSignedIn,
}: {
  onClose: () => void;
  onSignedIn: () => void;
}) {
  const { status } = useApp();
  const dialog = useRef<HTMLDialogElement>(null);
  const [opened, setOpened] = useState(false);
  const [pasted, setPasted] = useState("");
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    dialog.current?.showModal();
  }, []);

  // Google sends the browser back to the server in the tab it opened; notice that here.
  useInterval(
    () => {
      void api<StatusResponse>("/api/status").then((s) => s.signedIn && onSignedIn());
    },
    1500,
    opened,
  );

  const open = async () => {
    setError(undefined);
    setBusy(true);
    try {
      const { url } = await api<{ url: string }>("/api/auth/start", { method: "POST" });
      window.open(url, "_blank", "noopener");
      setOpened(true);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const complete = async (e: FormEvent) => {
    e.preventDefault();
    setError(undefined);
    setBusy(true);
    try {
      await api("/api/auth/complete", { method: "POST", body: { url: pasted.trim() } });
      onSignedIn();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <dialog ref={dialog} className="dialog" onClose={onClose} aria-labelledby="signin-title">
      <h2 id="signin-title">Connect YouTube</h2>

      {!status?.hasClientSecrets ? (
        <>
          <p>Sortify needs an OAuth client from Google Cloud before you can sign in.</p>
          {status?.clientSecretsError && (
            <Notice tone="warn">The server says: {status.clientSecretsError}</Notice>
          )}
          <ol className="steps">
            <li>
              In Google Cloud Console, enable <strong>YouTube Data API v3</strong>.
            </li>
            <li>Create an OAuth client ID of type Desktop app and download its JSON file.</li>
            <li>
              Set <code>SORTIFY_CLIENT_SECRETS</code> to the contents of that file, or to its path.
              In a Codespace, add it as a Codespaces secret and restart the codespace; secrets only
              reach a codespace when it starts.
            </li>
            <li>
              Restart the backend (<code>sortify ui</code>) from a terminal where the variable is
              set.
            </li>
          </ol>
          <div className="dialog-actions">
            <Button onClick={onClose}>Close</Button>
          </div>
        </>
      ) : (
        <>
          <p>
            Sortify asks for permission to read your playlists and create new ones. It never changes
            or deletes existing playlists.
          </p>
          <ol className="steps">
            <li>
              <Button variant="primary" busy={busy && !opened} onClick={open}>
                Open Google sign-in
              </Button>
            </li>
            <li>
              Approve access. This page updates by itself when Google sends you back.
              <form className="paste-form" onSubmit={complete}>
                <label htmlFor="paste-url">
                  If the page after approving doesn't load, copy its address and paste it here:
                </label>
                <div className="add-row">
                  <input
                    id="paste-url"
                    type="text"
                    placeholder="http://127.0.0.1:4747/?state=…&code=…"
                    value={pasted}
                    onChange={(e) => setPasted(e.target.value)}
                    disabled={!opened}
                  />
                  <Button type="submit" busy={busy && opened} disabled={!pasted.trim()}>
                    Finish
                  </Button>
                </div>
              </form>
            </li>
          </ol>
          {error && <Notice tone="error">{error}</Notice>}
          <div className="dialog-actions">
            <Button variant="ghost" onClick={onClose}>
              Cancel
            </Button>
          </div>
        </>
      )}
    </dialog>
  );
}
