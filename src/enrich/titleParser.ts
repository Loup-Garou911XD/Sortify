export interface ParsedTitle {
  artist: string | null;
  songTitle: string | null;
  /** Lowercased contents of (...) and [...] plus trailing " - ..." segments; used by song-type rules. */
  hints: string[];
}

const SEPARATOR = /\s+[-–—~]\s+|\s+[-–—]\s*|\s*[-–—]\s+/;
const BRACKETED = /[([【「]([^)\]】」]*)[)\]】」]/g;
const FEATURING = /\s+(?:feat\.?|ft\.?|featuring)\s+.*$/i;
const NOISE =
  /\b(?:official\s+(?:music\s+)?(?:video|audio|visuali[sz]er|lyric\s+video)|official|music\s+video|lyrics?\s+video|visuali[sz]er|video\s*clip|m\/v|hd|hq|4k)\b/gi;

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

/** "TaylorSwiftVEVO" → "Taylor Swift"; "Adele - Topic" → "Adele"; "Muse Official" → "Muse". */
export function cleanChannelName(channel: string): string {
  let name = channel.replace(/\s*-\s*Topic$/i, "").replace(/VEVO$/i, "");
  if (name !== channel && !/\s/.test(name)) name = name.replace(/([a-z])([A-Z])/g, "$1 $2");
  name = name.replace(/\s+(?:official|music|official\s+channel|band)$/i, "");
  return tidy(name);
}

/**
 * Splits a YouTube video title into artist and song title. Handles "Artist - Title (Official
 * Video)", auto-generated "- Topic" channels (title is the song, channel is the artist),
 * `Artist "Title"`, and falls back to the channel name as the artist.
 */
export function parseTitle(rawTitle: string, channel: string): ParsedTitle {
  const hints: string[] = [];
  let title = rawTitle.replace(BRACKETED, (_, inner: string) => {
    hints.push(inner.toLowerCase().trim());
    return " ";
  });
  // Anything after a pipe or double slash is almost always channel/series noise.
  title = title.split(/\s(?:\||\/\/)\s/)[0] ?? title;
  title = tidy(title.replace(NOISE, " "));

  const isTopic = /\s-\s*Topic$/i.test(channel);
  if (isTopic) {
    // Topic titles are just the song, sometimes with " - Live" or " - Remastered 2011".
    const [song = "", ...rest] = title.split(SEPARATOR).map(tidy).filter(Boolean);
    hints.push(...rest.map((part) => part.toLowerCase()));
    return {
      artist: cleanChannelName(channel) || null,
      songTitle: field(song),
      hints,
    };
  }

  const quoted = /^(.*?)\s*["“](.+?)["”]\s*(.*)$/.exec(title);
  if (quoted?.[1] && quoted[2]) {
    if (quoted[3]) hints.push(quoted[3].toLowerCase());
    return {
      artist: field(quoted[1]),
      songTitle: field(quoted[2]),
      hints,
    };
  }

  const parts = title.split(SEPARATOR).map(tidy).filter(Boolean);
  if (parts.length >= 2) {
    const [artist = "", song = "", ...rest] = parts;
    hints.push(...rest.map((part) => part.toLowerCase()));
    return {
      artist: field(artist),
      songTitle: field(song),
      hints,
    };
  }

  return {
    artist: cleanChannelName(channel) || null,
    songTitle: field(title),
    hints,
  };
}
