import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Config, loadConfig } from "../src/config.ts";

/** A fresh temporary directory for one test. */
export const tempDir = (): string => mkdtempSync(join(tmpdir(), "sortify-test-"));

/**
 * `loadConfig` with every config and data directory inside a fresh temp dir, so tests never read
 * or write the real ~/.config/sortify or ~/.local/share/sortify.
 */
export function testConfig(env: NodeJS.ProcessEnv = {}): Config {
  const sandbox = tempDir();
  return loadConfig({
    XDG_CONFIG_HOME: sandbox,
    XDG_DATA_HOME: sandbox,
    SORTIFY_HOME: sandbox,
    ...env,
  });
}
