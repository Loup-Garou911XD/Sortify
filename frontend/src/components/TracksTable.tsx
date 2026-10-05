import { useMemo, useState } from "react";
import type { TrackView } from "../../../backend/src/api/types.ts";
import { useApp } from "../App.tsx";
import { duration, fmt } from "../hooks.ts";
import { IconSearch } from "./icons.tsx";
import { Button, Segmented, TagChips } from "./ui.tsx";

type Filter = "all" | "untagged" | "tagged";
const PAGE = 200;

const hasGenreOrMood = (t: TrackView) =>
  t.tags.some((g) => g.dimension === "subgenre" || g.dimension === "mood");

export function TracksTable({ tracks }: { tracks: TrackView[] }) {
  const { status } = useApp();
  const label = (id: string) => status?.sources.find((s) => s.id === id)?.label ?? id;
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [limit, setLimit] = useState(PAGE);

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    return tracks
      .map((t, i) => ({ t, n: i + 1 }))
      .filter(({ t }) => {
        if (filter === "untagged" && hasGenreOrMood(t)) return false;
        if (filter === "tagged" && !hasGenreOrMood(t)) return false;
        if (!q) return true;
        return [t.title, t.artist, t.songTitle, ...t.tags.map((g) => g.value)]
          .filter(Boolean)
          .some((s) => (s as string).toLowerCase().includes(q));
      });
  }, [tracks, query, filter]);

  const untaggedCount = tracks.filter((t) => !hasGenreOrMood(t)).length;

  return (
    <div className="tracks">
      <div className="toolbar">
        <span className="search-field">
          <IconSearch size={15} />
          <input
            type="search"
            placeholder="Search title, artist or tag"
            aria-label="Search tracks"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setLimit(PAGE);
            }}
          />
        </span>
        <Segmented
          label="Filter tracks"
          value={filter}
          onChange={(v) => {
            setFilter(v);
            setLimit(PAGE);
          }}
          options={[
            { value: "all", label: "All" },
            { value: "tagged", label: "Tagged" },
            { value: "untagged", label: `No genre or mood (${fmt(untaggedCount)})` },
          ]}
        />
        <span className="toolbar-spacer" />
        <span className="small muted tabular">
          {fmt(Math.min(limit, rows.length))} of {fmt(rows.length)} shown
        </span>
      </div>

      <div className="table-wrap">
        <div className="table-scroll">
          <table className="table">
            <thead>
              <tr>
                <th className="num">#</th>
                <th>Track</th>
                <th>Subgenre</th>
                <th>Mood</th>
                <th>Type</th>
                <th>Language</th>
                <th>Decade</th>
                <th className="num">Length</th>
              </tr>
            </thead>
            <tbody>
              {rows.slice(0, limit).map(({ t, n }) => (
                <tr key={t.videoId}>
                  <td className="num col-index">{n}</td>
                  <td>
                    <div className="track-cell">
                      <a
                        href={`https://music.youtube.com/watch?v=${t.videoId}`}
                        target="_blank"
                        rel="noreferrer"
                        title={t.title}
                      >
                        {t.songTitle ?? t.title}
                      </a>
                      <span className="muted">
                        {t.artist ?? t.channel}
                        {t.retryProviders.length > 0
                          ? ` · will retry ${t.retryProviders.map(label).join(", ")}`
                          : !t.enriched && " · not tagged yet"}
                      </span>
                    </div>
                  </td>
                  <td>
                    <TagChips tags={t.tags} dimension="subgenre" />
                  </td>
                  <td>
                    <TagChips tags={t.tags} dimension="mood" />
                  </td>
                  <td>
                    <TagChips tags={t.tags} dimension="type" />
                  </td>
                  <td>
                    <TagChips tags={t.tags} dimension="language" />
                  </td>
                  <td>
                    <TagChips tags={t.tags} dimension="decade" />
                  </td>
                  <td className="num muted">{duration(t.durationS)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {rows.length === 0 && (
          <p className="empty-row">No tracks match. Try a different search or filter.</p>
        )}
      </div>
      {rows.length > limit && (
        <div className="more">
          <Button onClick={() => setLimit((l) => l + PAGE)}>
            Show {fmt(Math.min(PAGE, rows.length - limit))} more
          </Button>
        </div>
      )}
    </div>
  );
}
