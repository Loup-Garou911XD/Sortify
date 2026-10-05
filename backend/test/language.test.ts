import { describe, expect, it } from "vitest";
import { Store } from "../src/db.ts";
import { detectLanguages } from "../src/enrich/language.ts";
import { enrichPlaylist } from "../src/enrich/pipeline.ts";
import type { ProviderClient } from "../src/enrich/provider.ts";
import { TagMapper } from "../src/tagging/mapper.ts";

const detect = (title: string) => detectLanguages(title).map((t) => t.value);

describe("detectLanguages", () => {
  it("names the language of a title's script", () => {
    expect(detect("तुम ही हो - Arijit Singh")).toEqual(["Hindi"]);
    expect(detect("ਲੌਂਗ ਲਾਚੀ")).toEqual(["Punjabi"]);
    expect(detect("BTS (방탄소년단) 'Dynamite'")).toEqual(["Korean"]);
    expect(detect("Пачка сигарет")).toEqual(["Russian"]);
  });

  it("tells Japanese from Chinese by its kana", () => {
    expect(detect("周杰倫 - 青花瓷")).toEqual(["Mandarin"]);
    expect(detect("YOASOBI「夜に駆ける」")).toEqual(["Japanese"]);
  });

  it("says nothing about a Latin-script title, or one borrowed character", () => {
    expect(detect("Daft Punk - Get Lucky (Official Video)")).toEqual([]);
    expect(detect("Kavinsky - Nightcall ★")).toEqual([]);
    expect(detect("Song (feat. 松)")).toEqual([]);
  });

  it("keeps only the script that carries the title", () => {
    expect(detect("Kesariya (Brahmastra) - केसरिया गाना")).toEqual(["Hindi"]);
  });
});

describe("language tags from providers", () => {
  it("maps tags that belong to a language, beside the script rule", async () => {
    const store = new Store(":memory:");
    store.savePlaylist("PL", "Mix", [
      { videoId: "a", title: "Diljit Dosanjh - Born To Shine", channel: "Diljit Dosanjh" },
      { videoId: "b", title: "रातें - Arijit Singh", channel: "T-Series" },
    ]);
    const tagger: ProviderClient = {
      id: "lastfm",
      trackTags: async ({ artist }) => ({
        genres:
          artist === "Diljit Dosanjh"
            ? [{ tag: "bhangra", source: "lastfm", weight: 0.8 }]
            : [{ tag: "k-pop", source: "lastfm", weight: 0.7 }],
      }),
    };
    await enrichPlaylist(store, "PL", { mapper: new TagMapper(), clients: [tagger] });

    const tags = store
      .playlistTags("PL", "language")
      .map((t) => [t.videoId, t.value, t.source])
      .sort();
    expect(tags).toEqual([
      ["a", "Punjabi", "lastfm"],
      // The title is Devanagari, so the stray Korean tag does not stand alone.
      ["b", "Hindi", "rule"],
      ["b", "Korean", "lastfm"],
    ]);
  });
});
