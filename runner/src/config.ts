// On-disk config for the self-hosted CLI/daemon. Everything lives under ~/.jungle-runner:
//   config.json                — the device registration (token + backend URLs)
//   agents/<agentId>/workspace — each agent's working dir (files, repo, memory)
//   agents/<agentId>/state     — each agent's runner state (session, git config/creds)
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

export const RUNNER_VERSION = process.env.JUNGLE_RUNNER_VERSION ?? "0.1.0";

export function configRoot(): string {
  return process.env.JUNGLE_RUNNER_HOME ?? path.join(os.homedir(), ".jungle-runner");
}
export function configPath(): string {
  return path.join(configRoot(), "config.json");
}
export function agentsRoot(): string {
  return path.join(configRoot(), "agents");
}

// The device registration saved after `jungle-runner connect`. `controlWs` is the host-control
// endpoint the daemon dials; `deviceToken` authenticates it. Per-agent runner tokens are never
// stored here — the backend hands them to the daemon over the control channel at run time.
export interface DeviceConfig {
  backend: string; // API origin, e.g. https://api.jungleagents.com
  controlWs: string; // wss://…/api/host
  deviceToken: string;
  device: { id: string; name: string };
}

export async function loadConfig(): Promise<DeviceConfig | null> {
  try {
    return JSON.parse(await fs.readFile(configPath(), "utf8")) as DeviceConfig;
  } catch {
    return null;
  }
}

export async function saveConfig(cfg: DeviceConfig): Promise<void> {
  await fs.mkdir(configRoot(), { recursive: true });
  await fs.writeFile(configPath(), JSON.stringify(cfg, null, 2), { mode: 0o600 });
}

export async function clearConfig(): Promise<void> {
  await fs.rm(configPath(), { force: true });
}
