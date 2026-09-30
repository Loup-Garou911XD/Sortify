import { useApp } from "../App.tsx";
import { fmt, pct, plural } from "../hooks.ts";
import { Button, Progress, StatusPill } from "./ui.tsx";

const BY = { subgenre: "subgenre", mood: "mood", type: "song type" } as const;

export function Home() {
  const { status, playlists, runs, navigate, openSignIn } = useApp();

  const steps = [
    {
      title: "Connect YouTube",
      text: "Sign in so Sortify can read your playlists and create new ones.",
      done: status?.signedIn ?? false,
    },
    {
      title: "Add a playlist",
      text: "Paste a YouTube or YouTube Music playlist link in the sidebar.",
      done: playlists.length > 0,
    },
    {
      title: "Tag the tracks",
      text: "Subgenres, moods and song types are looked up from music metadata services.",
      done: playlists.some((p) => p.enriched > 0),
    },
    {
      title: "Sort and create",
      text: "Preview the new playlists, adjust them, then create them on YouTube.",
      done: runs.some((r) => r.status === "done"),
    },
  ];
  const current = steps.findIndex((s) => !s.done);
  // Once there is something to come back to, the page is a library, not a pitch.
  const setUp = Boolean(status?.signedIn) && playlists.length > 0;
  const tracks = playlists.reduce((sum, p) => sum + p.total, 0);

  const go = (to: string) => (e: React.MouseEvent) => {
    e.preventDefault();
    navigate(to);
  };

  const stepList = (
    <ol className="steps-flow">
      {steps.map((s, i) => (
        <li
          key={s.title}
          className={`step${s.done ? " done" : ""}${i === current ? " current" : ""}`}
        >
          <span className="step-num" aria-hidden>
            {s.done ? "✓" : i + 1}
          </span>
          <div className="step-body">
            <div className="step-title">
              {s.title}
              {s.done && <span className="sr-only"> (done)</span>}
            </div>
            <div className="step-text">{s.text}</div>
            {i === 0 && !s.done && (
              <Button variant="primary" onClick={openSignIn} className="step-action">
                Connect YouTube
              </Button>
            )}
          </div>
        </li>
      ))}
    </ol>
  );

  return (
    <div className="page">
      {setUp ? (
        <header className="page-header">
          <div className="page-heading">
            <h1>Library</h1>
            <p className="meta">
              <span>{plural(playlists.length, "playlist")}</span>
              <span className="sep">·</span>
              <span>{plural(tracks, "track")}</span>
              {runs.length > 0 && (
                <>
                  <span className="sep">·</span>
                  <span>{plural(runs.length, "plan")}</span>
                </>
              )}
            </p>
          </div>
        </header>
      ) : (
        <>
          <header className="hero">
            <h1>Split one big playlist into focused ones</h1>
            <p className="lead">
              Sortify reads a playlist, tags every track with a subgenre, mood and song type, then
              groups them. Nothing is written to YouTube until you approve the plan.
            </p>
          </header>
          {stepList}
        </>
      )}

      {playlists.length > 0 && (
        <section className="home-section">
          <span className="eyebrow">Playlists</span>
          <div className="card-grid">
            {playlists.map((p) => {
              const tagged = Math.max(p.withSubgenre, p.withMood);
              return (
                <a
                  key={p.playlistId}
                  className="card"
                  href={`/playlists/${p.playlistId}`}
                  onClick={go(`/playlists/${p.playlistId}`)}
                >
                  <span className="card-title">{p.title}</span>
                  <Progress value={tagged} max={p.total} tone="muted" label="Tagged" />
                  <span className="card-meta">
                    <span>{plural(p.total, "track")}</span>
                    <span>{pct(tagged, p.total)}% tagged</span>
                  </span>
                </a>
              );
            })}
          </div>
        </section>
      )}

      {runs.length > 0 && (
        <section className="home-section">
          <span className="eyebrow">Plans</span>
          <div className="card-grid">
            {runs.map((r) => (
              <a
                key={r.runId}
                className="card"
                href={`/runs/${r.runId}`}
                onClick={go(`/runs/${r.runId}`)}
              >
                <span className="card-title">
                  {r.groupCount} playlists by {BY[r.dimension]}
                </span>
                <Progress
                  value={r.written}
                  max={r.total}
                  tone={r.status === "done" ? "good" : "accent"}
                  label="Tracks added"
                />
                <span className="card-meta">
                  <span className="ellipsis">
                    {fmt(r.written)} of {fmt(r.total)} added
                  </span>
                  <StatusPill status={r.status} />
                </span>
              </a>
            ))}
          </div>
        </section>
      )}

      {setUp && current !== -1 && (
        <section className="home-section">
          <span className="eyebrow">Next steps</span>
          {stepList}
        </section>
      )}
    </div>
  );
}
