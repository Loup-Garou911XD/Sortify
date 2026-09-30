/** YouTube's watch_videos page takes at most this many videos per link. */
export const WATCH_LINK_SIZE = 50;

/**
 * Links that play the videos in order as a temporary YouTube playlist. They are plain
 * youtube.com URLs, so they cost no API quota and need no sign-in. The page is undocumented and
 * could change; longer lists are split into several links.
 */
export function watchLinks(videoIds: readonly string[], size = WATCH_LINK_SIZE): string[] {
  const links: string[] = [];
  for (let i = 0; i < videoIds.length; i += size) {
    links.push(
      `https://www.youtube.com/watch_videos?video_ids=${videoIds.slice(i, i + size).join(",")}`,
    );
  }
  return links;
}
