// Starts the backend API (restarting on changes) and the frontend dev server together.
// Usage: npm run dev. The servers are spawned directly (not through npm) so stopping this
// script stops them too.
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const root = new URL("../", import.meta.url);
const backend = new URL("backend/", root);
const frontend = new URL("frontend/", root);
const vitePkg = createRequire(new URL("package.json", frontend)).resolve("vite/package.json");
const viteBin = JSON.parse(readFileSync(vitePkg, "utf8")).bin.vite;
const vite = join(dirname(vitePkg), viteBin);

const children = [
  spawn(process.execPath, ["--watch-path=src", "src/cli.ts", "ui"], {
    cwd: backend,
    stdio: "inherit",
  }),
  spawn(process.execPath, [vite], { cwd: frontend, stdio: "inherit" }),
];

let stopping = false;
const stop = (code = 0) => {
  if (stopping) return;
  stopping = true;
  for (const child of children) child.kill("SIGTERM");
  process.exitCode = code;
};

for (const child of children) child.on("exit", (code) => stop(code ?? 0));
process.on("SIGINT", () => stop());
process.on("SIGTERM", () => stop());
