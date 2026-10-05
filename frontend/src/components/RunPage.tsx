import { useState } from "react";
import type { Privacy, RunDetail } from "../../../backend/src/api/types.ts";
import { useApp } from "../App.tsx";
import { api } from "../api.ts";
import { fmt, planName, plural, quotaFor, timeAgo, UNSORTED, useResource } from "../hooks.ts";
import { IconArrowLeft, IconExternal, IconMusic, IconPlay, IconTrash } from "./icons.tsx";
import { Button, ConfirmDialog, Field, Notice, PageSkeleton, Progress, StatusPill } from "./ui.tsx";

export function RunPage({ runId }: { runId: number }) {
  const { version, job, status, startJob, navigate, refresh, openSignIn, notify } = useApp();
  const detail = useResource<RunDetail>(`/api/runs/${runId}`, version);
  const [privacy, setPrivacy] = useState<Privacy>("private");
  const [maxWrites, setMaxWrites] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string>();

  if (detail.error)
    return (
      <div className="page page-narrow">
        <Notice tone="error">{detail.error}</Notice>
      </div>
    );
  if (!detail.data) return <PageSkeleton label="Loading the plan" />;

  const { run, groups, untagged } = detail.data;
  const busy = job?.status === "running";
  const applyingThis = busy && job?.kind === "apply" && job.runId === runId ? job : null;
  const written = applyingThis?.progress?.done ?? run.written;
  const total = applyingThis?.progress?.total ?? run.total;
  const toCreate = groups.filter((g) => g.targetPlaylistId === null).length;
  const created = groups.length - toCreate;
  const pending = run.total - run.written;
  const quota = quotaFor(toCreate, pending, status?.dailyQuota ?? 10_000);
  const neverApplied = groups.every((g) => g.targetPlaylistId === null);
  // Untagged tracks are in this plan only if it kept the leftover group for them.
  const hasUnsorted = groups.some((g) => g.name === UNSORTED);
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
    setError(undefined);
    setDeleting(true);
    try {
      await api(`/api/runs/${runId}`, { method: "DELETE" });
      notify("good", "Plan deleted.");
      refresh();
      navigate(`/playlists/${run.sourcePlaylistId}`);
    } catch (e) {
      setConfirmDelete(false);
      setError((e as Error).message);
    } finally {
      setDeleting(false);
    }
  };

  const openSource = (e: React.MouseEvent) => {
    e.preventDefault();
    navigate(`/playlists/${run.sourcePlaylistId}`);
  };

  /** Said on the page and again in the confirmation, which is the last point of no return. */
  const untaggedWarning = (
    <>
      {plural(untagged, "track")} in “{run.sourceTitle}” {untagged === 1 ? "has" : "have"} no tags
      yet, so{" "}
      {hasUnsorted
        ? `${untagged === 1 ? "it sits" : "they all sit"} in Unsorted here.`
        : `${untagged === 1 ? "it is" : "they are"} in none of these playlists.`}{" "}
      To sort {untagged === 1 ? "it" : "them"} properly, tag{" "}
      <button type="button" className="link" onClick={openSource}>
        the playlist
      </button>{" "}
      and make a new plan.
    </>
  );

  return (
    <div className="page">
      <header className="page-header">
        <div className="page-heading">
          <a className="back-link" href={`/playlists/${run.sourcePlaylistId}`} onClick={openSource}>
            <IconArrowLeft />
            {run.sourceTitle}
          </a>
          <h1>{planName(run)}</h1>
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
            <Button variant="ghost" onClick={() => setConfirmDelete(true)}>
              <IconTrash />
              Delete plan
            </Button>
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

      {run.status !== "done" && !applyingThis && !status?.signedIn && (
        <Notice tone="warn">
          <button type="button" className="link" onClick={openSignIn}>
            Connect YouTube
          </button>{" "}
          to create these playlists.
        </Notice>
      )}
      {run.status !== "done" && !applyingThis && untagged > 0 && (
        <Notice tone="warn">{untaggedWarning}</Notice>
      )}
      {run.status !== "done" && !applyingThis && status?.signedIn && (
        <section className="panel" aria-label="Create playlists">
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
        </section>
      )}

      {confirming && status?.signedIn && (
        <ConfirmDialog
          title={run.status === "planned" ? "Create these playlists?" : "Resume this plan?"}
          confirmLabel={run.status === "planned" ? "Create playlists" : "Resume"}
          onConfirm={apply}
          onCancel={() => setConfirming(false)}
        >
          <p>
            {toCreate > 0 && (
              <>
                Create <strong>{plural(toCreate, `${privacy} playlist`)}</strong> and add{" "}
              </>
            )}
            {toCreate === 0 && "Add "}
            <strong>{plural(pending, "track")}</strong>
            {writeLimit ? `, stopping after ${plural(writeLimit, "write")}` : ""}. This uses about{" "}
            {fmt(quota.units)} of your {fmt(status.dailyQuota)} daily quota units
            {quota.days > 1 && `, so it will take about ${quota.days} days`}. If the quota runs out,
            the plan pauses and you can resume it after midnight Pacific time.
          </p>
          {/* The last chance to notice: after this, the untagged tracks are written as they are. */}
          {untagged > 0 && <Notice tone="warn">{untaggedWarning}</Notice>}
        </ConfirmDialog>
      )}

      <div className="table-wrap">
        <div className="table-scroll">
          <table className="table">
            <thead>
              <tr>
                <th>Playlist</th>
                <th className="num">Tracks</th>
                <th title="Temporary playlists: no quota or sign-in needed, 50 tracks per link">
                  Play without quota
                </th>
                <th className="col-progress">Added</th>
                <th>On YouTube</th>
              </tr>
            </thead>
            <tbody>
              {groups.map((g) => (
                <tr key={g.groupId}>
                  <td style={{ fontWeight: 550 }}>{g.name}</td>
                  <td className="num">{fmt(g.total)}</td>
                  <td>
                    <PlayLinks
                      runId={runId}
                      groupId={g.groupId}
                      name={g.name}
                      links={g.watchLinks}
                      inMusic={status?.opensInMusic ?? false}
                    />
                  </td>
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
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {groups.some((g) => g.watchLinks.length > 0) && (
        <div className="hint play-note">
          {status?.opensInMusic ? (
            <>
              <p>{playNoteLead} and the Music link opens the same tracks there:</p>
              <ol>
                <li>
                  Follow the <strong>Music</strong> link.
                </li>
                {saveStep}
              </ol>
            </>
          ) : (
            <>
              <p>
                {playNoteLead} but we cannot open it there directly from here. To do it by hand:
              </p>
              <ol>
                <li>
                  Follow a <strong>Play</strong> link.
                </li>
                <li>
                  In the address bar, change <code>www.youtube.com</code> to{" "}
                  <code>music.youtube.com</code>, leaving the rest of the address alone.
                </li>
                {saveStep}
              </ol>
            </>
          )}
        </div>
      )}

      {confirmDelete && (
        <ConfirmDialog
          title="Delete this plan?"
          confirmLabel="Delete plan"
          variant="danger"
          busy={deleting}
          onConfirm={remove}
          onCancel={() => setConfirmDelete(false)}
        >
          <p>
            Sortify forgets this plan and its {plural(run.groupCount, "group")}. The playlist it was
            made from, “{run.sourceTitle}”, and its tags are untouched.
          </p>
          {!neverApplied && (
            <p>
              The {plural(created, "playlist")} it has already created{" "}
              {created === 1 ? "stays" : "stay"} on YouTube
              {run.status === "done"
                ? "."
                : ", and the tracks it had not added yet cannot be resumed."}
            </p>
          )}
        </ConfirmDialog>
      )}
    </div>
  );
}

const playNoteLead = (
  <>
    The <strong>Play without quota</strong> link opens a temporary playlist on YouTube, and YouTube
    has no button to save it. YouTube Music has one,
  </>
);

const saveStep = (
  <li>
    Press <strong>Save</strong> above the queue. The untitled list gets saved in your library, and
    it still costs no api quota.
  </li>
);

/**
 * Where to hear a group without spending quota: a youtube.com temporary playlist and, where this
 * shell can resolve it, the same tracks in YouTube Music. YouTube caps each link at 50 tracks, so
 * a bigger group has several parts; a picker chooses one rather than a row of numbered links.
 *
 * The Music URL cannot be written here: YouTube only mints the temporary playlist when it answers
 * the watch_videos request, and a page is not allowed to read that answer. So the tab is opened
 * empty on the click, which keeps it out of the popup blocker, and pointed somewhere once the
 * server has asked.
 */
function PlayLinks({
  runId,
  groupId,
  name,
  links,
  inMusic,
}: {
  runId: number;
  groupId: number;
  name: string;
  links: string[];
  inMusic: boolean;
}) {
  const { notify } = useApp();
  const [part, setPart] = useState(0);
  const [opening, setOpening] = useState(false);
  if (links.length === 0) return <span className="faint">No tracks</span>;
  const parts = links.length;
  const which = parts === 1 ? name : `${name}, part ${part + 1} of ${parts}`;

  const openMusic = async () => {
    // No "noopener" here: that makes window.open return null, and the handle is the point.
    // Cutting the new tab's own back-reference instead, while it is still about:blank.
    const tab = window.open("", "_blank");
    if (tab) tab.opener = null;
    setOpening(true);
    try {
      const { url } = await api<{ url: string }>(
        `/api/runs/${runId}/groups/${groupId}/music-link`,
        { method: "POST", body: { part: part + 1 } },
      );
      if (tab) tab.location.href = url;
      else notify("error", "Allow pop-ups for this page to open YouTube Music.");
    } catch (e) {
      tab?.close();
      notify("error", (e as Error).message);
    } finally {
      setOpening(false);
    }
  };

  return (
    <span className="play-links">
      {parts > 1 && (
        <select
          className="part-picker"
          aria-label={`Part of ${name} to play`}
          title="YouTube plays at most 50 tracks per link"
          value={part}
          onChange={(e) => setPart(Number(e.target.value))}
        >
          {links.map((link, i) => (
            <option key={link} value={i}>
              {i + 1} / {parts}
            </option>
          ))}
        </select>
      )}
      <a
        className="btn btn-ghost btn-link"
        href={links[part]}
        target="_blank"
        rel="noreferrer"
        aria-label={`Play ${which} on YouTube`}
      >
        <IconPlay />
        Play
      </a>
      {inMusic && (
        <Button
          variant="ghost"
          className="btn-link"
          busy={opening}
          aria-label={`Open ${which} in YouTube Music`}
          onClick={() => void openMusic()}
        >
          {!opening && <IconMusic size={14} />}
          Music
        </Button>
      )}
    </span>
  );
}
