import dotenv from "dotenv";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

export const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "../..");

export function loadEnv() {
  const envPath = process.env.JUNGLE_ENV_FILE ?? join(repoRoot, ".env");
  if (!existsSync(envPath)) {
    throw new Error(
      `Missing ${envPath}. Copy .env.example to .env and fill in DATABASE_URL + ANTHROPIC_API_KEY.`,
    );
  }
  dotenv.config({ path: envPath });
  if (!process.env.DATABASE_URL) {
    throw new Error(`DATABASE_URL is not set in ${envPath}`);
  }
  return { envPath, db: new URL(process.env.DATABASE_URL) };
}

export function schemaSql() {
  return readFileSync(join(repoRoot, "backend/db/schema.sql"), "utf8");
}
