import { describe, expect, it } from "vitest";
import { detectSongTypes } from "../src/enrich/songType.ts";
import { similarity } from "../src/enrich/text.ts";
import { cleanChannelName, parseTitle } from "../src/enrich/titleParser.ts";

describe("parseTitle", () => {
  it.each([
    [
      "Daft Punk - Get Lucky (Official Video) ft. Pharrell Williams",
      "Some Channel",
      "Daft Punk",
      "Get Lucky",
    ],
    [
      "The Weeknd – Blinding Lights [Official Music Video]",
      "TheWeekndVEVO",
      "The Weeknd",
      "Blinding Lights",
    ],
    ["Adele — Hello (Lyrics)", "Lyric Channel", "Adele", "Hello"],
    ['Billie Eilish "bad guy" Official Audio', "x", "Billie Eilish", "bad guy"],
    ["Dancing with Myself", "Billy Idol - Topic", "Billy Idol", "Dancing with Myself"],
    ["Clean", "Taylor Swift - Topic", "Taylor Swift", "Clean"],
    ["Jay-Z - Empire State of Mind | Live 2010", "x", "Jay-Z", "Empire State of Mind"],
    ["Midnight City", "M83VEVO", "M83", "Midnight City"],
    ["Get Lucky feat. Pharrell", "DaftPunkVEVO", "Daft Punk", "Get Lucky"],
  ])("%s", (title, channel, artist, song) => {
    const parsed = parseTitle(title, channel);
    expect(parsed.artist).toBe(artist);
    expect(parsed.songTitle).toBe(song);
  });

  it("keeps version info from Topic titles as hints", () => {
    const parsed = parseTitle("Wonderwall - Remastered 2014", "Oasis - Topic");
    expect(parsed.songTitle).toBe("Wonderwall");
    expect(parsed.hints).toContain("remastered 2014");
  });
});

describe("cleanChannelName", () => {
  it("splits camel-cased VEVO names and strips Topic", () => {
    expect(cleanChannelName("TaylorSwiftVEVO")).toBe("Taylor Swift");
    expect(cleanChannelName("Adele - Topic")).toBe("Adele");
    expect(cleanChannelName("Muse Official")).toBe("Muse");
  });
});

describe("detectSongTypes", () => {
  const types = (title: string, channel = "x"): string[] =>
    detectSongTypes(title, parseTitle(title, channel).hints).map((t) => t.value);

  it("finds version types in brackets and trailing segments", () => {
    expect(types("Song (Tiësto Remix)")).toEqual(["Remix"]);
    expect(types("Artist - Song (Live at Wembley)")).toEqual(["Live"]);
    expect(types("Artist - Song - Acoustic Version")).toEqual(["Acoustic"]);
    expect(types("Artist - Song [Sped Up]")).toEqual(["Sped Up"]);
    expect(types("Artist - Song (slowed + reverb)")).toEqual(["Slowed"]);
    expect(types("Song (Karaoke Version)")).toEqual(["Instrumental"]);
    expect(types("Artist - Song (Cover)")).toEqual(["Cover"]);
  });

  it("does not tag plain song names or non-remix mixes", () => {
    expect(types("Oasis - Live Forever")).toEqual([]);
    expect(types("Artist - Song (Original Mix)")).toEqual([]);
    expect(types("Artist - Song (Radio Edit)")).toEqual([]);
    expect(types("Take Cover", "Band - Topic")).toEqual([]);
  });
});

describe("similarity", () => {
  it("ignores case, accents and a leading 'the'", () => {
    expect(similarity("Beyoncé", "beyonce")).toBe(1);
    expect(similarity("The Weeknd", "Weeknd")).toBe(1);
    expect(similarity("Daft Punk", "Daft Punk feat. Pharrell")).toBe(0.9);
    expect(similarity("Daft Punk", "Metallica")).toBeLessThan(0.3);
  });
});
