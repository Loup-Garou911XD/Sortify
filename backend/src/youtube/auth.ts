import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { dirname } from "node:path";
import { createInterface } from "node:readline";
import { type Credentials, OAuth2Client } from "google-auth-library";
import type { StatusResponse } from "../api/types.ts";
import type { ClientSecretsSource, Config } from "../config.ts";
import { DRIVE_SCOPE } from "../sync/drive.ts";

/**
 * Read access to playlists plus the right to create playlists and add items, and a hidden
 * folder of Sortify's own in Drive for syncing between devices. Adding a scope invalidates
 * stored consent, so a sign-in made before it was added has to be repeated.
 */
export const SCOPES = ["https://www.googleapis.com/auth/youtube", DRIVE_SCOPE];

interface ClientSecrets {
  clientId: string;
  clientSecret: string;
}

function readClientSecrets(source: ClientSecretsSource): string {
  if ("json" in source) return source.json;
  try {
    return readFileSync(source.path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(`SORTIFY_CLIENT_SECRETS points to ${source.path}, which does not exist`);
    }
    throw err;
  }
}

function loadClientSecrets(config: Config): ClientSecrets {
  const source = config.clientSecrets;
  if (!source) {
    throw new Error(
      "SORTIFY_CLIENT_SECRETS is not set. Set it to the OAuth client JSON (Desktop app) from " +
        "Google Cloud Console, or to the path of that file.",
    );
  }
  const text = readClientSecrets(source);
  const where = "json" in source ? "SORTIFY_CLIENT_SECRETS" : source.path;
  let json: {
    installed?: { client_id?: string; client_secret?: string };
    web?: { client_id?: string; client_secret?: string };
  };
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`${where} is not valid JSON`);
  }
  const creds = json.installed ?? json.web;
  if (!creds?.client_id || !creds.client_secret) {
    throw new Error(`${where} does not look like a Google OAuth client file`);
  }
  return { clientId: creds.client_id, clientSecret: creds.client_secret };
}

/** Writes JSON readable only by the current user (tokens, PKCE verifiers). */
function writePrivateJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value, null, 2));
  chmodSync(path, 0o600);
}

/**
 * Returns an OAuth client with stored credentials. Refreshed access tokens are written back so
 * the refresh token keeps working across runs.
 */
export function loadAuthClient(config: Config): OAuth2Client {
  const { clientId, clientSecret } = loadClientSecrets(config);
  if (!existsSync(config.tokenPath)) {
    throw new Error("Not signed in. Run `sortify auth` first.");
  }
  const stored = JSON.parse(readFileSync(config.tokenPath, "utf8")) as Credentials;
  if (!stored.refresh_token) {
    throw new Error("The saved YouTube sign-in is incomplete. Sign out and connect YouTube again.");
  }
  const client = new OAuth2Client({ clientId, clientSecret });
  client.setCredentials(stored);
  client.on("tokens", (tokens) => {
    writePrivateJson(config.tokenPath, { ...stored, ...tokens });
  });
  return client;
}

/** Turns the `error` Google puts on the redirect into something the user can act on. */
export function describeAuthError(error: string): string {
  if (error === "access_denied") {
    return (
      "Google refused the sign-in (access_denied). While the app is in Testing mode, only its " +
      "test users can sign in: in Google Cloud Console, open Google Auth Platform → Audience, " +
      "add your Google account under Test users, then try again. If you pressed Cancel on " +
      "Google's page, just try again."
    );
  }
  return `Google sign-in failed: ${error}`;
}

export function authState(config: Config): Pick<StatusResponse, "clientSecretsError" | "signedIn"> {
  let clientSecretsError: string | null = null;
  try {
    loadClientSecrets(config);
  } catch (err) {
    clientSecretsError = (err as Error).message;
  }
  return { clientSecretsError, signedIn: existsSync(config.tokenPath) };
}

export function signOut(config: Config): void {
  rmSync(config.tokenPath, { force: true });
}

export interface PendingAuth {
  url: string;
  state: string;
  codeVerifier: string;
  redirectUri: string;
}

const PENDING_TTL_MS = 15 * 60 * 1000;

type PendingEntry = PendingAuth & { createdAt: number };

/**
 * Sign-ins started from the web UI and not yet finished, keyed by OAuth `state`. Several can be
 * open at once (the user may click "Open Google sign-in" twice), and they are kept on disk so a
 * server restart in the middle of a sign-in does not lose them.
 */
export class PendingAuthStore {
  private readonly path: string;

  constructor(path: string) {
    this.path = path;
  }

  private load(): PendingEntry[] {
    try {
      return JSON.parse(readFileSync(this.path, "utf8"));
    } catch {
      return [];
    }
  }

  private live(now: number): PendingEntry[] {
    return this.load().filter((e) => now - e.createdAt < PENDING_TTL_MS);
  }

  add(pending: PendingAuth, now = Date.now()): void {
    writePrivateJson(this.path, [...this.live(now), { ...pending, createdAt: now }]);
  }

  /** Returns and forgets the sign-in with this state, if it is still recent. */
  take(state: string, now = Date.now()): PendingAuth | undefined {
    const entries = this.live(now);
    const found = entries.find((e) => e.state === state);
    writePrivateJson(
      this.path,
      entries.filter((e) => e !== found),
    );
    return found;
  }
}

/** First half of the browser sign-in used by `sortify ui`: the Google consent URL to open. */
export async function beginWebAuth(config: Config, redirectUri: string): Promise<PendingAuth> {
  const { clientId, clientSecret } = loadClientSecrets(config);
  const client = new OAuth2Client({ clientId, clientSecret, redirectUri });
  const { codeVerifier, codeChallenge } = await client.generateCodeVerifierAsync();
  const state = randomBytes(16).toString("hex");
  const url = client.generateAuthUrl({
    access_type: "offline",
    prompt: "consent",
    scope: SCOPES,
    state,
    code_challenge: codeChallenge,
    code_challenge_method: "S256" as never,
  });
  return { url, state, codeVerifier, redirectUri };
}

/** Second half: exchanges the code Google sent back and stores the token. */
export async function finishWebAuth(
  config: Config,
  pending: PendingAuth,
  code: string,
): Promise<void> {
  const { clientId, clientSecret } = loadClientSecrets(config);
  const client = new OAuth2Client({ clientId, clientSecret, redirectUri: pending.redirectUri });
  const { tokens } = await client.getToken({
    code,
    codeVerifier: pending.codeVerifier,
    redirect_uri: pending.redirectUri,
  });
  if (!tokens.refresh_token) {
    throw new Error("Google did not return a refresh token; revoke Sortify's access and retry.");
  }
  writePrivateJson(config.tokenPath, tokens);
}

/**
 * Desktop OAuth flow with a loopback redirect. In a remote container the browser redirect to
 * 127.0.0.1 may not reach this process, so the user can also paste the redirected URL instead.
 */
export async function authorize(config: Config, log: (line: string) => void): Promise<void> {
  const { clientId, clientSecret } = loadClientSecrets(config);

  let resolveCode!: (code: string) => void;
  let rejectCode!: (err: Error) => void;
  const codePromise = new Promise<string>((resolve, reject) => {
    resolveCode = resolve;
    rejectCode = reject;
  });

  const handleRedirect = (raw: string): boolean => {
    const url = new URL(raw, "http://127.0.0.1");
    const error = url.searchParams.get("error");
    const code = url.searchParams.get("code");
    if (error) rejectCode(new Error(describeAuthError(error)));
    else if (code) resolveCode(code);
    return Boolean(error || code);
  };

  const server = createServer((req, res) => {
    const handled = handleRedirect(req.url ?? "/");
    res.writeHead(handled ? 200 : 404, { "content-type": "text/plain" });
    res.end(handled ? "Sortify is signed in. You can close this tab." : "Not found");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  const redirectUri = `http://127.0.0.1:${port}`;

  const client = new OAuth2Client({ clientId, clientSecret, redirectUri });
  const { codeVerifier, codeChallenge } = await client.generateCodeVerifierAsync();
  const authUrl = client.generateAuthUrl({
    access_type: "offline",
    prompt: "consent",
    scope: SCOPES,
    code_challenge: codeChallenge,
    code_challenge_method: "S256" as never,
  });

  log("Open this URL in your browser and approve access:\n");
  log(`  ${authUrl}\n`);
  log(
    "If the browser cannot reach the redirect page (e.g. in a Codespace), copy the full URL " +
      "from its address bar and paste it here.",
  );

  const rl = createInterface({ input: process.stdin });
  rl.on("line", (line) => {
    if (line.trim() && !handleRedirect(line.trim())) log("That URL has no `code` parameter.");
  });

  try {
    const code = await codePromise;
    const { tokens } = await client.getToken({ code, codeVerifier, redirect_uri: redirectUri });
    if (!tokens.refresh_token) {
      throw new Error("Google did not return a refresh token; revoke Sortify's access and retry.");
    }
    writePrivateJson(config.tokenPath, tokens);
    log(`Signed in. Token saved to ${config.tokenPath}`);
  } finally {
    rl.close();
    server.close();
  }
}
