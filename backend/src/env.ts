// Load secrets from the repo-local .env (gitignored). Imported first by db.ts / index.ts
// so process.env is populated before use. Holds everything:
//   DATABASE_URL, ANTHROPIC_API_KEY, GITHUB_CLIENT_ID, GITHUB_CLIENT_SECRET,
//   GITHUB_APP_PRIVATE_KEY (inline PEM).
// Override the path with JUNGLE_ENV_FILE if needed.
import dotenv from "dotenv";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "../../"); // backend/src -> repo
dotenv.config({ path: process.env.JUNGLE_ENV_FILE ?? join(repoRoot, ".env") });
