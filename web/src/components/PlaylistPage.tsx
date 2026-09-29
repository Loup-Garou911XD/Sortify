import { useState } from "react";
import type { PlaylistDetail } from "../../../src/api/types.ts";
import { useApp } from "../App.tsx";
import { fmt, pct, plural, timeAgo, useResource } from "../hooks.ts";
import { SortPanel } from "./SortPanel.tsx";
import { TracksTable } from "./TracksTable.tsx";
import { Button, Notice, Progress, Stat } from "./ui.tsx";

type Tab = "sort" | "tracks";

export function PlaylistPage({ playlistId }: { playlistId: string }) {
  const { version, job, status, startJob } = useApp();
  const detail = useResource<PlaylistDetail>(`/api/playlists/${playlistId}`, version);
  const [tab, setTab] = useState<Tab>("sort");
  const [error, setError] = useState<string>();
  const busy = job?.status === "running";
  const running = busy && job?.playlistId === playlistId ? job : null;

  if (detail.error) return <Notice tone="error">{detail.error}</Notice>;
  if (!detail.data) return <div className="page loading">Loading…</div>;

  const { playlist, tracks } = detail.data;
  const untagged = playlist.total - playlist.enriched;

  const run = async (path: string, body: unknown = {}) => {
    setError(undefined);
    try {
      await startJob(path, body);
    } catch (err) {
      setError((err as Error).message);
    }
  };

  return (
    <div className="page">
      <header className="page-header">
        <div>
          <h1>{playlist.title}</h1>
          <p className="meta">
            {plural(playlist.total, "track")} · read from YouTube {timeAgo(playlist.fetchedAt)} ·{" "}
            <a
              href={`https://music.youtube.com/playlist?list=${playlist.playlistId}`}
              target="_blank"
              rel="noreferrer"
            >
              Open on YouTube Music
            </a>
          </p>
        </div>
        <div className="page-actions">
          <Button
            variant="ghost"
            disabled={busy || !status?.signedIn}
            title={status?.signedIn ? "Read the playlist again to pick up new tracks" : undefined}
            onClick={() => run("/api/playlists", { url: playlist.playlistId })}
          >
            Refresh from YouTube
          </Button>
          <Button
            disabled={busy || playlist.enriched === 0}
            title="Re-tag every track; cached lookups are reused, so this is quick"
            onClick={() => run(`/api/playlists/${playlistId}/enrich`, { force: true })}
          >
            Re-tag all
          </Button>
          <Button
            variant="primary"
            disabled={busy || untagged === 0}
            onClick={() => run(`/api/playlists/${playlistId}/enrich`)}
          >
            {untagged === 0 ? "All tracks tagged" : `Tag ${plural(untagged, "track")}`}
          </Button>
        </div>
      </header>

      {error && <Notice tone="error">{error}</Notice>}
      {running?.kind === "enrich" && (
        <Notice tone="info">
          Tagging tracks…{" "}
          {running.progress && `${fmt(running.progress.done)} of ${fmt(running.progress.total)}`}.
          You can keep working; the page updates when it finishes.
        </Notice>
      )}
      {status && (!status.sources.discogs || !status.sources.lastfm) && untagged > 0 && (
        <Notice tone="warn">
          {!status.sources.discogs && !status.sources.lastfm
            ? "Discogs and Last.fm are not configured, so most tracks will end up Unsorted. "
            : !status.sources.discogs
              ? "Discogs is not configured, so subgenres come only from Last.fm and MusicBrainz. "
              : "Last.fm is not configured, so there will be no moods. "}
          Set {!status.sources.discogs && <code>DISCOGS_TOKEN</code>}
          {!status.sources.discogs && !status.sources.lastfm && " and "}
          {!status.sources.lastfm && <code>LASTFM_API_KEY</code>}, then restart{" "}
          <code>sortify ui</code>.
        </Notice>
      )}

      <section className="stats" aria-label="Tag coverage">
        <Stat
          label="Tagged"
          value={`${pct(playlist.enriched, playlist.total)}%`}
          sub={<Progress value={playlist.enriched} max={playlist.total} label="Tagged" />}
        />
        <Stat
          label="Have a subgenre"
          value={`${pct(playlist.withSubgenre, playlist.total)}%`}
          sub={<Progress value={playlist.withSubgenre} max={playlist.total} label="Subgenre" />}
        />
        <Stat
          label="Have a mood"
          value={`${pct(playlist.withMood, playlist.total)}%`}
          sub={<Progress value={playlist.withMood} max={playlist.total} label="Mood" />}
        />
      </section>

      <div className="tabs" role="tablist">
        <button
          type="button"
          role="tab"
          aria-selected={tab === "sort"}
          className={tab === "sort" ? "tab active" : "tab"}
          onClick={() => setTab("sort")}
        >
          Sort into playlists
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === "tracks"}
          className={tab === "tracks" ? "tab active" : "tab"}
          onClick={() => setTab("tracks")}
        >
          Tracks <span className="tab-count">{fmt(tracks.length)}</span>
        </button>
      </div>

      <div role="tabpanel">
        {tab === "sort" ? (
          <SortPanel playlistId={playlistId} tracks={tracks} />
        ) : (
          <TracksTable tracks={tracks} />
        )}
      </div>
    </div>
  );
}
