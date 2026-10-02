import { describe, expect, it } from "vitest";
import { Store } from "../src/db.ts";
import { groupMusicLink, requireRun } from "../src/server/runs.ts";

function planned() {
  const store = new Store(":memory:");
  const ids = Array.from({ length: 60 }, (_, i) => `v${i}`);
  store.savePlaylist(
    "SRC",
    "Source",
    ids.map((videoId) => ({ videoId, title: videoId, channel: "C" })),
  );
  const runId = store.createRun("SRC", "subgenre", 1, [{ name: "Pop", videoIds: ids }]);
  const run = requireRun(store, String(runId));
  const [group] = store.runGroups(runId);
  return { store, run, groupId: String(group?.groupId) };
}

describe("groupMusicLink", () => {
  it("resolves the stored part, not anything the request names", async () => {
    const { store, run, groupId } = planned();
    const seen: string[] = [];
    const resolve = async (link: string) => {
      seen.push(link);
      return "https://music.youtube.com/watch?v=v50&list=TL";
    };
    const res = await groupMusicLink(store, run, groupId, { part: 2 }, resolve);
    expect(res.url).toBe("https://music.youtube.com/watch?v=v50&list=TL");
    expect(seen[0]).toMatch(/^https:\/\/www\.youtube\.com\/watch_videos\?video_ids=v50,/);
  });

  it("answers 404 for an unknown group or part, and 501 without a resolver", async () => {
    const { store, run, groupId } = planned();
    const resolve = async () => "x";
    await expect(groupMusicLink(store, run, "999", {}, resolve)).rejects.toMatchObject({
      status: 404,
    });
    await expect(groupMusicLink(store, run, groupId, { part: 3 }, resolve)).rejects.toMatchObject({
      status: 404,
    });
    await expect(groupMusicLink(store, run, groupId, {}, undefined)).rejects.toMatchObject({
      status: 501,
    });
  });

  it("answers 502 when YouTube hands back no playlist", async () => {
    const { store, run, groupId } = planned();
    const failing = async () => {
      throw new Error("YouTube did not hand back a playlist");
    };
    await expect(groupMusicLink(store, run, groupId, {}, failing)).rejects.toMatchObject({
      status: 502,
    });
  });
});
