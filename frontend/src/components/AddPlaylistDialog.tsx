import { type FormEvent, useState } from "react";
import type { LibraryPlaylist, LibraryResponse } from "../../../backend/src/api/types.ts";
import { useApp } from "../App.tsx";
import { fmt, useResource } from "../hooks.ts";
import { IconPlus } from "./icons.tsx";
import { Button, Dialog, DialogRow } from "./ui.tsx";

/**
 * Adding a playlist, opened from the sidebar: paste a link, or pick one of the signed-in user's
 * own playlists. The list loads each time the dialog opens (1 quota unit per 50 playlists), so
 * one made a moment ago in YouTube shows up. One already added opens instead of being fetched
 * again. Adding starts a background task and closes the dialog; the job bar shows its progress.
 */
export function AddPlaylistDialog({ onClose }: { onClose: () => void }) {
  const { playlists, job, startJob, navigate } = useApp();
  const [url, setUrl] = useState("");
  const library = useResource<LibraryResponse>("/api/youtube/playlists");
  const items = library.data?.playlists;
  const [error, setError] = useState<string>();
  /** The link being added, or the id of the playlist picked from the list. */
  const [adding, setAdding] = useState<string>();
  const busy = job?.status === "running";
  const added = new Set(playlists.map((p) => p.playlistId));

  const add = async (source: string) => {
    setAdding(source);
    setError(undefined);
    try {
      await startJob("/api/playlists", { url: source });
      onClose();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setAdding(undefined);
    }
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (url.trim()) void add(url.trim());
  };
  const pick = (p: LibraryPlaylist) => {
    if (added.has(p.playlistId)) {
      navigate(`/playlists/${p.playlistId}`);
      onClose();
    } else {
      void add(p.playlistId);
    }
  };

  return (
    <Dialog
      title="Add a playlist"
      status={busy ? { tone: "sync", text: "A task is running" } : undefined}
      className="add-dialog"
      onClose={onClose}
      actions={(close) => (
        <Button variant="ghost" onClick={close}>
          Cancel
        </Button>
      )}
    >
      <DialogRow
        label="Paste a link"
        help="A youtube.com or music.youtube.com playlist link."
        stacked
      >
        <form className="add-row" onSubmit={submit}>
          <input
            type="text"
            inputMode="url"
            aria-label="Playlist link"
            placeholder="https://music.youtube.com/playlist?list=…"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            autoFocus
          />
          <Button
            type="submit"
            variant="primary"
            busy={adding === url.trim()}
            disabled={busy || adding !== undefined || !url.trim()}
          >
            Add
          </Button>
        </form>
      </DialogRow>

      <DialogRow
        label="Or pick one of yours"
        help="Liked videos, then the playlists you own. Ones Sortify made are left out."
        stacked
      >
        {library.error ? (
          <p className="field-error" role="alert">
            {library.error}
          </p>
        ) : !items ? (
          <p className="hint">
            <span className="spinner" aria-hidden /> Loading your playlists{"…"}
          </p>
        ) : (
          <ul className="nav-list library-list">
            {items.map((p) => {
              const isAdded = added.has(p.playlistId);
              return (
                <li key={p.playlistId}>
                  <button
                    type="button"
                    className="nav-item library-item"
                    disabled={!isAdded && (busy || adding !== undefined)}
                    title={isAdded ? "Already added: open it" : "Add this playlist"}
                    onClick={() => pick(p)}
                  >
                    <span className="nav-title">{p.title}</span>
                    <span className="nav-meta nav-meta-row">
                      <span>{p.count === null ? "Your likes" : `${fmt(p.count)} videos`}</span>
                      {adding === p.playlistId ? (
                        <span className="spinner" aria-hidden />
                      ) : isAdded ? (
                        <span className="library-added">Added</span>
                      ) : (
                        <IconPlus size={14} />
                      )}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </DialogRow>

      {busy && (
        <p className="dialog-note">Wait for the current task to finish before adding another.</p>
      )}
      {error && (
        <p className="field-error" role="alert">
          {error}
        </p>
      )}
    </Dialog>
  );
}
