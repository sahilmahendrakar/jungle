// The self-hosted DAEMON. After `jungle-agents connect` registers this machine, the daemon holds
// one host-control WebSocket to the backend (shared/src/host-protocol.ts) and spawns/kills a
// per-agent runner CHILD (dist/index.js — the same runner cloud uses) on the backend's command.
// Each child dials /api/runner with its own runner_token and runs a normal SDK session; the daemon
// only manages lifecycle. Model calls go through the backend LLM proxy, so no API key lives here.
import WebSocket from "ws";
import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { BackendToHost, RunAgentFrame } from "./host-protocol.js";
import { HOST_PROTOCOL_VERSION } from "./host-protocol.js";
import type { DeviceConfig } from "./config.js";
import { agentsRoot, RUNNER_VERSION } from "./config.js";

const RUNNER_ENTRY = path.join(path.dirname(fileURLToPath(import.meta.url)), "index.js");
const HEARTBEAT_MS = 30_000;
const CHILD_RESTART_BACKOFF_MS = 2_000;
const CHILD_RESTART_MAX_MS = 30_000;
// A child that exits with this code hit a terminal backend close (bad token / agent deleted) and
// must NOT be restarted (see connection.ts). Any other exit is treated as a crash and restarted.
const CHILD_TERMINAL_EXIT = 3;

interface Child {
  spec: RunAgentFrame;
  proc: ChildProcess | null;
  intendedStop: boolean; // set on stop_agent/remove_agent so an exit isn't treated as a crash
  restartTimer: NodeJS.Timeout | null;
  backoffMs: number;
}

export class Daemon {
  private ws: WebSocket | null = null;
  private closed = false;
  private backoffMs = 500;
  private heartbeat: NodeJS.Timeout | null = null;
  private readonly children = new Map<string, Child>();

  constructor(private readonly cfg: DeviceConfig) {}

  start(): void {
    this.connect();
    const stop = () => this.shutdown();
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
  }

  // --- Control connection ---

  private connect(): void {
    if (this.closed) return;
    const sep = this.cfg.controlWs.includes("?") ? "&" : "?";
    const url = `${this.cfg.controlWs}${sep}token=${encodeURIComponent(this.cfg.deviceToken)}`;
    const ws = new WebSocket(url);
    this.ws = ws;

    ws.on("open", () => {
      this.backoffMs = 500;
      console.log(`[daemon] connected to ${this.cfg.controlWs}`);
      this.sendHello();
      if (this.heartbeat) clearInterval(this.heartbeat);
      this.heartbeat = setInterval(() => this.send({ type: "host_heartbeat" }), HEARTBEAT_MS);
    });

    ws.on("message", (raw) => {
      let frame: BackendToHost;
      try {
        frame = JSON.parse(raw.toString());
      } catch {
        return;
      }
      this.handle(frame);
    });

    ws.on("close", (code) => {
      this.ws = null;
      if (this.heartbeat) clearInterval(this.heartbeat);
      // 4001 = token rejected, 4003 = device removed. Terminal: stop everything and exit so we
      // don't hammer the backend. The children are torn down too (their agents no longer run here).
      if (code === 4001 || code === 4003) {
        console.error(`[daemon] device deauthorized (code ${code}); exiting`);
        this.shutdown();
        return;
      }
      console.warn(`[daemon] control connection closed (code ${code}); reconnecting`);
      this.scheduleReconnect();
    });

    ws.on("error", (err) => console.warn(`[daemon] control error: ${String(err)}`));
  }

  private scheduleReconnect(): void {
    if (this.closed) return;
    const delay = this.backoffMs;
    this.backoffMs = Math.min(this.backoffMs * 2, 30_000);
    setTimeout(() => this.connect(), delay);
  }

  private send(frame: { type: string; [k: string]: unknown }): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(frame));
  }

  private sendHello(): void {
    this.send({
      type: "host_hello",
      protocol: HOST_PROTOCOL_VERSION,
      hostname: os.hostname(),
      platform: process.platform,
      arch: process.arch,
      runnerVersion: RUNNER_VERSION,
      running: [...this.children.keys()].filter((id) => this.children.get(id)?.proc),
    });
  }

  // --- Command handling ---

  private handle(frame: BackendToHost): void {
    switch (frame.type) {
      case "run_agent":
        this.runAgent(frame);
        break;
      case "stop_agent":
        void this.stopAgent(frame.agentId, false);
        break;
      case "remove_agent":
        void this.stopAgent(frame.agentId, true);
        break;
    }
  }

  private runAgent(spec: RunAgentFrame): void {
    const existing = this.children.get(spec.agentId);
    if (existing) {
      existing.spec = spec; // refresh token/urls
      existing.intendedStop = false;
      if (existing.proc) return; // already running
    } else {
      this.children.set(spec.agentId, { spec, proc: null, intendedStop: false, restartTimer: null, backoffMs: CHILD_RESTART_BACKOFF_MS });
    }
    void this.spawnChild(spec.agentId);
  }

  private async spawnChild(agentId: string): Promise<void> {
    const child = this.children.get(agentId);
    if (!child || child.proc) return;
    const { spec } = child;
    const dir = path.join(agentsRoot(), agentId);
    const workspace = path.join(dir, "workspace");
    const state = path.join(dir, "state");
    await fs.mkdir(workspace, { recursive: true });
    await fs.mkdir(state, { recursive: true });

    const env: NodeJS.ProcessEnv = {
      ...process.env,
      JUNGLE_BACKEND_WS: spec.backendWs,
      JUNGLE_RUNNER_TOKEN: spec.runnerToken,
      JUNGLE_AGENT_ID: agentId,
      JUNGLE_AGENT_HANDLE: spec.handle,
      JUNGLE_WORKSPACE: workspace,
      JUNGLE_STATE_DIR: state,
      JUNGLE_SELF_HOSTED: "1",
      JUNGLE_RUNNER_VERSION: RUNNER_VERSION,
      // Model calls go to the backend proxy, authenticated by the runner token — no real key here.
      ANTHROPIC_BASE_URL: spec.llmBaseUrl,
      ANTHROPIC_API_KEY: spec.runnerToken,
      // Keep git config/credentials inside the agent's private state dir — never touch the user's.
      GIT_CONFIG_GLOBAL: path.join(state, "gitconfig"),
      JUNGLE_GIT_CREDENTIALS: path.join(state, "git-credentials"),
    };

    console.log(`[daemon] starting @${spec.handle} (${agentId})`);
    const proc = spawn(process.execPath, [RUNNER_ENTRY], { env, stdio: ["ignore", "pipe", "pipe"] });
    child.proc = proc;
    const tag = `[@${spec.handle}]`;
    proc.stdout?.on("data", (d) => process.stdout.write(`${tag} ${d}`));
    proc.stderr?.on("data", (d) => process.stderr.write(`${tag} ${d}`));

    proc.on("exit", (code, signal) => {
      child.proc = null;
      this.send({ type: "runner_exited", agentId, code: code ?? null, signal: signal ?? null });
      if (child.intendedStop) return; // stopped/removed on purpose — don't restart
      if (code === CHILD_TERMINAL_EXIT) {
        console.error(`[daemon] @${spec.handle} deauthorized; not restarting`);
        this.children.delete(agentId);
        return;
      }
      // Crash: restart with backoff.
      console.warn(`[daemon] @${spec.handle} exited (code ${code}, signal ${signal}); restarting in ${child.backoffMs}ms`);
      child.restartTimer = setTimeout(() => {
        child.restartTimer = null;
        void this.spawnChild(agentId);
      }, child.backoffMs);
      child.backoffMs = Math.min(child.backoffMs * 2, CHILD_RESTART_MAX_MS);
    });
  }

  private async stopAgent(agentId: string, remove: boolean): Promise<void> {
    const child = this.children.get(agentId);
    if (child) {
      child.intendedStop = true;
      if (child.restartTimer) clearTimeout(child.restartTimer);
      if (child.proc) {
        child.proc.kill("SIGINT");
        // Hard kill if it doesn't exit promptly.
        const proc = child.proc;
        setTimeout(() => proc.kill("SIGKILL"), 10_000).unref();
      }
      this.children.delete(agentId);
    }
    if (remove) {
      await fs.rm(path.join(agentsRoot(), agentId), { recursive: true, force: true }).catch(() => {});
      console.log(`[daemon] removed ${agentId}`);
    }
  }

  private shutdown(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.heartbeat) clearInterval(this.heartbeat);
    for (const child of this.children.values()) {
      child.intendedStop = true;
      if (child.restartTimer) clearTimeout(child.restartTimer);
      child.proc?.kill("SIGINT");
    }
    try {
      this.ws?.close();
    } catch {
      /* ignore */
    }
    // Give children a moment to exit cleanly, then go.
    setTimeout(() => process.exit(0), 1_000);
  }
}
