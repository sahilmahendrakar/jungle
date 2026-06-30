// One-time local dev setup: Postgres role/db, schema, and a root .env with DATABASE_URL.
// Safe to re-run — all steps are idempotent.
import { execSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import pg from "pg";

const DEFAULT_URL = "postgres://jungle:jungle@127.0.0.1:5432/jungle";
const ENV_PATH = new URL("../.env", import.meta.url);
const SCHEMA_PATH = new URL("../backend/db/schema.sql", import.meta.url);

function sh(cmd) {
  execSync(cmd, { stdio: "inherit", shell: true });
}

function ensureEnvFile() {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  if (existsSync(ENV_PATH)) {
    for (const line of readFileSync(ENV_PATH, "utf8").split("\n")) {
      const m = line.match(/^DATABASE_URL=(.+)$/);
      if (m) return m[1].trim();
    }
  }
  writeFileSync(ENV_PATH, `DATABASE_URL=${DEFAULT_URL}\n`);
  console.log("created .env with local DATABASE_URL");
  return DEFAULT_URL;
}

async function canConnect(url) {
  const pool = new pg.Pool({ connectionString: url });
  try {
    await pool.query("select 1");
    return true;
  } catch {
    return false;
  } finally {
    await pool.end();
  }
}

function ensurePostgresRoleAndDb() {
  sh(`sudo -u postgres psql -v ON_ERROR_STOP=0 -c "CREATE USER jungle WITH PASSWORD 'jungle';"`);
  sh(`sudo -u postgres psql -v ON_ERROR_STOP=0 -c "CREATE DATABASE jungle OWNER jungle;"`);
  sh(`sudo -u postgres psql -v ON_ERROR_STOP=0 -c "GRANT ALL PRIVILEGES ON DATABASE jungle TO jungle;"`);
}

async function ensureSchema(url) {
  const sql = readFileSync(SCHEMA_PATH, "utf8");
  const pool = new pg.Pool({ connectionString: url });
  await pool.query(sql);
  await pool.end();
}

const url = ensureEnvFile();
if (!(await canConnect(url))) {
  console.log("setting up local Postgres for Jungle…");
  ensurePostgresRoleAndDb();
  if (!(await canConnect(url))) {
    console.error("Could not connect to Postgres at", url);
    console.error("Install/start Postgres, or set DATABASE_URL in .env");
    process.exit(1);
  }
}

await ensureSchema(url);
console.log("dev db ready");
