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
import { isSdkMode, catalogEntry } from "@jungle/shared";
import { resolveProvider } from "./providers";
import * as db from "./db";
import { signedPath } from "./attachments";
import { provisionerFor } from "./provisioner";
import * as hostcontrol from "./hostcontrol";
import { adapterFor } from "./integrations";

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
export interface ReadHistoryInput {
  to?: string;
  // Read a specific thread's transcript instead of the channel's, by its root message id.
  threadRootId?: string;
  // Page older than this seq (from a previous result's oldestSeq); omitted = most recent page.
  beforeSeq?: string;
  limit?: number;
}
export interface ReadHistoryResult {
  ok: boolean;
  error?: string;
  text?: string;
  oldestSeq?: string | null;
}
export type ConfirmDecision = { result: "allow" | "deny"; denyMessage?: string; updatedInput?: unknown };
export interface ScheduleCreateInput {
  prompt?: string;
  cron?: string;
  timezone?: string;
  runAt?: string;
  channel?: string;
}
export interface ScheduleCreateResult {
  ok: boolean;
  error?: string;
  scheduleId?: string;
  nextRunAt?: string;
}
export interface ScheduleListResult {
  ok: boolean;
  error?: string;
  text?: string;
}
export interface ScheduleCancelResult {
  ok: boolean;
  error?: string;
}

export interface RunnerHooks {
  // Post a message the agent asked to send (same routing/cascade as the MA path's onSend).
  // `turnId` is the runner's current turn when the send arrived (null outside a tracked turn) —
  // persisted on the message so the UI can link it back to the work that produced it.
  deliverAgentMessage: (
    agent: { id: string; handle: string; workspace_id: string },
    input: SendMessageInput,
    turnId: string | null,
  ) => Promise<SendMessageResult>;
  // Read a page of channel/thread history the agent asked for (read_history tool).
  readHistory: (
    agent: { id: string; handle: string; workspace_id: string },
    input: ReadHistoryInput,
  ) => Promise<ReadHistoryResult>;
  // The agent manages its own scheduled turns (schedule_create/list/cancel tools). Validation
  // and guardrails live in services/scheduler.ts.
  scheduleCreate: (
    agent: { id: string; handle: string; workspace_id: string },
    input: ScheduleCreateInput,
  ) => Promise<ScheduleCreateResult>;
  scheduleList: (
    agent: { id: string; handle: string; workspace_id: string },
  ) => Promise<ScheduleListResult>;
  scheduleCancel: (
    agent: { id: string; handle: string; workspace_id: string },
    input: { scheduleId?: string },
  ) => Promise<ScheduleCancelResult>;
  // Surface a tool-confirmation to humans and resolve when one decides. `agentId`+`id`
  // let the decision endpoint route the result back to the right runner.
  requestConfirm: (
    agent: db.AgentRow,
    confirm: { id: string; toolName: string; input: unknown; suggestions?: unknown },
  ) => Promise<ConfirmDecision>;
  // A turn began: carries the dispatch context of the inbox batch that fed it (null when the
  // batch had none, e.g. compaction). Broadcast so clients learn the turn's home channel.
  onTurnStarted?: (agentId: string, turnId: string, context: db.DispatchContext | null) => void;
  // A follow-up batch was consumed by a turn ALREADY in progress (a message spliced in rather
  // than queued for its own turn — see runner/src/runner.ts's splice comment). Lets that
  // message's chip anchor to the same running turn instead of showing nothing.
  onTurnMessageJoined?: (agentId: string, turnId: string, context: db.DispatchContext) => void;
  // Persist an SDK stream event and broadcast it to app websockets. `context` is the current
  // turn's dispatch context (rides on every frame so mid-turn page loads still learn the home).
  onAgentEvent: (
    agentId: string,
    turnId: string | null,
    event: unknown,
    context?: db.DispatchContext | null,
  ) => void;
  // The runner reported how full the agent's context window is (once per turn).
  // Persist + broadcast so open profile dialogs live-update.
  onContextUsage: (agentId: string, usage: { tokens: number; maxTokens: number }) => void;
  // The agent's /workspace/MEMORY.md changed (reported after the turn that changed it, and once
  // after configure). Persist the mirror + broadcast so an open profile panel live-updates.
  onMemoryUpdated: (agentId: string, content: string) => void;
  // A turn died (SDK crash, OOM kill, API error). Tell the humans who were waiting —
  // otherwise the agent just goes silent mid-task.
  onTurnFailed: (agent: { id: string; handle: string }, error: string) => void;
  // A turn ended, ok or not — fires for EVERY turn_done (unlike onTurnFailed). Carries the
  // turnId so consumers can attribute the result to the inbox items (and, via their persisted
  // context, the schedules) that fed the turn.
  onTurnFinished?: (agentId: string, turnId: string, ok: boolean, error?: string) => void;
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
  // The current turn's dispatch context (fetched at turn_started from the batch's inbox rows),
  // attached to every event broadcast so clients know the turn's home channel.
  currentTurnContext: db.DispatchContext | null;
  // Per-connection serialization chain: frames run in order (see enqueueFrame).
  frameTail: Promise<void>;
  // The turn this socket most recently reported via `turn_started`. Mid-turn follow-up batches
  // emit `consumed` with no accompanying `turn_started`, so the consumed handler attributes
  // them to this turn.
  currentTurnId: string | null;
  // Timestamp this conn most recently entered "idle" (null while running or never yet idle
  // on this socket). The idle-stop sweeper reads this to decide when to stop the machine.
  idleSince: number | null;
}

// agentId -> the single live runner connection (a new connect replaces the old).
const conns = new Map<string, RunnerConn>();

export function isConnected(agentId: string): boolean {
  return conns.has(agentId);
}

// Re-exported for callers that already depend on runners (orchestrator, routes): whether a
// self-hosted agent's device is currently connected. False for cloud agents. See hostcontrol.
export const isAgentDeviceOnline = hostcontrol.isAgentDeviceOnline;

// --- Agent status (Working / Idle / Sleeping / Waking / Offline) ---

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
  // Self-hosted with its device disconnected: the backend CANNOT wake it (no machine to start) —
  // it's offline, not sleeping. Queued work waits for the device to come back. This predicate is
  // false for cloud agents, so the machine-map logic below is unchanged for them.
  if (hostcontrol.isAgentDeviceOffline(agentId)) return "offline";
  const m = machine.get(agentId);
  if (m?.kind === "starting") return "waking";
  if (m?.kind === "stopped") return "sleeping";
  return "idle"; // no signal either way — the pre-idle-stop (Docker) baseline
}

function emitStatus(agentId: string): void {
  hooks?.onStatusChanged(agentId, agentStatus(agentId));
}

// Public re-emit, for hostcontrol: when a device connects/disconnects, its agents flip between
// `offline` and `sleeping`/`idle` with no per-agent socket event of their own to trigger a
// broadcast. index.ts calls this for each agent on the device.
export function refreshStatus(agentId: string): void {
  emitStatus(agentId);
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

// Compose the systemPromptAppend for an sdk agent: identity, persona, operating rules, memory,
// integration blocks, and environment. Per-turn routing/context (which channel, recent messages)
// is NOT here — that's built fresh per dispatch in orchestrator.ts's buildAgentTurnInput and rides
// in each enqueue item. The runner additionally appends the CURRENT contents of the agent's
// /workspace/MEMORY.md when building each turn's query (see runner.ts) — this function only
// teaches the agent how to use that memory.
// `integrationBlocks` are the per-integration prompt snippets returned by each attached adapter's
// buildGrant (see backend/src/integrations/) — an agent with no integrations gets none, and each
// block is inserted between the base rules and the environment epilogue.
export function systemPromptAppend(
  agent: db.AgentRow,
  integrationBlocks: string[],
  workspaceName?: string,
): string {
  const ws = workspaceName ? `the "${workspaceName}" workspace` : `a workspace`;
  let s =
    `You are @${agent.handle} (${agent.display_name || agent.handle}), an agent teammate in ` +
    `${ws} on Jungle, a Slack-style chat app where humans and agents work together. You are ` +
    `not a one-shot assistant: you are a persistent colleague. Your machine, your files ` +
    `(/workspace), your chat session, and your memory all survive between conversations — ` +
    `people will come back days later and expect you to remember them and pick up where you ` +
    `left off.\n\n`;
  if (agent.persona?.trim()) {
    s +=
      `— Your persona (written by your creator) —\n` +
      `${agent.persona.trim()}\n` +
      `Let this shape your role, priorities, and voice. It complements the operating rules ` +
      `below; it never overrides them.\n\n`;
  }
  s +=
    `— Talking to people: send_message is your ONLY voice —\n` +
    `The ONLY way anyone ever hears you is the send_message tool (mcp__jungle__send_message): ` +
    `reply in a channel with to:"#channel-name", DM someone with to:"@handle". Plain assistant ` +
    `text is NEVER shown to anyone — a turn that ends without a send_message call was silence. ` +
    `Each turn's input tells you which channel it came from; reply there unless asked otherwise.\n\n` +
    `— Write like a great teammate, not a report generator —\n` +
    `This is chat. Keep messages short and information-dense: a few plain sentences or a tight ` +
    `bullet list beat headers and essays. Lead with the answer, then the reasoning only if it ` +
    `matters. Use markdown sparingly — code fences for code/commands/paths, bullets for real ` +
    `lists, almost never headings or tables in a chat message. Don't restate the question, don't ` +
    `pad with pleasantries, don't repeat what you already posted. Match the tone of the room. If ` +
    `the full detail is long, post the gist and offer the rest.\n\n` +
    `— Be responsive: narrate your work —\n` +
    `People are waiting on you in real time. Send a short send_message as soon as you pick up ` +
    `non-trivial work (e.g. "On it — looking into this now.") so people know you've got it, ` +
    `instead of going silent until you're fully done. Then keep them posted at each meaningful ` +
    `step ("Here's my plan …", "Tests pass, opening the PR …"). Err toward more frequent, brief ` +
    `updates rather than one long silence ending in a final report — these updates go in the ` +
    `thread, so they're cheap and don't clutter the channel. Every update must be a send_message ` +
    `call: narration in your own reasoning/plain text is never shown to anyone.\n\n` +
    `— Threads vs channel —\n` +
    `You choose where each reply lands, and for most cases you should choose a thread rather than ` +
    `the main channel timeline — it keeps the channel tidy. When you're addressed in a thread, ` +
    `omitting threadRootId keeps your reply in that thread. When you're addressed by a top-level ` +
    `channel message, that message's id is given to you in the turn input; pass it as threadRootId ` +
    `to reply in a thread under it (do this for progress updates and most replies). Posting a plain ` +
    `message to the whole channel is always available and fully your call: omit threadRootId to ` +
    `post at the top level, or set alsoToChannel:true to post to both a thread and the channel. ` +
    `Reserve channel-level posts for things everyone should see, not routine progress.\n\n` +
    `— Working with other agents —\n` +
    `@mentioning or DMing another agent wakes them up, just like a person being paged. Only do ` +
    `it when you specifically want that agent to wake up and take some action — never as an ` +
    `incidental reference or FYI. Stay focused on what you were specifically assigned: if you see ` +
    `a message addressed to a different agent, don't assume it's your job too — only act on it if ` +
    `the user specifically mentioned or asked you.\n\n` +
    `— Your memory (load-bearing) —\n` +
    `You have a persistent memory directory (the memory system described in your base ` +
    `instructions, at your CLAUDE_CONFIG_DIR's projects/<slug>/memory/): one markdown file per ` +
    `durable fact, indexed by MEMORY.md. Your MEMORY.md index is injected into your context ` +
    `every turn — it is what you "know" at the start of any conversation, and the only knowledge ` +
    `guaranteed to survive session compaction. Writes inside your memory directory never need ` +
    `approval. Use it like a colleague who never forgets:\n` +
    `• The moment you learn something durable, save it: people's preferences and standing ` +
    `feedback ("keep PRs small", "always deploy to preprod first"), project facts and decisions, ` +
    `gotchas you hit once and never want to hit again, key repos/paths/URLs/channel names, who's ` +
    `who. An unwritten fact is a fact you'll forget.\n` +
    `• When an index line looks relevant to the task at hand, Read that memory file before acting.\n` +
    `• Don't store task minutiae or anything you can re-derive from the repo or chat history ` +
    `(read_history exists). Curate: update or delete stale memories instead of piling up ` +
    `duplicates, and keep the index tight — it rides in every prompt.\n` +
    `• Never store secrets, tokens, or credentials. Workspace members can read your memory from ` +
    `your profile.\n\n` +
    `— Files & images —\n` +
    `Files people attach to messages are saved into your workspace under ` +
    `/workspace/attachments/ (each queued message lists the exact paths). To send files or ` +
    `images to people, pass workspace file paths in send_message's \`files\` parameter, e.g. ` +
    `files:["/workspace/repo/screenshot.png"] — images render inline in the chat, other file ` +
    `types become downloads. Max 10 files, 25MB each.\n\n` +
    `— Schedules —\n` +
    `You can schedule future work for yourself with schedule_create: recurring (a 5-field cron ` +
    `expression + IANA timezone) or one-time (runAt, ISO-8601). IMPORTANT: a scheduled turn runs ` +
    `with NO memory of the conversation where it was created — write the prompt as a complete, ` +
    `self-contained instruction for a future you (what to do, where to post results, any repos, ` +
    `links, or channel names it needs). When it fires you'll receive that instruction verbatim; ` +
    `do the work, post results with send_message if there's something worth saying, and finish ` +
    `silently when there isn't. Review with schedule_list, remove with schedule_cancel. Limits: ` +
    `10 schedules per agent, recurring at most every 15 minutes. When someone asks you to ` +
    `"remind me", "check every morning", or "do X weekly", use these tools — never just promise ` +
    `to remember. (Schedules are for future ACTIONS; MEMORY.md is for durable FACTS.)`;
  for (const block of integrationBlocks) s += block;
  s += `\n\n— Your environment —\n`;
  if (agent.runner_provider === "self_hosted") {
    // A user's OWN machine: real privileges, real files, real consequences. Say so plainly — the
    // container caveats above are false here, and understating the stakes would be dangerous.
    const host = (agent.runner_meta as db.RunnerMeta | null)?.host;
    const where = host ? `directly on ${host.hostname} (${host.platform}/${host.arch})` : `directly on a personal computer`;
    s +=
      `You run ${where} — a personal machine belonging to your creator, NOT a disposable cloud ` +
      `sandbox. You have that machine's real user account, real files, and real network access, so ` +
      `your actions can have real and possibly irreversible effects. Be conservative and explicit: ` +
      `prefer reversible steps, explain what you're about to do before anything destructive, and ` +
      `never delete or overwrite files outside your workspace without asking. Treat credentials, ` +
      `keys, and personal data on the machine as strictly off-limits unless the person explicitly ` +
      `directs you to use them for the task at hand. Dev servers and other long-running processes ` +
      `MUST use the Bash tool's run_in_background option — plain \`&\` background jobs are killed ` +
      `when the Bash call returns.`;
  } else {
    s +=
      `You run in a Linux container: no sudo/apt, ~3GB memory (don't run several heavy ` +
      `processes at once), Chromium preinstalled for Playwright (PLAYWRIGHT_BROWSERS_PATH is set). ` +
      `Dev servers and other long-running processes MUST use the Bash tool's run_in_background ` +
      `option — plain \`&\` background jobs are killed when the Bash call returns.`;
  }
  // Non-Anthropic models don't have Claude's native memory convention trained in, so spell the
  // mechanic out explicitly (the section above assumes the "base instructions" memory system).
  if (catalogEntry(agent.model)?.provider !== "anthropic" && agent.model) {
    s +=
      `\n\n— How your memory works (mechanics) —\n` +
      `Your memory lives as markdown files under $CLAUDE_CONFIG_DIR/projects/<slug>/memory/, ` +
      `indexed by a MEMORY.md file in that directory. To remember a durable fact: write (or edit) ` +
      `a short markdown file there and add a one-line entry for it to MEMORY.md. To recall: read ` +
      `MEMORY.md (its contents are injected each turn) and Read any file whose entry looks ` +
      `relevant before acting. Nothing you keep only in your reply survives to the next ` +
      `conversation — if a fact should outlast this turn, write it to a memory file now.`;
  }
  return s;
}

// Build the `configure` reply to a runner's `hello`: model, permission mode, persona, and each
// attached integration's grant (git installation token, Gmail access token, …). Every per-service
// concern lives in that integration's adapter (backend/src/integrations/); here we just loop over
// the agent's attached integrations and let each adapter mint tokens, set the frame fields the
// runner reads, and return its system-prompt block.
async function buildConfigure(agent: db.AgentRow): Promise<ConfigureFrame> {
  const frame: ConfigureFrame = {
    type: "configure",
    model: agent.model ?? null,
    permissionMode: toPermissionMode(agent.mode),
    effort: agent.effort,
    // Non-Anthropic model? Resolve its endpoint + key so the runner routes there. null for
    // Anthropic/default models (runner keeps its container ANTHROPIC_API_KEY). If a routed
    // provider's key is missing this returns null and logs — the turn then fails loudly against
    // Anthropic rather than silently misrouting.
    provider: resolveProvider(agent.model ?? null),
    systemPromptAppend: "",
  };
  const blocks: string[] = [];
  for (const row of await db.listAgentIntegrations(agent.id)) {
    const adapter = adapterFor(row.integration_key);
    if (!adapter) continue;
    const block = await adapter.buildGrant(frame, agent, row.config);
    if (block) blocks.push(block);
  }
  const workspace = await db.getWorkspace(agent.workspace_id);
  frame.systemPromptAppend = systemPromptAppend(agent, blocks, workspace?.name);
  return frame;
}

// --- Credential refresh ---

// Re-mint every attached integration's short-lived token and push a credentials frame to the
// runner. OAuth/installation tokens hard-expire (GitHub App tokens at ~1h, Google access tokens
// at ~1h); a runner that stays connected longer would otherwise keep using the stale token it was
// handed once in `configure`. Adapters cache until near expiry, so this is ~free until a refresh
// is actually needed. Called before each drain so every turn starts with valid credentials — no
// timers, no background state. No-op for agents whose integrations don't expire mid-session.
async function refreshCredentials(conn: RunnerConn, agent: db.AgentRow): Promise<void> {
  for (const row of await db.listAgentIntegrations(agent.id)) {
    const adapter = adapterFor(row.integration_key);
    if (!adapter?.refreshCredentials) continue;
    try {
      await adapter.refreshCredentials(agent, row.config, (frame) => send(conn, frame));
    } catch (e) {
      console.error(`runner[${agent.id}] refreshCredentials(${row.integration_key}):`, e);
    }
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
  // Push fresh integration credentials before the work so a long-lived runner never begins a turn
  // with an expired token. Ordered before `enqueue` so the runner applies them before the turn
  // (and any git/gmail/… ops in it) starts.
  const agent = await db.getAgentRow(agentId);
  if (agent) await refreshCredentials(conn, agent);
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
      const selfHosted = agent.runner_provider === "self_hosted";
      try {
        if (conn) {
          // Self-hosted: keep the runner child alive while the device is online (no idle-stop) —
          // it's cheap when idle on the user's own machine, and killing/respawning it would add
          // session-resume latency to every message. The child stops when the device disconnects.
          if (selfHosted) continue;
          if (IDLE_STOP_MS === 0) continue;
          if (conn.state !== "idle" || conn.idleSince == null) continue;
          if (Date.now() - conn.idleSince < IDLE_STOP_MS) continue;
          if ((await db.pendingInbox(agent.id)).length > 0) continue;
          await provisionerFor(agent).stop(agent.id);
          noteProvisionerStop(agent.id);
        } else {
          // Self-hosted with an offline device: we can't wake it — skip (the work stays queued and
          // drains when the daemon reconnects). Only start when the device is actually online.
          if (selfHosted && !hostcontrol.isAgentDeviceOnline(agent.id)) continue;
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

// Run one sweep pass immediately (out of band from the 15s timer). Used when a self-hosted device
// just came online, so any agent that queued work while it was offline starts without waiting for
// the next tick.
export function kickSweep(): void {
  void sweepOnce();
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
  // Carry the new model's provider routing so the runner swaps model + credentials together at
  // its next turn boundary (see runner handleSetModel). null for Anthropic/default models.
  if (conn) send(conn, { type: "set_model", model, provider: resolveProvider(model) });
}
export function setEffort(agentId: string, effort: string): void {
  const conn = conns.get(agentId);
  if (conn) send(conn, { type: "set_effort", effort });
}

// Rebuild + push a fresh `configure` to a connected runner. Persona/display-name edits live in
// the systemPromptAppend, which the runner otherwise only receives at `hello` — this makes such
// an edit apply at the agent's next turn instead of waiting for a reconnect. No-op when offline
// (the next hello builds configure from the fresh row anyway).
export async function reconfigure(agentId: string): Promise<void> {
  const conn = conns.get(agentId);
  if (!conn) return;
  const agent = await db.getAgentRow(agentId);
  if (!agent) return;
  send(conn, await buildConfigure(agent));
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
  // Self-hosted with an offline device: nothing to wake — report failure so the UI can say the
  // device is offline rather than spinning on "waking" forever.
  if (agent.runner_provider === "self_hosted" && !hostcontrol.isAgentDeviceOnline(agent.id)) {
    return "wake_failed";
  }
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
    if (conn) enqueueFrame(conn, raw.toString());
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
    currentTurnId: null,
    currentTurnContext: null,
    frameTail: Promise.resolve(),
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

  // Replay any frames (notably `hello`) that arrived during the token lookup, in order.
  for (const raw of early) enqueueFrame(conn, raw);
}

// Serialize frame handling per connection: each frame runs only after the previous one settles,
// so ordering-sensitive state (a turn's currentTurnContext, set by an async turn_started, is read
// by the events that follow) is never overtaken by a later frame. A thrown handler doesn't stall
// the queue.
function enqueueFrame(conn: RunnerConn, raw: string): void {
  conn.frameTail = conn.frameTail.then(() => handleFrame(conn, raw)).catch((e) =>
    console.error(`runner[${conn.agentId}] frame handler:`, e),
  );
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
        conn.currentTurnId = null;
        conn.currentTurnContext = null;
        clearMachine(agentId); // a live hello always wins over stale starting/stopped state
        // Self-hosted: persist the host details the runner reports so the "your environment"
        // prompt block and the profile's Environment card reflect the real machine. Merge (don't
        // clobber) so the hostId set at assignment survives.
        if (agent.runner_provider === "self_hosted" && frame.host) {
          const meta = (agent.runner_meta as db.RunnerMeta | null) ?? {};
          const merged: db.RunnerMeta = { ...meta, host: frame.host };
          await db.setRunnerMeta(agentId, merged);
          agent.runner_meta = merged as Record<string, unknown>; // reflect in the configure we build below
        }
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
        // The runner is consuming these inbox items in turn `frame.turnId`. Record the turn on
        // the rows (turn-result attribution) and on the conn (mid-turn follow-up batches emit
        // `consumed` with no turn_started). Durable delivery is still confirmed by `consumed`.
        conn.currentTurnId = frame.turnId;
        const inboxIds = Array.isArray(frame.inboxIds) ? frame.inboxIds : [];
        await db.markInboxTurnStarted(agentId, inboxIds, frame.turnId);
        // Resolve the batch's dispatch context: it names the turn's HOME (trigger channel/
        // thread/message), which clients use to show work where it was requested.
        conn.currentTurnContext = await db.contextForInboxIds(agentId, inboxIds);
        hooks?.onTurnStarted?.(agentId, frame.turnId, conn.currentTurnContext);
        break;
      }
      case "consumed": {
        const ids: string[] = Array.isArray(frame.inboxIds) ? frame.inboxIds : [];
        // `consumed` carries no turnId of its own; attribute to the socket's current turn
        // (markInboxConsumed coalesces, so rows already stamped by turn_started keep theirs).
        await db.markInboxConsumed(agentId, ids, conn.currentTurnId);
        // Anchor this batch's dispatch context to the current turn too. Covers both the very
        // first batch (already anchored by turn_started — a no-op here) and a later batch
        // spliced into a turn already in progress: a genuinely new anchor, so that message gets
        // its own chip pointing at the SAME running turn instead of showing nothing.
        if (conn.currentTurnId) {
          const ctx = await db.contextForInboxIds(agentId, ids);
          if (ctx) hooks?.onTurnMessageJoined?.(agentId, conn.currentTurnId, ctx);
        }
        break;
      }
      case "event": {
        // Attach the current turn's context only when the frame belongs to that turn.
        const ctx = frame.turnId && frame.turnId === conn.currentTurnId ? conn.currentTurnContext : null;
        hooks?.onAgentEvent(agentId, frame.turnId ?? null, frame.event, ctx);
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
      case "memory": {
        // The MEMORY.md mirror. Bound it defensively (the runner already caps what it injects
        // into the prompt; this guards the DB against a runaway file).
        const content = String(frame.content ?? "").slice(0, 65_536);
        hooks?.onMemoryUpdated(agentId, content);
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
              { id: agent.id, handle: agent.handle, workspace_id: agent.workspace_id },
              (frame.input ?? {}) as SendMessageInput,
              conn.currentTurnId,
            );
          } catch (e) {
            result = { ok: false, error: String((e as Error).message ?? e) };
          }
        }
        send(conn, { type: "send_message_result", id: frame.id, result });
        break;
      }
      case "read_history": {
        const agent = await db.getAgentRow(agentId);
        let result: ReadHistoryResult;
        if (!hooks || !agent) {
          result = { ok: false, error: "backend not ready" };
        } else {
          try {
            result = await hooks.readHistory(
              { id: agent.id, handle: agent.handle, workspace_id: agent.workspace_id },
              (frame.input ?? {}) as ReadHistoryInput,
            );
          } catch (e) {
            result = { ok: false, error: String((e as Error).message ?? e) };
          }
        }
        send(conn, { type: "read_history_result", id: frame.id, result });
        break;
      }
      case "schedule_create": {
        const agent = await db.getAgentRow(agentId);
        let result: ScheduleCreateResult;
        if (!hooks || !agent) {
          result = { ok: false, error: "backend not ready" };
        } else {
          try {
            result = await hooks.scheduleCreate(
              { id: agent.id, handle: agent.handle, workspace_id: agent.workspace_id },
              (frame.input ?? {}) as ScheduleCreateInput,
            );
          } catch (e) {
            result = { ok: false, error: String((e as Error).message ?? e) };
          }
        }
        send(conn, { type: "schedule_create_result", id: frame.id, result });
        break;
      }
      case "schedule_list": {
        const agent = await db.getAgentRow(agentId);
        let result: ScheduleListResult;
        if (!hooks || !agent) {
          result = { ok: false, error: "backend not ready" };
        } else {
          try {
            result = await hooks.scheduleList({
              id: agent.id,
              handle: agent.handle,
              workspace_id: agent.workspace_id,
            });
          } catch (e) {
            result = { ok: false, error: String((e as Error).message ?? e) };
          }
        }
        send(conn, { type: "schedule_list_result", id: frame.id, result });
        break;
      }
      case "schedule_cancel": {
        const agent = await db.getAgentRow(agentId);
        let result: ScheduleCancelResult;
        if (!hooks || !agent) {
          result = { ok: false, error: "backend not ready" };
        } else {
          try {
            result = await hooks.scheduleCancel(
              { id: agent.id, handle: agent.handle, workspace_id: agent.workspace_id },
              (frame.input ?? {}) as { scheduleId?: string },
            );
          } catch (e) {
            result = { ok: false, error: String((e as Error).message ?? e) };
          }
        }
        send(conn, { type: "schedule_cancel_result", id: frame.id, result });
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
        hooks?.onTurnFinished?.(agentId, frame.turnId, !!frame.ok,
          frame.ok ? undefined : String(frame.error ?? "unknown error"));
        // A turn finished; more work may have queued while it ran.
        await drain(agentId);
        break;
      }
      case "fatal": {
        console.error(`runner[${agentId}] FATAL:`, frame.error);
        const agent = await db.getAgentRow(agentId);
        if (agent && hooks) hooks.onTurnFailed({ id: agent.id, handle: agent.handle }, `fatal: ${frame.error}`);
        if (!agent) break;
        // Self-hosted: the device's own daemon supervises its runner children (it restarts a
        // crashed child with backoff). Don't also drive a provisioner restart from here — we don't
        // own that machine, and stop/start would just race the daemon's own recovery.
        if (agent.runner_provider === "self_hosted") break;
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
