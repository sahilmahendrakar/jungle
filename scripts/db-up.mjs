// Start a local Postgres container matching DATABASE_URL in .env.
// Run: npm run db:up
import { execSync, spawnSync } from "node:child_process";
import { setTimeout } from "node:timers/promises";
import { loadEnv } from "./lib/env.mjs";

const CONTAINER = "jungle-postgres";
const VOLUME = "jungle-postgres-data";
const IMAGE = "postgres:16-alpine";

const { db } = loadEnv();
const user = decodeURIComponent(db.username);
const password = decodeURIComponent(db.password);
const database = db.pathname.slice(1);
const port = db.port || "5432";
const host = db.hostname;

if (host !== "127.0.0.1" && host !== "localhost") {
  console.log(`DATABASE_URL host is ${host} — skipping local Docker Postgres (db:up is for localhost only).`);
  process.exit(0);
}

try {
  execSync("docker info", { stdio: "ignore" });
} catch {
  console.error("Docker is not running. Start Docker Desktop, then run: npm run db:up");
  process.exit(1);
}

const running = spawnSync("docker", ["inspect", "-f", "{{.State.Running}}", CONTAINER], { encoding: "utf8" });
if (running.stdout.trim() === "true") {
  console.log(`${CONTAINER} is already running on port ${port}`);
  process.exit(0);
}

execSync("docker volume create " + VOLUME, { stdio: "ignore" });
try {
  execSync(`docker rm -f ${CONTAINER}`, { stdio: "ignore" });
} catch {}

execSync(
  [
    "docker run -d",
    `--name ${CONTAINER}`,
    `-e POSTGRES_USER=${user}`,
    `-e POSTGRES_PASSWORD=${password}`,
    `-e POSTGRES_DB=${database}`,
    `-p ${port}:5432`,
    `-v ${VOLUME}:/var/lib/postgresql/data`,
    IMAGE,
  ].join(" "),
  { stdio: "inherit" },
);

for (let i = 0; i < 30; i++) {
  const ready = spawnSync("docker", ["exec", CONTAINER, "pg_isready", "-U", user, "-d", database], {
    encoding: "utf8",
  });
  if (ready.status === 0) {
    console.log(`${CONTAINER} ready on localhost:${port} (database: ${database})`);
    process.exit(0);
  }
  await setTimeout(1000);
}

console.error(`${CONTAINER} started but did not become ready in time`);
process.exit(1);
