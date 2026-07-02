import "./env";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

// The Provisioner seam (docs/runner-protocol.md §"Provisioner seam"). One implementation
// today — Docker — shelling out to the `docker` CLI. A future Cloudflare/Vercel-sandbox
// implementation swaps in here without touching runners.ts or the protocol.
export interface Provisioner {
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

// The process-wide provisioner. Kept as a mutable export so tests / a future Cloudflare
// backend can swap in a different implementation.
export let provisioner: Provisioner = new DockerProvisioner();
export function setProvisioner(p: Provisioner): void {
  provisioner = p;
}
