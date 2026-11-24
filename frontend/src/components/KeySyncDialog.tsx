import { useState } from "react";
import type { KeySyncView } from "../../../backend/src/api/types.ts";
import { useApp } from "../App.tsx";
import { api } from "../api.ts";
import { plural } from "../hooks.ts";
import { IconInbox, IconTrash } from "./icons.tsx";
import { Button, Dialog, DialogRow, Notice, Segmented } from "./ui.tsx";

/**
 * Everything about syncing tag-source keys through Google Drive, opened from the Connections
 * panel: this device's switch, sharing its own keys, and removing them from every device. Each
 * action answers with the new state, which the dialog shows at once.
 *
 * Where the device can rewrite its own keys (`keysMovable`: the static build), turning sync on
 * moves them into Drive and there is no `.env` to upload from (see backend/src/server/keys.ts).
 */
export function KeySyncDialog({ initial, onClose }: { initial: KeySyncView; onClose: () => void }) {
  const { notify, refresh } = useApp();
  const [view, setView] = useState(initial);
  const [busy, setBusy] = useState<"sync" | "share" | "forget">();
  const [confirmingForget, setConfirmingForget] = useState(false);
  const keys = (n: number) => plural(n, "key");

  const run = async (
    kind: "sync" | "share" | "forget",
    done: (next: KeySyncView) => string,
    body?: unknown,
  ) => {
    setBusy(kind);
    try {
      const next = await api<KeySyncView>(`/api/keys/${kind}`, { method: "POST", body });
      setView(next);
      setConfirmingForget(false);
      notify("good", done(next));
      refresh();
    } catch (err) {
      notify("error", (err as Error).message);
    } finally {
      setBusy(undefined);
    }
  };

  const toggle = (on: boolean) => {
    if (on === view.enabled || busy) return;
    void run(
      "sync",
      (next) =>
        next.enabled
          ? `Key sync is on here: ${keys(next.inDrive.length)} in Google Drive.`
          : "Key sync is off on this device.",
      { enabled: on },
    );
  };

  return (
    <Dialog
      title="API keys"
      status={view.enabled ? { tone: "on", text: "On here" } : { tone: "off", text: "Off here" }}
      onClose={onClose}
    >
      <p>
        Share your tag-source keys (Discogs, Last.fm, Spotify and the iTunes store) between your
        devices, through the same hidden Sortify folder in your Google Drive that carries your
        playlists and tags.
      </p>

      <DialogRow
        label="Use synced keys on this device"
        help={
          view.keysMovable
            ? "Turning it on moves this browser's keys into Drive, so an edit made on any device reaches the others."
            : "Keys in this device's .env always come first; synced keys only fill in the sources it has no key for."
        }
      >
        <Segmented
          label="Use synced keys on this device"
          value={view.enabled ? "on" : "off"}
          options={[
            { value: "off", label: "Off" },
            { value: "on", label: busy === "sync" ? "…" : "On" },
          ]}
          onChange={(v) => toggle(v === "on")}
        />
      </DialogRow>

      <DialogRow
        label="In your Google Drive"
        help={
          view.inDrive.length > 0 ? (
            <span className="source-keys">
              {view.inDrive.map((name) => (
                <code key={name}>{name}</code>
              ))}
            </span>
          ) : (
            "No keys yet."
          )
        }
      />

      {!view.keysMovable && view.enabled && (
        <DialogRow
          label="Share this device's keys"
          help="Copies the tag-source keys from this device's .env into Drive. The .env file is not changed."
        >
          <Button
            busy={busy === "share"}
            disabled={busy !== undefined}
            onClick={() =>
              void run(
                "share",
                (next) => `Shared this device's keys: ${keys(next.inDrive.length)} in Drive.`,
              )
            }
          >
            {busy !== "share" && <IconInbox size={15} />}
            Upload from .env
          </Button>
        </DialogRow>
      )}

      {view.inDrive.length > 0 &&
        (confirmingForget ? (
          <Notice tone="warn">
            <p>
              The {keys(view.inDrive.length)} in Drive will be removed on every device at its next
              sync, and key sync turns off here.{" "}
              {view.keysMovable
                ? "This browser keeps a copy, so its tag sources keep working."
                : "Keys in this device's .env are untouched; other devices that relied on the synced keys lose those sources until their keys are set again."}
            </p>
            <div className="notice-actions">
              <Button
                variant="ghost"
                disabled={busy !== undefined}
                onClick={() => setConfirmingForget(false)}
              >
                Keep them
              </Button>
              <Button
                variant="danger"
                busy={busy === "forget"}
                disabled={busy !== undefined}
                onClick={() => void run("forget", () => "Removed the keys from Google Drive.")}
              >
                Remove from every device
              </Button>
            </div>
          </Notice>
        ) : (
          <DialogRow
            label="Remove keys from Drive"
            help="Deletes them on every device, not just this one."
          >
            <Button
              variant="ghost"
              disabled={busy !== undefined}
              onClick={() => setConfirmingForget(true)}
            >
              <IconTrash size={15} />
              Remove
            </Button>
          </DialogRow>
        ))}

      <p className="dialog-note">
        Your Google sign-in and Google client never go to Drive. Reading the file already takes a
        Google sign-in that can do far more than these keys, which only read public music metadata.
      </p>
    </Dialog>
  );
}
