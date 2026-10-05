import type { Cache } from "../db.ts";
import type { ProviderClient, TagProvider, TrackQuery, TrackTags } from "./provider.ts";

/** Broad labels, so they only matter when no other provider found a subgenre. */
const TOPIC_WEIGHT = 0.5;
/** On nearly every music video; says nothing about genre. */
const GENERIC = new Set(["Music"]);

/**
 * YouTube's own topic labels for each video ("Hip hop music", "Pop music", "Music of Asia").
 * They are collected with the video durations when a playlist is fetched, so this provider makes
 * no requests of its own and covers every track, including uploads no music database knows.
 */
export class YouTubeTopics implements ProviderClient {
  readonly id = "youtube";
  /** The labels hang off the video, so a title no database could match still gets these. */
  readonly videoOnly = true;
  private readonly store: Cache;

  constructor(store: Cache) {
    this.store = store;
  }

  async trackTags({ videoId }: TrackQuery): Promise<TrackTags> {
    const topics = this.store.trackTopics(videoId).filter((t) => !GENERIC.has(t));
    return { genres: topics.map((tag) => ({ tag, source: this.id, weight: TOPIC_WEIGHT })) };
  }
}

export const youtubeTopics: TagProvider = {
  id: "youtube",
  label: "YouTube topics",
  help: "Broad genres from YouTube's own topic labels, collected free when a playlist is fetched.",
  envVars: [],
  create: (deps) => new YouTubeTopics(deps.store),
};
