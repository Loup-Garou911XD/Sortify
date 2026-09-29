import { homedir } from "node:os";
import { join } from "node:path";

export interface Config {
  configDir: string;
  dataDir: string;
  dbPath: string;
  tokenPath: string;
  /** Path to the OAuth client JSON downloaded from Google Cloud Console. */
  clientSecretsPath: string | undefined;
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
  const configDir = join(env.XDG_CONFIG_HOME ?? join(home, ".config"), "sortify");
  const dataDir =
    env.SORTIFY_HOME ?? join(env.XDG_DATA_HOME ?? join(home, ".local", "share"), "sortify");
  const contact = env.SORTIFY_CONTACT ?? "https://github.com/Loup-Garou911XD/Sortify";
  const dailyQuota = Number(env.SORTIFY_DAILY_QUOTA ?? 10_000);

  return {
    configDir,
    dataDir,
    dbPath: env.SORTIFY_DB ?? join(dataDir, "sortify.db"),
    tokenPath: join(configDir, "token.json"),
    clientSecretsPath: env.SORTIFY_CLIENT_SECRETS,
    tagMapPath: env.SORTIFY_TAG_MAP ?? join(configDir, "tag_map.yaml"),
    discogsToken: env.DISCOGS_TOKEN || undefined,
    lastfmApiKey: env.LASTFM_API_KEY || undefined,
    userAgent: `Sortify/${VERSION} ( ${contact} )`,
    dailyQuota: Number.isFinite(dailyQuota) && dailyQuota > 0 ? dailyQuota : 10_000,
  };
}
