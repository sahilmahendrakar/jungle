// Load secrets (DATABASE_URL, ANTHROPIC_API_KEY, …) from the secure env file.
// Imported first by db.ts / index.ts so process.env is populated before use.
import dotenv from "dotenv";
import { existsSync } from "node:fs";
import { join } from "node:path";

const repoRoot = join(import.meta.dirname, "../..");

for (const path of [
  process.env.JUNGLE_ENV_FILE,
  "/home/ec2-user/.config/jungle/.env",
  join(repoRoot, ".env"),
]) {
  if (path && existsSync(path)) {
    dotenv.config({ path });
    break;
  }
}

// Local dev fallback when no env file provides a database URL.
if (!process.env.DATABASE_URL && process.env.NODE_ENV !== "production") {
  process.env.DATABASE_URL = "postgres://jungle:jungle@127.0.0.1:5432/jungle";
}
