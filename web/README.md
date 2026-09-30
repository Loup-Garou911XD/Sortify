# Sortify on GitHub Pages

The same UI as `sortify ui`, with no server behind it. Everything — reading your playlists,
tagging tracks, planning, and creating the new playlists — happens in the browser tab, and the
cache lives in IndexedDB instead of SQLite.

This does not replace the local app. `backend/` and `frontend/` are untouched and still the way
to run Sortify on your own machine; this is a second way to ship the same thing.

## How it reuses the app

`vite.config.ts` builds `frontend/`'s React app and swaps exactly one module: `frontend/src/api.ts`
normally calls `sortify ui` over HTTP, and `web/src/api.ts` takes its place, answering the same
routes in the page by calling the same domain code the server calls (`enrichPlaylist`,
`planGroups`, `applyRun`, the provider registry). Nothing in `frontend/` or `backend/` is copied.

| Local (`sortify ui`) | GitHub Pages |
| --- | --- |
| SQLite via `node:sqlite` | in-memory model flushed to IndexedDB (`src/store.ts`) |
| keys from a git-ignored `.env` | keys you type into Settings, kept in localStorage |
| OAuth desktop flow on a loopback port | authorization code + PKCE, exchanged in the browser |

## Setting it up

1. **Deploy it.** Settings → Pages → Source: GitHub Actions. Push to `main`; the workflow in
   `.github/workflows/pages.yml` builds and publishes it.
2. **Create a Google OAuth client.** In Google Cloud Console, enable **YouTube Data API v3**,
   then create an OAuth client ID of type **Web application**. Add your Pages URL (for example
   `https://<user>.github.io/Sortify/`) to *both* Authorized JavaScript origins and Authorized
   redirect URIs. Add yourself as a test user while the app is in testing mode.
3. **Open the site and press Settings.** Paste the client ID and secret, plus any provider keys
   you have (Discogs, Last.fm, Spotify). MusicBrainz, iTunes and YouTube topics need no key.
4. **Connect YouTube**, then use it exactly as you would locally.

## What you are trading away

- **Your keys sit in this browser's localStorage,** including the Google client secret. Anything
  that can run script on the origin can read them. Use keys you are willing to keep in a browser,
  and revoke them if you stop using the site. The local app keeps them in a git-ignored `.env`
  instead, which is why it remains the safer option.
- **Google expires refresh tokens after 7 days** while the OAuth app is in testing mode, so
  expect to reconnect about weekly.
- **Browsers forbid setting `User-Agent`.** MusicBrainz and Discogs both ask API clients to send
  a descriptive one; a static page cannot, and sends the browser's own instead.
- **The cache is per-browser.** Clearing site data clears your playlists and the lookup cache.
  Nothing is lost on YouTube, but tagging has to run again.
- Two messages come from the shared UI and read oddly here: the sign-in dialog and the tag
  sources panel both mention setting environment variables and restarting `sortify ui`. Use
  Settings instead. Fixing the wording means editing `frontend/`, which this build deliberately
  leaves alone.

## Running it locally

```sh
npm run dev:web      # Vite on :5173, no backend needed
npm run build:web    # static site into web/dist
SORTIFY_BASE=/Sortify/ npm run build:web   # for a project page
```

`web/dist/404.html` is a copy of `index.html`: GitHub Pages serves it for any path it does not
recognise, which is what lets a deep link like `/runs/2` load the app.
