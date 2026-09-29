import { normalizeForMatch, similarity } from "./text.ts";

export interface ParsedTitle {
  artist: string | null;
  songTitle: string | null;
  /** Lowercased contents of (...) and [...] plus trailing " - ..." segments; used by song-type rules. */
  hints: string[];
  /** From an auto-generated "Artist - Topic" channel: artist and title are label metadata. */
  official: boolean;
  /**
   * The artist is stated by the title or channel. False when it was guessed from a list of names
   * (e.g. "Song | Movie | Cast | Composer" from a label channel), so artist-level tags are unsafe.
   */
  confident: boolean;
}

const SEPARATOR = /\s+~\s+|\s+[-–—]\s*|\s*[-–—]\s+/;
const BRACKETED = /[([【「]([^)\]】」]*)[)\]】」]/g;
const FEATURING = /\s+(?:feat\.?|ft\.?|featuring)\s+.*$/i;
const NOISE =
  /\b(?:official\s+(?:music\s+)?(?:video|audio|visuali[sz]er|lyric\s+video)|official|music\s+video|lyrics?\s+video|lyrical(?:\s+video)?|(?:full\s+)?video\s+song|visuali[sz]er|video\s*clip|m\/v|hd|hq|4k)\b/gi;
/** "Lyrical: Song | …", "Full Video: Song | …" */
const PREFIX =
  /^(?:lyrical(?:\s+video)?|full\s+(?:video|song|audio)|video\s+song|official\s+(?:video|audio)|video|audio)\s*[:\-–]\s*/i;
/** "Song (Music Video) Artist", "Song (Audio): ARTIST", "Song (Official Lyric Video) - Artist" */
const MEDIA_BRACKET =
  /^(.+?)\s*[([]\s*(?:official\s+)?(?:music\s+|lyric(?:al)?\s+|full\s+)?(?:video|audio)(?:\s+song)?\s*[)\]]\s*[:\-–]?\s*(.+)$/i;
/** "Shanivaar Raati Song Main Tera Hero", "Zor Ka Jhatka Full HD Song Action Replayy" */
const SONG_WORD_TAIL = /\s+(?:full\s+)?(?:hd\s+)?(?:video\s+)?song\b.*$/i;
/** Channels that publish many artists (labels, lyric channels): never the artist. */
const LABEL_CHANNEL =
  /\b(?:series|music|records|recordings|studios?|company|films?|entertainment|lyrics?|tv)\b/i;
/** Pipe segments that describe the upload rather than name anyone. */
const NOISE_SEGMENT =
  /\b(?:official|video|audio|lyrics?|lyrical|songs?|latest|new|hd|4k|full)\b|\b(?:19|20)\d{2}\b/i;
/** Several credited artists. "ft." is ignored: "Song ft. X" is far more common than a list. */
const ARTIST_LIST = /,|&|\sx\s/i;

function tidy(value: string): string {
  return value
    .replace(/\s+/g, " ")
    .replace(/^[\s\-–—~:|]+|[\s\-–—~:|]+$/g, "")
    .trim();
}

/** Final clean-up of a returned artist or title: also drops surrounding quotes. */
function field(value: string): string | null {
  return tidy(value.replace(FEATURING, "").replace(/^["“]+|["”]+$/g, "")) || null;
}

/** The first of several credited artists, which is what the metadata services index. */
function primaryArtist(value: string): string | null {
  return field(value.split(/\s*,\s*/)[0] ?? value);
}

/** "TaylorSwiftVEVO" → "Taylor Swift"; "Adele - Topic" → "Adele"; "Muse Official" → "Muse". */
export function cleanChannelName(channel: string): string {
  let name = channel.replace(/\s*-\s*Topic$/i, "").replace(/VEVO$/i, "");
  if (name !== channel && !/\s/.test(name)) name = name.replace(/([a-z])([A-Z])/g, "$1 $2");
  name = name.replace(/\s+(?:official|music|official\s+channel|band)$/i, "");
  return tidy(name);
}

function mentions(text: string, name: string): boolean {
  const a = normalizeForMatch(text);
  const b = normalizeForMatch(name);
  return b.length > 0 && (a.includes(b) || similarity(text, name) >= 0.8);
}

function stripBrackets(text: string, hints: string[]): string {
  return text.replace(BRACKETED, (_, inner: string) => {
    hints.push(inner.toLowerCase().trim());
    return " ";
  });
}

/**
 * Splits a YouTube video title into artist and song title. Handles auto-generated "- Topic"
 * channels, "Artist - Song" and "Song - Artist" (told apart by the channel name), `Artist "Song"`,
 * "Artist: Song", and the pipe-separated style common on Indian music channels:
 * "Song (Music Video) Artist | …", "Lyrical: Song | Movie | Cast | Composer".
 */
export function parseTitle(rawTitle: string, channel: string): ParsedTitle {
  const hints: string[] = [];
  const channelName = cleanChannelName(channel);
  const channelIsArtist = !LABEL_CHANNEL.test(channel) && channelName.length > 0;

  if (/\s-\s*Topic$/i.test(channel)) {
    // Topic titles are just the song, sometimes with " - Live" or " - Remastered 2011".
    const title = tidy(stripBrackets(rawTitle, hints).replace(NOISE, " "));
    const [song = "", ...rest] = title.split(SEPARATOR).map(tidy).filter(Boolean);
    hints.push(...rest.map((part) => part.toLowerCase()));
    return {
      artist: channelName || null,
      songTitle: field(song),
      hints,
      official: true,
      confident: true,
    };
  }

  const result = (artist: string | null, song: string, confident = true): ParsedTitle => ({
    artist,
    songTitle: field(song),
    hints,
    official: false,
    confident: confident && artist !== null,
  });

  // Pipes separate song, movie, cast and credits; " // " separates series noise.
  const [head = "", ...segments] = rawTitle.split(/\s*\|\s*/);
  const unprefixed = head.replace(PREFIX, "");
  const prefixed = unprefixed !== head;
  const first = unprefixed.split(/\s\/\/\s/)[0] ?? unprefixed;

  const media = MEDIA_BRACKET.exec(first);
  if (media?.[1] && media[2] && !SEPARATOR.test(media[1]) && !media[1].includes(":")) {
    stripBrackets(first, hints);
    return result(primaryArtist(media[2]), media[1]);
  }

  const title = tidy(stripBrackets(first, hints).replace(NOISE, " "));

  const quoted = /^(.*?)\s*["“](.+?)["”]\s*(.*)$/.exec(title);
  if (quoted?.[1] && quoted[2]) {
    if (quoted[3]) hints.push(quoted[3].toLowerCase());
    return result(primaryArtist(quoted[1]), quoted[2]);
  }

  const parts = title.split(SEPARATOR).map(tidy).filter(Boolean);
  if (parts.length >= 2) {
    const [left = "", right = "", ...rest] = parts;
    hints.push(...rest.map((part) => part.toLowerCase()));
    // "Song - Artist" when the channel or an artist list says so; "Artist - Song" otherwise.
    const songFirst =
      (channelIsArtist && mentions(right, channelName) && !mentions(left, channelName)) ||
      (ARTIST_LIST.test(right.replace(FEATURING, "")) && !ARTIST_LIST.test(left));
    return songFirst ? result(primaryArtist(right), left) : result(primaryArtist(left), right);
  }

  const colon = /^([^:]{2,40}?)\s*:\s+(.+)$/.exec(title);
  if (colon?.[1] && colon[2] && !prefixed) {
    return result(primaryArtist(colon[1]), colon[2]);
  }

  // Only the song is in the title; the artist is in a later pipe segment or is the channel.
  const song = title.replace(SONG_WORD_TAIL, "") || title;
  const names = segments.map(tidy).filter((s) => s && !NOISE_SEGMENT.test(s));
  const named = channelIsArtist ? names.find((s) => mentions(s, channelName)) : undefined;
  if (named) return result(primaryArtist(named), song);
  if (channelIsArtist) return result(channelName, song);
  // A label channel: take the last single name (usually singer or composer), not cast lists.
  const guess = names.filter((s) => !s.includes(",")).at(-1);
  return result(guess ? primaryArtist(guess) : null, song, false);
}
