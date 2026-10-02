# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Layout

npm workspaces in one repo:

- `backend/` (package `sortify`): the CLI, the local API server, all domain logic, and the tests. Source is in `backend/src`, tests in `backend/test`.
- `frontend/` (package `@sortify/frontend`): the React 19 + Vite web UI. It builds to `frontend/dist`, which the backend serves (override with `SORTIFY_UI_DIR`).
- `web/` (package `@sortify/web`): a second, server-free build of that same UI for GitHub Pages, where users bring their own API keys. It adds files, it does not change `backend/` or `frontend/`. See `web/README.md`.
- Root: shared tooling (Biome, CI, `.vscode/tasks.json`) and scripts that run both packages.

## Commands

Run from the repo root:

```sh
npm install                    # installs both workspaces
npm run dev:backend            # `sortify ui` on :4747, restarts on backend/src changes
npm run dev:frontend           # Vite on :5173 with hot reload, proxies /api to :4747
                               # (in VS Code, Ctrl+Shift+B starts both in separate terminals)
npm run dev:web                # the static build on :5173, no backend needed
npm run build:web              # static site → web/dist (SORTIFY_BASE=/<repo>/ for a project page)
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
2. **enrich** (`enrich/pipeline.ts`): `titleParser.ts` splits video titles into artist/title (also the pipe-separated Indian-label style, "Song - Artist" told apart by the channel name) and flags `official` ("- Topic" channels) and `confident` (artist stated, not guessed). `songType.ts` rules give `type` tags. Then the **tag providers** run in three generic steps: the first `resolve` that matches fixes the spelling, every provider's `trackTags` runs in parallel, and `artistTags` fills in only when nothing gave a genre and the artist is known. Several tracks are tagged at once (`concurrency`, default 4). The pipeline never names a provider.
   - **Providers** (`enrich/provider.ts` interface, `enrich/providers.ts` registry `PROVIDERS`): MusicBrainz (resolver; `skip`s official tracks), Discogs (styles → subgenres), Last.fm (genres + moods, artist fallback), Spotify (artist genres; client-credentials token via a `headers` function), iTunes (store genres; `fallback: true` so it is only asked when no subgenre was found, because of its ~20 req/min limit), YouTube topics (no requests: reads `tracks.topics`, filled by `videoDetails` during fetch). A provider can use per-video data through `TrackQuery.videoId`. Each owns its weights and thresholds, reads its own env vars (`envVars`; missing → off), and talks HTTP through `lookup.ts` `ServiceClient`: its own `RateLimiter` (slots reserved synchronously; `penalize` backs off every caller on 429/5xx), the `Budget` (`--max-api-calls`), in-flight de-duplication, and the `lookup_cache` table (a "no match" is cached too; 401/403 throws). Provider ids are the cache namespace, the tag `source`, and the key in `tracks.external_ids`.
   - **Adding a provider** (e.g. Spotify): write `enrich/<name>.ts` exporting a `TagProvider` whose client implements any of `resolve`/`trackTags`/`artistTags`/`skip`, and add it to `PROVIDERS`. The CLI (`enrich --skip <ids>`, missing-key warnings), `/api/status` `sources`, and the web UI pick it up from the registry. Tests can plug in a fake `ProviderClient` (see `test/enrich.test.ts`).
3. **tag mapping** (`tagging/`): raw tags are normalized (`normalizeTag`) and mapped onto fixed label lists (`defaultTagMap.ts`, overridable by a YAML file). Broad `families` are used only when no subgenre matched.
4. **plan** (`planner.ts`): multi-membership grouping (a track joins every matching group, ranked by summed weight across sources), `--min-size` drops, *Other*/*Unsorted* leftovers, quota estimate. Saved as a `runs` row with `run_groups`/`run_items`.
5. **apply** (`apply.ts`): creates playlists and adds tracks, saving progress after each call. It resumes safely: a group whose playlist was created but not recorded is found by the `[sortify run N group M]` marker in its description, and groups with a stored target are diffed against the playlist's current contents before adding.

**Web UI** (`sortify ui`): `server/` is a dependency-free `node:http` JSON API over the same `Store` and services (`services.ts` is shared with the CLI). Long tasks (fetch, enrich, apply) run one at a time in `JobRunner` (`jobs.ts`) and the UI polls `GET /api/job`; enrich and apply take an `AbortSignal` so "Stop" leaves them resumable. Security: binds to 127.0.0.1, rejects unknown `Host` headers (DNS rebinding; `*.app.github.dev` allowed in Codespaces), and requires an `x-sortify: 1` header on writes (blocks cross-site requests). Browser OAuth redirects to `http://127.0.0.1:<port>/?code=&state=`, handled in `app.ts`. `api/types.ts` holds the JSON shapes. It is the only backend file the frontend touches, imported type-only by relative path. The frontend (`frontend/src`) uses no router or UI library and talks to the backend only over HTTP (`frontend/src/api.ts`). Plans edited in the UI are validated server-side (`validateGroups`) before becoming a run.

Design constraints worth keeping:
- No LLM/AI classification — tags must come from metadata APIs or rules.
- YouTube writes cost 50 quota units (≈200/day by default), so the write path must stay resumable and duplicate-free.
- Personal use first: the Google app stays in testing mode; sharing with other users (app verification) is deferred.
- External services are injected (`fetch`, `sleep`, `PlaylistWriter`), and tests use fakes and an in-memory `Store(":memory:")`. Tests never make network calls.

## Sync (`sync/`)

One dataset across devices, through a single file in Google Drive's `appDataFolder` — a hidden,
per-app, per-user folder. No server and no new infrastructure: the OAuth client each shell
already uses just also asks for `drive.appdata` (`SCOPES` in `youtube/auth.ts` and
`web/src/auth.ts`). **Adding that scope invalidates existing consent**, so a sign-in made before
it has to be repeated — `sortify auth` again, and Connect YouTube again in the browser.

**One OAuth client serves all three shells**, of type Web application. Google exempts loopback
addresses from its HTTPS-only rule, so `http://127.0.0.1:<port>/` can be registered on a Web
client; the match is exact, including port and trailing slash. That is why `sortify auth` listens
on the fixed `AUTH_PORT` (4748) rather than any free port — a random one could not be registered.
`sortify ui` uses its own port (4747) and the static build its deploy URL. The single credential
lives in `SORTIFY_CLIENT_SECRETS`; the browser build takes the id and secret out of that same
JSON through its `.env` import.

- `sync/snapshot.ts` is the travelling shape and the merge rules, free of `node:` imports so both
  shells share it. Merging is per record: tracks by `videoId` with the more recently tagged copy
  winning, tags following the winning track, the lookup cache unioned, playlists taking the newer
  fetch whole. Details that cost YouTube quota (`durationS`, `topics`) are kept from whichever
  side has them, even when the other copy wins.
- **Run ids are the one hazard.** They are local counters on both sides, so two devices both mint
  "run 3". A colliding run is renumbered — *except* when `idsAreFrozen()`: a run that has started
  applying and still has a group with no recorded target may have a `[sortify run N group M]`
  marker live on a YouTube playlist, and `apply` finds that playlist again by the marker. Moving
  such an id would orphan the playlist and make the next apply create a duplicate. Those are
  reported as conflicts instead. Once every target is recorded the marker is never read again, so
  the run is safe to renumber. Runs are matched by identity (`createdAt` + source playlist), not
  by id, so re-merging the same remote does not duplicate a run that was already moved.
- `sync/drive.ts` is the Drive client, `fetch`-based with the token provider injected like
  `YouTubeClient`. `sync/engine.ts` is pull → merge → push, debounced, guarded by Drive's
  `modifiedTime`. Drive has no compare-and-swap on content, so a push can still be clobbered by
  one landing microseconds earlier; that is safe because every push sends the merge of local and
  remote, so the overwritten device restores its data on its next cycle.
- Both stores implement `Syncable` (`snapshot()`/`absorb()`), and the compiler enforces it.
  SQLite's `absorb` also bumps `sqlite_sequence`, or `AUTOINCREMENT` would hand out an id a merge
  had just assigned to something else.
- Wiring: `sortify ui` syncs on start, every 5 minutes, after each job and on shutdown — the
  one-shot CLI commands need no changes, because their work travels on the server's next cycle.
  The browser syncs on load, after writes and on page-hide. `/api/status` carries a `sync` view,
  and the UI refreshes only when `changed` says a merge actually brought something in; a blanket
  refresh would rebuild the sort preview and discard a half-edited plan.

Note for the browser build: `fetch` must be captured as `fetch.bind(globalThis)`. Storing the
bare global in a variable and calling it throws "Illegal invocation" in browsers while working
fine in Node.

## The static build (`web/`)

`web/` ships the frontend to GitHub Pages with no server behind it. It works by building
`frontend/`'s app and swapping exactly one module: `vite.config.ts` has a `resolveId` plugin that
redirects anything resolving to `frontend/src/api.ts` to `web/src/api.ts`. That module answers the
same routes the server does, in the page, by calling the same domain code (`enrichPlaylist`,
`planGroups`, `applyRun`, `PROVIDERS`). A path alias would not work: the app imports `./api.ts`
and `../api.ts`, and Vite aliases match the specifier as written.

What differs from the local app, and why:
- **Storage**: `web/src/store.ts` holds the whole model in memory and flushes dirty collections to
  IndexedDB, debounced. The `Store` API is synchronous and IndexedDB is not, so this is what keeps
  the pipeline unchanged. `Store` is a class with private SQLite fields, so `api.ts` has one
  `as unknown as Store` cast — the only place the web build asserts anything about backend internals.
- **Keys**: `web/src/settings.ts` keeps them in localStorage and hands them to
  `createProviderClients` as the same `env` record `process.env` provides.
- **Auth**: `web/src/auth.ts` is the authorization-code flow with PKCE, exchanged in the browser
  with the user's own client secret. Every upstream (Google's token endpoint included) sends CORS
  headers, which is what makes a serverless build possible at all.
- **Node-only imports**: only `tagging/mapper.ts` has one (`node:fs`, for the YAML override, which
  this build never reads); it is aliased to `web/src/node-fs-stub.ts`. Everything else that touches
  `db.ts` does so with `import type`, so `node:sqlite` never reaches the bundle. `enrich/spotify.ts`
  uses `Buffer` for base64, shimmed in `web/src/shims.ts`. If you add a runtime `node:` import to a
  module the pipeline reaches, the web build breaks.
- **YouTube Music links**: a plan's "Play without quota" links are `youtube.com/watch_videos`
  URLs. YouTube answers one with a 303 to `watch?v=<first>&list=<id>`, and that id opens in
  YouTube Music, but reading the redirect needs something that is not a browser: YouTube sends no
  `access-control-allow-origin` there and answers the preflight with 405. So `musicLink()` runs
  server-side behind `POST /api/music-link`, `StatusResponse.opensInMusic` says whether the shell
  can do it, and this build sets it false and shows only the youtube.com link.
- **Routing**: `useLocation` in `frontend/src/hooks.ts` strips and re-adds `import.meta.env.BASE_URL`
  so the app can live under `/<repo>/`. With the local build's base of `/` this is a no-op.
  `web/dist/404.html` is a copy of `index.html`, which is how Pages serves deep links.

## License

GPL-3.0-or-later. New dependencies must be compatible.
