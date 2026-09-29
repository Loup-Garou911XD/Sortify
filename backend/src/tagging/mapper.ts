import { existsSync, readFileSync } from "node:fs";
import { parse } from "yaml";
import type { Tag, TagSource } from "../db.ts";
import { DEFAULT_TAG_MAP, type TagMap } from "./defaultTagMap.ts";

export interface RawTag {
  tag: string;
  source: TagSource;
  weight: number;
}

/** "Drum n' Bass", "drum & bass" and "Drum-and-Bass" all normalize to "drum and bass". */
export function normalizeTag(tag: string): string {
  return tag
    .toLowerCase()
    .replace(/[-_/]/g, " ")
    .replace(/\s*&\s*/g, " and ")
    .replace(/\s'?n'?\s/g, " and ")
    .replace(/[,.!]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** Built-in map, with any section present in the user's YAML file replacing the default one. */
export function loadTagMap(path?: string): TagMap {
  if (!path || !existsSync(path)) return DEFAULT_TAG_MAP;
  const override = (parse(readFileSync(path, "utf8")) ?? {}) as Partial<TagMap>;
  return {
    families: override.families ?? DEFAULT_TAG_MAP.families,
    subgenres: override.subgenres ?? DEFAULT_TAG_MAP.subgenres,
    moods: override.moods ?? DEFAULT_TAG_MAP.moods,
  };
}

function buildIndex(section: Record<string, string[] | null>): Map<string, string> {
  const index = new Map<string, string>();
  for (const [label, aliases] of Object.entries(section)) {
    for (const alias of [label, ...(aliases ?? [])]) index.set(normalizeTag(alias), label);
  }
  return index;
}

/** Maps free-form tags from Discogs, MusicBrainz and Last.fm onto the fixed label lists. */
export class TagMapper {
  private readonly families: Map<string, string>;
  private readonly subgenres: Map<string, string>;
  private readonly moods: Map<string, string>;

  constructor(map: TagMap = DEFAULT_TAG_MAP) {
    this.families = buildIndex(map.families);
    this.subgenres = buildIndex(map.subgenres);
    this.moods = buildIndex(map.moods);
  }

  /** Subgenre tags; falls back to broad families only when no subgenre matched. */
  genres(raw: RawTag[]): Tag[] {
    const subgenres = this.lookup(raw, this.subgenres, "subgenre");
    return subgenres.length > 0 ? subgenres : this.lookup(raw, this.families, "subgenre");
  }

  /** Whether any raw tag maps to a detailed subgenre (not just a broad family). */
  hasSubgenre(raw: RawTag[]): boolean {
    return raw.some((r) => this.subgenres.has(normalizeTag(r.tag)));
  }

  moodTags(raw: RawTag[]): Tag[] {
    return this.lookup(raw, this.moods, "mood");
  }

  private lookup(raw: RawTag[], index: Map<string, string>, dimension: Tag["dimension"]): Tag[] {
    // One tag per (label, source), keeping the strongest raw tag.
    const best = new Map<string, Tag>();
    for (const r of raw) {
      const label = index.get(normalizeTag(r.tag));
      if (!label) continue;
      const key = `${label}\u0000${r.source}`;
      const current = best.get(key);
      if (!current || r.weight > current.weight) {
        best.set(key, {
          dimension,
          value: label,
          rawTag: r.tag,
          source: r.source,
          weight: r.weight,
        });
      }
    }
    return [...best.values()];
  }
}
