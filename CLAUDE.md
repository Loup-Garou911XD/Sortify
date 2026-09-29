# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```sh
npm install
npm run sortify -- <command>   # run the CLI from source (Node 24 strips TS types natively)
npm test                       # vitest, all tests
npx vitest run test/planner.test.ts            # one file
npx vitest run -t "resumes without duplicates" # one test by name
npm run lint                   # biome check (npm run format to auto-fix)
npm run typecheck              # tsc for src/ and test/, then web/
npm run build                  # CLI (tsc → dist/) + web UI (vite → dist/web)
npm run sortify -- ui          # local web UI on http://127.0.0.1:4747 (serves dist/web)
npm run dev:web                # Vite dev server with hot reload; proxies /api to `sortify ui`
```

Requires Node ≥ 24: the code uses the built-in `node:sqlite` module and runs `.ts` files directly. Because of type stripping, `tsconfig.json` sets `erasableSyntaxOnly`: no enums, namespaces or constructor parameter properties. Relative imports use `.ts` extensions (rewritten to `.js` on build).

## Architecture

Sortify is a CLI pipeline (`src/cli.ts`, commander). Each stage reads and writes a local SQLite cache (`src/db.ts`, `Store`), so any stage can be re-run on its own:

1. **fetch** (`src/youtube/`): OAuth desktop flow (`auth.ts`, loopback redirect *or* pasted redirect URL for Codespaces) and a small fetch-based YouTube Data API client (`client.ts`) that counts quota units, retries transient 409/5xx and raises `QuotaExceededError`.
2. **enrich** (`src/enrich/pipeline.ts`): `titleParser.ts` splits video titles into artist/title; `songType.ts` rules give `type` tags; then MusicBrainz (spelling correction), Discogs (styles → subgenres) and Last.fm (track tags → subgenres + moods; artist tags as a half-weight fallback). All HTTP goes through `lookup.ts` `cachedGet`: per-service `RateLimiter`, `Budget` (`--max-api-calls`), and the `lookup_cache` table. A "no match" result is cached too; 401/403 throws rather than caching.
3. **tag mapping** (`src/tagging/`): raw tags are normalized (`normalizeTag`) and mapped onto fixed label lists (`defaultTagMap.ts`, overridable by a YAML file). Broad `families` are used only when no subgenre matched.
4. **plan** (`src/planner.ts`): multi-membership grouping (a track joins every matching group, ranked by summed weight across sources), `--min-size` drops, *Other*/*Unsorted* leftovers, quota estimate. Saved as a `runs` row with `run_groups`/`run_items`.
5. **apply** (`src/apply.ts`): creates playlists and adds tracks, saving progress after each call. It resumes safely: a group whose playlist was created but not recorded is found by the `[sortify run N group M]` marker in its description, and groups with a stored target are diffed against the playlist's current contents before adding.

**Web UI** (`sortify ui`): `src/server/` is a dependency-free `node:http` JSON API over the same `Store` and services (`src/services.ts` is shared with the CLI). Long tasks (fetch, enrich, apply) run one at a time in `JobRunner` (`jobs.ts`) and the UI polls `GET /api/job`; enrich and apply take an `AbortSignal` so "Stop" leaves them resumable. Security: binds to 127.0.0.1, rejects unknown `Host` headers (DNS rebinding; `*.app.github.dev` allowed in Codespaces), and requires an `x-sortify: 1` header on writes (blocks cross-site requests). Browser OAuth redirects to `http://127.0.0.1:<port>/?code=&state=`, handled in `app.ts`. `src/api/types.ts` holds the JSON shapes and is imported type-only by `web/` (React 19 + Vite, no router or UI library; `web/tsconfig.json` is type-checked separately). Plans edited in the UI are validated server-side (`validateGroups`) before becoming a run.

Design constraints worth keeping:
- No LLM/AI classification — tags must come from metadata APIs or rules.
- YouTube writes cost 50 quota units (≈200/day by default), so the write path must stay resumable and duplicate-free.
- Personal use first: the Google app stays in testing mode; sharing with other users (app verification) is deferred.
- External services are injected (`fetch`, `sleep`, `PlaylistWriter`), and tests use fakes and an in-memory `Store(":memory:")`. Tests never make network calls.

## License

GPL-3.0-or-later. New dependencies must be compatible.
