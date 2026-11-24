import { useState } from "react";
import { useApp } from "../App.tsx";
import { fmt, pct, planName } from "../hooks.ts";
import { AddPlaylistDialog } from "./AddPlaylistDialog.tsx";
import { IconPlus } from "./icons.tsx";
import { Button, Progress, StatusPill } from "./ui.tsx";

export function Sidebar({ path, open }: { path: string; open: boolean }) {
  const { playlists, runs, status, navigate, openSignIn } = useApp();
  const [adding, setAdding] = useState(false);

  const link = (href: string, title: string, meta: React.ReactNode) => (
    <a
      href={href}
      className={path === href ? "nav-item active" : "nav-item"}
      aria-current={path === href ? "page" : undefined}
      onClick={(e) => {
        e.preventDefault();
        navigate(href);
      }}
    >
      <span className="nav-title">{title}</span>
      {meta}
    </a>
  );

  return (
    <nav
      className={open ? "sidebar open" : "sidebar"}
      aria-label="Playlists and plans"
      id="sidebar"
    >
      <div className="add-form">
        <Button
          variant="primary"
          className="add-button"
          disabled={!status?.signedIn}
          onClick={() => setAdding(true)}
        >
          <IconPlus />
          Add a playlist
        </Button>
        {!status?.signedIn && (
          <p className="hint">
            <button type="button" className="link" onClick={openSignIn}>
              Connect YouTube
            </button>{" "}
            to add playlists.
          </p>
        )}
      </div>
      {adding && <AddPlaylistDialog onClose={() => setAdding(false)} />}

      <section className="rail-section">
        <div className="rail-head">
          <span className="eyebrow">Playlists</span>
          {playlists.length > 0 && <span className="rail-count">{playlists.length}</span>}
        </div>
        {playlists.length === 0 ? (
          <p className="rail-empty">None yet. Press Add a playlist above.</p>
        ) : (
          <ul className="nav-list">
            {playlists.map((p) => {
              const tagged = p.enriched;
              return (
                <li key={p.playlistId}>
                  {link(
                    `/playlists/${p.playlistId}`,
                    p.title,
                    <>
                      <span className="nav-meta">
                        {fmt(p.total)} tracks <span className="sep">·</span> {pct(tagged, p.total)}%
                        tagged
                      </span>
                      <Progress value={tagged} max={p.total} tone="muted" label="Tagged" />
                    </>,
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </section>

      {runs.length > 0 && (
        <section className="rail-section">
          <div className="rail-head">
            <span className="eyebrow">Plans</span>
            <span className="rail-count">{runs.length}</span>
          </div>
          <ul className="nav-list">
            {runs.map((r) => (
              <li key={r.runId}>
                {link(
                  `/runs/${r.runId}`,
                  planName(r),
                  <span className="nav-meta nav-meta-row">
                    <span className="ellipsis">from {r.sourceTitle}</span>
                    <StatusPill status={r.status} />
                  </span>,
                )}
              </li>
            ))}
          </ul>
        </section>
      )}
    </nav>
  );
}
