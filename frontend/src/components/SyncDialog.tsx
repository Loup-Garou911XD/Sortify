import type { DrivePart, DriveUsage, SyncView } from "../../../backend/src/api/types.ts";
import { useApp } from "../App.tsx";
import { bytes, plural, timeAgo } from "../hooks.ts";
import { IconRefresh, IconSignIn } from "./icons.tsx";
import { Button, Dialog, DialogRow, Notice, type Tone } from "./ui.tsx";

export const SYNC_LABEL = {
  idle: "Up to date",
  syncing: "Syncing…",
  offline: "Not reachable",
  "needs-auth": "Needs sign-in",
} as const satisfies Record<SyncView["state"], string>;

export const SYNC_TONE = {
  idle: "on",
  syncing: "sync",
  offline: "bad",
  "needs-auth": "bad",
} as const satisfies Record<SyncView["state"], Tone>;

/** How each part of the sync file is named, and what one of its items is called. */
const PARTS: Record<DrivePart, { label: string; item: string }> = {
  cache: { label: "Lookup cache", item: "answer" },
  tracks: { label: "Tracks", item: "track" },
  tags: { label: "Tags", item: "tagged track" },
  playlists: { label: "Playlists", item: "playlist" },
  plans: { label: "Plans", item: "plan" },
  keys: { label: "API keys", item: "key" },
  other: { label: "Bookkeeping", item: "deletion record" },
};

/**
 * What is in the Drive folder: one bar split by part, then each part with its count and size.
 * The parts are measured from this device's last upload, so they add up to the file as sent.
 */
function UsageBreakdown({ usage }: { usage: DriveUsage }) {
  const total = usage.parts.reduce((sum, p) => sum + p.bytes, 0) || 1;
  const share = (n: number) => `${Math.max(1, Math.round((100 * n) / total))}%`;
  return (
    <div className="usage">
      <div className="usage-bar" aria-hidden>
        {usage.parts.map((p) => (
          <span
            key={p.part}
            className={`usage-seg usage-${p.part}`}
            style={{ width: share(p.bytes) }}
          />
        ))}
      </div>
      <ul className="usage-list">
        {usage.parts.map((p) => (
          <li key={p.part}>
            <span className={`usage-swatch usage-${p.part}`} aria-hidden />
            <span className="usage-name">{PARTS[p.part].label}</span>
            <span className="usage-count">
              {p.part === "other" && p.count === 0
                ? "ids and format"
                : plural(p.count, PARTS[p.part].item)}
            </span>
            <span className="usage-size">
              {bytes(p.bytes)} <span className="usage-share">{share(p.bytes)}</span>
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** "2 playlists, 30 tracks and 1 plan", or null when every count is zero. */
function listOf(counts: [number, string][]): string | null {
  const parts = counts.filter(([n]) => n > 0).map(([n, noun]) => plural(n, noun));
  if (parts.length === 0) return null;
  return parts.length === 1
    ? (parts[0] ?? null)
    : `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
}

/** What the last sync changed here, in a sentence. */
function lastChange(sync: SyncView): string {
  const brought = listOf([
    [sync.brought.playlists, "playlist"],
    [sync.brought.tracks, "track"],
    [sync.brought.runs, "plan"],
    [sync.brought.keys, "API key"],
  ]);
  const removed = listOf([
    [sync.removed.playlists, "playlist"],
    [sync.removed.tracks, "track"],
    [sync.removed.runs, "plan"],
  ]);
  if (!brought && !removed) return "Nothing new: this device and Drive already agreed.";
  return [
    brought && `Brought in ${brought} from another device.`,
    removed && `Removed ${removed} deleted on another device.`,
  ]
    .filter(Boolean)
    .join(" ");
}

/**
 * Google Drive sync, opened from the Connections panel: its state, when it last ran, what that
 * run changed, anything about plans that needs a decision, and what travels. It reads `sync` from
 * the app, so it follows a sync that finishes while it is open.
 */
export function SyncDialog({ onClose }: { onClose: () => void }) {
  const { sync, syncNow, openSignIn, notify } = useApp();
  if (!sync) return null;

  const now = async () => {
    try {
      await syncNow();
    } catch (err) {
      notify("error", (err as Error).message);
    }
  };

  return (
    <Dialog
      title="Google Drive sync"
      status={{ tone: SYNC_TONE[sync.state], text: SYNC_LABEL[sync.state] }}
      onClose={onClose}
      actions={(close) =>
        sync.state === "needs-auth" ? (
          <>
            <Button variant="ghost" onClick={close}>
              Close
            </Button>
            <Button
              variant="primary"
              onClick={() => {
                close();
                openSignIn();
              }}
            >
              <IconSignIn size={15} />
              Sign in again
            </Button>
          </>
        ) : (
          <>
            <Button busy={sync.state === "syncing"} onClick={() => void now()}>
              {sync.state !== "syncing" && <IconRefresh size={15} />}
              Sync now
            </Button>
            <Button variant="primary" onClick={close}>
              Done
            </Button>
          </>
        )
      }
    >
      <p>
        Your playlists, tags and plans are kept in step across your devices through one file in a
        hidden Sortify folder in your Google Drive. Only your own Google client can read it, and it
        does not show up in Drive itself.
      </p>

      {sync.message && <Notice tone="error">{sync.message}</Notice>}
      {sync.conflictedRuns.length > 0 && (
        <Notice tone="warn">
          Plan {sync.conflictedRuns.join(", ")} is part-created on two devices and was left alone.
          Finish or delete it on one of them.
        </Notice>
      )}
      {sync.renamedRuns.length > 0 && (
        <Notice tone="info">
          Plans renumbered to keep them apart from another device's:{" "}
          {sync.renamedRuns.map((r) => `${r.from} → ${r.to}`).join(", ")}.
        </Notice>
      )}

      <DialogRow
        label="Space in Drive"
        help={
          sync.usage
            ? `${bytes(sync.usage.bytes)} in one file. It counts toward your Google account's storage, though it does not show up in Drive itself.`
            : "Shown after this device's first sync."
        }
        stacked={sync.usage !== null}
      >
        {sync.usage ? <UsageBreakdown usage={sync.usage} /> : undefined}
      </DialogRow>
      <DialogRow
        label="Last synced"
        help={sync.state === "syncing" ? "In progress" : timeAgo(sync.at)}
      />
      <DialogRow label="What it changed" help={lastChange(sync)} />
    </Dialog>
  );
}
