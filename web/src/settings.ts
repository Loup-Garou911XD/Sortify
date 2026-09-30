/**
 * Bring-your-own keys.
 *
 * The local server reads these from a git-ignored `.env`. On a static site there is no server,
 * so each person supplies their own and they live in this browser's localStorage. That means
 * anything able to run script on this origin can read them: use keys you are willing to keep in
 * a browser, and revoke them from the issuing service if the machine is shared.
 */

/** Everything the app can be given, in the order the settings screen shows it. */
export const KEYS = [
  {
    id: "GOOGLE_CLIENT_ID",
    label: "Google client ID",
    help: "From an OAuth client of type Web application in Google Cloud Console.",
    required: true,
  },
  {
    id: "GOOGLE_CLIENT_SECRET",
    label: "Google client secret",
    help: "Issued with the client ID. Needed to exchange and refresh the sign-in token.",
    required: true,
    secret: true,
  },
  {
    id: "DISCOGS_TOKEN",
    label: "Discogs token",
    help: "The main subgenre source. developer.discogs.com → personal access token.",
  },
  {
    id: "LASTFM_API_KEY",
    label: "Last.fm API key",
    help: "The only mood source. last.fm/api/account/create.",
  },
  {
    id: "SPOTIFY_CLIENT_ID",
    label: "Spotify client ID",
    help: "Detailed artist genres. developer.spotify.com → create an app.",
  },
  {
    id: "SPOTIFY_CLIENT_SECRET",
    label: "Spotify client secret",
    help: "Issued with the Spotify client ID.",
    secret: true,
  },
  {
    id: "ITUNES_COUNTRY",
    label: "iTunes store",
    help: "Two-letter country for the iTunes store, e.g. IN or US. Defaults to US.",
  },
] as const;

export type KeyId = (typeof KEYS)[number]["id"];

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

export function getKeys(): Record<string, string> {
  return { ...cached };
}

export function getKey(id: KeyId): string {
  return cached[id] ?? "";
}

/** Stores the given keys, dropping any that were blanked out. */
export function saveKeys(next: Record<string, string>): void {
  const cleaned: Record<string, string> = {};
  for (const [k, v] of Object.entries(next)) {
    const trimmed = v.trim();
    if (trimmed) cleaned[k] = trimmed;
  }
  cached = cleaned;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(cleaned));
  } catch {
    // Storage blocked: the keys hold for this page only.
  }
}

/**
 * The keys shaped the way the provider registry expects `process.env`, so `providerStatuses`
 * and `createProviderClients` work unchanged.
 */
export function envVars(): Record<string, string | undefined> {
  return { ...cached };
}

/** Whether sign-in can even be attempted. */
export function hasGoogleClient(): boolean {
  return Boolean(cached.GOOGLE_CLIENT_ID && cached.GOOGLE_CLIENT_SECRET);
}
