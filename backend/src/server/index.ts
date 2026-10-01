import { createServer, type Server } from "node:http";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Config } from "../config.ts";
import { Store } from "../db.ts";
import { youtubeFor } from "../services.ts";
import { DriveSnapshots } from "../sync/drive.ts";
import { SyncEngine } from "../sync/engine.ts";
import { loadAuthClient } from "../youtube/auth.ts";
import { createApp } from "./app.ts";

/**
 * While the server is up, pick up anything another device pushed. The one-shot CLI commands do
 * not sync themselves; their work travels on the next cycle this process runs.
 */
const SYNC_EVERY_MS = 5 * 60 * 1000;

/**
 * The built frontend (<repo>/frontend/dist). The path is the same from backend/src/server and
 * backend/dist/server; SORTIFY_UI_DIR overrides it.
 */
export const DEFAULT_STATIC_DIR =
  (process.env.SORTIFY_UI_DIR &&
    resolve(process.env.INIT_CWD ?? process.cwd(), process.env.SORTIFY_UI_DIR)) ??
  fileURLToPath(new URL("../../../frontend/dist/", import.meta.url));

export async function startServer(
  config: Config,
  options: { port: number; host?: string; staticDir?: string },
): Promise<{ server: Server; url: string; close: () => Promise<void> }> {
  const store = new Store(config.dbPath);

  // Syncing needs a signed-in account; without one the server simply runs local-only.
  let sync: SyncEngine | undefined;
  try {
    const auth = loadAuthClient(config);
    sync = new SyncEngine(
      store,
      new DriveSnapshots({ getAccessToken: () => auth.getAccessToken() }),
    );
  } catch {
    sync = undefined;
  }
  const allowedHosts = (process.env.SORTIFY_UI_ALLOWED_HOSTS ?? "")
    .split(",")
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean);
  const app = createApp({
    config,
    store,
    sync,
    youtube: () => youtubeFor(config),
    staticDir: options.staticDir ?? DEFAULT_STATIC_DIR,
    port: options.port,
    allowedHosts,
  });
  const server = createServer((req, res) => {
    void app.handle(req, res);
  });
  // Carry up whatever the CLI did while this process was not running, and pull anything new.
  void sync?.sync();
  const ticker = sync ? setInterval(() => void sync?.sync(), SYNC_EVERY_MS) : undefined;
  ticker?.unref?.();

  const host = options.host ?? "127.0.0.1";
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, host, resolve);
  });
  return {
    server,
    url: `http://127.0.0.1:${options.port}/`,
    close: async () => {
      app.jobs.cancel();
      if (ticker) clearInterval(ticker);
      await new Promise<void>((resolve) => server.close(() => resolve()));
      // Push anything still pending before the database closes under it.
      await sync?.flush().catch(() => {});
      store.close();
    },
  };
}
