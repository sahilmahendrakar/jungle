import "./env";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import * as db from "./db";
import * as hostcontrol from "./hostcontrol";

// The Provisioner seam (docs/runner-protocol.md §"Provisioner seam"). Cloud implementations
// (Docker, Fly) own a sandbox lifecycle the backend controls. SelfHostedProvisioner routes
// lifecycle to a user's own device over the host-control channel — it only "manages lifecycle"
// while that device's daemon is connected (see managesLifecycle).
export interface Provisioner {
  // Whether the backend can start/stop this agent's runner on demand. True for Docker/Fly always;
  // for self-hosted it's true only when the device is online — callers that idle-stop / wake read
  // hostcontrol.isAgentDeviceOnline(agentId) rather than trusting this flag blindly.
  readonly managesLifecycle: boolean;
  create(agent: { id: string; handle: string; runnerToken: string }): Promise<void>; // image/volume/home
  start(agentId: string): Promise<void>;
  stop(agentId: string): Promise<void>;
  destroy(agentId: string): Promise<void>; // includes the volume
  status(agentId: string): Promise<"running" | "stopped" | "absent">;
}

const execFileAsync = promisify(execFile);

// The runner image (built in parallel). Overridable so a staging box can pin a tag.
const RUNNER_IMAGE = process.env.RUNNER_IMAGE ?? "jungle-runner:dev";
// The backend port the runner dials back into. Matches index.ts's PORT default.
const BACKEND_PORT = Number(process.env.PORT ?? 3001);
// Container reaches the host (where the backend listens) via host.docker.internal.
const BACKEND_WS = `ws://host.docker.internal:${BACKEND_PORT}/api/runner`;
// The runner needs its own Anthropic key to run the Agent SDK loop.
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY ?? "";
// Some hosts require `sudo docker` (backend user not in the docker group). Default off:
// the task assumes docker-group access. Set RUNNER_DOCKER_SUDO=1 to prefix sudo.
const USE_SUDO = process.env.RUNNER_DOCKER_SUDO === "1";

const containerName = (agentId: string) => `jungle-agent-${agentId}`;
const volumeName = (agentId: string) => `jungle-agent-${agentId}-ws`;

// Run `docker <args>`, optionally via sudo. Returns stdout; throws on non-zero exit.
async function docker(args: string[]): Promise<string> {
  const [cmd, cmdArgs] = USE_SUDO ? ["sudo", ["docker", ...args]] : ["docker", args];
  const { stdout } = await execFileAsync(cmd, cmdArgs, { encoding: "utf8" });
  return stdout;
}

// Like docker(), but returns "" instead of throwing (for best-effort / probing calls).
async function dockerSoft(args: string[]): Promise<string> {
  try {
    return await docker(args);
  } catch {
    return "";
  }
}

export class DockerProvisioner implements Provisioner {
  readonly managesLifecycle = true;

  // Create (idempotently) the agent's container: named, persistent-volume, restart-on-boot,
  // resource-capped, with the env the runner boots from. Not started here — `start` does that.
  // If a container already exists (e.g. after a backend restart) we leave it as-is.
  async create(agent: { id: string; handle: string; runnerToken: string }): Promise<void> {
    if ((await this.status(agent.id)) !== "absent") return; // already provisioned
    // Named volume for /workspace (agent memory survives container recreation).
    await docker(["volume", "create", volumeName(agent.id)]);
    await docker([
      "create",
      "--name", containerName(agent.id),
      "--restart=unless-stopped",
      // 3g: a web-dev turn realistically runs the SDK process + `next dev` + headless
      // Chromium at once; 1g OOM-killed the SDK mid-turn (2026-07-02, selenite-agent).
      // Caps are not reservations — idle agents cost nothing.
      "--memory=3g",
      "--cpus=1",
      // Chromium crashes with the 64mb docker default /dev/shm.
      "--shm-size=512m",
      "--add-host=host.docker.internal:host-gateway",
      "-v", `${volumeName(agent.id)}:/workspace`,
      "-e", `JUNGLE_BACKEND_WS=${BACKEND_WS}`,
      "-e", `JUNGLE_RUNNER_TOKEN=${agent.runnerToken}`,
      "-e", `ANTHROPIC_API_KEY=${ANTHROPIC_API_KEY}`,
      // Purely informational for logs/debugging inside the runner.
      "-e", `JUNGLE_AGENT_ID=${agent.id}`,
      "-e", `JUNGLE_AGENT_HANDLE=${agent.handle}`,
      RUNNER_IMAGE,
    ]);
  }

  async start(agentId: string): Promise<void> {
    await docker(["start", containerName(agentId)]);
  }

  async stop(agentId: string): Promise<void> {
    // Best-effort: stopping an already-stopped/absent container shouldn't error the caller.
    await dockerSoft(["stop", containerName(agentId)]);
  }

  // Remove the container AND its workspace volume — full teardown for agent deletion.
  async destroy(agentId: string): Promise<void> {
    await dockerSoft(["rm", "-f", containerName(agentId)]);
    await dockerSoft(["volume", "rm", volumeName(agentId)]);
  }

  async status(agentId: string): Promise<"running" | "stopped" | "absent"> {
    const out = (await dockerSoft(["inspect", "-f", "{{.State.Running}}", containerName(agentId)])).trim();
    if (out === "") return "absent"; // inspect failed => no such container
    return out === "true" ? "running" : "stopped";
  }
}

// Where a self-hosted agent's runner CHILD dials back in, and where its SDK subprocess sends model
// calls. The child gets the LLM base as ANTHROPIC_BASE_URL + its runner_token as ANTHROPIC_API_KEY,
// so the platform's real Anthropic key never leaves the backend (see http/routes/llm.ts). Both are
// derived from the same public backend URL the Fly runner already uses (RUNNER_BACKEND_WS).
const RUNNER_BACKEND_WS = process.env.RUNNER_BACKEND_WS ?? "wss://api.jungleagents.com/api/runner";
const LLM_BASE_URL = process.env.RUNNER_LLM_BASE_URL ?? deriveLlmBase(RUNNER_BACKEND_WS);

function deriveLlmBase(runnerWs: string): string {
  try {
    const u = new URL(runnerWs);
    const scheme = u.protocol === "wss:" ? "https:" : "http:";
    return `${scheme}//${u.host}/api/llm`;
  } catch {
    return "https://api.jungleagents.com/api/llm";
  }
}

// The URLs a self-hosted device's daemon needs, handed out at device-token exchange (routes/
// devices.ts) and to each runner child (below). Kept here so the derivation lives in one place.
export function selfHostedEndpoints(): { backendWs: string; llmBaseUrl: string } {
  return { backendWs: RUNNER_BACKEND_WS, llmBaseUrl: LLM_BASE_URL };
}

// Runs an agent on a user's OWN device (participants.runner_provider = 'self_hosted'). The backend
// owns no machine here — it sends run/stop/remove commands down the device's host-control channel
// (hostcontrol.ts) and the device's daemon spawns/kills the per-agent runner child. Lifecycle is
// therefore best-effort: when the device is offline these are no-ops and queued work simply waits.
export class SelfHostedProvisioner implements Provisioner {
  readonly managesLifecycle = true; // gated per-call by hostcontrol.isAgentDeviceOnline

  // No cloud resource to create — just record which device this agent is bound to so status/wake
  // decisions can be made synchronously. The route already persisted runner_meta.hostId.
  async create(agent: { id: string; handle: string; runnerToken: string }): Promise<void> {
    const meta = await db.getRunnerMeta(agent.id);
    if (meta?.hostId) hostcontrol.setAgentHost(agent.id, meta.hostId);
  }

  // Ensure the device is running a runner child for this agent. Carries everything the daemon needs
  // to spawn it (so it survives a daemon restart with no server-side session state). No-op when the
  // device is offline — the agent shows `offline` and the work waits in agent_inbox.
  async start(agentId: string): Promise<void> {
    const agent = await db.getAgentRow(agentId);
    const hostId = agent?.runner_meta?.hostId as string | undefined;
    if (!agent || !hostId || !agent.runner_token) return;
    hostcontrol.setAgentHost(agentId, hostId);
    // The device's sandbox setting tells the daemon where to root the agent's workspace: an
    // isolated per-agent dir (sandboxed, the default) or the directory `jungle-agents connect`
    // was run from (unsandboxed — the agent runs in the user's real cwd). Falls back to true
    // for an unknown/host-less row so an old or racey read never silently unsandboxes.
    const host = await db.getHost(hostId);
    const sandboxed = host ? host.sandboxed : true;
    hostcontrol.sendToHost(hostId, {
      type: "run_agent",
      agentId,
      handle: agent.handle,
      runnerToken: agent.runner_token,
      backendWs: RUNNER_BACKEND_WS,
      llmBaseUrl: LLM_BASE_URL,
      sandboxed,
    });
  }

  // Stop the child but keep its workspace (idle-stop / sleep). No-op if the device is offline.
  async stop(agentId: string): Promise<void> {
    const hostId = hostcontrol.hostForAgent(agentId) ?? (await db.getRunnerMeta(agentId))?.hostId;
    if (hostId) hostcontrol.sendToHost(hostId, { type: "stop_agent", agentId });
  }

  // Stop the child AND delete its workspace (agent deleted). Always forget the mapping.
  async destroy(agentId: string): Promise<void> {
    const hostId = hostcontrol.hostForAgent(agentId) ?? (await db.getRunnerMeta(agentId))?.hostId;
    if (hostId) hostcontrol.sendToHost(hostId, { type: "remove_agent", agentId });
    hostcontrol.clearAgentHost(agentId);
  }

  // Derived, not provider-owned: the device offline => "stopped" (surfaced as `offline`); the
  // daemon reports a live child => "running"; otherwise "stopped". Never "absent" — a self-hosted
  // agent's state is its device's connectivity, not a cloud resource that can vanish.
  async status(agentId: string): Promise<"running" | "stopped" | "absent"> {
    const meta = await db.getRunnerMeta(agentId);
    if (meta?.hostId) hostcontrol.setAgentHost(agentId, meta.hostId);
    if (!meta?.hostId || !hostcontrol.isHostOnline(meta.hostId)) return "stopped";
    return hostcontrol.isRunningOnDevice(agentId) ? "running" : "stopped";
  }
}

// The process-wide provisioner registry, keyed by participants.runner_provider. 'docker' and
// 'self_hosted' are always registered; index.ts registers 'fly' at boot. provisionerFor() is the
// seam every caller (index.ts, runners.ts) should use instead of reaching for a single global.
const registry: Record<string, Provisioner> = {
  docker: new DockerProvisioner(),
  self_hosted: new SelfHostedProvisioner(),
};

export function setProvisioner(kind: string, impl: Provisioner): void {
  registry[kind] = impl;
}

export function provisionerFor(agent: { runner_provider?: string | null }): Provisioner {
  const kind = agent.runner_provider || "docker";
  const p = registry[kind];
  if (!p) throw new Error(`no provisioner registered for runner_provider "${kind}"`);
  return p;
}
