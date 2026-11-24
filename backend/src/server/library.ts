/**
 * `GET /api/youtube/playlists`, shared by the server (`app.ts`) and the static build
 * (`web/src/api.ts`). Free of `node:` imports.
 */
import type { LibraryResponse } from "../api/types.ts";
import { hasGroupMarker } from "../apply.ts";
import { LIKED_VIDEOS, LIKED_VIDEOS_TITLE, type YouTubeClient } from "../youtube/client.ts";

/**
 * The playlists a user would want to sort: Liked videos, then the ones they own, minus those
 * Sortify created itself (sorted results, not sources). Costs 1 quota unit per 50 playlists.
 */
export async function libraryPlaylists(
  yt: Pick<YouTubeClient, "myPlaylists">,
): Promise<LibraryResponse> {
  const own = await yt.myPlaylists();
  return {
    playlists: [
      { playlistId: LIKED_VIDEOS, title: LIKED_VIDEOS_TITLE, count: null },
      ...own
        .filter((p) => !hasGroupMarker(p.description))
        .map((p) => ({ playlistId: p.id, title: p.title, count: p.count ?? null })),
    ],
  };
}
