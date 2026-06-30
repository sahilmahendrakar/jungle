// Apply backend/db/schema.sql to the database in DATABASE_URL.
// Run: npm run db:migrate
import { execSync, spawnSync } from "node:child_process";
import { loadEnv, schemaSql } from "./lib/env.mjs";

const CONTAINER = "jungle-postgres";
const { db } = loadEnv();
const user = decodeURIComponent(db.username);
const password = decodeURIComponent(db.password);
const database = db.pathname.slice(1);
const sql = schemaSql();

const containerRunning =
  spawnSync("docker", ["inspect", "-f", "{{.State.Running}}", CONTAINER], { encoding: "utf8" }).stdout.trim() ===
  "true";

if (containerRunning) {
  const result = spawnSync(
    "docker",
    ["exec", "-i", "-e", `PGPASSWORD=${password}`, CONTAINER, "psql", "-U", user, "-d", database],
    { input: sql, encoding: "utf8" },
  );
  if (result.status !== 0) {
    console.error(result.stderr || "db:migrate failed");
    process.exit(result.status ?? 1);
  }
} else {
  const result = spawnSync("psql", [process.env.DATABASE_URL, "-v", "ON_ERROR_STOP=1"], {
    input: sql,
    encoding: "utf8",
    env: { ...process.env, PGPASSWORD: password },
  });
  if (result.status !== 0) {
    if (result.error?.code === "ENOENT") {
      console.error("psql not found and jungle-postgres container is not running. Run: npm run db:up");
    } else {
      console.error(result.stderr || "db:migrate failed");
    }
    process.exit(result.status ?? 1);
  }
}

console.log("schema applied");
