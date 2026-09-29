import { useState } from "react";
import type { Privacy, RunDetail } from "../../../src/api/types.ts";
import { useApp } from "../App.tsx";
import { api } from "../api.ts";
import { fmt, plural, quotaFor, timeAgo, useResource } from "../hooks.ts";
import { Button, Notice, Progress, StatusPill } from "./ui.tsx";

const BY = { subgenre: "subgenre", mood: "mood", type: "song type" } as const;

export function RunPage({ runId }: { runId: number }) {
  const { version, job, status, startJob, navigate, refresh, openSignIn } = useApp();
  const detail = useResource<RunDetail>(`/api/runs/${runId}`, version);
  const [privacy, setPrivacy] = useState<Privacy>("private");
  const [maxWrites, setMaxWrites] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [error, setError] = useState<string>();

  if (detail.error) return <Notice tone="error">{detail.error}</Notice>;
  if (!detail.data) return <div className="page loading">Loading…</div>;

  const { run, groups } = detail.data;
  const busy = job?.status === "running";
  const applyingThis = busy && job?.kind === "apply" && job.runId === runId ? job : null;
  const written = applyingThis?.progress?.done ?? run.written;
  const total = applyingThis?.progress?.total ?? run.total;
  const toCreate = groups.filter((g) => g.targetPlaylistId === null).length;
  const pending = run.total - run.written;
  const quota = quotaFor(toCreate, pending, status?.dailyQuota ?? 10_000);
  const neverApplied = groups.every((g) => g.targetPlaylistId === null);
  const writeLimit = Number(maxWrites) > 0 ? Math.floor(Number(maxWrites)) : undefined;

  const apply = async () => {
    setError(undefined);
    setConfirming(false);
    try {
      await startJob(`/api/runs/${runId}/apply`, { privacy, maxWrites: writeLimit });
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const remove = async () => {
    try {
      await api(`/api/runs/${runId}`, { method: "DELETE" });
      refresh();
      navigate(`/playlists/${run.sourcePlaylistId}`);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const openSource = (e: React.MouseEvent) => {
    e.preventDefault();
    navigate(`/playlists/${run.sourcePlaylistId}`);
  };

  return (
    <div className="page">
      <header className="page-header">
        <div>
          <p className="eyebrow">
            <a href={`/playlists/${run.sourcePlaylistId}`} onClick={openSource}>
              ← {run.sourceTitle}
            </a>
          </p>
          <h1>
            {plural(run.groupCount, "playlist")} by {BY[run.dimension]}
          </h1>
          <p className="meta">
            <StatusPill status={applyingThis ? "applying" : run.status} /> Planned{" "}
            {timeAgo(run.createdAt)} · {fmt(run.quotaUsed)} quota units used so far
          </p>
        </div>
        {neverApplied && !applyingThis && (
          <div className="page-actions">
            {confirmDelete ? (
              <>
                <span className="muted">Delete this plan?</span>
                <Button variant="ghost" onClick={() => setConfirmDelete(false)}>
                  Keep
                </Button>
                <Button variant="danger" onClick={remove}>
                  Delete
                </Button>
              </>
            ) : (
              <Button variant="ghost" onClick={() => setConfirmDelete(true)}>
                Delete plan
              </Button>
            )}
          </div>
        )}
      </header>

      {error && <Notice tone="error">{error}</Notice>}

      <section className="panel progress-panel" aria-label="Progress">
        <div className="progress-head">
          <strong>
            {fmt(written)} of {plural(total, "track")} added
          </strong>
          <span className="muted">
            {toCreate > 0
              ? `${plural(groups.length - toCreate, "playlist")} of ${groups.length} created`
              : "All playlists created"}
          </span>
        </div>
        <Progress value={written} max={total} tone={run.status === "done" ? "good" : "accent"} />
        {applyingThis && <p className="muted small">{applyingThis.log.at(-1) ?? "Starting…"}</p>}
      </section>

      {run.status !== "done" && !applyingThis && (
        <section className="panel apply-panel" aria-label="Create playlists">
          {!status?.signedIn ? (
            <Notice tone="warn">
              <button type="button" className="link" onClick={openSignIn}>
                Connect YouTube
              </button>{" "}
              to create these playlists.
            </Notice>
          ) : confirming ? (
            <div className="confirm">
              <p>
                {toCreate > 0 && (
                  <>
                    Create <strong>{plural(toCreate, `${privacy} playlist`)}</strong> and add{" "}
                  </>
                )}
                {toCreate === 0 && "Add "}
                <strong>{plural(pending, "track")}</strong>
                {writeLimit ? `, stopping after ${plural(writeLimit, "write")}` : ""}. This uses
                about {fmt(quota.units)} of your {fmt(status.dailyQuota)} daily quota units
                {quota.days > 1 && `, so it will take about ${quota.days} days`}. If the quota runs
                out, the plan pauses and you can resume it after midnight Pacific time.
              </p>
              <div className="confirm-actions">
                <Button variant="ghost" onClick={() => setConfirming(false)}>
                  Cancel
                </Button>
                <Button variant="primary" onClick={apply}>
                  {run.status === "planned" ? "Create playlists" : "Resume"}
                </Button>
              </div>
            </div>
          ) : (
            <div className="apply-row">
              <label className="control">
                <span className="control-label">New playlists are</span>
                <select
                  value={privacy}
                  onChange={(e) => setPrivacy(e.target.value as Privacy)}
                  disabled={toCreate === 0}
                >
                  <option value="private">Private</option>
                  <option value="unlisted">Unlisted</option>
                  <option value="public">Public</option>
                </select>
              </label>
              <label className="control">
                <span className="control-label">Stop after (optional)</span>
                <span className="number-field">
                  <input
                    type="number"
                    min={1}
                    placeholder="No limit"
                    value={maxWrites}
                    onChange={(e) => setMaxWrites(e.target.value)}
                  />
                  <span className="muted">writes</span>
                </span>
              </label>
              <Button
                variant="primary"
                disabled={busy}
                title={busy ? "Wait for the current task to finish" : undefined}
                onClick={() => setConfirming(true)}
              >
                {run.status === "planned" ? "Create playlists…" : "Resume…"}
              </Button>
            </div>
          )}
        </section>
      )}

      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th>Playlist</th>
              <th className="num">Tracks</th>
              <th className="progress-col">Added</th>
              <th>On YouTube</th>
            </tr>
          </thead>
          <tbody>
            {groups.map((g) => (
              <tr key={g.groupId}>
                <td>{g.name}</td>
                <td className="num">{fmt(g.total)}</td>
                <td className="progress-col">
                  <div className="inline-progress">
                    <Progress
                      value={g.written}
                      max={g.total}
                      tone={g.written === g.total ? "good" : "accent"}
                      label={`${g.name} added`}
                    />
                    <span className="muted small">{fmt(g.written)}</span>
                  </div>
                </td>
                <td>
                  {g.targetPlaylistId ? (
                    <a
                      href={`https://music.youtube.com/playlist?list=${g.targetPlaylistId}`}
                      target="_blank"
                      rel="noreferrer"
                    >
                      Open
                    </a>
                  ) : (
                    <span className="muted">Not created yet</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
