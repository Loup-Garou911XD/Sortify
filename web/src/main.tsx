import { StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";
import { App } from "../../frontend/src/App.tsx";
import "../../frontend/src/styles.css";
import "./web.css";
import { providerStatuses } from "../../backend/src/enrich/providers.ts";
import { boot } from "./api.ts";
import { completeAuth } from "./auth.ts";
import { ImportDialog } from "./ImportDialog.tsx";
import { KeyDialog } from "./KeyDialog.tsx";
import { getKeys } from "./settings.ts";
import { BrowserStore } from "./store.ts";

/**
 * The tab Google sends the browser back to. It finishes the exchange, then closes itself — the
 * tab that started sign-in is already polling `/api/status`, and localStorage is shared between
 * them, so it notices on its own.
 */
async function handleOAuthRedirect(): Promise<boolean> {
  const params = new URLSearchParams(location.search);
  if (!params.has("code") && !params.has("error")) return false;

  const root = document.getElementById("root");
  const say = (text: string) => {
    if (root) root.innerHTML = `<div class="callback"><p>${text}</p></div>`;
  };
  try {
    await completeAuth(location.href);
    say("YouTube is connected. You can close this tab.");
  } catch (err) {
    say(`Sign-in failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  // Drop the code from the address bar either way, so a reload cannot replay it.
  history.replaceState(null, "", location.pathname);
  close();
  return true;
}

function Root() {
  // Which dialog is open: a provider id, "account" for the Google client, or "import".
  const [editing, setEditing] = useState<string | null>(null);
  // Saving a key changes what /api/status reports, so remount the app to pick it up.
  const [generation, setGeneration] = useState(0);
  const close = () => setEditing(null);
  const bump = () => setGeneration((g) => g + 1);
  return (
    <>
      <App key={generation} configureSource={setEditing} />
      {editing === "import" ? (
        <ImportDialog onClose={close} onSaved={bump} />
      ) : editing ? (
        <KeyDialog
          key={editing}
          sourceId={editing}
          source={providerStatuses(getKeys()).find((s) => s.id === editing)}
          onClose={close}
          onSaved={bump}
        />
      ) : null}
    </>
  );
}

async function start(): Promise<void> {
  if (await handleOAuthRedirect()) return;
  boot(await BrowserStore.open());
  const root = document.getElementById("root");
  if (root)
    createRoot(root).render(
      <StrictMode>
        <Root />
      </StrictMode>,
    );
}

void start();
