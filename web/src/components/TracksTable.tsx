import { useMemo, useState } from "react";
import type { TrackView } from "../../../src/api/types.ts";
import { duration, fmt } from "../hooks.ts";
import { Button, Segmented, TagChips } from "./ui.tsx";

type Filter = "all" | "untagged" | "tagged";
const PAGE = 200;

const hasGenreOrMood = (t: TrackView) => t.tags.some((g) => g.dimension !== "type");

export function TracksTable({ tracks }: { tracks: TrackView[] }) {
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
      </div>

      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th className="num">#</th>
              <th>Track</th>
              <th>Subgenre</th>
              <th>Mood</th>
              <th>Type</th>
              <th className="num">Length</th>
            </tr>
          </thead>
          <tbody>
            {rows.slice(0, limit).map(({ t, n }) => (
              <tr key={t.videoId}>
                <td className="num muted">{n}</td>
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
                      {!t.enriched && " · not tagged yet"}
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
                <td className="num muted">{duration(t.durationS)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {rows.length === 0 && <p className="empty">No tracks match.</p>}
      </div>
      {rows.length > limit && (
        <div className="more">
          <Button onClick={() => setLimit((l) => l + PAGE)}>
            Show more ({fmt(rows.length - limit)} left)
          </Button>
        </div>
      )}
    </div>
  );
}
