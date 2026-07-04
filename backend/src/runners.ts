import "./env";
import type { IncomingMessage } from "node:http";
import type internal from "node:stream";
import { WebSocket, WebSocketServer } from "ws";
import type {
  RunnerToBackend,
  BackendToRunner,
  ConfigureFrame,
  AgentStatus,
  PermissionMode,
} from "@jungle/shared";
import { isSdkMode } from "@jungle/shared";
import * as db from "./db";
import * as gh from "./github";
import { signedPath } from "./attachments";
import { provisionerFor } from "./provisioner";

export type { AgentStatus };

// The SDK-runner side of Jungle. A runner is a per-agent container that dials INTO the backend
// at GET /api/runner?token=<runner_token> (WS upgrade) and speaks docs/runner-protocol.md.
// The backend authenticates by matching the token to participants.runner_token (sdk agents
// only), then pushes work (`enqueue`) and config (`configure`) down the socket.
//
// This module owns: the WS upgrade + auth, the per-agent connection registry, the inbox
// drain, and all protocol frame handling. The chat-side effects it needs (posting a message
// the agent sends, surfacing a tool-confirmation card, persisting/broadcasting events) live
// in index.ts and are injected via init() to avoid an import cycle.

// --- Injected hooks (wired by index.ts in init) ---

export interface SendMessageInput {
  to?: string;
  body?: string;
  // Ids the runner got back from POST /api/attachments (it uploads the agent's workspace
  // files itself, then references them here).
  attachmentIds?: string[];
  // Threads: reply into a thread by root message id. Omitted → the backend defaults it to the
  // thread the agent was triggered in (sdkContext), so agents reply in-thread without effort.
  // Pass threadRootId: null to force a top-level post even when triggered inside a thread.
  threadRootId?: string | null;
  // Echo a thread reply into the main channel timeline too ("also send to channel").
  alsoToChannel?: boolean;
}
export interface SendMessageResult {
  ok: boolean;
  error?: string;
  messageId?: string;
}
export type ConfirmDecision = { result: "allow" | "deny"; denyMessage?: string; updatedInput?: unknown };

export interface RunnerHooks {
  // Post a message the agent asked to send (same routing/cascade as the MA path's onSend).
  deliverAgentMessage: (
    agent: { id: string; handle: string },
    input: SendMessageInput,
  ) => Promise<SendMessageResult>;
  // Surface a tool-confirmation to humans and resolve when one decides. `agentId`+`id`
  // let the decision endpoint route the result back to the right runner.
  requestConfirm: (
    agent: db.AgentRow,
    confirm: { id: string; toolName: string; input: unknown; suggestions?: unknown },
  ) => Promise<ConfirmDecision>;
  // Persist an SDK stream event and broadcast it to app websockets.
  onAgentEvent: (agentId: string, turnId: string | null, event: unknown) => void;
  // The runner reported how full the agent's context window is (once per turn).
  // Persist + broadcast so open profile dialogs live-update.
  onContextUsage: (agentId: string, usage: { tokens: number; maxTokens: number }) => void;
  // A turn died (SDK crash, OOM kill, API error). Tell the humans who were waiting —
  // otherwise the agent just goes silent mid-task.
  onTurnFailed: (agent: { id: string; handle: string }, error: string) => void;
  // The agent's live status changed (see AgentStatus). Backend broadcasts it to app sockets.
  onStatusChanged: (agentId: string, status: AgentStatus) => void;
}

let hooks: RunnerHooks | null = null;

// --- Permission mode mapping (protocol §"Permission modes") ---

// Map whatever is stored in participants.mode to an SDK wire permissionMode. New sdk agents
// store an SDK mode directly; legacy MA values are mapped for safety if an agent is migrated.
export function toPermissionMode(mode: string | null | undefined): PermissionMode {
  if (mode && isSdkMode(mode)) return mode;
  if (mode === "always_allow") return "bypassPermissions";
  if (mode === "always_ask") return "default";
  return "default";
}

// --- Connection registry ---

interface RunnerConn {
  agentId: string;
  ws: WebSocket;
  state: "idle" | "running";
  sessionId: string | null;
  // Inbox ids already sent to THIS socket (in-memory, reset on reconnect). Prevents
  // re-sending the same pending row twice on the same connection; the runner also dedupes
  // by inboxId, so double-delivery across reconnects is harmless.
  sentInbox: Set<string>;
  // Pending confirmations from this runner, keyed by the runner-chosen confirm id, so a
  // late/duplicate decision is a no-op.
  pendingConfirms: Set<string>;
  // Timestamp this conn most recently entered "idle" (null while running or never yet idle
  // on this socket). The idle-stop sweeper reads this to decide when to stop the machine.
  idleSince: number | null;
}

// agentId -> the single live runner connection (a new connect replaces the old).
const conns = new Map<string, RunnerConn>();

export function isConnected(agentId: string): boolean {
  return conns.has(agentId);
}

// --- Agent status (Working / Idle / Sleeping / Waking up) ---

// AgentStatus (imported from @jungle/shared) is the single user-facing status for an agent,
// derived from two independent facts: whether a runner socket is currently connected (+ its
// turn state), and the machine's lifecycle when no socket is connected. Connected always wins;
// sleeping is only ever set by an explicit noteProvisionerStop (never inferred from a drop).

// Machine lifecycle bookkeeping, tracked only while NO socket is connected. `starting` = a
// provisioner.start() was issued and we're waiting for the runner's `hello`; `stopped` = the
// machine was intentionally stopped (idle-stop sweeper). Cleared the instant `hello` arrives.
const machine = new Map<string, { kind: "starting" | "stopped"; timer?: NodeJS.Timeout }>();

// How long to show "waking" before giving up (a cold machine + image pull + runner boot).
const WAKE_TIMEOUT_MS = 3 * 60_000;

export function agentStatus(agentId: string): AgentStatus {
  const conn = conns.get(agentId);
  if (conn) return conn.state === "running" ? "working" : "idle"; // connected always wins
  const m = machine.get(agentId);
  if (m?.kind === "starting") return "waking";
  if (m?.kind === "stopped") return "sleeping";
  return "idle"; // no signal either way — the pre-idle-stop (Docker) baseline
}

function emitStatus(agentId: string): void {
  hooks?.onStatusChanged(agentId, agentStatus(agentId));
}

// Set a conn's turn state, tracking when it most recently entered idle (idleSince). Used by
// the idle-stop sweeper to measure how long a connected-but-idle runner has been quiet.
function setConnState(conn: RunnerConn, state: "idle" | "running"): void {
  const enteringIdle = state === "idle" && (conn.state !== "idle" || conn.idleSince == null);
  conn.state = state;
  if (state === "running") conn.idleSince = null;
  else if (enteringIdle) conn.idleSince = Date.now();
}

// Mark a machine as starting (call right after provisioner.start()). No-op if a socket is
// already connected. Starts a wake-timeout so a machine that never says `hello` falls back to
// idle rather than showing "waking" forever.
export function noteProvisionerStart(agentId: string): void {
  if (conns.has(agentId)) return;
  const prev = machine.get(agentId);
  if (prev?.timer) clearTimeout(prev.timer);
  const timer = setTimeout(() => {
    if (!conns.has(agentId)) {
      machine.delete(agentId);
      console.error(`runner[${agentId}] never sent hello after start (wake timeout)`);
      emitStatus(agentId);
    }
  }, WAKE_TIMEOUT_MS);
  machine.set(agentId, { kind: "starting", timer });
  emitStatus(agentId);
}

// Mark a machine as intentionally stopped (call right after provisioner.stop()). This is the
// ONLY way an agent reaches "sleeping".
export function noteProvisionerStop(agentId: string): void {
  const prev = machine.get(agentId);
  if (prev?.timer) clearTimeout(prev.timer);
  machine.set(agentId, { kind: "stopped" });
  emitStatus(agentId);
}

// Boot reconciliation: seed at-rest state from the real provisioner. Only "stopped" is
// recorded; a running-but-not-yet-connected machine shows idle briefly until `hello` arrives.
export function reseedMachineState(agentId: string, providerStatus: "running" | "stopped" | "absent"): void {
  if (providerStatus === "stopped") {
    machine.set(agentId, { kind: "stopped" });
    emitStatus(agentId);
  }
}

// Drop any machine bookkeeping (clearing a live timer). Called when a socket connects or the
// agent is deleted.
function clearMachine(agentId: string): void {
  const m = machine.get(agentId);
  if (m?.timer) clearTimeout(m.timer);
  machine.delete(agentId);
}

function send(conn: RunnerConn, frame: BackendToRunner): void {
  if (conn.ws.readyState === WebSocket.OPEN) conn.ws.send(JSON.stringify(frame));
}

// --- Config framing ---

// Compose the systemPromptAppend for an sdk agent: persona, behavior, and environment. Per-turn
// routing/context (which channel, recent messages) is NOT here — that's built fresh per dispatch
// in orchestrator.ts's buildAgentTurnInput and rides in each enqueue item instead.
export function systemPromptAppend(agent: db.AgentRow): string {
  let s =
    `You are @${agent.handle} (${agent.display_name || agent.handle}) in Jungle, a Slack-style ` +
    `workspace. You are a chat participant.\n` +
    `Your ONLY way to say anything to people is the send_message tool ` +
    `(mcp__jungle__send_message): to reply in a channel use to:"#channel-name", to DM someone ` +
    `use to:"@handle". Plain assistant text is NEVER shown to anyone. ` +
    `Each queued message tells you which channel it came from — reply there unless asked otherwise.\n\n` +
    `— Be responsive: narrate your work —\n` +
    `People are waiting on you in real time, like a Slack channel. Send a short send_message as ` +
    `soon as you pick up non-trivial work (e.g. "On it — looking into this now.") so people know ` +
    `you've got it, instead of going silent until you're fully done. Then keep them posted as you ` +
    `go: a quick "Here's my plan …", "Starting on the refactor …", "Tests pass, opening the PR …" ` +
    `at each meaningful step. Err toward more frequent, brief updates rather than one long silence ` +
    `ending in a final report — these updates go in the thread, so they're cheap and don't clutter ` +
    `the channel.\n\n` +
    `— Mentioning and DMing other agents —\n` +
    `@mentioning or DMing another agent wakes them up, just like a person being paged. Only do ` +
    `it when you specifically want that agent to wake up and take some action — never as an ` +
    `incidental reference or FYI. Stay focused on what you were specifically assigned: if you see ` +
    `a message addressed to a different agent, don't assume it's your job too — only act on it if ` +
    `the user specifically mentioned or asked you.\n\n` +
    `— Threads vs channel —\n` +
    `You choose where each reply lands, and for most cases you should choose a thread rather than ` +
    `the main channel timeline — it keeps the channel tidy. When you're addressed in a thread, ` +
    `omitting threadRootId keeps your reply in that thread. When you're addressed by a top-level ` +
    `channel message, that message's id is given to you in the turn input; pass it as threadRootId ` +
    `to reply in a thread under it (do this for progress updates and most replies). Posting a plain ` +
    `message to the whole channel is always available and fully your call: omit threadRootId to ` +
    `post at the top level, or set alsoToChannel:true to post to both a thread and the channel. ` +
    `Reserve channel-level posts for things everyone should see, not routine progress.\n\n` +
    `— Files & images —\n` +
    `Files people attach to messages are saved into your workspace under ` +
    `/workspace/attachments/ (each queued message lists the exact paths). To send files or ` +
    `images to people, pass workspace file paths in send_message's \`files\` parameter, e.g. ` +
    `files:["/workspace/repo/screenshot.png"] — images render inline in the chat, other file ` +
    `types become downloads. Max 10 files, 25MB each.`;
  if (agent.repo) {
    const gitName = agent.display_name || agent.handle;
    const gitEmail = `${agent.handle}@agents.jungle.dev`;
    s +=
      `\n\n— Working on ${agent.repo} —\n` +
      `The repo is already cloned at /workspace/repo with git credentials configured ` +
      `(if it's ever missing, clone it yourself with gh). Make and COMMIT changes with git so ` +
      `commits are authored as you. Before committing, run once:\n` +
      `  git config user.name ${JSON.stringify(gitName)}\n` +
      `  git config user.email ${JSON.stringify(gitEmail)}\n` +
      `Then push your branch and open the pull request.`;
  }
  s +=
    `\n\n— Your environment —\n` +
    `You run in a Linux container: no sudo/apt, ~3GB memory (don't run several heavy ` +
    `processes at once), Chromium preinstalled for Playwright (PLAYWRIGHT_BROWSERS_PATH is set). ` +
    `Dev servers and other long-running processes MUST use the Bash tool's run_in_background ` +
    `option — plain \`&\` background jobs are killed when the Bash call returns.`;
  return s;
}

// Build the `configure` reply to a runner's `hello`: model, permission mode, persona, and
// (for GitHub-capable agents) a fresh installation token so the runner can authenticate git.
async function buildConfigure(agent: db.AgentRow): Promise<ConfigureFrame> {
  const frame: ConfigureFrame = {
    type: "configure",
    model: agent.model ?? null,
    permissionMode: toPermissionMode(agent.mode),
    effort: agent.effort,
    systemPromptAppend: systemPromptAppend(agent),
  };
  if (agent.repo && gh.appAuthConfigured()) {
    try {
      const token = await gh.installationTokenForRepo(agent.repo);
      const login = agent.handle; // git identity/login the runner presents
      // repoUrl makes the runner clone into /workspace/repo before its first turn.
      frame.git = { token, login, repoUrl: `https://github.com/${agent.repo}.git` };
    } catch (e) {
      console.error(`runner[${agent.id}] configure: could not mint git token:`, e);
    }
  }
  return frame;
}

// --- Git credential refresh ---

// Re-mint the repo's installation token and push it to the runner as a `git_credentials`
// frame. GitHub App installation tokens hard-expire at 1h; a runner that stays connected
// longer than that would otherwise keep using the stale token it was handed once in
// `configure` (its `git push`/`gh` share that token and 401 together). installationTokenForRepo
// caches until ~5 min before expiry, so this is ~free until a refresh is actually needed. We
// call it before each drain so every turn starts with a valid token — no timers, no background
// state. No-op for agents without a repo or when App auth isn't configured.
async function refreshGitCredentials(conn: RunnerConn, agent: db.AgentRow): Promise<void> {
  if (!agent.repo || !gh.appAuthConfigured()) return;
  try {
    const token = await gh.installationTokenForRepo(agent.repo);
    send(conn, { type: "git_credentials", token, login: agent.handle });
  } catch (e) {
    console.error(`runner[${agent.id}] could not refresh git token:`, e);
  }
}

// --- Drain: push pending inbox items to a connected runner ---

// Send one `enqueue` carrying every not-yet-sent-on-this-socket pending inbox row. Safe to
// call redundantly: rows already sent on this connection are skipped; the runner also dedupes
// by inboxId. When no runner is connected, this is a no-op and the rows wait in the DB.
export async function drain(agentId: string): Promise<void> {
  const conn = conns.get(agentId);
  if (!conn) return; // offline — rows stay pending, drained on next hello
  const pending = await db.pendingInbox(agentId);
  const items = pending
    .filter((p) => !conn.sentInbox.has(p.id))
    .map((p) => ({
      inboxId: p.id,
      text: p.text,
      // Sign download URLs now (not at enqueue) so items that waited in the inbox while the
      // runner was offline still carry live links. Paths are origin-relative; the runner
      // prefixes the backend origin it already dials for its WebSocket.
      ...(p.attachments?.length
        ? {
            attachments: p.attachments.map((a) => ({
              url: signedPath(a.id),
              filename: a.filename,
              mime: a.mime,
              sizeBytes: Number(a.size_bytes),
            })),
          }
        : {}),
    }));
  if (!items.length) return;
  // Push a fresh git token before the work so a long-lived runner never begins a turn with an
  // expired installation token. Ordered before `enqueue` so the runner applies it before the
  // turn (and any git ops in it) starts.
  const agent = await db.getAgentRow(agentId);
  if (agent) await refreshGitCredentials(conn, agent);
  for (const it of items) conn.sentInbox.add(it.inboxId);
  send(conn, { type: "enqueue", items });
}

// --- Idle-stop sweeper + fatal-restart ---

// How long a connected-but-idle runner may sit with an empty inbox before its machine is
// stopped (0 disables idle-stop entirely — e.g. for the Docker-on-EC2 dev box).
const IDLE_STOP_MS = (() => {
  const raw = Number(process.env.RUNNER_IDLE_STOP_SECONDS ?? 60);
  return Number.isFinite(raw) && raw > 0 ? raw * 1000 : 0;
})();
const SWEEP_INTERVAL_MS = 15_000;
let sweeping = false;

// One sweep pass over every sdk agent: stop machines that have been idle too long with
// nothing queued, and (reverse direction) start machines for a disconnected agent that has
// pending inbox work — this heals the enqueue-vs-stop race and crashed runners with queued
// work, uniformly for docker AND fly agents. Sequential (not Promise.all) so the pass itself
// throttles calls to the Fly API (~1/s rate limit).
async function sweepOnce(): Promise<void> {
  if (sweeping) return;
  sweeping = true;
  try {
    const agents = await db.listSdkAgents();
    for (const agent of agents) {
      const conn = conns.get(agent.id);
      try {
        if (conn) {
          if (IDLE_STOP_MS === 0) continue;
          if (conn.state !== "idle" || conn.idleSince == null) continue;
          if (Date.now() - conn.idleSince < IDLE_STOP_MS) continue;
          if ((await db.pendingInbox(agent.id)).length > 0) continue;
          await provisionerFor(agent).stop(agent.id);
          noteProvisionerStop(agent.id);
        } else {
          if (machine.get(agent.id)?.kind === "starting") continue;
          if ((await db.pendingInbox(agent.id)).length === 0) continue;
          await provisionerFor(agent).start(agent.id);
          noteProvisionerStart(agent.id);
        }
      } catch (e) {
        console.error(`idle-stop sweep: agent ${agent.id}:`, e);
      }
    }
  } catch (e) {
    console.error("idle-stop sweep:", e);
  } finally {
    sweeping = false;
  }
}

// Start the recurring sweep. Call once at boot (index.ts, after runners.init).
export function startIdleSweeper(): void {
  setInterval(() => void sweepOnce(), SWEEP_INTERVAL_MS).unref();
}

// Loop guard for the fatal-restart path below: at most FATAL_RESTART_MAX restarts per agent
// within FATAL_RESTART_WINDOW_MS, so a runner that fatals immediately on every boot doesn't
// spin the machine forever.
const fatalRestarts = new Map<string, number[]>();
const FATAL_RESTART_WINDOW_MS = 10 * 60_000;
const FATAL_RESTART_MAX = 3;

// --- Live config pushes (called by the PATCH /api/agents/:id endpoint) ---

export function setPermissionMode(agentId: string, mode: PermissionMode): void {
  const conn = conns.get(agentId);
  if (conn) send(conn, { type: "set_permission_mode", mode });
}
export function setModel(agentId: string, model: string): void {
  const conn = conns.get(agentId);
  if (conn) send(conn, { type: "set_model", model });
}
export function setEffort(agentId: string, effort: string): void {
  const conn = conns.get(agentId);
  if (conn) send(conn, { type: "set_effort", effort });
}

// Interrupt the agent's running turn (queued inbox items are untouched — they'll be
// consumed at the next turn boundary). Returns false if no runner is connected.
export function interrupt(agentId: string): boolean {
  const conn = conns.get(agentId);
  if (!conn) return false;
  send(conn, { type: "interrupt" });
  return true;
}

// Ask the agent's runner to compact/summarize its session context. The runner runs a
// dedicated `/compact` turn when the agent is next idle (repeated requests coalesce).
// Returns false if no runner is connected.
export function compact(agentId: string): boolean {
  const conn = conns.get(agentId);
  if (!conn) return false;
  send(conn, { type: "compact" });
  return true;
}

// agentId -> a compact request made while the machine was asleep/waking, to be delivered the
// moment its runner says `hello` (see the "hello" case below).
const pendingCompact = new Set<string>();

// Compact-button entry point: sends immediately if a runner is connected; otherwise wakes the
// agent's machine (same wake-on-message path as a triggering chat message) and remembers the
// request so it's delivered on the runner's next `hello` instead of failing with "offline".
export async function compactOrWake(
  agent: db.Participant,
): Promise<"sent" | "waking" | "wake_failed"> {
  if (compact(agent.id)) return "sent";
  pendingCompact.add(agent.id);
  try {
    await provisionerFor(agent).start(agent.id);
    noteProvisionerStart(agent.id);
    return "waking";
  } catch (e) {
    pendingCompact.delete(agent.id);
    console.error(`compactOrWake: wake failed for ${agent.id}:`, e);
    return "wake_failed";
  }
}

// Runner liveness/state for the UI (Activity header, profile status dot).
export function runnerState(
  agentId: string,
): { connected: boolean; state: "idle" | "running"; status: AgentStatus } {
  const conn = conns.get(agentId);
  return { connected: !!conn, state: conn?.state ?? "idle", status: agentStatus(agentId) };
}

// Drop a runner connection (agent deletion). Closes the socket with 4003 so the runner
// exits rather than reconnecting, and forgets it immediately.
export function disconnect(agentId: string): void {
  const conn = conns.get(agentId);
  if (!conn) return;
  conns.delete(agentId);
  clearMachine(agentId);
  try {
    conn.ws.close(4003, "agent deleted");
  } catch {
    // socket may already be closing — nothing to do.
  }
}

// --- Confirm routing ---

// Relay a resolved confirm decision to the runner as a confirm_result frame. Called internally
// when the requestConfirm hook settles (allow/deny/timeout). Returns false if no live runner /
// unknown id.
function resolveConfirm(agentId: string, confirmId: string, result: ConfirmDecision): boolean {
  const conn = conns.get(agentId);
  if (!conn || !conn.pendingConfirms.has(confirmId)) return false;
  conn.pendingConfirms.delete(confirmId);
  send(conn, {
    type: "confirm_result",
    id: confirmId,
    result: result.result,
    ...(result.denyMessage ? { denyMessage: result.denyMessage } : {}),
    ...(result.updatedInput !== undefined
      ? { updatedInput: result.updatedInput as Record<string, unknown> }
      : {}),
  });
  return true;
}

// --- WS upgrade + protocol handling ---

// Authenticate + register a runner socket. Called from the server 'upgrade' handler for the
// /api/runner path. `token` is the query param from the connect URL.
async function accept(ws: WebSocket, token: string): Promise<void> {
  // Attach the message listener SYNCHRONOUSLY, before any await. The runner sends `hello`
  // the instant the socket opens; if we awaited the token lookup first, that frame would
  // arrive with no listener attached and be dropped — leaving the agent connected but never
  // configured (turns silently never start). So buffer frames until auth+registration
  // completes, then replay them in order and switch to direct handling.
  let conn: RunnerConn | null = null;
  const early: string[] = [];
  ws.on("message", (raw) => {
    if (conn) void handleFrame(conn, raw.toString());
    else early.push(raw.toString());
  });
  ws.on("error", (e) => console.error("runner socket error (pre-auth):", e));

  const agent = await db.agentByRunnerToken(token);
  if (!agent) {
    ws.close(4001, "invalid runner token");
    return;
  }
  // One live socket per agent: a new connection replaces the old (old is closed).
  const existing = conns.get(agent.id);
  if (existing && existing.ws !== ws) {
    try {
      existing.ws.close(4000, "replaced by new connection");
    } catch {
      /* ignore */
    }
  }
  conn = {
    agentId: agent.id,
    ws,
    state: "idle",
    sessionId: null,
    sentInbox: new Set(),
    pendingConfirms: new Set(),
    idleSince: null,
  };
  conns.set(agent.id, conn);
  console.log(`runner[${agent.id}] (@${agent.handle}) connected`);

  ws.on("close", () => {
    // Only forget this socket if it's still the registered one (a replacement may own it now).
    if (conns.get(agent.id) === conn) {
      conns.delete(agent.id);
      // No machine bookkeeping here: an unexpected drop (crash/blip) falls through to idle, not
      // sleeping — sleeping is only ever set by an explicit noteProvisionerStop.
      emitStatus(agent.id);
    }
    console.log(`runner[${agent.id}] disconnected`);
  });

  // Replay any frames (notably `hello`) that arrived during the token lookup.
  for (const raw of early) void handleFrame(conn, raw);
}

async function handleFrame(conn: RunnerConn, raw: string): Promise<void> {
  // Frames are trusted to match the protocol (the runner is our own code); the discriminated
  // union narrows each case below. Malformed JSON is dropped.
  let frame: RunnerToBackend;
  try {
    frame = JSON.parse(raw) as RunnerToBackend;
  } catch {
    return;
  }
  const agentId = conn.agentId;
  try {
    switch (frame.type) {
      case "hello": {
        // Re-fetch the row so config reflects any edits made while the runner was offline.
        const agent = await db.getAgentRow(agentId);
        if (!agent) {
          conn.ws.close(4001, "agent gone");
          return;
        }
        conn.sessionId = frame.sessionId ?? null;
        setConnState(conn, "idle");
        conn.sentInbox.clear(); // reconnect: allow re-sending unacked inbox rows
        clearMachine(agentId); // a live hello always wins over stale starting/stopped state
        emitStatus(agentId);
        send(conn, await buildConfigure(agent));
        // Runner is idle after configure — push any queued work, plus a compact requested
        // while this agent was asleep/waking (see compactOrWake).
        await drain(agentId);
        if (pendingCompact.delete(agentId)) send(conn, { type: "compact" });
        break;
      }
      case "state": {
        setConnState(conn, frame.state === "running" ? "running" : "idle");
        if (frame.sessionId !== undefined) conn.sessionId = frame.sessionId;
        emitStatus(agentId);
        break;
      }
      case "turn_started": {
        // The runner is consuming these inbox items in turn `frame.turnId`. Informational;
        // durable delivery is confirmed by `consumed`.
        break;
      }
      case "consumed": {
        const ids: string[] = Array.isArray(frame.inboxIds) ? frame.inboxIds : [];
        // `consumed` carries no turnId (turn_started already recorded it); markInboxConsumed
        // coalesces, so a null here preserves any turn_id already set.
        await db.markInboxConsumed(agentId, ids, null);
        break;
      }
      case "event": {
        hooks?.onAgentEvent(agentId, frame.turnId ?? null, frame.event);
        break;
      }
      case "context_usage": {
        const tokens = Number(frame.tokens);
        const maxTokens = Number(frame.maxTokens);
        if (Number.isFinite(tokens) && Number.isFinite(maxTokens) && tokens > 0 && maxTokens > 0) {
          hooks?.onContextUsage(agentId, { tokens: Math.round(tokens), maxTokens: Math.round(maxTokens) });
        }
        break;
      }
      case "send_message": {
        const agent = await db.getAgentRow(agentId);
        let result: SendMessageResult;
        if (!hooks || !agent) {
          result = { ok: false, error: "backend not ready" };
        } else {
          try {
            result = await hooks.deliverAgentMessage(
              { id: agent.id, handle: agent.handle },
              (frame.input ?? {}) as SendMessageInput,
            );
          } catch (e) {
            result = { ok: false, error: String((e as Error).message ?? e) };
          }
        }
        send(conn, { type: "send_message_result", id: frame.id, result });
        break;
      }
      case "confirm_request": {
        const agent = await db.getAgentRow(agentId);
        const confirmId = String(frame.id ?? "");
        if (!hooks || !agent || !confirmId) {
          send(conn, {
            type: "confirm_result",
            id: confirmId,
            result: "deny",
            denyMessage: "backend not ready",
          });
          break;
        }
        conn.pendingConfirms.add(confirmId);
        // requestConfirm resolves when a human decides (or auto-allow / timeout). We route the
        // decision back here; resolveConfirm also handles the live-endpoint path, so guard
        // against a double-send by checking membership before sending.
        hooks
          .requestConfirm(agent, {
            id: confirmId,
            toolName: frame.toolName ?? "tool",
            input: frame.input ?? {},
            suggestions: frame.suggestions,
          })
          .then((decision) => {
            if (conn.pendingConfirms.has(confirmId)) resolveConfirm(agentId, confirmId, decision);
          })
          .catch((e) => {
            if (conn.pendingConfirms.has(confirmId)) {
              resolveConfirm(agentId, confirmId, {
                result: "deny",
                denyMessage: String((e as Error).message ?? e),
              });
            }
          });
        break;
      }
      case "turn_done": {
        setConnState(conn, "idle");
        emitStatus(agentId);
        if (!frame.ok) {
          console.error(`runner[${agentId}] turn ${frame.turnId} failed:`, frame.error);
          const agent = await db.getAgentRow(agentId);
          if (agent && hooks) {
            hooks.onTurnFailed(
              { id: agent.id, handle: agent.handle },
              String(frame.error ?? "unknown error"),
            );
          }
        }
        // A turn finished; more work may have queued while it ran.
        await drain(agentId);
        break;
      }
      case "fatal": {
        console.error(`runner[${agentId}] FATAL:`, frame.error);
        const agent = await db.getAgentRow(agentId);
        if (agent && hooks) hooks.onTurnFailed({ id: agent.id, handle: agent.handle }, `fatal: ${frame.error}`);
        if (!agent) break;
        const now = Date.now();
        const hist = (fatalRestarts.get(agentId) ?? []).filter((t) => now - t < FATAL_RESTART_WINDOW_MS);
        if (hist.length >= FATAL_RESTART_MAX) {
          console.error(`runner[${agentId}] fatal-restart loop guard tripped — leaving stopped`);
          fatalRestarts.set(agentId, hist);
          break;
        }
        fatalRestarts.set(agentId, [...hist, now]);
        try {
          await provisionerFor(agent).stop(agentId);
          noteProvisionerStop(agentId);
          await provisionerFor(agent).start(agentId);
          noteProvisionerStart(agentId);
        } catch (e) {
          console.error(`runner[${agentId}] fatal-restart failed:`, e);
        }
        break;
      }
      default:
        console.warn(`runner[${agentId}] unknown frame type:`, (frame as RunnerToBackend).type);
    }
  } catch (e) {
    console.error(`runner[${agentId}] error handling ${(frame as RunnerToBackend).type}:`, e);
  }
}

// Wire the runner subsystem into the HTTP/WS server. Handles the `upgrade` for /api/runner
// (leaving all other upgrade paths to the app WebSocketServer). Must be called once at boot.
export function init(
  server: import("node:http").Server,
  h: RunnerHooks,
): void {
  hooks = h;
  // A dedicated WS server with no attached http.Server; we feed it upgrades ourselves so the
  // app's WebSocketServer keeps handling the default path.
  const rwss = new WebSocketServer({ noServer: true });
  rwss.on("connection", (ws: WebSocket, _req: IncomingMessage, token: string) => {
    void accept(ws, token);
  });
  server.on("upgrade", (req: IncomingMessage, socket: internal.Duplex, head: Buffer) => {
    let pathname = "";
    try {
      pathname = new URL(req.url ?? "/", "http://localhost").pathname;
    } catch {
      return;
    }
    if (pathname !== "/api/runner") return; // not ours — the app WSS handles it
    const token = new URL(req.url ?? "/", "http://localhost").searchParams.get("token") ?? "";
    rwss.handleUpgrade(req, socket, head, (ws) => rwss.emit("connection", ws, req, token));
  });
}
