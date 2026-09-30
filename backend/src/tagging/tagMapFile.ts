import { existsSync, readFileSync } from "node:fs";
import { parse } from "yaml";
import type { TagMap } from "./defaultTagMap.ts";
import { DEFAULT_TAG_MAP } from "./defaultTagMap.ts";
import { mergeTagMap } from "./mapper.ts";

/**
 * Reads the user's YAML tag map and merges it over the built-in one. Kept apart from
 * `mapper.ts` so that module stays free of `node:` imports and can run in the browser build.
 */
export function loadTagMap(path?: string): TagMap {
  if (!path || !existsSync(path)) return DEFAULT_TAG_MAP;
  return mergeTagMap(parse(readFileSync(path, "utf8")) as Partial<TagMap> | null);
}
