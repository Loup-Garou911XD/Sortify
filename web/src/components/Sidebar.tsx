import { type FormEvent, useState } from "react";
import { useApp } from "../App.tsx";
import { fmt, pct } from "../hooks.ts";
import { Button, Progress, StatusPill } from "./ui.tsx";

const DIMENSION_LABEL = { subgenre: "subgenre", mood: "mood", type: "song type" } as const;

export function Sidebar({ path }: { path: string }) {
  const { playlists, runs, status, job, startJob, navigate, openSignIn } = useApp();
  const [url, setUrl] = useState("");
  const [error, setError] = useState<string>();
  const [adding, setAdding] = useState(false);
  const busy = job?.status === "running";

  const add = async (e: FormEvent) => {
    e.preventDefault();
    if (!url.trim()) return;
    setAdding(true);
    setError(undefined);
    try {
      await startJob("/api/playlists", { url: url.trim() });
      setUrl("");
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setAdding(false);
    }
  };

  return (
    <nav className="sidebar" aria-label="Playlists and plans">
      <form className="add-form" onSubmit={add}>
        <label htmlFor="add-url" className="section-title">
          Add a playlist
        </label>
        <div className="add-row">
          <input
            id="add-url"
            type="text"
            inputMode="url"
            placeholder="Playlist link"
            title="A youtube.com or music.youtube.com playlist link"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            disabled={!status?.signedIn}
          />
          <Button
            type="submit"
            variant="primary"
            busy={adding}
            disabled={!status?.signedIn || busy || !url.trim()}
          >
            Add
          </Button>
        </div>
        {!status?.signedIn && (
          <p className="hint">
            <button type="button" className="link" onClick={openSignIn}>
              Connect YouTube
            </button>{" "}
            to add playlists.
          </p>
        )}
        {busy && status?.signedIn && <p className="hint">Wait for the current task to finish.</p>}
        {error && (
          <p className="field-error" role="alert">
            {error}
          </p>
        )}
      </form>

      <div className="section-title">Playlists</div>
      {playlists.length === 0 ? (
        <p className="hint">Nothing here yet.</p>
      ) : (
        <ul className="nav-list">
          {playlists.map((p) => {
            const href = `/playlists/${p.playlistId}`;
            const tagged = Math.max(p.withSubgenre, p.withMood);
            return (
              <li key={p.playlistId}>
                <a
                  href={href}
                  className={path === href ? "nav-item active" : "nav-item"}
                  aria-current={path === href ? "page" : undefined}
                  onClick={(e) => {
                    e.preventDefault();
                    navigate(href);
                  }}
                >
                  <span className="nav-title">{p.title}</span>
                  <span className="nav-meta">
                    {fmt(p.total)} tracks · {pct(tagged, p.total)}% tagged
                  </span>
                  <Progress value={tagged} max={p.total} tone="muted" label="Tagged" />
                </a>
              </li>
            );
          })}
        </ul>
      )}

      {runs.length > 0 && (
        <>
          <div className="section-title">Saved plans</div>
          <ul className="nav-list">
            {runs.map((r) => {
              const href = `/runs/${r.runId}`;
              return (
                <li key={r.runId}>
                  <a
                    href={href}
                    className={path === href ? "nav-item active" : "nav-item"}
                    aria-current={path === href ? "page" : undefined}
                    onClick={(e) => {
                      e.preventDefault();
                      navigate(href);
                    }}
                  >
                    <span className="nav-title">{r.sourceTitle}</span>
                    <span className="nav-meta nav-meta-row">
                      <span>
                        {r.groupCount} playlists by {DIMENSION_LABEL[r.dimension]}
                      </span>
                      <StatusPill status={r.status} />
                    </span>
                  </a>
                </li>
              );
            })}
          </ul>
        </>
      )}
    </nav>
  );
}
