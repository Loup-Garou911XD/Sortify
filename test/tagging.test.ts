import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadTagMap, normalizeTag, TagMapper } from "../src/tagging/mapper.ts";

describe("normalizeTag", () => {
  it("treats spelling variants as one tag", () => {
    expect(normalizeTag("Drum n Bass")).toBe("drum and bass");
    expect(normalizeTag("drum & bass")).toBe("drum and bass");
    expect(normalizeTag("Synth-pop")).toBe("synth pop");
    expect(normalizeTag("Folk, World, & Country")).toBe("folk world and country");
  });
});

describe("TagMapper", () => {
  const mapper = new TagMapper();

  it("maps Discogs styles and Last.fm tags to subgenres, keeping the strongest per source", () => {
    const tags = mapper.genres([
      { tag: "Synth-pop", source: "discogs", weight: 1 },
      { tag: "Electronic", source: "discogs", weight: 1 },
      { tag: "synthpop", source: "lastfm", weight: 0.4 },
      { tag: "synth pop", source: "lastfm", weight: 0.9 },
      { tag: "seen live", source: "lastfm", weight: 1 },
    ]);
    expect(tags.map((t) => [t.value, t.source, t.weight])).toEqual([
      ["Synth-pop", "discogs", 1],
      ["Synth-pop", "lastfm", 0.9],
    ]);
  });

  it("falls back to broad families only when no subgenre matches", () => {
    const tags = mapper.genres([
      { tag: "Hip-Hop", source: "discogs", weight: 1 },
      { tag: "rap", source: "lastfm", weight: 0.5 },
    ]);
    expect(tags.map((t) => t.value)).toEqual(["Hip Hop", "Hip Hop"]);
  });

  it("maps mood tags", () => {
    const tags = mapper.moodTags([
      { tag: "chillout", source: "lastfm", weight: 0.8 },
      { tag: "melancholic", source: "lastfm", weight: 0.3 },
      { tag: "indie", source: "lastfm", weight: 1 },
    ]);
    expect(tags.map((t) => t.value).sort()).toEqual(["Chill", "Sad"]);
  });

  it("lets a YAML file replace a section", () => {
    const dir = mkdtempSync(join(tmpdir(), "sortify-"));
    const path = join(dir, "tag_map.yaml");
    writeFileSync(path, "moods:\n  Cozy: [chill, warm]\n");
    const custom = new TagMapper(loadTagMap(path));
    expect(custom.moodTags([{ tag: "chill", source: "lastfm", weight: 1 }])[0]?.value).toBe("Cozy");
    expect(custom.genres([{ tag: "Techno", source: "discogs", weight: 1 }])[0]?.value).toBe(
      "Techno",
    );
  });
});
