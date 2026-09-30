import { useState } from "react";
import type { Privacy, RunDetail } from "../../../backend/src/api/types.ts";
import { useApp } from "../App.tsx";
import { api } from "../api.ts";
import { fmt, plural, quotaFor, timeAgo, useResource } from "../hooks.ts";
import { IconArrowLeft, IconExternal, IconPlay, IconTrash } from "./icons.tsx";
import { Button, Field, Notice, PageSkeleton, Progress, StatusPill } from "./ui.tsx";

const BY = { subgenre: "subgenre", mood: "mood", type: "song type" } as const;

export function RunPage({ runId }: { runId: number }) {
  const { version, job, status, startJob, navigate, refresh, openSignIn, notify } = useApp();
  const detail = useResource<RunDetail>(`/api/runs/${runId}`, version);
  const [privacy, setPrivacy] = useState<Privacy>("private");
  const [maxWrites, setMaxWrites] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [error, setError] = useState<string>();

  if (detail.error)
    return (
      <div className="page page-narrow">
        <Notice tone="error">{detail.error}</Notice>
      </div>
    );
  if (!detail.data) return <PageSkeleton label="Loading the plan" />;

  const { run, groups } = detail.data;
  const busy = job?.status === "running";
  const applyingThis = busy && job?.kind === "apply" && job.runId === runId ? job : null;
  const written = applyingThis?.progress?.done ?? run.written;
  const total = applyingThis?.progress?.total ?? run.total;
  const toCreate = groups.filter((g) => g.targetPlaylistId === null).length;
  const created = groups.length - toCreate;
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
      notify("good", "Plan deleted.");
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
        <div className="page-heading">
          <a className="back-link" href={`/playlists/${run.sourcePlaylistId}`} onClick={openSource}>
            <IconArrowLeft />
            {run.sourceTitle}
          </a>
          <h1>
            {plural(run.groupCount, "playlist")} by {BY[run.dimension]}
          </h1>
          <p className="meta">
            <StatusPill status={applyingThis ? "applying" : run.status} />
            <span className="sep">·</span>
            <span>planned {timeAgo(run.createdAt)}</span>
            <span className="sep">·</span>
            <span>{fmt(run.quotaUsed)} quota units used</span>
          </p>
        </div>
        {!applyingThis && (
          <div className="page-actions">
            {confirmDelete ? (
              <>
                <span className="muted small" style={{ maxWidth: "46ch" }}>
                  Delete this plan?
                  {!neverApplied &&
                    ` Its ${plural(created, "playlist")} stay on YouTube${
                      run.status === "done" ? "" : ", and the rest can't be resumed"
                    }.`}
                </span>
                <Button variant="ghost" onClick={() => setConfirmDelete(false)}>
                  Keep
                </Button>
                <Button variant="danger" onClick={remove}>
                  Delete
                </Button>
              </>
            ) : (
              <Button variant="ghost" onClick={() => setConfirmDelete(true)}>
                <IconTrash />
                Delete plan
              </Button>
            )}
          </div>
        )}
      </header>

      {error && <Notice tone="error">{error}</Notice>}

      <section className="panel run-progress" aria-label="Progress">
        <div className="run-figures">
          <div className="run-figure">
            <strong>
              {fmt(written)} <span className="muted">/ {fmt(total)}</span>
            </strong>
            <span className="eyebrow">Tracks added</span>
          </div>
          <div className="run-figure">
            <strong>
              {fmt(created)} <span className="muted">/ {fmt(groups.length)}</span>
            </strong>
            <span className="eyebrow">Playlists created</span>
          </div>
        </div>
        <Progress value={written} max={total} tone={run.status === "done" ? "good" : "accent"} />
        {applyingThis && (
          <p className="muted small" style={{ margin: 0 }}>
            {applyingThis.log.at(-1) ?? "Starting…"}
          </p>
        )}
      </section>

      {run.status !== "done" && !applyingThis && (
        <section className="panel" aria-label="Create playlists">
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
              <Field label="New playlists are">
                <select
                  value={privacy}
                  onChange={(e) => setPrivacy(e.target.value as Privacy)}
                  disabled={toCreate === 0}
                >
                  <option value="private">Private</option>
                  <option value="unlisted">Unlisted</option>
                  <option value="public">Public</option>
                </select>
              </Field>
              <Field label="Stop after (optional)">
                <span className="number-field">
                  <input
                    type="number"
                    min={1}
                    placeholder="No limit"
                    value={maxWrites}
                    onChange={(e) => setMaxWrites(e.target.value)}
                  />
                  <span className="muted small">writes</span>
                </span>
              </Field>
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
        <div className="table-scroll">
          <table className="table">
            <thead>
              <tr>
                <th>Playlist</th>
                <th className="num">Tracks</th>
                <th className="col-progress">Added</th>
                <th>On YouTube</th>
                <th title="Temporary youtube.com playlists: no quota or sign-in needed, 50 tracks per link">
                  Play without quota
                </th>
              </tr>
            </thead>
            <tbody>
              {groups.map((g) => (
                <tr key={g.groupId}>
                  <td style={{ fontWeight: 550 }}>{g.name}</td>
                  <td className="num">{fmt(g.total)}</td>
                  <td className="col-progress">
                    <div className="inline-meter">
                      <Progress
                        value={g.written}
                        max={g.total}
                        tone={g.written === g.total ? "good" : "accent"}
                        label={`${g.name} added`}
                      />
                      <span>{fmt(g.written)}</span>
                    </div>
                  </td>
                  <td>
                    {g.targetPlaylistId ? (
                      <a
                        className="ext-link"
                        href={`https://music.youtube.com/playlist?list=${g.targetPlaylistId}`}
                        target="_blank"
                        rel="noreferrer"
                      >
                        Open
                        <IconExternal />
                      </a>
                    ) : (
                      <span className="faint">Not created yet</span>
                    )}
                  </td>
                  <td>
                    <WatchLinks name={g.name} links={g.watchLinks} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

/** One link per 50 tracks; YouTube opens each as a temporary playlist. */
function WatchLinks({ name, links }: { name: string; links: string[] }) {
  if (links.length === 0) return <span className="faint">No tracks</span>;
  if (links.length === 1) {
    return (
      <a className="ext-link" href={links[0]} target="_blank" rel="noreferrer">
        <IconPlay />
        Play
      </a>
    );
  }
  return (
    <span className="link-row">
      {links.map((link, i) => (
        <a
          key={link}
          className={i === 0 ? "ext-link" : undefined}
          href={link}
          target="_blank"
          rel="noreferrer"
          aria-label={`Play ${name}, part ${i + 1} of ${links.length}`}
        >
          {i === 0 ? (
            <>
              <IconPlay />
              Play 1
            </>
          ) : (
            i + 1
          )}
        </a>
      ))}
    </span>
  );
}
