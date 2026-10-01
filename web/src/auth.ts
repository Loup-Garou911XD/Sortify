/**
 * Google sign-in from a static page.
 *
 * The desktop flow the CLI uses needs a loopback listener, which a Pages deploy has not got, so
 * this is the authorization-code flow with PKCE, exchanged in the browser using the client
 * secret the user supplied. Google's token endpoint sends CORS headers for both the
 * `authorization_code` and `refresh_token` grants, which is what makes this possible at all.
 *
 * Consent opens in a second tab. That tab lands back here with `?code=`, completes the exchange
 * and closes; the first tab notices because tokens live in localStorage, which both tabs share.
 */
import { DRIVE_SCOPE } from "../../backend/src/sync/drive.ts";
import { getKey, hasGoogleClient } from "./settings.ts";

/**
 * Read access to playlists plus the right to create them and add items — the same scope the CLI
 * asks for. Copied rather than imported: `backend/src/youtube/auth.ts` is the Node loopback flow
 * and pulls in `node:` modules and google-auth-library.
 */
const SCOPES = ["https://www.googleapis.com/auth/youtube", DRIVE_SCOPE];

const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const TOKEN_KEY = "sortify-google-token";
const PENDING_KEY = "sortify-oauth-pending";
/** Refresh this long before expiry, so a request never starts with a token about to lapse. */
const EARLY_S = 60;

interface Tokens {
  accessToken: string;
  /** Epoch milliseconds. */
  expiresAt: number;
  refreshToken?: string;
}

interface Pending {
  verifier: string;
  state: string;
}

interface TokenResponse {
  access_token?: string;
  expires_in?: number;
  refresh_token?: string;
  error?: string;
  error_description?: string;
}

/** The page itself is the redirect target, so this must be an Authorized redirect URI. */
export function redirectUri(): string {
  return location.origin + location.pathname;
}

function readJson<T>(storage: Storage, key: string): T | null {
  try {
    const raw = storage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

function writeJson(storage: Storage, key: string, value: unknown): void {
  try {
    storage.setItem(key, JSON.stringify(value));
  } catch {
    // Storage blocked; sign-in then lasts only as long as this page.
  }
}

const tokens = (): Tokens | null => readJson<Tokens>(localStorage, TOKEN_KEY);

export function isSignedIn(): boolean {
  const t = tokens();
  // A refresh token means we can get a new access token even though this one has lapsed.
  return t !== null && (t.refreshToken !== undefined || t.expiresAt > Date.now());
}

export function signOut(): void {
  try {
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(PENDING_KEY);
  } catch {
    // Nothing to clear.
  }
}

function randomString(bytes = 48): string {
  const raw = crypto.getRandomValues(new Uint8Array(bytes));
  return base64Url(raw);
}

function base64Url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function challengeFor(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return base64Url(new Uint8Array(digest));
}

/** Builds the consent URL and remembers the PKCE verifier for the tab that comes back. */
export async function startAuth(): Promise<string> {
  if (!hasGoogleClient()) {
    throw new Error("Add your Google client ID and secret in Settings first.");
  }
  const verifier = randomString();
  const state = randomString(16);
  writeJson(localStorage, PENDING_KEY, { verifier, state } satisfies Pending);
  const params = new URLSearchParams({
    client_id: getKey("GOOGLE_CLIENT_ID"),
    redirect_uri: redirectUri(),
    response_type: "code",
    scope: SCOPES.join(" "),
    // Without these Google returns no refresh token, and sign-in would lapse within the hour.
    access_type: "offline",
    prompt: "consent",
    include_granted_scopes: "true",
    state,
    code_challenge: await challengeFor(verifier),
    code_challenge_method: "S256",
  });
  return `${AUTH_URL}?${params}`;
}

async function postToken(body: URLSearchParams): Promise<TokenResponse> {
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });
  const data = (await res.json()) as TokenResponse;
  if (!res.ok || !data.access_token) {
    throw new Error(data.error_description ?? data.error ?? `Google returned ${res.status}`);
  }
  return data;
}

function store(data: TokenResponse, previousRefresh?: string): void {
  writeJson(localStorage, TOKEN_KEY, {
    accessToken: data.access_token as string,
    expiresAt: Date.now() + (data.expires_in ?? 3600) * 1000,
    // A refresh response usually omits the refresh token; keep the one we already hold.
    refreshToken: data.refresh_token ?? previousRefresh,
  } satisfies Tokens);
}

/**
 * Finishes sign-in from the URL Google sent the browser back to. Accepts a full URL so the user
 * can paste it by hand when the redirect tab cannot open.
 */
export async function completeAuth(url: string): Promise<void> {
  let parsed: URL;
  try {
    parsed = new URL(url, location.href);
  } catch {
    throw new Error("That does not look like a URL.");
  }
  const error = parsed.searchParams.get("error");
  if (error) throw new Error(`Google refused the sign-in: ${error}`);
  const code = parsed.searchParams.get("code");
  const state = parsed.searchParams.get("state");
  if (!code) throw new Error("That URL has no code parameter.");

  const pending = readJson<Pending>(localStorage, PENDING_KEY);
  if (!pending) throw new Error("This sign-in was not started here. Try connecting again.");
  if (state !== pending.state) throw new Error("The sign-in state did not match. Try again.");

  const data = await postToken(
    new URLSearchParams({
      grant_type: "authorization_code",
      code,
      client_id: getKey("GOOGLE_CLIENT_ID"),
      client_secret: getKey("GOOGLE_CLIENT_SECRET"),
      redirect_uri: redirectUri(),
      code_verifier: pending.verifier,
    }),
  );
  store(data);
  try {
    localStorage.removeItem(PENDING_KEY);
  } catch {
    // Already gone.
  }
}

let refreshing: Promise<string> | undefined;

async function refresh(current: Tokens): Promise<string> {
  if (!current.refreshToken) {
    throw new Error("Your YouTube sign-in has expired. Connect YouTube again.");
  }
  const data = await postToken(
    new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: current.refreshToken,
      client_id: getKey("GOOGLE_CLIENT_ID"),
      client_secret: getKey("GOOGLE_CLIENT_SECRET"),
    }),
  );
  store(data, current.refreshToken);
  return data.access_token as string;
}

/**
 * The shape `YouTubeClient` expects. Refreshes when the token is close to expiry, and shares one
 * in-flight refresh so parallel calls cannot each spend the refresh token.
 */
export async function getAccessToken(): Promise<{ token?: string | null }> {
  const current = tokens();
  if (!current) throw new Error("Connect YouTube first.");
  if (current.expiresAt - EARLY_S * 1000 > Date.now()) return { token: current.accessToken };
  refreshing ??= refresh(current).finally(() => {
    refreshing = undefined;
  });
  return { token: await refreshing };
}
