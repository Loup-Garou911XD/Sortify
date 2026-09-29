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

  it.each([
    // Pipe style: "Song (Music Video) Artist | …"
    [
      "5-7 (Music Video) Karan Aujla | Mxrci | Alankriitaa Sahai | Rehaan Records | Punjabi Songs 2026",
      "Rehaan Records",
      "Karan Aujla",
      "5-7",
      true,
    ],
    [
      "Ashke (Music Video) Karan Aujla  | Mxrci  | Aujla Szn 1",
      "Karan Aujla",
      "Karan Aujla",
      "Ashke",
      true,
    ],
    [
      "INSANE DRIPPIN (Audio): YO YO HONEY SINGH | 51 GLORIOUS DAYS",
      "T-Series",
      "YO YO HONEY SINGH",
      "INSANE DRIPPIN",
      true,
    ],
    [
      "Ae Ajnabee (Official Lyric Video) - Aditya Rikhari, Ravator, Kutle Khan | Coke Studio Bharat.",
      "Coke Studio India ",
      "Aditya Rikhari",
      "Ae Ajnabee",
      true,
    ],
    // Label channels: song first, artist guessed from the credits (low confidence)
    [
      "Lyrical: Soni De Nakhre | Partner | Govinda, Salman Khan, Katrina Kaif | Sajid - Wajid",
      "T-Series",
      "Sajid - Wajid",
      "Soni De Nakhre",
      false,
    ],
    [
      "Shanivaar Raati Song Main Tera Hero | Arijit Singh | Varun Dhawan, Ileana D'Cruz, Nargis Fakhri",
      "T-Series",
      "Arijit Singh",
      "Shanivaar Raati",
      false,
    ],
    [
      "Paisa Paisa -Video Song |De Dana Dan |Akshay Kumar & Katrina Kaif | Pritam |RDB, Manak-E & Selina",
      "Ishtar Music",
      "Pritam",
      "Paisa Paisa",
      false,
    ],
    ["Zor Ka Jhatka Full HD Song Action Replayy", "T-Series", null, "Zor Ka Jhatka", false],
    // "Song - Artist", recognised from the channel or an artist list
    ["GOYARD - Parmish Verma | VICTORY LAP", "Parmish Verma", "Parmish Verma", "GOYARD", true],
    [
      "DEKHI JA - Parmish Verma - Harman Brar Ft. Kiran Bajwa | VICTORY LAP",
      "Parmish Verma",
      "Parmish Verma",
      "DEKHI JA",
      true,
    ],
    ["laila - Vasu Raina, Rosha (ft. Karun)", "Vasu Raina", "Vasu Raina", "laila", true],

    // "Artist - Song" stays as it was
    ["Farak - Taare | Official Music Video |", "Farak", "Farak", "Taare", true],
    [
      "Karan Aujla, OneRepublic, Disha Patani, Ikky -  Tell Me (Official Music Video)",
      "Karan Aujla",
      "Karan Aujla",
      "Tell Me",
      true,
    ],
    ["Pixies - Where Is My Mind", "i'm cyborg but that's ok", "Pixies", "Where Is My Mind", true],
    ["Flo Rida - Low (feat. T-Pain) [Official Video]", "Flo Rida Videos", "Flo Rida", "Low", true],
    // Other shapes
    [
      "twenty one pilots: Heathens (from Suicide Squad: The Album) [OFFICIAL VIDEO]",
      "Fueled By Ramen",
      "twenty one pilots",
      "Heathens",
      true,
    ],
    [
      "Fire Again ft. Ashnikko // Official Music Video // VALORANT Champions 2022",
      "VALORANT",
      "VALORANT",
      "Fire Again",
      true,
    ],
  ] as const)("%s", (title, channel, artist, song, confident) => {
    const parsed = parseTitle(title, channel);
    expect(parsed.artist).toBe(artist);
    expect(parsed.songTitle).toBe(song);
    expect(parsed.confident).toBe(confident);
    expect(parsed.official).toBe(false);
  });

  it("marks Topic tracks as official", () => {
    expect(parseTitle("In the End", "Linkin Park - Topic")).toMatchObject({
      artist: "Linkin Park",
      songTitle: "In the End",
      official: true,
      confident: true,
    });
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
