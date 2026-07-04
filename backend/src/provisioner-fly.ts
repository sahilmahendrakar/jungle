import "./env";
import type { Provisioner } from "./provisioner";
import * as db from "./db";

const FLY_API = "https://api.machines.dev/v1";
const FLY_APP = process.env.FLY_APP ?? "jungle-runners";
const FLY_REGION = process.env.FLY_REGION ?? "iad";
const FLY_API_TOKEN = process.env.FLY_API_TOKEN ?? "";
const FLY_RUNNER_IMAGE = process.env.FLY_RUNNER_IMAGE ?? `registry.fly.io/${FLY_APP}:v1`;
const RUNNER_BACKEND_WS = process.env.RUNNER_BACKEND_WS ?? "wss://api.jungleagents.com/api/runner";
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY ?? "";

class FlyNotFound extends Error {}

async function fly<T = any>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${FLY_API}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${FLY_API_TOKEN}`, "Content-Type": "application/json", ...(init?.headers as any) },
  });
  if (res.status === 404) throw new FlyNotFound(path);
  if (!res.ok) throw new Error(`fly ${init?.method ?? "GET"} ${path} -> ${res.status}: ${await res.text().catch(() => "")}`);
  return (res.status === 204 ? null : await res.json()) as T;
}

const machineName = (agentId: string) => `jungle-agent-${agentId}`;
// Fly volume names: [a-z0-9_], max 30 chars. A de-hyphenated uuid is 32 chars, so prefix
// "jr_" + the first 26 hex chars (still 104 bits — collision-free at our scale) = 29 chars.
const volumeName = (agentId: string) => `jr_${agentId.replace(/-/g, "").slice(0, 26)}`;

// Talks directly to the Fly Machines REST API (https://api.machines.dev/v1) rather than
// shelling out to flyctl — the backend has no flyctl install and this is a thin enough
// surface (create volume+machine, start/stop/destroy, poll state) to hit with plain fetch.
export class FlyProvisioner implements Provisioner {
  async create(agent: { id: string; handle: string; runnerToken: string }): Promise<void> {
    if ((await db.getRunnerMeta(agent.id))?.machineId) return;
    const vol = await fly<{ id: string }>(`/apps/${FLY_APP}/volumes`, {
      method: "POST",
      body: JSON.stringify({ name: volumeName(agent.id), region: FLY_REGION, size_gb: 10 }),
    });
    const machine = await fly<{ id: string }>(`/apps/${FLY_APP}/machines`, {
      method: "POST",
      body: JSON.stringify({
        name: machineName(agent.id),
        region: FLY_REGION,
        config: {
          image: FLY_RUNNER_IMAGE,
          guest: { cpu_kind: "shared", cpus: 2, memory_mb: 3072 },
          mounts: [{ volume: vol.id, path: "/workspace" }],
          restart: { policy: "no" },
          kill_signal: "SIGINT",
          kill_timeout: 30,
          env: {
            JUNGLE_BACKEND_WS: RUNNER_BACKEND_WS,
            JUNGLE_RUNNER_TOKEN: agent.runnerToken,
            JUNGLE_AGENT_ID: agent.id,
            JUNGLE_AGENT_HANDLE: agent.handle,
            ANTHROPIC_API_KEY,
          },
        },
      }),
    });
    await db.setRunnerMeta(agent.id, { machineId: machine.id, volumeId: vol.id });
  }

  async start(agentId: string): Promise<void> {
    const meta = await db.getRunnerMeta(agentId);
    if (!meta?.machineId) throw new Error(`fly start: no machine recorded for ${agentId}`);
    try {
      await fly(`/apps/${FLY_APP}/machines/${meta.machineId}/start`, { method: "POST" });
    } catch (e) {
      // A machine created via the API auto-boots, so a start() right after create races the
      // first boot and 412s with "current state: 'created'/'starting'". Those states mean it's
      // already coming up — treat as success. (A genuinely stopped machine starts cleanly.)
      if (/already (started|running)|current state: '?(started|created|starting|replacing)/i.test(String(e))) return;
      throw e;
    }
  }

  async stop(agentId: string): Promise<void> {
    const meta = await db.getRunnerMeta(agentId);
    if (!meta?.machineId) return;
    try {
      await fly(`/apps/${FLY_APP}/machines/${meta.machineId}/stop`, {
        method: "POST",
        body: JSON.stringify({ timeout: "30s" }),
      });
    } catch (e) {
      if (e instanceof FlyNotFound || /not running|already stopped/i.test(String(e))) return;
      console.error(`fly stop ${agentId}:`, e);
    }
  }

  // Remove the machine AND its workspace volume — full teardown for agent deletion.
  async destroy(agentId: string): Promise<void> {
    const meta = await db.getRunnerMeta(agentId);
    if (!meta?.machineId) return;
    await fly(`/apps/${FLY_APP}/machines/${meta.machineId}?force=true`, { method: "DELETE" }).catch(() => {});
    if (meta.volumeId) await fly(`/apps/${FLY_APP}/volumes/${meta.volumeId}`, { method: "DELETE" }).catch(() => {});
    await db.clearRunnerMeta(agentId);
  }

  async status(agentId: string): Promise<"running" | "stopped" | "absent"> {
    const meta = await db.getRunnerMeta(agentId);
    if (!meta?.machineId) return "absent";
    try {
      const m = await fly<{ state: string }>(`/apps/${FLY_APP}/machines/${meta.machineId}`);
      if (m.state === "started") return "running";
      if (m.state === "destroyed") return "absent";
      return "stopped";
    } catch (e) {
      if (e instanceof FlyNotFound) return "absent";
      throw e;
    }
  }
}
