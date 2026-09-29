// Starts the backend API (restarting on changes) and the frontend dev server together.
// Usage: npm run dev. The servers are spawned directly (not through npm) so stopping this
// script stops them too.
import { spawn } from "node:child_process";
import { createRequire } from "node:module";

const root = new URL("../", import.meta.url);
const backend = new URL("backend/", root);
const frontend = new URL("frontend/", root);
const vite = createRequire(new URL("package.json", frontend)).resolve("vite/bin/vite.js");

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
