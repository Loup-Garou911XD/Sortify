const PLAYLIST_ID = /^[A-Za-z0-9_-]{2,}$/;

/**
 * Accepts a playlist URL from youtube.com or music.youtube.com (including watch URLs that carry
 * a `list` parameter) or a bare playlist ID, and returns the ID. YouTube Music playlists are
 * ordinary YouTube playlists, so the same ID works with the Data API.
 */
export function parsePlaylistId(input: string): string {
  const trimmed = input.trim();
  if (PLAYLIST_ID.test(trimmed)) return trimmed;

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new Error(`Not a playlist URL or ID: ${input}`);
  }
  const host = url.hostname.replace(/^www\.|^m\./, "");
  if (!["youtube.com", "music.youtube.com", "youtu.be"].includes(host)) {
    throw new Error(`Not a YouTube or YouTube Music URL: ${input}`);
  }
  const list = url.searchParams.get("list");
  if (!list || !PLAYLIST_ID.test(list)) {
    throw new Error(`URL has no playlist ID (expected a "list" parameter): ${input}`);
  }
  return list;
}
