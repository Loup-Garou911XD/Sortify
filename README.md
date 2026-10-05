# Sortify

Sortify takes a large, mixed-bag YouTube or YouTube Music playlist and splits it into focused
sub-playlists: by subgenre, mood, language or decade.

It reads the playlist, tags every track from public music databases, shows you the split it
proposes, and only creates playlists in your account once you approve it. Nothing is written to
YouTube until then, and no AI or LLM is involved: every tag comes from a music metadata service
or a plain rule.

There are three ways to run it, all on the same data:

- **A local web app**, `sortify ui`: the whole flow in a browser on your own machine.
- **The command line**: the same steps as commands, scriptable and resumable. See [CLI.md](CLI.md).
- **In the browser alone**: a server-free build for GitHub Pages, using your own keys. See
  [web/README.md](web/README.md).

Datasets travel between them through your Google Drive, so tagging on one device shows up on the
next.

## Requirements

- Node.js 24 or newer
- A Google Cloud project with the **YouTube Data API v3** enabled
- Optional but recommended: a Discogs token and a Last.fm API key (without them most tracks only
  get a broad genre)

## Setup

```sh
npm install          # installs all three workspaces
npm run build        # builds the web UI and the CLI
```

In the commands below, `sortify` stands for `npm run -s sortify --` run from the repo root (or
`node backend/dist/cli.js` after a build).

The code is split into `backend/` (CLI, local API server, tagging and planning), `frontend/` (the
React UI the backend serves) and `web/` (the same UI built for GitHub Pages).

### 1. Google OAuth client (required)

1. In [Google Cloud Console](https://console.cloud.google.com/), create a project and enable
   **YouTube Data API v3**.
2. Configure the OAuth consent screen (External, testing mode is fine) and add your Google
   account as a test user.
3. Create an **OAuth client ID** of type **Web application**. One client covers all three ways of
   running Sortify, because Google exempts loopback addresses from its HTTPS-only rule. Register
   the addresses you will sign in from, exactly, including the port and the trailing slash:

   | Authorized redirect URI | Used by |
   | --- | --- |
   | `http://127.0.0.1:4747/` | `sortify ui` |
   | `http://127.0.0.1:4748/` | `sortify auth` (a fixed port, so it can be registered) |
   | `https://<your-pages-url>/` | the browser build, if you deploy it |

   The browser build also needs its host under **Authorized JavaScript origins**.
4. Point Sortify at the client's JSON and sign in:

```sh
export SORTIFY_CLIENT_SECRETS=/path/to/client_secret.json
sortify auth
```

The easiest place for this and the API keys below is a `.env` file in the repo root (copy
`.env.example`; it is git-ignored). The backend reads it however it is started, including from the
VS Code tasks, which don't see variables exported in your terminal. Variables already set in the
environment take precedence.

`SORTIFY_CLIENT_SECRETS` can also hold the JSON itself instead of a path, which suits a GitHub
Codespaces secret and is what the browser build imports. Codespaces secrets only reach a codespace
when it starts, so restart the codespace after adding one.

In testing mode Google expires the sign-in after 7 days; run `sortify auth` again when that
happens.

### 2. Tag sources

| Provider | Setting | Used for |
| --- | --- | --- |
| MusicBrainz | none | Corrects artist and title spelling, and adds curated genres for tracks nothing else placed |
| Discogs | `DISCOGS_TOKEN` (Discogs → Settings → Developers → *Generate new token*) | Detailed subgenres from release styles (main source) |
| Last.fm | `LASTFM_API_KEY` ([last.fm/api/account/create](https://www.last.fm/api/account/create)) | Moods, and subgenres where Discogs has none |
| Spotify | `SPOTIFY_CLIENT_ID`, `SPOTIFY_CLIENT_SECRET` (an app at [developer.spotify.com](https://developer.spotify.com/dashboard)) | Detailed artist genres such as desi hip hop or punjabi pop, and release years |
| iTunes | none (`ITUNES_COUNTRY` picks the store, default `US`) | Store genres such as Bollywood or Punjabi Pop, and release years. Asked only when the others found no subgenre, since Apple allows about 20 requests a minute |
| Deezer | none | Album genres and release years, also only when nothing else found a subgenre. Not available in the browser build, which cannot read its answers |
| YouTube topics | none | Broad genres from YouTube's own topic labels, collected free when a playlist is fetched |

Providers without their setting are skipped; `sortify enrich --skip itunes,spotify` skips others
for one run. Answers are cached, so re-tagging is cheap and mostly offline.

Two tags need no service at all. **Song type** (live, remix, cover, acoustic, sped up, …) comes
from the title, and **language** from the script a title is written in, with provider tags like
"bollywood" or "k-pop" filling in the romanized ones. After tagging, a track with no subgenre
takes the one the same artist's other tracks in the playlist agree on.

## Web interface

```sh
sortify ui           # then open http://127.0.0.1:4747
```

The web interface covers the whole flow: connect YouTube, add playlists, tag tracks with live
progress, and preview the split. Before saving, you can rename playlists, leave groups out and
remove single tracks. It then creates the playlists with a live progress bar, and you can stop and
resume at any time.

It only listens on this machine (`--port` changes the port). In a Codespace, open the forwarded
port; if Google's sign-in page can't redirect back, the sign-in dialog lets you paste the address
instead. Set `SORTIFY_UI_ALLOWED_HOSTS` if you reach it under another hostname.

## Command line

The same steps are available as commands: see [CLI.md](CLI.md).

## Sync across devices

`sortify ui` and the browser build keep one dataset in sync through a single file in your Google
Drive, in the hidden per-app `appDataFolder`. There is no server and nothing to set up: the OAuth
client you already made asks for the `drive.appdata` scope as well. Playlists, tags, the lookup
cache and plans all travel, so tagging done on a laptop is there on a phone.

The local app syncs on start, every five minutes, after each job and on shutdown; the browser
build on load, after writes and when you leave the page. One-off CLI commands need no syncing of
their own, since their work travels on the server's next cycle.

If you signed in before the Drive scope existed, Google's old consent does not cover it: run
`sortify auth` again, and press Connect YouTube again in the browser.

## In the browser, with no server

`web/` builds the same UI for GitHub Pages, where it runs entirely in the tab: your own API keys,
your own OAuth client, and IndexedDB instead of SQLite. Useful on a machine where you cannot run
Node, and it shares a dataset with the local app through Drive sync.

```sh
npm run dev:web      # the static build on http://localhost:5173, no backend needed
npm run build:web    # build it into web/dist
```

See [web/README.md](web/README.md) for deploying it and for the handful of things that differ.

## YouTube quota

The default quota is 10,000 units a day. Adding a track or creating a playlist costs 50 units, so
about 200 writes fit in a day. The plan tells you how many days a run will take. When the quota
runs out, applying stops cleanly, and running it again after the daily reset (midnight Pacific
time) continues without creating duplicates or re-adding tracks. For large playlists, request a
quota increase in Google Cloud Console.

Reading a playlist and tagging it cost almost nothing: the expensive part is only ever the writes
you approve.

## Customising the labels

The built-in label lists live in `backend/src/tagging/defaultTagMap.ts`. To change them without
editing code, create `~/.config/sortify/tag_map.yaml` with any of the sections `families`,
`subgenres`, `moods` and `languages`. Each section you include replaces the built-in one:

```yaml
moods:
  Chill: [chillout, relaxing, mellow]
  Workout: [gym, workout, running, pump up]
```

To see what is worth adding, ask for a report:

```sh
sortify tags PL...   # coverage per dimension and source, plus the tags no label matched
```

It replays what the services already said from the cache, so it makes no API calls and writes
nothing. Tags listed as unmatched are the ones your map is throwing away, most common first. After
editing the map, `sortify enrich PL... --force` re-tags every track against it, reusing the
cached answers rather than asking the services again.

## Other settings

| Variable | Default |
| --- | --- |
| `SORTIFY_HOME` | `~/.local/share/sortify` (holds `sortify.db`) |
| `SORTIFY_DB` | `$SORTIFY_HOME/sortify.db` |
| `SORTIFY_TAG_MAP` | `~/.config/sortify/tag_map.yaml` |
| `SORTIFY_DAILY_QUOTA` | `10000` |
| `SORTIFY_UI_DIR` | `frontend/dist`, the built UI the server serves |
| `SORTIFY_UI_ALLOWED_HOSTS` | none; extra hostnames `sortify ui` may be reached under |
| `SORTIFY_CONTACT` | project URL; sent to MusicBrainz in the User-Agent, as their API asks |

## Development

```sh
npm run dev:backend  # API server, restarts on changes (run in one terminal)
npm run dev:frontend # UI with hot reload on http://localhost:5173 (run in another)
                     # in VS Code, Ctrl+Shift+B starts both
npm run dev:web      # the server-free build, on its own
npm test             # backend tests (vitest)
npm run lint         # biome
npm run typecheck    # tsc, all workspaces
npm run format       # biome --write
```

Tests never touch the network or your real data: every service is faked and every config and data
directory is sandboxed.

## License

GPL-3.0-or-later
