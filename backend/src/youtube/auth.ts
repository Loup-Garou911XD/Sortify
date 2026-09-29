import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { dirname } from "node:path";
import { createInterface } from "node:readline";
import { type Credentials, OAuth2Client } from "google-auth-library";
import type { Config } from "../config.ts";

/** Read access to playlists plus the right to create playlists and add items. */
export const SCOPES = ["https://www.googleapis.com/auth/youtube"];

interface ClientSecrets {
  clientId: string;
  clientSecret: string;
}

function loadClientSecrets(config: Config): ClientSecrets {
  const path = config.clientSecretsPath;
  if (!path) {
    throw new Error(
      "SORTIFY_CLIENT_SECRETS is not set. Point it at the OAuth client JSON (Desktop app) " +
        "downloaded from Google Cloud Console.",
    );
  }
  const json = JSON.parse(readFileSync(path, "utf8")) as {
    installed?: { client_id: string; client_secret: string };
    web?: { client_id: string; client_secret: string };
  };
  const creds = json.installed ?? json.web;
  if (!creds) throw new Error(`${path} does not look like a Google OAuth client file`);
  return { clientId: creds.client_id, clientSecret: creds.client_secret };
}

function saveToken(path: string, tokens: Credentials): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(tokens, null, 2));
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
    saveToken(config.tokenPath, { ...stored, ...tokens });
  });
  return client;
}

export function authState(config: Config): { hasClientSecrets: boolean; signedIn: boolean } {
  return {
    hasClientSecrets: Boolean(config.clientSecretsPath && existsSync(config.clientSecretsPath)),
    signedIn: existsSync(config.tokenPath),
  };
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
  saveToken(config.tokenPath, tokens);
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
    if (error) rejectCode(new Error(`Google sign-in failed: ${error}`));
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
    saveToken(config.tokenPath, tokens);
    log(`Signed in. Token saved to ${config.tokenPath}`);
  } finally {
    rl.close();
    server.close();
  }
}
