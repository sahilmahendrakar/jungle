#!/usr/bin/env node
// Deploy a new runner image to ALL Fly agents, end to end:
//   1. build the runner (npm run build) + docker image
//   2. push it to the Fly registry
//   3. UPDATE every runner machine so it actually re-pulls the new image
//
// Step 3 is the whole point. Fly pins the RESOLVED image digest per machine at create/update
// time, so pushing a rebuilt :v1 tag does nothing to existing machines — a plain wake
// (provisioner.start) reuses the old pinned digest and keeps running the old code. Each machine
// must be updated to re-resolve the tag. (Learned 2026-07-04: a runner fix was pushed to :v1 but
// every agent kept running the buggy image until the machines were updated.)
//
// Usage (from repo root, with FLY_API_TOKEN in .env or the environment):
//   node scripts/deploy-fly-runner.mjs            # build + push + roll out
//   node scripts/deploy-fly-runner.mjs --rollout  # skip build/push, just update machines
//
// This mirrors FlyProvisioner.redeploy() (backend/src/provisioner-fly.ts) but bundles the
// build/push so "deploy the runner" is one command.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// Load a few keys from the repo-root .env if not already in the environment (no dep on dotenv).
function loadEnv() {
  try {
    for (const line of readFileSync(path.join(ROOT, ".env"), "utf8").split("\n")) {
      const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
      if (m && process.env[m[1]] === undefined) {
        process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
      }
    }
  } catch {
    /* no .env — rely on the environment */
  }
}
loadEnv();

const FLY_APP = process.env.FLY_APP ?? "jungle-runners";
const FLY_API_TOKEN = process.env.FLY_API_TOKEN ?? "";
const IMAGE = process.env.FLY_RUNNER_IMAGE ?? `registry.fly.io/${FLY_APP}:v1`;
const FLY_API = "https://api.machines.dev/v1";
const rolloutOnly = process.argv.includes("--rollout");

if (!FLY_API_TOKEN) {
  console.error("FLY_API_TOKEN is not set (checked env and repo-root .env).");
  process.exit(1);
}

async function fly(pathname, init) {
  const res = await fetch(`${FLY_API}${pathname}`, {
    ...init,
    headers: { Authorization: `Bearer ${FLY_API_TOKEN}`, "Content-Type": "application/json", ...(init?.headers) },
  });
  if (!res.ok) throw new Error(`fly ${init?.method ?? "GET"} ${pathname} -> ${res.status}: ${await res.text().catch(() => "")}`);
  return res.status === 204 ? null : res.json();
}

function run(cmd, args, opts = {}) {
  console.log(`$ ${cmd} ${args.join(" ")}`);
  execFileSync(cmd, args, { stdio: "inherit", cwd: ROOT, ...opts });
}

async function main() {
  if (!rolloutOnly) {
    console.log("== build runner ==");
    run("npm", ["run", "build"], { cwd: path.join(ROOT, "runner") });
    console.log("== docker build ==");
    run("docker", ["build", "-t", IMAGE, "."], { cwd: path.join(ROOT, "runner") });
    console.log("== docker login + push (token via stdin) ==");
    execFileSync("docker", ["login", "registry.fly.io", "-u", "x", "--password-stdin"],
      { input: FLY_API_TOKEN, stdio: ["pipe", "inherit", "inherit"], cwd: ROOT });
    run("docker", ["push", IMAGE]);
  } else {
    console.log("== --rollout: skipping build/push ==");
  }

  console.log(`== rollout: updating every ${FLY_APP} machine to ${IMAGE} ==`);
  const machines = await fly(`/apps/${FLY_APP}/machines`);
  const runners = machines.filter((m) => (m.name ?? "").startsWith("jungle-agent-"));
  let ok = 0;
  for (const m of runners) {
    try {
      await fly(`/apps/${FLY_APP}/machines/${m.id}`, {
        method: "POST",
        body: JSON.stringify({ config: { ...m.config, image: IMAGE } }),
      });
      const after = await fly(`/apps/${FLY_APP}/machines/${m.id}`);
      console.log(`  ${m.name} (${m.id}): state=${after.state} digest=${after.image_ref?.digest}`);
      ok++;
    } catch (e) {
      console.error(`  ${m.name} (${m.id}): FAILED ${e.message ?? e}`);
    }
  }
  console.log(`== done: ${ok}/${runners.length} machines updated ==`);
  if (ok < runners.length) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
