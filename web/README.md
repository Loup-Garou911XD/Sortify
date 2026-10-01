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

The one thing this build asks of the shared UI is an optional `configureSource` prop on `App`.
When it is passed, the Connections panel turns each row into a button and calls back with the
source to configure; `web/src/KeyDialog.tsx` answers with that source's setup. The local app
passes nothing and its rows stay plain text, exactly as before.

| Local (`sortify ui`) | GitHub Pages |
| --- | --- |
| SQLite via `node:sqlite` | in-memory model flushed to IndexedDB (`src/store.ts`) |
| keys from a git-ignored `.env` | keys you type into Settings, kept in localStorage |
| OAuth desktop flow on a loopback port | authorization code + PKCE, exchanged in the browser |

## Setting it up

1. **Deploy it.** Settings → Pages → Source: GitHub Actions. Push to `main`; the workflow in
   `.github/workflows/pages.yml` builds and publishes it.

   The site has to be built for the path it is served from. `web/public/CNAME` decides that: with
   a custom domain the site sits at the domain root, so the workflow builds with `SORTIFY_BASE=/`;
   without one it is a project page under `/<repo>/`. Put the domain in that file when you set a
   custom domain, and delete the file if you stop using one — otherwise every asset URL is wrong
   and the page loads as a blank screen.
2. **Create a Google OAuth client.** In Google Cloud Console, enable **YouTube Data API v3**,
   then create an OAuth client ID of type **Web application**. The two fields take different
   values, and neither accepts the other's:

   | Field | Value | Rule |
   | --- | --- | --- |
   | Authorized JavaScript origins | `https://sortify.example.com` | An origin only: scheme, host, port. A path is rejected. |
   | Authorized redirect URIs | `https://sortify.example.com/` | Matched exactly, path and trailing slash included. |

   Both change if you move the site, so update them whenever the URL does — a stale redirect URI
   fails sign-in with `redirect_uri_mismatch`.

   The YouTube dialog under Connections prints both values for your own deploy, so copy them
   from there. Add yourself as a test user while the app is in testing mode.
3. **Open the site and use Connections in the top bar.** If your keys already sit in a `.env`
   file, **Import keys from a .env file** at the bottom of that panel reads them all at once,
   under the same names the backend uses, and unwraps a Web application client stored as
   `SORTIFY_CLIENT_SECRETS` JSON. File pickers hide dotfiles, so pasting the contents works too.
   Otherwise enter them one at a time: every row in that panel is a button. Pick **YouTube** for
   the Google client ID and secret, or a tag source to see how to get its key. MusicBrainz,
   iTunes and YouTube topics need no key and say so.
4. **Connect YouTube**, then use it exactly as you would locally.

## Syncing between devices

Signed in, the app keeps one dataset in a hidden folder of your own Google Drive
(`appDataFolder`), so the same playlists, tags and plans show up on every browser you sign into —
and in `sortify ui` on your machine, which syncs the same file. Connections → Sync shows how the
last attempt went.

Nothing is shared with anyone: the folder is per-app and per-user, invisible in your Drive, and
no other app can read it. The one visible cost is that granting it changes what the app asks for,
so you reconnect YouTube once.

## What you are trading away

- **Your keys sit in this browser's localStorage,** including the Google client secret. Anything
  that can run script on the origin can read them. Use keys you are willing to keep in a browser,
  and revoke them if you stop using the site. The local app keeps them in a git-ignored `.env`
  instead, which is why it remains the safer option.
- **Google expires refresh tokens after 7 days** while the OAuth app is in testing mode, so
  expect to reconnect about weekly.
- **Syncing needs the `drive.appdata` permission.** A sign-in made before syncing existed does
  not carry it, so the first thing it will say is that it needs you to sign in again.
- **Browsers forbid setting `User-Agent`.** MusicBrainz and Discogs both ask API clients to send
  a descriptive one; a static page cannot, and sends the browser's own instead.
- **Clearing site data clears this browser's copy.** With syncing on it comes back from Drive on
  the next sign-in; without it, tagging has to run again.
- The sign-in dialog still describes the local setup: it mentions `SORTIFY_CLIENT_SECRETS` and
  restarting `sortify ui`. Use Connections → YouTube instead. The tag sources panel no longer has
  that problem — it adapts when the shell can edit its own keys.

## Running it locally

```sh
npm run dev:web      # Vite on :5173, no backend needed
npm run build:web    # static site into web/dist
SORTIFY_BASE=/Sortify/ npm run build:web   # for a project page
```

Keys live in the browser, not in the build, so a dev server and a deploy are built from exactly
the same bytes. Import your `.env` once through Connections and it persists per browser.

`web/dist/404.html` is a copy of `index.html`: GitHub Pages serves it for any path it does not
recognise, which is what lets a deep link like `/runs/2` load the app.
