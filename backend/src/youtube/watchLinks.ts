/** YouTube's watch_videos page takes at most this many videos per link. */
export const WATCH_LINK_SIZE = 50;

/** The only URL `musicLink` will fetch. Exported so a caller can reject bad input as bad input. */
export const WATCH_VIDEOS = "https://www.youtube.com/watch_videos?video_ids=";

/**
 * Links that play the videos in order as a temporary YouTube playlist. They are plain
 * youtube.com URLs, so they cost no API quota and need no sign-in. The page is undocumented and
 * could change; longer lists are split into several links.
 */
export function watchLinks(videoIds: readonly string[], size = WATCH_LINK_SIZE): string[] {
  const links: string[] = [];
  for (let i = 0; i < videoIds.length; i += size) {
    links.push(`${WATCH_VIDEOS}${videoIds.slice(i, i + size).join(",")}`);
  }
  return links;
}

/**
 * The same list, on YouTube Music.
 *
 * `watch_videos` answers 303 to `watch?v=<first>&list=<id>`, and Music plays that id as an
 * untitled list. The id cannot be built here: it is a server-side digest of the videos with the
 * date appended, so it has to be asked for, and it is not worth storing because it rotates
 * daily. Only the redirect is read, never followed, so this costs one header exchange rather
 * than a megabyte of watch page.
 *
 * It needs something that is not a browser. YouTube sends no `access-control-allow-origin` on
 * that endpoint and answers the preflight with 405, so a page can never read the `list` value;
 * the static build has no YouTube Music link for that reason.
 */
export async function musicLink(
  watchUrl: string,
  fetchImpl: typeof fetch = fetch.bind(globalThis),
): Promise<string> {
  if (!watchUrl.startsWith(WATCH_VIDEOS)) {
    throw new Error("Only a YouTube watch_videos link can be opened in YouTube Music.");
  }
  const res = await fetchImpl(watchUrl, { redirect: "manual" });
  const location = res.headers.get("location");
  const target = location === null ? null : URL.parse(location);
  const list = target?.searchParams.get("list");
  const first = target?.searchParams.get("v");
  if (!list || !first) {
    throw new Error("YouTube did not hand back a playlist for those tracks. Try again later.");
  }
  return `https://music.youtube.com/watch?v=${first}&list=${list}`;
}
