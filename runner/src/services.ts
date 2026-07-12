// Runner-managed long-lived services (dev servers, watchers, tunnels) — the service_* tools.
//
// Why this exists: the runner starts one CLI subprocess PER TURN and exits it at the idle
// boundary. Anything the agent backgrounds inside a turn (Bash run_in_background) is a child
// of that CLI process: it is killed when the turn ends, and the orphaned task record it leaves
// in the session transcript breaks the next resume (observed: CLI 2.1.198 comes up with NO MCP
// servers mounted, muting the agent for whole turns). Services move ownership of long-lived
// processes up to the RUNNER process, which lives across turns.
//
// Mechanics:
//   - Each service is `sh -c <command>` spawned detached (own process group, stdio to a log
//     file) and unref'd, so it survives even a runner crash.
//   - The registry (name -> record) is persisted to <stateDir>/services/services.json; a
//     restarted runner re-adopts entries by probing their pids, so stop/status keep working.
//   - stop() kills the whole process group (negative pid), SIGTERM then SIGKILL after a grace
//     window — dev servers love to leave grandchildren behind.
//   - Liveness is re-probed on every read; exits of processes we spawned in THIS runner process
//     are also caught by the child's exit event. onChange fires on any observed transition so
//     the runner can report the fresh list to the backend.
import { spawn, type ChildProcess } from "node:child_process";
import { promises as fs, openSync, closeSync } from "node:fs";
import * as fsSync from "node:fs";
import path from "node:path";
import { log } from "./log.js";
import type { AgentServiceInfo } from "./protocol.js";

interface ServiceRecord extends AgentServiceInfo {
  logFile: string;
}

const NAME_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;
const MAX_SERVICES = 8; // running at once; exited records are replaced on name reuse
const MAX_COMMAND_CHARS = 2_000;
const LOG_TAIL_BYTES = 16 * 1024;
const STOP_GRACE_MS = 5_000;
const RESTART_WAIT_MS = 3_000; // how long start() waits for an old instance to die on restart
const PROBE_INTERVAL_MS = 30_000;

export class ServiceManager {
  private readonly dir: string;
  private readonly registryFile: string;
  private readonly services = new Map<string, ServiceRecord>();
  // Children spawned by THIS runner process (exit events keep the registry fresh without
  // polling). Adopted services (spawned by a previous runner process) are only pid-probed.
  private readonly children = new Map<string, ChildProcess>();
  private writeChain: Promise<void> = Promise.resolve();
  private probeTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly defaultCwd: string,
    stateDir: string,
    // Fired after any registry change (start/stop/exit), so the runner can report the list.
    private readonly onChange: () => void,
  ) {
    this.dir = path.join(stateDir, "services");
    this.registryFile = path.join(this.dir, "services.json");
  }

  // Load the persisted registry and re-adopt: entries whose process group still answers a
  // 0-signal probe stay "running" (stop/logs keep working via the pid); the rest are marked
  // exited. Called once before the runner connects.
  async init(): Promise<void> {
    try {
      const raw = await fs.readFile(this.registryFile, "utf8");
      const parsed = JSON.parse(raw) as ServiceRecord[];
      for (const rec of Array.isArray(parsed) ? parsed : []) {
        if (typeof rec?.name !== "string" || typeof rec?.command !== "string") continue;
        if (rec.status === "running" && !(rec.pid && isAlive(rec.pid))) {
          rec.status = "exited";
          rec.exitedAt = new Date().toISOString();
          rec.exitCode = null; // died while no runner was watching — exit code unknown
        }
        this.services.set(rec.name, rec);
      }
    } catch (err: any) {
      if (err?.code !== "ENOENT") {
        log.warn("failed to read services registry, starting empty", { err: String(err) });
      }
    }
    void this.persist();
    // Low-frequency probe so an adopted (or grandchild-orphaned) service's death is noticed
    // even when no tool call asks; onChange only fires when something actually transitioned.
    this.probeTimer = setInterval(() => {
      if (this.refreshLiveness()) {
        void this.persist();
        this.onChange();
      }
    }, PROBE_INTERVAL_MS);
    this.probeTimer.unref?.();
  }

  // Start (or restart) a named service. An existing running instance with the same name is
  // stopped first — agents iterate on dev servers constantly, so "start again" meaning
  // "restart with this command" is the ergonomic contract.
  async start(input: { name: string; command: string; cwd?: string }): Promise<AgentServiceInfo> {
    const name = String(input.name ?? "").trim();
    const command = String(input.command ?? "").trim();
    if (!NAME_RE.test(name)) {
      throw new Error(`invalid service name "${name}" (want kebab-case, e.g. "dev-server")`);
    }
    if (!command || command.length > MAX_COMMAND_CHARS) {
      throw new Error(`command required (max ${MAX_COMMAND_CHARS} chars)`);
    }
    const cwd = path.resolve(this.defaultCwd, input.cwd ?? ".");

    const existing = this.services.get(name);
    if (existing?.status === "running") {
      await this.stop(name, RESTART_WAIT_MS);
    }
    const running = [...this.services.values()].filter((s) => s.status === "running").length;
    if (running >= MAX_SERVICES) {
      throw new Error(
        `service limit reached (${MAX_SERVICES} running); stop one with service_stop first`,
      );
    }

    await fs.mkdir(this.dir, { recursive: true });
    const logFile = path.join(this.dir, `${name}.log`);
    // Fresh log per start: service_logs then always shows the CURRENT instance's output.
    const fd = openSync(logFile, "w");
    // Scrub runner plumbing and model credentials from the service's env: a dev server has no
    // business holding the runner token or Anthropic auth, and NODE_ENV=production makes npm
    // installs inside services silently skip devDependencies (same rationale as childEnv()).
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) {
      if (typeof v === "string") env[k] = v;
    }
    delete env.NODE_ENV;
    delete env.JUNGLE_RUNNER_TOKEN;
    delete env.JUNGLE_BACKEND_WS;
    delete env.ANTHROPIC_API_KEY;
    delete env.ANTHROPIC_AUTH_TOKEN;
    delete env.ANTHROPIC_BASE_URL;
    let proc: ChildProcess;
    try {
      proc = spawn("/bin/sh", ["-c", command], {
        cwd,
        detached: true, // own process group: survives the runner, killable as a group
        stdio: ["ignore", fd, fd],
        env,
      });
    } finally {
      closeSync(fd); // the child holds its own copy of the fd
    }
    proc.unref();

    const rec: ServiceRecord = {
      name,
      command,
      cwd,
      status: "running",
      pid: proc.pid,
      startedAt: new Date().toISOString(),
      logFile,
    };
    delete (rec as Partial<ServiceRecord>).exitedAt;
    delete (rec as Partial<ServiceRecord>).exitCode;
    this.services.set(name, rec);
    this.children.set(name, proc);

    proc.on("error", (err) => {
      log.warn("service spawn error", { name, err: String(err) });
      this.markExited(name, null);
    });
    proc.on("exit", (code) => {
      // Only record the exit if this child is still the CURRENT instance (a restart swaps it).
      if (this.children.get(name) === proc) {
        this.children.delete(name);
        this.markExited(name, code);
      }
    });

    log.info("service started", { name, pid: proc.pid, cwd });
    void this.persist();
    this.onChange();
    return publicInfo(rec);
  }

  // Stop a service: SIGTERM its process group, escalate to SIGKILL after the grace window.
  // Resolves once the group no longer answers probes (or after the escalation fires).
  async stop(name: string, waitMs: number = STOP_GRACE_MS): Promise<AgentServiceInfo> {
    const rec = this.services.get(name);
    if (!rec) throw new Error(`no service named "${name}"`);
    if (rec.status !== "running" || !rec.pid) return publicInfo(rec);

    killGroup(rec.pid, "SIGTERM");
    const deadline = Date.now() + waitMs;
    while (Date.now() < deadline && isAlive(rec.pid)) {
      await sleep(150);
    }
    if (isAlive(rec.pid)) {
      log.warn("service ignored SIGTERM; killing group", { name, pid: rec.pid });
      killGroup(rec.pid, "SIGKILL");
      const hardDeadline = Date.now() + 2_000;
      while (Date.now() < hardDeadline && isAlive(rec.pid)) {
        await sleep(100);
      }
    }
    // The child's exit event (if it's ours) also fires markExited — idempotent by status check.
    this.markExited(name, null);
    return publicInfo(this.services.get(name)!);
  }

  // Current list, liveness re-probed. Snapshot for the services frame / service_status tool.
  list(): AgentServiceInfo[] {
    if (this.refreshLiveness()) void this.persist();
    return [...this.services.values()]
      .sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1))
      .map(publicInfo);
  }

  // Tail of a service's log file (last `lines` lines from the final LOG_TAIL_BYTES).
  async logs(name: string, lines = 100): Promise<string> {
    const rec = this.services.get(name);
    if (!rec) throw new Error(`no service named "${name}"`);
    let fh: fs.FileHandle | null = null;
    try {
      fh = await fs.open(rec.logFile, "r");
      const { size } = await fh.stat();
      const start = Math.max(0, size - LOG_TAIL_BYTES);
      const buf = Buffer.alloc(size - start);
      await fh.read(buf, 0, buf.length, start);
      const text = buf.toString("utf8");
      const all = text.split("\n");
      const clamped = Math.min(Math.max(1, Math.floor(lines)), 500);
      return all.slice(-clamped - 1).join("\n").trim() || "(log is empty)";
    } catch (err: any) {
      if (err?.code === "ENOENT") return "(no log file yet)";
      throw err;
    } finally {
      await fh?.close();
    }
  }

  // Best-effort synchronous teardown for runner shutdown (SIGINT/SIGTERM from the daemon or
  // container stop): the agent is being stopped on purpose, so its services go too. No waiting
  // — the process is about to exit; SIGKILL escalation is the OS's problem at that point.
  stopAll(): void {
    for (const rec of this.services.values()) {
      if (rec.status === "running" && rec.pid) {
        killGroup(rec.pid, "SIGTERM");
        rec.status = "exited";
        rec.exitedAt = new Date().toISOString();
        rec.exitCode = null;
      }
    }
    // Synchronous-ish persist: fire and hope — an unflushed registry self-heals at next init
    // via the pid probe.
    void this.persist();
  }

  private markExited(name: string, code: number | null): void {
    const rec = this.services.get(name);
    if (!rec || rec.status === "exited") return;
    rec.status = "exited";
    rec.exitedAt = new Date().toISOString();
    rec.exitCode = code;
    log.info("service exited", { name, code });
    void this.persist();
    this.onChange();
  }

  // Probe every "running" record; returns true if any transitioned to exited.
  private refreshLiveness(): boolean {
    let changed = false;
    for (const rec of this.services.values()) {
      if (rec.status === "running" && !(rec.pid && isAlive(rec.pid))) {
        rec.status = "exited";
        rec.exitedAt = new Date().toISOString();
        rec.exitCode = null;
        changed = true;
      }
    }
    return changed;
  }

  private persist(): Promise<void> {
    const snapshot = JSON.stringify([...this.services.values()], null, 2);
    this.writeChain = this.writeChain.then(async () => {
      try {
        await fs.mkdir(this.dir, { recursive: true });
        const tmp = this.registryFile + ".tmp";
        await fs.writeFile(tmp, snapshot, "utf8");
        await fs.rename(tmp, this.registryFile);
      } catch (err) {
        log.error("failed to persist services registry", { err: String(err) });
      }
    });
    return this.writeChain;
  }
}

// The wire/tool projection: everything except the local log path.
function publicInfo(rec: ServiceRecord): AgentServiceInfo {
  const { logFile: _logFile, ...info } = rec;
  return info;
}

// Probe the process GROUP: true while any member is genuinely alive. Group (not leader) is the
// right question for stop/status — a dev server often re-execs and the leader dies first.
//
// The naive kill(-pgid, 0) probe has a zombie hole: a group holding only ZOMBIES still answers
// the signal probe, and when the runner is PID 1 (docker without --init) orphaned grandchild
// zombies are never reaped — the dead group then probes "alive" forever (observed: stop()
// always escalating to SIGKILL after the full grace window). On Linux we therefore scan
// /proc for members of the group in a non-zombie state; elsewhere (macOS self-hosted — where
// the OS init reaps orphans, so the hole doesn't arise) we fall back to the signal probe.
function isAlive(pid: number): boolean {
  try {
    process.kill(-pid, 0);
  } catch (err: any) {
    return err?.code === "EPERM"; // EPERM = alive but not ours; anything else = gone
  }
  if (process.platform !== "linux") return true;
  return procGroupHasLiveMember(pid);
}

// Linux: does process group `pgid` contain any non-zombie member? Reads each numeric /proc
// entry's stat line; pgrp is field 3 after the parenthesized comm (which may contain spaces).
// Any read error for an individual entry is skipped (processes vanish mid-scan routinely).
function procGroupHasLiveMember(pgid: number): boolean {
  let entries: string[];
  try {
    entries = fsSync.readdirSync("/proc");
  } catch {
    return true; // /proc unavailable — trust the signal probe's answer
  }
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      const stat = fsSync.readFileSync(`/proc/${entry}/stat`, "utf8");
      const after = stat.slice(stat.lastIndexOf(")") + 2); // "state ppid pgrp sid ..."
      const [state, , pgrp] = after.split(" ");
      if (Number(pgrp) === pgid && state !== "Z") return true;
    } catch {
      /* raced with process exit — skip */
    }
  }
  return false;
}

function killGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
  } catch {
    /* already gone */
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
