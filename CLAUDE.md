# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Layout

npm workspaces in one repo:

- `backend/` (package `sortify`): the CLI, the local API server, all domain logic, and the tests. Source is in `backend/src`, tests in `backend/test`.
- `frontend/` (package `@sortify/frontend`): the React 19 + Vite web UI. It builds to `frontend/dist`, which the backend serves (override with `SORTIFY_UI_DIR`).
- Root: shared tooling (Biome, CI, `.vscode/tasks.json`) and scripts that run both packages.

## Commands

Run from the repo root:

```sh
npm install                    # installs both workspaces
npm run dev:backend            # `sortify ui` on :4747, restarts on backend/src changes
npm run dev:frontend           # Vite on :5173 with hot reload, proxies /api to :4747
                               # (in VS Code, Ctrl+Shift+B starts both in separate terminals)
npm run -s sortify -- <command>   # the CLI from source, e.g. `npm run -s sortify -- ui`
npm test                       # backend tests (vitest)
npm test -w backend -- test/planner.test.ts                # one file
npm test -w backend -- -t "resumes without duplicates"     # one test by name
npm run lint                   # biome check for both (npm run format to auto-fix)
npm run typecheck              # tsc in each workspace
npm run build                  # frontend → frontend/dist, backend → backend/dist
```

The backend loads a git-ignored repo-root `.env` (`backend/src/env.ts`, which must stay the first import in `cli.ts`; see `.env.example`), so settings reach the server however it is started. Real environment variables win over `.env`. Tests build configs with `testConfig()` from `backend/test/helpers.ts`, which sandboxes every config and data directory.

Requires Node ≥ 24: the backend uses the built-in `node:sqlite` module and runs `.ts` files directly. Because of type stripping, `backend/tsconfig.json` sets `erasableSyntaxOnly`: no enums, namespaces or constructor parameter properties. Relative imports use `.ts` extensions (rewritten to `.js` on build).

## Architecture

Sortify is a CLI pipeline (`backend/src/cli.ts`, commander). Paths below are relative to `backend/src/`. Each stage reads and writes a local SQLite cache (`db.ts`, `Store`), so any stage can be re-run on its own:

1. **fetch** (`youtube/`): OAuth desktop flow (`auth.ts`, loopback redirect *or* pasted redirect URL for Codespaces) and a small fetch-based YouTube Data API client (`client.ts`) that counts quota units, retries transient 409/5xx and raises `QuotaExceededError`.
2. **enrich** (`enrich/pipeline.ts`): `titleParser.ts` splits video titles into artist/title; `songType.ts` rules give `type` tags; then MusicBrainz (spelling correction), Discogs (styles → subgenres) and Last.fm (track tags → subgenres + moods; artist tags as a half-weight fallback). All HTTP goes through `lookup.ts` `cachedGet`: per-service `RateLimiter`, `Budget` (`--max-api-calls`), and the `lookup_cache` table. A "no match" result is cached too; 401/403 throws rather than caching.
3. **tag mapping** (`tagging/`): raw tags are normalized (`normalizeTag`) and mapped onto fixed label lists (`defaultTagMap.ts`, overridable by a YAML file). Broad `families` are used only when no subgenre matched.
4. **plan** (`planner.ts`): multi-membership grouping (a track joins every matching group, ranked by summed weight across sources), `--min-size` drops, *Other*/*Unsorted* leftovers, quota estimate. Saved as a `runs` row with `run_groups`/`run_items`.
5. **apply** (`apply.ts`): creates playlists and adds tracks, saving progress after each call. It resumes safely: a group whose playlist was created but not recorded is found by the `[sortify run N group M]` marker in its description, and groups with a stored target are diffed against the playlist's current contents before adding.

**Web UI** (`sortify ui`): `server/` is a dependency-free `node:http` JSON API over the same `Store` and services (`services.ts` is shared with the CLI). Long tasks (fetch, enrich, apply) run one at a time in `JobRunner` (`jobs.ts`) and the UI polls `GET /api/job`; enrich and apply take an `AbortSignal` so "Stop" leaves them resumable. Security: binds to 127.0.0.1, rejects unknown `Host` headers (DNS rebinding; `*.app.github.dev` allowed in Codespaces), and requires an `x-sortify: 1` header on writes (blocks cross-site requests). Browser OAuth redirects to `http://127.0.0.1:<port>/?code=&state=`, handled in `app.ts`. `api/types.ts` holds the JSON shapes. It is the only backend file the frontend touches, imported type-only by relative path. The frontend (`frontend/src`) uses no router or UI library and talks to the backend only over HTTP (`frontend/src/api.ts`). Plans edited in the UI are validated server-side (`validateGroups`) before becoming a run.

Design constraints worth keeping:
- No LLM/AI classification — tags must come from metadata APIs or rules.
- YouTube writes cost 50 quota units (≈200/day by default), so the write path must stay resumable and duplicate-free.
- Personal use first: the Google app stays in testing mode; sharing with other users (app verification) is deferred.
- External services are injected (`fetch`, `sleep`, `PlaylistWriter`), and tests use fakes and an in-memory `Store(":memory:")`. Tests never make network calls.

## License

GPL-3.0-or-later. New dependencies must be compatible.
