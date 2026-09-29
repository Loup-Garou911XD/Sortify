# Sortify
An automated playlist management tool that ingests large, mixed-bag YouTube music playlists and intelligently organizes the tracks into focused sub-playlists based on genre, mood, or song type.

Sortify is a command-line tool. It reads a YouTube or YouTube Music playlist, tags every track with detailed subgenres (from Discogs styles), moods (from Last.fm tags) and song type (live, remix, cover, acoustic, …), previews the split, and only then creates the new playlists in your account. No AI or LLM is involved: every tag comes from a public music database or a simple rule.

## Requirements

- Node.js 24 or newer
- A Google Cloud project with the **YouTube Data API v3** enabled
- Optional but recommended: a Discogs token and a Last.fm API key

## Setup

```sh
npm install          # installs backend/ and frontend/
npm run build        # builds the web UI and the CLI
```

In the commands below, `sortify` stands for `npm run -s sortify --` run from the repo root (or `node backend/dist/cli.js` after a build).

The code is split into `backend/` (CLI, local API server, tagging and planning) and `frontend/` (the React web UI that the backend serves).

### 1. Google OAuth client (required)

1. In [Google Cloud Console](https://console.cloud.google.com/), create a project and enable **YouTube Data API v3**.
2. Configure the OAuth consent screen (External, testing mode is fine) and add your Google account as a test user.
3. Create an **OAuth client ID** of type **Desktop app** and download its JSON file.
4. Point Sortify at it and sign in:

```sh
export SORTIFY_CLIENT_SECRETS=/path/to/client_secret.json
sortify auth
```

The easiest place for this and the API keys below is a `.env` file in the repo root (copy `.env.example`; it is git-ignored). The backend reads it however it is started, including from the VS Code tasks, which don't see variables exported in your terminal. Variables already set in the environment take precedence.

`SORTIFY_CLIENT_SECRETS` can also hold the JSON itself instead of a path, which suits a GitHub Codespaces secret. Codespaces secrets only reach a codespace when it starts, so restart the codespace after adding one.

In testing mode Google expires the sign-in after 7 days; run `sortify auth` again when that happens.

### 2. Tag sources

| Provider | Setting | Used for |
| --- | --- | --- |
| MusicBrainz | none | Corrects artist and title spelling |
| Discogs | `DISCOGS_TOKEN` (Discogs → Settings → Developers → *Generate new token*) | Detailed subgenres (main source) |
| Last.fm | `LASTFM_API_KEY` ([last.fm/api/account/create](https://www.last.fm/api/account/create)) | Moods, and subgenres |
| Spotify | `SPOTIFY_CLIENT_ID`, `SPOTIFY_CLIENT_SECRET` (an app at [developer.spotify.com](https://developer.spotify.com/dashboard)) | Detailed artist genres such as desi hip hop or punjabi pop |
| iTunes | none (`ITUNES_COUNTRY` picks the store, default `US`) | Store genres such as Bollywood or Punjabi Pop, asked only when the others found no subgenre (Apple allows about 20 requests a minute, so it slows tagging a little) |
| YouTube topics | none | Broad genres from YouTube's own topic labels, collected free when a playlist is fetched or refreshed |

Providers without their setting are skipped; `sortify enrich --skip itunes,spotify` skips others for one run. Without Discogs and Last.fm, many tracks only get a broad genre.

## Web interface

```sh
sortify ui           # then open http://127.0.0.1:4747
```

The web interface covers the whole flow: connect YouTube, add playlists, tag tracks with live progress, and preview the split. Before saving, you can rename playlists, leave groups out and remove single tracks. It then creates the playlists with a live progress bar, and you can stop and resume at any time. It only listens on this machine (`--port` changes the port). In a Codespace, open the forwarded port; if Google's sign-in page can't redirect back, the sign-in dialog lets you paste the address instead. Set `SORTIFY_UI_ALLOWED_HOSTS` if you reach it under another hostname.

## Command line

The same steps are available as commands:

```sh
sortify fetch "https://music.youtube.com/playlist?list=PL..."   # read the playlist (cheap on quota)
sortify enrich PL...                                            # tag tracks; resumable, cached
sortify plan PL... --by subgenre --min-size 5                   # preview; writes nothing
sortify apply <run-id>                                          # create playlists (asks first)
sortify status [run-id]                                         # progress of runs
```

- `--by` is `subgenre`, `mood` or `type`. A track goes into **every** group it matches; `--max-groups N` caps that.
- Groups smaller than `--min-size` are dropped. Tracks left without a group go to *Other*, tracks with no tags at all to *Unsorted* (`--no-leftovers` skips both).
- `enrich --max-api-calls N` and `apply --max-writes N` limit a single run. Run the same command again to continue.
- `apply` creates **private** playlists by default (`--privacy unlisted|public`), and `--dry-run` shows what it would do.

### YouTube quota

The default quota is 10,000 units a day. Adding a track or creating a playlist costs 50 units, so about 200 writes fit in a day. `plan` prints how many days a run will take. When the quota runs out, `apply` stops cleanly, and running `sortify apply <run-id>` again after the daily reset (midnight Pacific time) continues without creating duplicates. For large playlists, request a quota increase in Google Cloud Console.

### Customising the labels

The built-in subgenre and mood lists live in `backend/src/tagging/defaultTagMap.ts`. To change them without editing code, create `~/.config/sortify/tag_map.yaml` with any of the sections `families`, `subgenres` and `moods`. Each section you include replaces the built-in one:

```yaml
moods:
  Chill: [chillout, relaxing, mellow]
  Workout: [gym, workout, running, pump up]
```

### Other settings

| Variable | Default |
| --- | --- |
| `SORTIFY_HOME` | `~/.local/share/sortify` (holds `sortify.db`) |
| `SORTIFY_DB` | `$SORTIFY_HOME/sortify.db` |
| `SORTIFY_TAG_MAP` | `~/.config/sortify/tag_map.yaml` |
| `SORTIFY_DAILY_QUOTA` | `10000` |
| `SORTIFY_CONTACT` | project URL; sent to MusicBrainz in the User-Agent, as their API asks |

## Development

```sh
npm run dev:backend  # API server, restarts on changes (run in one terminal)
npm run dev:frontend # UI with hot reload on http://localhost:5173 (run in another)
                     # in VS Code, Ctrl+Shift+B starts both
npm test             # backend tests (vitest)
npm run lint         # biome
npm run typecheck    # tsc, both workspaces
npm run format       # biome --write
```

## License

GPL-3.0-or-later
