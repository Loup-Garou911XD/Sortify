/**
 * Request checking for the JSON API, kept free of `node:` imports so the browser build can run
 * the same rules. `server/app.ts` serves these over HTTP; `web/src/api.ts` answers the same
 * routes in the page. Anything that decides whether a request is acceptable belongs here, so
 * the two shells cannot drift.
 */
import { type Dimension, GROUP_BY, type GroupDraft } from "../api/types.ts";

export const MAX_GROUPS = 500;
export const MAX_NAME = 100;

/** A rejected request, carrying the status the HTTP shell should use. */
export class RequestError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export function asObject(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new RequestError(400, "Expected a JSON object");
  }
  return value as Record<string, unknown>;
}

export function optionalPositiveInt(value: unknown, name: string): number | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    throw new RequestError(400, `${name} must be a positive integer`);
  }
  return value;
}

export function dimensionOf(value: unknown): Dimension {
  if (typeof value !== "string" || !(GROUP_BY as readonly string[]).includes(value)) {
    throw new RequestError(400, `dimension must be one of ${GROUP_BY.join(", ")}`);
  }
  return value as Dimension;
}

/**
 * Checks edited groups against the playlist: known videos only, unique non-empty names, no
 * duplicates inside a group. Empty groups are dropped.
 */
export function validateGroups(raw: unknown, allowed: Set<string>): GroupDraft[] {
  if (!Array.isArray(raw)) throw new RequestError(400, "groups must be an array");
  if (raw.length > MAX_GROUPS) throw new RequestError(400, `At most ${MAX_GROUPS} groups`);
  const names = new Set<string>();
  const groups: GroupDraft[] = [];
  for (const item of raw) {
    const g = asObject(item);
    const name = typeof g.name === "string" ? g.name.trim() : "";
    if (!name || name.length > MAX_NAME) {
      throw new RequestError(400, `Group names must be 1–${MAX_NAME} characters`);
    }
    if (names.has(name.toLowerCase()))
      throw new RequestError(400, `Duplicate group name "${name}"`);
    names.add(name.toLowerCase());
    if (!Array.isArray(g.videoIds)) throw new RequestError(400, `Group "${name}" has no videoIds`);
    const ids: string[] = [];
    for (const id of g.videoIds) {
      if (typeof id !== "string" || !allowed.has(id)) {
        throw new RequestError(400, `Group "${name}" contains a video that is not in the playlist`);
      }
      if (!ids.includes(id)) ids.push(id);
    }
    if (ids.length > 0) groups.push({ name, videoIds: ids });
  }
  if (groups.length === 0) throw new RequestError(400, "The plan has no tracks");
  return groups;
}
