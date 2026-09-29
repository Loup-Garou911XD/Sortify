import { useEffect, useState } from "react";
import { useApp } from "../App.tsx";
import { api } from "../api.ts";
import { fmt } from "../hooks.ts";
import { Button, Progress } from "./ui.tsx";

const TITLE = {
  running: "",
  done: "Finished",
  failed: "Failed",
  cancelled: "Stopped",
} as const;

/** Shows the running background task, and its outcome until dismissed. */
export function JobBar() {
  const { job, navigate } = useApp();
  const [dismissed, setDismissed] = useState<number | null>(null);
  const [stopping, setStopping] = useState(false);

  // biome-ignore lint/correctness/useExhaustiveDependencies: reset when a new job appears
  useEffect(() => setStopping(false), [job?.id]);

  if (!job || dismissed === job.id) return null;
  const running = job.status === "running";
  const last = job.log.at(-1);

  return (
    <aside
      className={`jobbar jobbar-${job.status}`}
      aria-live="polite"
      aria-label="Background task"
    >
      <div className="jobbar-main">
        <div className="jobbar-text">
          <strong>{running ? job.label : `${TITLE[job.status]}: ${job.label}`}</strong>
          <span className="muted ellipsis">
            {running
              ? job.progress
                ? `${fmt(job.progress.done)} of ${fmt(job.progress.total)}${last ? ` · ${last}` : ""}`
                : (last ?? "Starting…")
              : job.message}
          </span>
        </div>
        {running && job.progress && (
          <Progress value={job.progress.done} max={job.progress.total} label={job.label} />
        )}
      </div>
      <div className="jobbar-actions">
        {!running && job.runId !== null && job.kind === "apply" && (
          <Button variant="ghost" onClick={() => navigate(`/runs/${job.runId}`)}>
            View plan
          </Button>
        )}
        {!running && job.kind === "fetch" && job.status === "done" && job.playlistId && (
          <Button variant="ghost" onClick={() => navigate(`/playlists/${job.playlistId}`)}>
            Open playlist
          </Button>
        )}
        {running ? (
          job.kind !== "fetch" && (
            <Button
              busy={stopping}
              onClick={async () => {
                setStopping(true);
                await api("/api/job/cancel", { method: "POST" }).catch(() => setStopping(false));
              }}
            >
              {stopping ? "Stopping…" : "Stop"}
            </Button>
          )
        ) : (
          <Button variant="ghost" onClick={() => setDismissed(job.id)}>
            Dismiss
          </Button>
        )}
      </div>
    </aside>
  );
}
