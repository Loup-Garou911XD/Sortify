import { createServer, type Server } from "node:http";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Config } from "../config.ts";
import { Store } from "../db.ts";
import { youtubeFor } from "../services.ts";
import { createApp } from "./app.ts";

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
  const allowedHosts = (process.env.SORTIFY_UI_ALLOWED_HOSTS ?? "")
    .split(",")
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean);
  const app = createApp({
    config,
    store,
    youtube: () => youtubeFor(config),
    staticDir: options.staticDir ?? DEFAULT_STATIC_DIR,
    port: options.port,
    allowedHosts,
  });
  const server = createServer((req, res) => {
    void app.handle(req, res);
  });
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
      await new Promise<void>((resolve) => server.close(() => resolve()));
      store.close();
    },
  };
}
