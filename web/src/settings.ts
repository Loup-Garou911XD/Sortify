/**
 * Bring-your-own keys.
 *
 * The local server reads these from a git-ignored `.env`. On a static site there is no server,
 * so each person supplies their own and they live in this browser's localStorage. That means
 * anything able to run script on this origin can read them: use keys you are willing to keep in
 * a browser, and revoke them from the issuing service if the machine is shared.
 */

interface KeyDef {
  label: string;
  help: string;
  /** Rendered as a password field. */
  secret?: boolean;
}

/** Everything the app can be given. Insertion order is the order dialogs show the fields in. */
const DEFS = {
  GOOGLE_CLIENT_ID: {
    label: "Google client ID",
    help: "From an OAuth client of type Web application in Google Cloud Console.",
  },
  GOOGLE_CLIENT_SECRET: {
    label: "Google client secret",
    help: "Issued with the client ID. Needed to exchange and refresh the sign-in token.",
    secret: true,
  },
  DISCOGS_TOKEN: {
    label: "Discogs token",
    help: "developer.discogs.com → personal access token.",
  },
  LASTFM_API_KEY: {
    label: "Last.fm API key",
    help: "last.fm/api/account/create.",
  },
  SPOTIFY_CLIENT_ID: {
    label: "Spotify client ID",
    help: "developer.spotify.com → create an app.",
  },
  SPOTIFY_CLIENT_SECRET: {
    label: "Spotify client secret",
    help: "Issued with the Spotify client ID.",
    secret: true,
  },
  ITUNES_COUNTRY: {
    label: "iTunes store",
    help: "Two-letter country for the iTunes store, e.g. IN or US. Defaults to US.",
  },
} satisfies Record<string, KeyDef>;

export type KeyId = keyof typeof DEFS;

/** The same object, typed uniformly so `KEYS[id].secret` reads on every entry. */
export const KEYS: Record<KeyId, KeyDef> = DEFS;

/**
 * What each row of the Connections panel opens: what the source gives you, how to get its key,
 * and which fields to show. Keyed by provider id, plus "account" for the Google client itself.
 * `{origin}` and `{redirect}` are filled in with this deploy's own URLs.
 */
export interface SourceGuide {
  title: string;
  blurb: string;
  docsUrl?: string;
  docsLabel?: string;
  steps: string[];
  fields: KeyId[];
}

export const SOURCE_GUIDES: Record<string, SourceGuide> = {
  account: {
    title: "YouTube account",
    blurb:
      "Sortify reads your playlists and creates new ones through your own Google OAuth client. It never changes or deletes existing playlists.",
    docsUrl: "https://console.cloud.google.com/apis/credentials",
    docsLabel: "Google Cloud credentials",
    steps: [
      "Enable YouTube Data API v3 for your Google Cloud project.",
      "Create an OAuth client ID of type Web application.",
      "Under Authorized JavaScript origins add {origin} — an origin cannot contain a path.",
      "Under Authorized redirect URIs add {redirect}, which must match exactly, trailing slash included.",
      "While the app is in testing mode, add your own Google account as a test user.",
    ],
    fields: ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET"],
  },
  discogs: {
    title: "Discogs",
    blurb: "The main subgenre source: release styles such as Synthwave or Deep House.",
    docsUrl: "https://www.discogs.com/settings/developers",
    docsLabel: "Discogs developer settings",
    steps: [
      "Sign in to Discogs and open Settings → Developers.",
      "Press Generate new token and copy the personal access token.",
    ],
    fields: ["DISCOGS_TOKEN"],
  },
  lastfm: {
    title: "Last.fm",
    blurb: "The only mood source, and subgenres when Discogs has none.",
    docsUrl: "https://www.last.fm/api/account/create",
    docsLabel: "Create a Last.fm API account",
    steps: [
      "Fill in the form with any application name.",
      "Copy the API key. The shared secret is not needed.",
    ],
    fields: ["LASTFM_API_KEY"],
  },
  spotify: {
    title: "Spotify",
    blurb: "Detailed artist genres, for example desi hip hop or punjabi pop.",
    docsUrl: "https://developer.spotify.com/dashboard",
    docsLabel: "Spotify developer dashboard",
    steps: [
      "Press Create app and give it any name and description.",
      "No redirect URI is needed: Sortify uses the client credentials flow.",
      "Open the app's settings and copy the client ID and client secret.",
    ],
    fields: ["SPOTIFY_CLIENT_ID", "SPOTIFY_CLIENT_SECRET"],
  },
  itunes: {
    title: "iTunes",
    blurb:
      "Store genres such as Punjabi Pop and Bollywood, asked only when nothing else found a subgenre.",
    steps: ["No key needed. Set a two-letter country to search a different store than the US."],
    fields: ["ITUNES_COUNTRY"],
  },
  musicbrainz: {
    title: "MusicBrainz",
    blurb:
      "Corrects artist and title spelling before the other sources are asked, and adds curated genres for the tracks nothing else placed.",
    steps: ["No key needed. It is always on."],
    fields: [],
  },
  youtube: {
    title: "YouTube topics",
    blurb: "Broad genres from YouTube's own topic labels.",
    steps: ["No key needed. These arrive free whenever a playlist is fetched."],
    fields: [],
  },
};

const STORAGE_KEY = "sortify-keys";

function read(): Record<string, string> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : {};
    return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, string>) : {};
  } catch {
    return {};
  }
}

let cached = read();

/**
 * The stored keys. The shape is also what the provider registry expects of `process.env`, so
 * `providerStatuses` and `createProviderClients` take it unchanged.
 */
export function getKeys(): Record<string, string> {
  return { ...cached };
}

export function getKey(id: KeyId): string {
  return cached[id] ?? "";
}

/** Merges the given keys over the stored ones, dropping any that were blanked out. */
export function saveKeys(next: Record<string, string>): void {
  const cleaned: Record<string, string> = { ...cached };
  for (const [k, v] of Object.entries(next)) {
    const trimmed = v.trim();
    if (trimmed) cleaned[k] = trimmed;
    else delete cleaned[k];
  }
  cached = cleaned;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(cleaned));
  } catch {
    // Storage blocked: the keys hold for this page only.
  }
}

/** The backend's OAuth client, which is a JSON blob rather than a plain key. */
const CLIENT_SECRETS = "SORTIFY_CLIENT_SECRETS";

export interface ParsedEnv {
  keys: Partial<Record<KeyId, string>>;
  /** Names that were parsed but mean nothing here. */
  ignored: string[];
  /** Set when the file held a Desktop-app OAuth client, which a browser cannot use. */
  desktopClient: boolean;
  /** Set when SORTIFY_CLIENT_SECRETS named a file rather than holding the JSON itself. */
  clientSecretsPath: boolean;
}

function unquote(raw: string): string {
  const value = raw.trim();
  const quote = value[0];
  if ((quote === '"' || quote === "'") && value.endsWith(quote) && value.length > 1) {
    const inner = value.slice(1, -1);
    // Only double quotes carry escapes, matching how dotenv files are normally read.
    return quote === '"' ? inner.replace(/\\n/g, "\n").replace(/\\(["\\])/g, "$1") : inner;
  }
  // An unquoted value ends at an inline comment.
  return value.split(" #")[0]?.trim() ?? "";
}

/**
 * Reads the text of a `.env` file.
 *
 * Node has `process.loadEnvFile` and the backend uses it; browsers have nothing equivalent, so
 * this covers the same ground: comments, blank lines, `export` prefixes, quoted values. A
 * Google client stored as `SORTIFY_CLIENT_SECRETS` JSON is unwrapped when it is a Web
 * application client, and reported when it is a Desktop one.
 */
export function parseEnv(text: string): ParsedEnv {
  const keys: Partial<Record<KeyId, string>> = {};
  const ignored: string[] = [];
  let desktopClient = false;
  let clientSecretsPath = false;

  for (const line of text.replace(/^\uFEFF/, "").split(/\r?\n/)) {
    const trimmed = line.trim().replace(/^export\s+/, "");
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq < 1) continue;
    const name = trimmed.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) continue;
    const value = unquote(trimmed.slice(eq + 1));
    if (!value) continue;

    if (name === CLIENT_SECRETS) {
      const client = readClientSecrets(value);
      if (client === "desktop") desktopClient = true;
      else if (client === null) {
        clientSecretsPath = true;
        ignored.push(name);
      } else if (client) {
        keys.GOOGLE_CLIENT_ID = client.id;
        keys.GOOGLE_CLIENT_SECRET = client.secret;
      }
      continue;
    }

    if (name in KEYS) keys[name as KeyId] = value;
    else ignored.push(name);
  }
  return {
    keys,
    ignored: [...new Set(ignored)],
    desktopClient,
    clientSecretsPath,
  };
}

/** `"desktop"` when the client cannot be used from a browser, `null` when it is not JSON. */
function readClientSecrets(value: string): { id: string; secret: string } | "desktop" | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    // A file path, which a browser cannot read.
    return null;
  }
  const root = parsed as { web?: Record<string, string>; installed?: Record<string, string> };
  if (root.installed) return "desktop";
  const web = root.web;
  return web?.client_id && web.client_secret
    ? { id: web.client_id, secret: web.client_secret }
    : null;
}

/** Whether sign-in can even be attempted. */
export function hasGoogleClient(): boolean {
  return Boolean(cached.GOOGLE_CLIENT_ID && cached.GOOGLE_CLIENT_SECRET);
}
