/**
 * Stands in for `node:fs`, which `tagging/mapper.ts` imports for `loadTagMap`.
 *
 * The web app never calls `loadTagMap` — it constructs `TagMapper` with the built-in map — so
 * these are only here to keep the module graph resolvable. If one is ever reached it should say
 * so loudly rather than pretend a file was missing.
 */
export function existsSync(): boolean {
  return false;
}

export function readFileSync(): string {
  throw new Error("Reading files is not possible in the browser build.");
}
