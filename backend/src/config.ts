import { homedir } from "node:os";
import { join, resolve } from "node:path";

/** The OAuth client JSON itself (handy for a Codespaces secret, which only holds text), or its file. */
export type ClientSecretsSource = { json: string } | { path: string };

export interface Config {
  configDir: string;
  dataDir: string;
  dbPath: string;
  tokenPath: string;
  /** Browser sign-ins started by `sortify ui` and not yet finished. */
  pendingAuthPath: string;
  /** The OAuth client from Google Cloud Console (SORTIFY_CLIENT_SECRETS). */
  clientSecrets: ClientSecretsSource | undefined;
  /** Optional user override for the built-in subgenre/mood lists. */
  tagMapPath: string;
  discogsToken: string | undefined;
  lastfmApiKey: string | undefined;
  /** MusicBrainz rejects requests without an identifying User-Agent. */
  userAgent: string;
  /** YouTube Data API units per day (default project quota is 10,000). */
  dailyQuota: number;
}

export const VERSION = "0.1.0";

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const home = homedir();
  // npm workspace scripts run inside backend/; INIT_CWD is where the user actually ran npm, so
  // relative paths in the environment mean what they typed.
  const path = (value: string | undefined): string | undefined =>
    value ? resolve(env.INIT_CWD ?? process.cwd(), value) : undefined;
  const secrets = env.SORTIFY_CLIENT_SECRETS?.trim();
  const configDir = join(env.XDG_CONFIG_HOME ?? join(home, ".config"), "sortify");
  const dataDir =
    path(env.SORTIFY_HOME) ?? join(env.XDG_DATA_HOME ?? join(home, ".local", "share"), "sortify");
  const contact = env.SORTIFY_CONTACT ?? "https://github.com/Loup-Garou911XD/Sortify";
  const dailyQuota = Number(env.SORTIFY_DAILY_QUOTA ?? 10_000);

  return {
    configDir,
    dataDir,
    dbPath: path(env.SORTIFY_DB) ?? join(dataDir, "sortify.db"),
    tokenPath: join(configDir, "token.json"),
    pendingAuthPath: join(configDir, "pending-auth.json"),
    clientSecrets: !secrets
      ? undefined
      : secrets.startsWith("{")
        ? { json: secrets }
        : { path: resolve(env.INIT_CWD ?? process.cwd(), secrets) },
    tagMapPath: path(env.SORTIFY_TAG_MAP) ?? join(configDir, "tag_map.yaml"),
    discogsToken: env.DISCOGS_TOKEN || undefined,
    lastfmApiKey: env.LASTFM_API_KEY || undefined,
    userAgent: `Sortify/${VERSION} ( ${contact} )`,
    dailyQuota: Number.isFinite(dailyQuota) && dailyQuota > 0 ? dailyQuota : 10_000,
  };
}
