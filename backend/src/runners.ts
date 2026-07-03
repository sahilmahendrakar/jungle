import "./env";
import type { IncomingMessage } from "node:http";
import type internal from "node:stream";
import { WebSocket, WebSocketServer } from "ws";
import * as db from "./db";
import * as gh from "./github";
import { signedPath } from "./attachments";

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
  // A turn died (SDK crash, OOM kill, API error). Tell the humans who were waiting —
  // otherwise the agent just goes silent mid-task.
  onTurnFailed: (agent: { id: string; handle: string }, error: string) => void;
}

let hooks: RunnerHooks | null = null;

// --- Permission mode mapping (protocol §"Permission modes") ---

const SDK_MODES = new Set(["default", "acceptEdits", "plan", "bypassPermissions", "dontAsk"]);

// Map whatever is stored in participants.mode to an SDK wire permissionMode. New sdk agents
// store an SDK mode directly; legacy MA values are mapped for safety if an agent is migrated.
export function toPermissionMode(mode: string | null | undefined): string {
  if (mode && SDK_MODES.has(mode)) return mode;
  if (mode === "always_allow") return "bypassPermissions";
  if (mode === "always_ask") return "default";
  return "default";
}

export function isSdkPermissionMode(mode: string): boolean {
  return SDK_MODES.has(mode);
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
}

// agentId -> the single live runner connection (a new connect replaces the old).
const conns = new Map<string, RunnerConn>();

export function isConnected(agentId: string): boolean {
  return conns.has(agentId);
}

function send(conn: RunnerConn, frame: Record<string, unknown>): void {
  if (conn.ws.readyState === WebSocket.OPEN) conn.ws.send(JSON.stringify(frame));
}

// --- Config framing ---

// Compose the systemPromptAppend for an sdk agent. Mirrors the persona framing the MA path
// puts in each turn's input (runAgentReply in index.ts): who the agent is and how it talks
// (send_message only). Per-turn/channel context is NOT here — it rides in each enqueue item.
export function systemPromptAppend(agent: db.AgentRow): string {
  let s =
    `You are @${agent.handle} (${agent.display_name || agent.handle}) in Jungle, a Slack-style ` +
    `workspace. You are a chat participant.\n` +
    `Your ONLY way to say anything to people is the send_message tool ` +
    `(mcp__jungle__send_message): to reply in a channel use to:"#channel-name", to DM someone ` +
    `use to:"@handle". Plain assistant text is NEVER shown to anyone. ` +
    `Each queued message tells you which channel it came from — reply there unless asked otherwise.\n\n` +
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
async function buildConfigure(agent: db.AgentRow): Promise<Record<string, unknown>> {
  const frame: Record<string, unknown> = {
    type: "configure",
    model: agent.model ?? null,
    permissionMode: toPermissionMode(agent.mode),
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

// --- Live config pushes (called by the PATCH /api/agents/:id endpoint) ---

export function setPermissionMode(agentId: string, mode: string): void {
  const conn = conns.get(agentId);
  if (conn) send(conn, { type: "set_permission_mode", mode });
}
export function setModel(agentId: string, model: string): void {
  const conn = conns.get(agentId);
  if (conn) send(conn, { type: "set_model", model });
}

// Interrupt the agent's running turn (queued inbox items are untouched — they'll be
// consumed at the next turn boundary). Returns false if no runner is connected.
export function interrupt(agentId: string): boolean {
  const conn = conns.get(agentId);
  if (!conn) return false;
  send(conn, { type: "interrupt" });
  return true;
}

// Runner liveness/state for the UI (Activity header, profile status dot).
export function runnerState(agentId: string): { connected: boolean; state: "idle" | "running" } {
  const conn = conns.get(agentId);
  return { connected: !!conn, state: conn?.state ?? "idle" };
}

// Drop a runner connection (agent deletion). Closes the socket with 4003 so the runner
// exits rather than reconnecting, and forgets it immediately.
export function disconnect(agentId: string): void {
  const conn = conns.get(agentId);
  if (!conn) return;
  conns.delete(agentId);
  try {
    conn.ws.close(4003, "agent deleted");
  } catch {
    // socket may already be closing — nothing to do.
  }
}

// --- Confirm routing (called by the decision endpoint in index.ts) ---

// Resolve a runner's confirm_request. Returns false if no live runner / unknown id.
export function resolveConfirm(agentId: string, confirmId: string, result: ConfirmDecision): boolean {
  const conn = conns.get(agentId);
  if (!conn || !conn.pendingConfirms.has(confirmId)) return false;
  conn.pendingConfirms.delete(confirmId);
  send(conn, {
    type: "confirm_result",
    id: confirmId,
    result: result.result,
    ...(result.denyMessage ? { denyMessage: result.denyMessage } : {}),
    ...(result.updatedInput !== undefined ? { updatedInput: result.updatedInput } : {}),
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
  };
  conns.set(agent.id, conn);
  console.log(`runner[${agent.id}] (@${agent.handle}) connected`);

  ws.on("close", () => {
    // Only forget this socket if it's still the registered one (a replacement may own it now).
    if (conns.get(agent.id) === conn) conns.delete(agent.id);
    console.log(`runner[${agent.id}] disconnected`);
  });

  // Replay any frames (notably `hello`) that arrived during the token lookup.
  for (const raw of early) void handleFrame(conn, raw);
}

async function handleFrame(conn: RunnerConn, raw: string): Promise<void> {
  let frame: any;
  try {
    frame = JSON.parse(raw);
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
        conn.state = "idle";
        conn.sentInbox.clear(); // reconnect: allow re-sending unacked inbox rows
        send(conn, await buildConfigure(agent));
        // Runner is idle after configure — push any queued work.
        await drain(agentId);
        break;
      }
      case "state": {
        conn.state = frame.state === "running" ? "running" : "idle";
        if (frame.sessionId !== undefined) conn.sessionId = frame.sessionId;
        break;
      }
      case "turn_started": {
        // The runner is consuming these inbox items in turn `frame.turnId`. Informational;
        // durable delivery is confirmed by `consumed`.
        break;
      }
      case "consumed": {
        const ids: string[] = Array.isArray(frame.inboxIds) ? frame.inboxIds : [];
        await db.markInboxConsumed(agentId, ids, frame.turnId ?? null);
        break;
      }
      case "event": {
        hooks?.onAgentEvent(agentId, frame.turnId ?? null, frame.event);
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
        conn.state = "idle";
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
        break;
      }
      default:
        console.warn(`runner[${agentId}] unknown frame type:`, frame.type);
    }
  } catch (e) {
    console.error(`runner[${agentId}] error handling ${frame?.type}:`, e);
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
