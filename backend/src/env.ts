import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

// Loads the git-ignored repo-root .env before anything reads process.env, so settings reach the
// CLI and server however they are started (npm scripts, VS Code tasks, `node dist/cli.js`).
// Variables already set in the environment win. The path is the same from src/ and dist/.
const envFile = fileURLToPath(new URL("../../.env", import.meta.url));
if (existsSync(envFile)) process.loadEnvFile(envFile);
