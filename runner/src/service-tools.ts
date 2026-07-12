// The service_* custom tools: the agent's supervisor-owned long-running processes (dev servers,
// watchers, tunnels). Local to the runner — no backend round-trip; the ops object is the
// runner's ServiceManager. Registered on the same in-process "jungle" SDK MCP server as
// send_message (see send-message-tool.ts), so they ride the same alwaysLoad pin.
//
// Permission model: service_status/service_logs are read-only (SAFE_TOOLS + allowedTools);
// service_start/service_stop run arbitrary commands / kill processes, so they are NOT
// auto-allowed — in default mode they route through the human confirmation card like Bash.
import { tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { log } from "./log.js";
import type { AgentServiceInfo } from "./protocol.js";

// What the tools need from the ServiceManager (kept as an interface so the tool layer stays
// decoupled from process management).
export interface ServiceOps {
  start(input: { name: string; command: string; cwd?: string }): Promise<AgentServiceInfo>;
  stop(name: string): Promise<AgentServiceInfo>;
  list(): AgentServiceInfo[];
  logs(name: string, lines?: number): Promise<string>;
}

export function createServiceTools(ops: ServiceOps) {
  const serviceStart = tool(
    "service_start",
    "Start (or restart) a named long-running background service on your machine: a dev server, " +
      "file watcher, tunnel, etc. Services are owned by your always-on supervisor — NOT the " +
      "per-turn sandbox — so they keep running between turns and conversations. ALWAYS use this " +
      "instead of Bash with run_in_background/nohup for anything that must outlive the current " +
      "turn. Output goes to a per-service log file (read it with service_logs). Starting a name " +
      "that is already running restarts it with the new command.",
    {
      name: z
        .string()
        .describe('Short kebab-case service name, unique to you, e.g. "dev-server"'),
      command: z
        .string()
        .describe('Shell command to run, e.g. "npm run dev". Runs via sh -c until stopped.'),
      cwd: z
        .string()
        .optional()
        .describe("Working directory (absolute or workspace-relative). Default: your workspace."),
    },
    async (args) => {
      try {
        const info = await ops.start({ name: args.name, command: args.command, cwd: args.cwd });
        return {
          content: [
            {
              type: "text",
              text:
                `Service "${info.name}" started (pid ${info.pid}).\n` +
                `It keeps running after this turn ends. Check it with service_status, read output ` +
                `with service_logs, stop it with service_stop.`,
            },
          ],
        };
      } catch (err) {
        log.error("service_start failed", { err: String(err) });
        return toolError(`Failed to start service: ${errMsg(err)}`);
      }
    },
  );

  const serviceStop = tool(
    "service_stop",
    "Stop one of your running services by name (kills its whole process group). Use " +
      "service_status to see what's running.",
    { name: z.string().describe("The service's name (from service_start / service_status)") },
    async (args) => {
      try {
        const info = await ops.stop(args.name);
        return { content: [{ type: "text", text: `Service "${info.name}" stopped.` }] };
      } catch (err) {
        log.error("service_stop failed", { err: String(err) });
        return toolError(`Failed to stop service: ${errMsg(err)}`);
      }
    },
  );

  const serviceStatus = tool(
    "service_status",
    "List your services (running and recently exited): name, status, pid, uptime, command. " +
      "Read-only.",
    {},
    async () => {
      const services = ops.list();
      if (!services.length) {
        return { content: [{ type: "text", text: "You have no services." }] };
      }
      const lines = services.map((s) => {
        const when =
          s.status === "running"
            ? `up since ${s.startedAt}`
            : `exited ${s.exitedAt ?? "?"} (code ${s.exitCode ?? "killed"})`;
        return `- ${s.name}: ${s.status}${s.pid ? ` (pid ${s.pid})` : ""} — ${when}\n  $ ${s.command}`;
      });
      return { content: [{ type: "text", text: lines.join("\n") }] };
    },
  );

  const serviceLogs = tool(
    "service_logs",
    "Read the tail of a service's log (stdout+stderr of its current instance). Read-only.",
    {
      name: z.string().describe("The service's name"),
      lines: z.number().int().min(1).max(500).optional().describe("How many lines (default 100)"),
    },
    async (args) => {
      try {
        const text = await ops.logs(args.name, args.lines);
        return { content: [{ type: "text", text }] };
      } catch (err) {
        return toolError(`Failed to read logs: ${errMsg(err)}`);
      }
    },
  );

  return [serviceStart, serviceStop, serviceStatus, serviceLogs];
}

function toolError(text: string) {
  return { content: [{ type: "text" as const, text }], isError: true };
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
