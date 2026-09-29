import { useApp } from "../App.tsx";
import { Button } from "./ui.tsx";

export function Welcome() {
  const { status, playlists, openSignIn } = useApp();
  const steps = [
    {
      title: "Connect YouTube",
      body: "Sign in so Sortify can read your playlists and create new ones.",
      done: status?.signedIn ?? false,
    },
    {
      title: "Add a playlist",
      body: "Paste a YouTube or YouTube Music playlist link in the sidebar.",
      done: playlists.length > 0,
    },
    {
      title: "Tag the tracks",
      body: "Subgenres come from Discogs, moods from Last.fm, and song types from the title.",
      done: playlists.some((p) => p.enriched > 0),
    },
    {
      title: "Sort and create",
      body: "Preview the new playlists, adjust them, then create them on YouTube.",
      done: false,
    },
  ];

  return (
    <div className="page welcome">
      <h1>Sort a big playlist into focused ones</h1>
      <p className="lead">
        Sortify splits a mixed playlist by subgenre, mood or song type. Nothing is written to
        YouTube until you approve the plan.
      </p>
      <ol className="welcome-steps">
        {steps.map((s, i) => (
          <li key={s.title} className={s.done ? "done" : ""}>
            <span className="step-num" aria-hidden>
              {s.done ? "✓" : i + 1}
            </span>
            <div>
              <div className="step-title">
                {s.title}
                {s.done && <span className="sr-only"> (done)</span>}
              </div>
              <div className="step-body">{s.body}</div>
              {i === 0 && !s.done && (
                <Button variant="primary" onClick={openSignIn} className="step-action">
                  Connect YouTube
                </Button>
              )}
            </div>
          </li>
        ))}
      </ol>
      {playlists.length > 0 && <p className="hint">Pick a playlist in the sidebar to continue.</p>}
    </div>
  );
}
