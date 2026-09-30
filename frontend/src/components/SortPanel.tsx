import { useEffect, useMemo, useState } from "react";
import type {
  Dimension,
  PreviewResponse,
  RunSummary,
  TrackView,
} from "../../../backend/src/api/types.ts";
import { useApp } from "../App.tsx";
import { api } from "../api.ts";
import { fmt, pct, plural, quotaFor, useDebounced } from "../hooks.ts";
import { IconClose } from "./icons.tsx";
import { Button, EmptyState, Field, Notice, Progress, Segmented } from "./ui.tsx";

interface Draft {
  key: string;
  name: string;
  videoIds: string[];
  included: boolean;
  leftover: boolean;
}

const LEFTOVERS = new Set(["Other", "Unsorted"]);
const PREVIEW_ROWS = 4;

const DIMENSIONS: { value: Dimension; label: string }[] = [
  { value: "subgenre", label: "Subgenre" },
  { value: "mood", label: "Mood" },
  { value: "type", label: "Song type" },
];

const DIMENSION_NOUN = { subgenre: "subgenre", mood: "mood", type: "song type" } as const;

export function SortPanel({ playlistId, tracks }: { playlistId: string; tracks: TrackView[] }) {
  const { status, version, navigate, refresh, runs } = useApp();
  const [dimension, setDimension] = useState<Dimension>("subgenre");
  const [minSize, setMinSize] = useState(5);
  const [maxGroups, setMaxGroups] = useState(0);
  const [leftovers, setLeftovers] = useState(true);
  // Debounce a string so an unchanged setting never looks new and refetches.
  const settingsKey = useDebounced(
    JSON.stringify({ dimension, minSize, maxGroups, leftovers }),
    250,
  );

  const [preview, setPreview] = useState<PreviewResponse>();
  // The settings the current preview was built from (the controls may be ahead of it).
  const [basis, setBasis] = useState<{ dimension: Dimension; minSize: number }>();
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const [edited, setEdited] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string>();
  const [saving, setSaving] = useState(false);

  const byId = useMemo(() => new Map(tracks.map((t) => [t.videoId, t])), [tracks]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: version refetches after tagging
  useEffect(() => {
    const settings = JSON.parse(settingsKey) as {
      dimension: Dimension;
      minSize: number;
      maxGroups: number;
      leftovers: boolean;
    };
    let live = true;
    api<PreviewResponse>(`/api/playlists/${playlistId}/preview`, {
      method: "POST",
      body: {
        dimension: settings.dimension,
        minSize: settings.minSize,
        maxGroupsPerTrack: settings.maxGroups || undefined,
        includeLeftovers: settings.leftovers,
      },
    })
      .then((p) => {
        if (!live) return;
        setPreview(p);
        setBasis({ dimension: settings.dimension, minSize: settings.minSize });
        setDrafts(
          p.groups.map((g, i) => ({
            key: `${g.name}-${i}`,
            name: g.name,
            videoIds: g.videoIds,
            included: true,
            leftover: LEFTOVERS.has(g.name),
          })),
        );
        setEdited(false);
        setExpanded(new Set());
        setError(undefined);
      })
      .catch((e: Error) => live && setError(e.message));
    return () => {
      live = false;
    };
  }, [playlistId, settingsKey, version]);

  const update = (key: string, change: (d: Draft) => Draft) => {
    setDrafts((ds) => ds.map((d) => (d.key === key ? change(d) : d)));
    setEdited(true);
  };

  const included = drafts.filter((d) => d.included && d.videoIds.length > 0);
  const untagged = tracks.filter((t) => !t.enriched).length;
  const noneTagged = untagged === tracks.length;
  const additions = included.reduce((sum, d) => sum + d.videoIds.length, 0);
  const quota = quotaFor(included.length, additions, status?.dailyQuota ?? 10_000);
  // Every card's bar is drawn against the biggest bin, so the grid reads as a histogram.
  const largest = Math.max(1, ...drafts.map((d) => d.videoIds.length));
  const nameCounts = new Map<string, number>();
  for (const d of included) {
    const k = d.name.trim().toLowerCase();
    nameCounts.set(k, (nameCounts.get(k) ?? 0) + 1);
  }
  const invalidName = included.find(
    (d) => !d.name.trim() || (nameCounts.get(d.name.trim().toLowerCase()) ?? 0) > 1,
  );
  const openPlans = runs.filter(
    (r) => r.sourcePlaylistId === playlistId && r.status !== "done",
  ) as RunSummary[];

  const save = async () => {
    setSaving(true);
    setError(undefined);
    try {
      const { runId } = await api<{ runId: number }>(`/api/playlists/${playlistId}/runs`, {
        method: "POST",
        body: {
          dimension: basis?.dimension ?? dimension,
          minSize: basis?.minSize ?? minSize,
          groups: included.map((d) => ({ name: d.name.trim(), videoIds: d.videoIds })),
        },
      });
      refresh();
      navigate(`/runs/${runId}`);
    } catch (e) {
      setError((e as Error).message);
      setSaving(false);
    }
  };

  const label = (id: string) => {
    const t = byId.get(id);
    if (!t) return id;
    return t.songTitle && t.artist ? `${t.songTitle} by ${t.artist}` : t.title;
  };

  return (
    <div className="sort">
      <section className="controls" aria-label="Sort settings">
        <div className="control">
          <span className="eyebrow" aria-hidden>
            Group by
          </span>
          <Segmented
            label="Group by"
            value={dimension}
            onChange={setDimension}
            options={DIMENSIONS}
          />
        </div>
        <Field label="Smallest playlist">
          <span className="number-field">
            <input
              type="number"
              min={1}
              max={500}
              value={minSize}
              onChange={(e) => setMinSize(Math.max(1, Number(e.target.value) || 1))}
            />
            <span className="muted small">tracks</span>
          </span>
        </Field>
        <Field label="Playlists per track">
          <select value={maxGroups} onChange={(e) => setMaxGroups(Number(e.target.value))}>
            <option value={0}>Every match</option>
            <option value={1}>Best match only</option>
            <option value={2}>Up to 2</option>
            <option value={3}>Up to 3</option>
          </select>
        </Field>
        <label className="control-toggle">
          <input
            type="checkbox"
            checked={leftovers}
            onChange={(e) => setLeftovers(e.target.checked)}
          />
          <span className="small">
            Other &amp; Unsorted playlists
            <span className="control-help">for tracks that fit no group</span>
          </span>
        </label>
      </section>
      {edited && (
        <p className="hint">Changing a setting rebuilds the preview and discards your edits.</p>
      )}

      {error && (
        <div style={{ marginTop: 14 }}>
          <Notice tone="error">{error}</Notice>
        </div>
      )}

      {untagged > 0 && (
        <div style={{ marginTop: 14 }}>
          <Notice tone="warn">
            {noneTagged
              ? `None of these ${fmt(tracks.length)} tracks are tagged yet, so they would all land in Unsorted.`
              : `${plural(untagged, "track")} ${untagged === 1 ? "isn't" : "aren't"} tagged yet and will land in Unsorted.`}{" "}
            Tag them from the top of this page first.
          </Notice>
        </div>
      )}

      {preview && (
        <>
          <div className="summary" aria-live="polite">
            <div className="summary-figures">
              <div className="summary-figure">
                <strong>{plural(included.length, "playlist")}</strong>
                <span className="muted small">{plural(additions, "track addition")}</span>
              </div>
              <div className="summary-figure">
                <strong>{fmt(quota.units)}</strong>
                <span className="muted small">
                  {quota.days <= 1 ? (
                    "quota units, fits in one day"
                  ) : (
                    <span className="warn-text">
                      quota units, about {quota.days} days at the daily limit
                    </span>
                  )}
                </span>
              </div>
              <div className="summary-figure">
                <div className="summary-coverage">
                  <strong>{pct(preview.tagged, preview.total)}%</strong>
                  <Progress value={preview.tagged} max={preview.total} label="Coverage" />
                </div>
                <span className="muted small">
                  of tracks have a {DIMENSION_NOUN[basis?.dimension ?? dimension]}
                </span>
              </div>
            </div>
            <Button
              variant="primary"
              busy={saving}
              disabled={included.length === 0 || Boolean(invalidName) || noneTagged}
              title={noneTagged ? "Tag the tracks first" : undefined}
              onClick={save}
            >
              Save plan
            </Button>
          </div>
          {invalidName && (
            <Notice tone="warn">
              Every playlist needs a unique name. Check “{invalidName.name || "(empty)"}”.
            </Notice>
          )}
          {openPlans.length > 0 && (
            <p className="hint" style={{ margin: "0 0 12px" }}>
              This playlist already has {plural(openPlans.length, "unfinished plan")}:{" "}
              {openPlans.map((r, i) => (
                <span key={r.runId}>
                  {i > 0 && ", "}
                  <a
                    href={`/runs/${r.runId}`}
                    onClick={(e) => {
                      e.preventDefault();
                      navigate(`/runs/${r.runId}`);
                    }}
                  >
                    by {DIMENSION_NOUN[r.dimension]}
                  </a>
                </span>
              ))}
              .
            </p>
          )}

          {drafts.length === 0 ? (
            <EmptyState title="No groups to create">
              Tag the tracks first, or lower the smallest playlist size.
            </EmptyState>
          ) : (
            <div className="groups">
              {drafts.map((d) => {
                const open = expanded.has(d.key);
                const shown = open ? d.videoIds : d.videoIds.slice(0, PREVIEW_ROWS);
                const cls = ["group", d.included ? "" : "excluded", d.leftover ? "leftover" : ""]
                  .filter(Boolean)
                  .join(" ");
                return (
                  <article key={d.key} className={cls}>
                    <header className="group-head">
                      <input
                        type="checkbox"
                        checked={d.included}
                        aria-label={`Create playlist ${d.name}`}
                        onChange={(e) =>
                          update(d.key, (x) => ({ ...x, included: e.target.checked }))
                        }
                      />
                      <input
                        className="group-name"
                        value={d.name}
                        maxLength={100}
                        aria-label="Playlist name"
                        onChange={(e) => update(d.key, (x) => ({ ...x, name: e.target.value }))}
                      />
                      <span className="group-count" title="Tracks">
                        {fmt(d.videoIds.length)}
                      </span>
                    </header>
                    <div
                      className="group-share"
                      aria-hidden
                      title={`${fmt(d.videoIds.length)} of ${fmt(largest)} in the biggest group`}
                    >
                      <span style={{ width: `${(100 * d.videoIds.length) / largest}%` }} />
                    </div>
                    {d.leftover && (
                      <p className="group-note">
                        {d.name === "Unsorted"
                          ? "No tags found for these tracks."
                          : "Their groups were too small to keep."}
                      </p>
                    )}
                    <ul className="group-tracks">
                      {shown.map((id) => (
                        <li key={id}>
                          <span className="ellipsis" title={label(id)}>
                            {label(id)}
                          </span>
                          <button
                            type="button"
                            className="row-btn"
                            aria-label={`Remove ${label(id)} from ${d.name}`}
                            title="Remove from this playlist"
                            onClick={() =>
                              update(d.key, (x) => ({
                                ...x,
                                videoIds: x.videoIds.filter((v) => v !== id),
                              }))
                            }
                          >
                            <IconClose size={13} />
                          </button>
                        </li>
                      ))}
                    </ul>
                    {d.videoIds.length > PREVIEW_ROWS && (
                      <button
                        type="button"
                        className="link small"
                        aria-expanded={open}
                        onClick={() =>
                          setExpanded((s) => {
                            const next = new Set(s);
                            if (open) next.delete(d.key);
                            else next.add(d.key);
                            return next;
                          })
                        }
                      >
                        {open ? "Show fewer" : `Show all ${fmt(d.videoIds.length)}`}
                      </button>
                    )}
                  </article>
                );
              })}
            </div>
          )}

          {preview.dropped.length > 0 && (
            <p className="hint dropped">
              Too small to keep (under {basis?.minSize ?? minSize}):{" "}
              {preview.dropped.map((g) => `${g.name} (${g.size})`).join(", ")}. Lower the smallest
              playlist size to include them.
            </p>
          )}
        </>
      )}
    </div>
  );
}
