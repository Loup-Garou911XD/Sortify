import type { Tag, Track, TrackTag } from "../db.ts";

/**
 * Source of a tag no service gave: the artist's other tracks in the same playlist did. Kept
 * apart from the provider ids so the next round can tell evidence from inference.
 */
export const AGREEMENT_SOURCE = "agreement";

/** Fewer tagged tracks than this is not a pattern, it is a coincidence. */
const MIN_TAGGED = 2;
/** A value has to hold for at least this share of the artist's tagged tracks. */
const MIN_SHARE = 0.5;
/** An artist who spans two subgenres is normal; one who spans five says nothing. */
const MAX_VALUES = 2;
/** A unanimous artist is worth this much; a half-and-half one, half of it. */
const AGREEMENT_WEIGHT = 0.4;

const key = (artist: string): string => artist.trim().toLowerCase();

/**
 * Subgenres to carry across one artist's tracks inside a playlist: when most of the artist's
 * tagged tracks agree on a subgenre, their untagged siblings get it too, weighted by how far
 * that agreement goes. No requests and no guesswork beyond "same artist, same music", which is
 * the one inference a metadata service would have made anyway through its artist genres.
 *
 * Only tracks that have been through tagging take part, and tags from a previous round of this
 * are ignored as evidence, so running it again neither compounds nor spreads further.
 */
export function artistAgreementTags(tracks: Track[], tags: TrackTag[]): Map<string, Tag[]> {
  const stated = new Map<string, Set<string>>();
  for (const tag of tags) {
    if (tag.dimension !== "subgenre" || tag.source === AGREEMENT_SOURCE) continue;
    const values = stated.get(tag.videoId) ?? new Set<string>();
    values.add(tag.value);
    stated.set(tag.videoId, values);
  }

  const byArtist = new Map<string, Track[]>();
  for (const track of tracks) {
    if (!track.artist || track.enrichedAt === null) continue;
    const list = byArtist.get(key(track.artist)) ?? [];
    list.push(track);
    byArtist.set(key(track.artist), list);
  }

  const added = new Map<string, Tag[]>();
  for (const group of byArtist.values()) {
    const tagged = group.filter((t) => stated.has(t.videoId));
    const untagged = group.filter((t) => !stated.has(t.videoId));
    if (tagged.length < MIN_TAGGED || untagged.length === 0) continue;

    const support = new Map<string, number>();
    for (const track of tagged) {
      for (const value of stated.get(track.videoId) ?? []) {
        support.set(value, (support.get(value) ?? 0) + 1);
      }
    }
    const agreed = [...support]
      .filter(([, count]) => count / tagged.length >= MIN_SHARE)
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, MAX_VALUES);
    if (agreed.length === 0) continue;

    for (const track of untagged) {
      added.set(
        track.videoId,
        agreed.map(([value, count]) => ({
          dimension: "subgenre",
          value,
          // The evidence is the artist, so that is what the tag shows it came from.
          rawTag: track.artist ?? "",
          source: AGREEMENT_SOURCE,
          weight: Number(((AGREEMENT_WEIGHT * count) / tagged.length).toFixed(3)),
        })),
      );
    }
  }
  return added;
}
