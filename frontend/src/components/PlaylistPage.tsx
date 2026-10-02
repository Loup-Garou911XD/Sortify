import { useState } from "react";
import type { PlaylistDetail } from "../../../backend/src/api/types.ts";
import { useApp } from "../App.tsx";
import { api } from "../api.ts";
import { fmt, pct, plural, timeAgo, useResource } from "../hooks.ts";
import { IconExternal, IconRefresh, IconTag, IconTrash } from "./icons.tsx";
import { SortPanel } from "./SortPanel.tsx";
import { TracksTable } from "./TracksTable.tsx";
import { Button, ConfirmDialog, InfoTip, Notice, PageSkeleton, Progress, Stat } from "./ui.tsx";

type Tab = "sort" | "tracks";

export function PlaylistPage({ playlistId }: { playlistId: string }) {
  const { version, job, status, startJob, navigate, refresh, notify, runs, configureSource } =
    useApp();
  const detail = useResource<PlaylistDetail>(`/api/playlists/${playlistId}`, version);
  const [tab, setTab] = useState<Tab>("sort");
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string>();
  const busy = job?.status === "running";
  const running = busy && job?.playlistId === playlistId ? job : null;

  if (detail.error)
    return (
      <div className="page page-narrow">
        <Notice tone="error">{detail.error}</Notice>
      </div>
    );
  if (!detail.data) return <PageSkeleton label="Loading the playlist" />;

  const { playlist, tracks } = detail.data;
  const untagged = playlist.total - playlist.enriched;
  const missingSources = status?.sources.filter((s) => !s.configured) ?? [];

  const plans = runs.filter((r) => r.sourcePlaylistId === playlistId);

  const remove = async () => {
    setError(undefined);
    setDeleting(true);
    try {
      await api(`/api/playlists/${playlistId}`, { method: "DELETE" });
      notify("good", `Removed "${playlist.title}".`);
      refresh();
      navigate("/");
    } catch (err) {
      setConfirmDelete(false);
      setError((err as Error).message);
    } finally {
      setDeleting(false);
    }
  };

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
        <div className="page-heading">
          <h1>{playlist.title}</h1>
          <p className="meta">
            <span>{plural(playlist.total, "track")}</span>
            <span className="sep">·</span>
            <span>read {timeAgo(playlist.fetchedAt)}</span>
            <span className="sep">·</span>
            <a
              className="ext-link"
              href={`https://music.youtube.com/playlist?list=${playlist.playlistId}`}
              target="_blank"
              rel="noreferrer"
            >
              YouTube Music
              <IconExternal />
            </a>
          </p>
        </div>
        <div className="page-actions">
          <Button
            variant="ghost"
            disabled={busy}
            title={busy ? "Wait for the current task to finish" : undefined}
            onClick={() => setConfirmDelete(true)}
          >
            <IconTrash />
            Delete
          </Button>
          <Button
            variant="ghost"
            disabled={busy || !status?.signedIn}
            title={
              status?.signedIn
                ? "Read the playlist again to pick up new tracks"
                : "Connect YouTube first"
            }
            onClick={() => run("/api/playlists", { url: playlist.playlistId })}
          >
            <IconRefresh />
            Refresh
          </Button>
          <Button
            disabled={busy || playlist.enriched === 0}
            title="Re-tag every track; cached lookups are reused, so this is quick"
            onClick={() => run(`/api/playlists/${playlistId}/enrich`, { force: true })}
          >
            Re-tag all
          </Button>
          {missingSources.length > 0 && untagged > 0 && (
            <InfoTip
              tone="warn"
              label={`${plural(missingSources.length, "tag source")} off, so tracks will miss tags`}
            >
              <strong>
                {missingSources.length === status?.sources.length
                  ? "No tag source is configured,"
                  : `${plural(missingSources.length, "tag source")} off,`}
              </strong>{" "}
              so tracks will miss their tags.
              <ul>
                {missingSources.map((s) => (
                  <li key={s.id}>
                    <strong>{s.label}:</strong> {s.help}
                    {!configureSource && (
                      <>
                        {" "}
                        Set{" "}
                        {s.envVars.map((v, i) => (
                          <span key={v}>
                            {i > 0 && " and "}
                            <code>{v}</code>
                          </span>
                        ))}
                        .
                      </>
                    )}
                  </li>
                ))}
              </ul>
              <p className="infotip-foot">
                {configureSource ? (
                  "Add their keys under Connections, in the top bar."
                ) : (
                  <>
                    Then restart <code>sortify ui</code>.
                  </>
                )}
              </p>
            </InfoTip>
          )}
          <Button
            variant="primary"
            disabled={busy || untagged === 0}
            onClick={() => run(`/api/playlists/${playlistId}/enrich`)}
          >
            <IconTag />
            {untagged === 0 ? "All tracks tagged" : `Tag ${plural(untagged, "track")}`}
          </Button>
        </div>
      </header>

      {error && <Notice tone="error">{error}</Notice>}
      {running?.kind === "enrich" && (
        <Notice tone="info">
          Tagging tracks
          {running.progress && ` — ${fmt(running.progress.done)} of ${fmt(running.progress.total)}`}
          . You can keep working; this page updates when it finishes.
        </Notice>
      )}

      <section className="stats" aria-label="Tag coverage">
        <Stat
          label="Tagged"
          value={`${pct(playlist.enriched, playlist.total)}%`}
          sub={
            <>
              <Progress value={playlist.enriched} max={playlist.total} label="Tagged" />
              <span className="stat-sub">
                {fmt(playlist.enriched)} of {fmt(playlist.total)} tracks
              </span>
            </>
          }
        />
        <Stat
          label="Have a subgenre"
          value={`${pct(playlist.withSubgenre, playlist.total)}%`}
          sub={
            <>
              <Progress value={playlist.withSubgenre} max={playlist.total} label="Subgenre" />
              <span className="stat-sub">{fmt(playlist.withSubgenre)} tracks</span>
            </>
          }
        />
        <Stat
          label="Have a mood"
          value={`${pct(playlist.withMood, playlist.total)}%`}
          sub={
            <>
              <Progress value={playlist.withMood} max={playlist.total} label="Mood" />
              <span className="stat-sub">{fmt(playlist.withMood)} tracks</span>
            </>
          }
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

      {confirmDelete && (
        <ConfirmDialog
          title={`Delete “${playlist.title}”?`}
          confirmLabel="Delete playlist"
          variant="danger"
          busy={deleting}
          onConfirm={remove}
          onCancel={() => setConfirmDelete(false)}
        >
          <p>
            Sortify forgets this playlist, along with the tags on the{" "}
            {plural(playlist.total, "track")} no other playlist holds
            {plans.length > 0 && <>, and {plural(plans.length, "plan")} made from it</>}.
          </p>
          <p>
            Nothing on YouTube changes: this playlist stays in your account, and so does every
            playlist Sortify has already created from it.
          </p>
        </ConfirmDialog>
      )}
    </div>
  );
}
