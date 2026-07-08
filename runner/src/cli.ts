#!/usr/bin/env node
// `jungle-runner` — the CLI you run on a machine to make it a Jungle "environment". Typical use:
//
//     jungle-runner connect            # authenticate this device (browser), then run the daemon
//
// After connecting once you never touch the terminal again: pick this device as an agent's
// environment in the Jungle web app, and the daemon runs that agent here. `up` re-runs the daemon
// on a machine that's already connected (e.g. at login / in a service unit).
import os from "node:os";
import { spawnSync } from "node:child_process";
import { Daemon } from "./daemon.js";
import {
  loadConfig,
  saveConfig,
  clearConfig,
  RUNNER_VERSION,
  type DeviceConfig,
} from "./config.js";

const DEFAULT_BACKEND = process.env.JUNGLE_BACKEND ?? "https://api.jungleagents.com";

function parseFlags(argv: string[]): { positional: string[]; flags: Record<string, string> } {
  const positional: string[] = [];
  const flags: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith("--")) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = "true";
      }
    } else {
      positional.push(a);
    }
  }
  return { positional, flags };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Best-effort "open this URL in a browser" across platforms. Never fatal.
function openBrowser(url: string): void {
  const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
  try {
    spawnSync(cmd, [url], { stdio: "ignore" });
  } catch {
    /* the user can open it themselves */
  }
}

async function connect(flags: Record<string, string>): Promise<void> {
  const backend = (flags.backend ?? DEFAULT_BACKEND).replace(/\/$/, "");
  const name = flags.name ?? os.hostname();

  const existing = await loadConfig();
  if (existing && !flags.force) {
    console.log(`This machine is already connected as "${existing.device.name}". Running the daemon…`);
    console.log(`(Run \`jungle-runner connect --force\` to re-register.)`);
    new Daemon(existing).start();
    return;
  }

  // 1. Start a device-code request.
  const start = await fetchJson(`${backend}/api/devices/auth/start`, { method: "POST" });
  const { deviceCode, userCode, verificationUri, verificationUriComplete, interval } = start as {
    deviceCode: string;
    userCode: string;
    verificationUri: string;
    verificationUriComplete: string;
    interval: number;
  };

  console.log("");
  console.log("  To connect this device to Jungle, open:");
  console.log(`      ${verificationUri}`);
  console.log(`  and enter the code:  ${userCode}`);
  console.log("");
  openBrowser(verificationUriComplete);

  // 2. Poll until a signed-in user approves, then exchange for a device token.
  const deadline = Date.now() + 10 * 60_000;
  let cfg: DeviceConfig | null = null;
  while (Date.now() < deadline) {
    await sleep(Math.max(2, interval ?? 3) * 1000);
    const res = await fetchJsonRaw(`${backend}/api/devices/auth/token`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        deviceCode,
        name,
        hostname: os.hostname(),
        platform: process.platform,
        arch: process.arch,
        runnerVersion: RUNNER_VERSION,
      }),
    });
    if (res.status === 202) continue; // authorization_pending
    if (!res.ok) {
      console.error(`\nCouldn't connect: ${res.body?.error ?? res.status}`);
      process.exit(1);
    }
    const body = res.body as { deviceToken: string; device: { id: string; name: string }; controlWs: string };
    cfg = { backend, controlWs: body.controlWs, deviceToken: body.deviceToken, device: body.device };
    break;
  }
  if (!cfg) {
    console.error("\nTimed out waiting for approval. Run `jungle-runner connect` again.");
    process.exit(1);
  }

  await saveConfig(cfg);
  console.log(`\n✓ Connected! This device is now "${cfg.device.name}" in Jungle.`);
  console.log("  Assign agents to it from the web app — this daemon will run them here.\n");
  if (flags["no-run"] === "true") return;
  new Daemon(cfg).start();
}

async function up(): Promise<void> {
  const cfg = await loadConfig();
  if (!cfg) {
    console.error("This machine isn't connected yet. Run `jungle-runner connect` first.");
    process.exit(1);
  }
  new Daemon(cfg).start();
}

async function status(): Promise<void> {
  const cfg = await loadConfig();
  if (!cfg) {
    console.log("Not connected. Run `jungle-runner connect`.");
    return;
  }
  console.log(`Connected as "${cfg.device.name}" (${cfg.device.id})`);
  console.log(`Backend: ${cfg.backend}`);
}

async function logout(): Promise<void> {
  await clearConfig();
  console.log("Disconnected this machine locally. Remove it from the web app to fully revoke it.");
}

// Warn (don't block) on missing runtime prerequisites the agent will likely need.
function preflight(): void {
  const [major] = process.versions.node.split(".").map(Number);
  if (major < 18) console.warn(`⚠ Node ${process.versions.node} detected; Node 18+ is required.`);
  const git = spawnSync("git", ["--version"], { stdio: "ignore" });
  if (git.status !== 0) console.warn("⚠ `git` was not found on PATH; agents that use git may fail.");
}

interface RawResult {
  ok: boolean;
  status: number;
  body: Record<string, unknown> | null;
}

async function fetchJsonRaw(url: string, init?: RequestInit): Promise<RawResult> {
  const res = await fetch(url, init);
  let body: Record<string, unknown> | null = null;
  try {
    body = (await res.json()) as Record<string, unknown>;
  } catch {
    /* no/invalid JSON */
  }
  return { ok: res.ok, status: res.status, body };
}

async function fetchJson(url: string, init?: RequestInit): Promise<Record<string, unknown>> {
  const res = await fetchJsonRaw(url, init);
  if (!res.ok) {
    console.error(`Request failed (${res.status}): ${res.body?.error ?? url}`);
    process.exit(1);
  }
  return res.body ?? {};
}

async function main(): Promise<void> {
  const [cmd, ...rest] = process.argv.slice(2);
  const { flags } = parseFlags(rest);
  preflight();
  switch (cmd) {
    case "connect":
      await connect(flags);
      break;
    case "up":
    case undefined:
      await up();
      break;
    case "status":
      await status();
      break;
    case "logout":
    case "disconnect":
      await logout();
      break;
    default:
      console.log("Usage: jungle-runner <connect|up|status|logout> [--backend URL] [--name NAME]");
      process.exit(cmd === "help" || cmd === "--help" ? 0 : 1);
  }
}

main().catch((err) => {
  console.error(String(err));
  process.exit(1);
});
