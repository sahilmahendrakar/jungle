// Jungle agent-runner protocol (v1). See docs/runner-protocol.md — authoritative.
// Frames are JSON text messages over one outbound WebSocket.
//
// This module is the SOURCE OF TRUTH for the runner wire contract. The backend imports these
// types from `@jungle/shared`. The runner is a standalone (non-workspace) package that cannot
// import from here at runtime, so `runner/src/protocol.ts` is GENERATED as a verbatim copy by
// `runner/scripts/sync-protocol.mjs` (runs as the runner's `prebuild`). Edit this file only.

export const PROTOCOL_VERSION = 1;

export type PermissionMode =
  | "default"
  | "acceptEdits"
  | "plan"
  | "bypassPermissions"
  | "dontAsk";

// ---- Runner -> backend ----

export interface HelloFrame {
  type: "hello";
  agentId: string;
  sessionId: string | null;
  protocol: 1;
  // Where this runner is executing. Reported by self-hosted runners so the backend can surface
  // the host in the UI and tailor the "your environment" system-prompt block; omitted by cloud
  // (docker/fly) runners. Optional → no protocol version bump; old runners simply don't send it.
  host?: { hostname: string; platform: string; arch: string; runnerVersion: string };
}

export interface StateFrame {
  type: "state";
  state: "idle" | "running";
  sessionId: string | null;
  model: string | null;
  permissionMode: PermissionMode;
}

export interface TurnStartedFrame {
  type: "turn_started";
  turnId: string;
  inboxIds: string[];
}

export interface ConsumedFrame {
  type: "consumed";
  inboxIds: string[];
}

export interface EventFrame {
  type: "event";
  turnId: string;
  event: unknown; // an SDK stream message, verbatim
}

export interface SendMessageFrame {
  type: "send_message";
  id: string;
  // attachmentIds reference uploads the runner already made via POST /api/attachments
  // (authenticated with its runner token). threadRootId replies into a thread (omitted →
  // the backend defaults to the thread the agent was triggered in); alsoToChannel echoes a
  // thread reply into the main channel timeline.
  input: {
    to: string;
    body: string;
    attachmentIds?: string[];
    threadRootId?: string | null;
    alsoToChannel?: boolean;
  };
}

// Read-only counterpart to SendMessageFrame: fetch a page of channel/thread transcript older
// than `beforeSeq` (same #channel / @handle addressing as send_message), for the read_history
// tool. `beforeSeq` omitted -> the most recent page.
export interface ReadHistoryFrame {
  type: "read_history";
  id: string;
  input: {
    to: string;
    threadRootId?: string;
    beforeSeq?: string;
    limit?: number;
  };
}

// Schedule tools (schedule_create / schedule_list / schedule_cancel): the agent manages its own
// standing scheduled turns. Same request/result correlation as read_history — a runner-chosen
// `id`. All validation (cron/timezone/caps) happens backend-side; the tool passes raw strings.
export interface ScheduleCreateFrame {
  type: "schedule_create";
  id: string;
  // Exactly one cadence: cron+timezone (recurring) or runAt (one-shot). `channel` ("#name")
  // sets the schedule's context channel; omitted -> the channel this turn was dispatched from.
  input: {
    prompt: string;
    cron?: string;
    timezone?: string;
    runAt?: string;
    channel?: string;
  };
}

export interface ScheduleListFrame {
  type: "schedule_list";
  id: string;
  input: Record<string, never>;
}

export interface ScheduleCancelFrame {
  type: "schedule_cancel";
  id: string;
  input: { scheduleId: string };
}

export interface ConfirmRequestFrame {
  type: "confirm_request";
  id: string;
  toolName: string;
  input: Record<string, unknown>;
  suggestions?: unknown;
}

export interface TurnDoneFrame {
  type: "turn_done";
  turnId: string;
  ok: boolean;
  error?: string;
}

// Context-window occupancy after a turn: how full the session's context is.
// `tokens`/`maxTokens` come from the SDK's getContextUsage() when available,
// else a fallback computed from the result message's usage. Sent once per turn.
export interface ContextUsageFrame {
  type: "context_usage";
  tokens: number;
  maxTokens: number;
  // 0–100, rounded; convenience so the backend/UI don't recompute.
  percent: number;
}

// The agent's curated long-term memory changed. `content` is a rendered mirror of the agent's
// memory: its MEMORY.md index followed by each memory file (the native Claude Code memory
// directory on the workspace volume; "" = no memory yet). Sent after any turn that changed it
// (hash-compared) and once after `configure` to heal backend drift. The backend persists it on
// the participant row so the profile panel can show what the agent knows even while it sleeps.
export interface MemoryFrame {
  type: "memory";
  content: string;
}

// A long-lived process the RUNNER manages on the agent's machine (the service_* agent tools):
// dev servers, file watchers, tunnels. Owned by the always-on runner process — NOT the per-turn
// CLI subprocess — so it survives turn boundaries (a Bash run_in_background task dies when the
// turn's CLI exits, and its orphaned record breaks the next session's MCP mount; services exist
// to make that pattern unnecessary). Registry + logs live in the runner's state dir.
export interface AgentServiceInfo {
  name: string; // unique per agent, kebab-case
  command: string; // the shell command line the service runs
  cwd?: string; // working directory (defaults to the agent workspace)
  status: "running" | "exited";
  pid?: number; // process-group leader while running
  startedAt: string; // ISO
  exitedAt?: string; // ISO, exited only
  exitCode?: number | null; // exited only; null = killed by signal
}

// Runner -> backend: the full service list, sent after configure and on every change
// (start/stop/exit). Snapshot semantics — the backend replaces, never merges.
export interface ServicesFrame {
  type: "services";
  services: AgentServiceInfo[];
}

export interface FatalFrame {
  type: "fatal";
  error: string;
}

export type RunnerToBackend =
  | HelloFrame
  | StateFrame
  | TurnStartedFrame
  | ConsumedFrame
  | EventFrame
  | SendMessageFrame
  | ReadHistoryFrame
  | ScheduleCreateFrame
  | ScheduleListFrame
  | ScheduleCancelFrame
  | ConfirmRequestFrame
  | TurnDoneFrame
  | ContextUsageFrame
  | MemoryFrame
  | ServicesFrame
  | FatalFrame;

// ---- Backend -> runner ----

// A remote MCP integration the agent is connected to (Linear, Notion, Granola, …). The runner
// mounts each as a remote MCP server — `{ type: "http", url, headers: { Authorization: Bearer
// <accessToken> } }` — so its tools appear as mcp__<key>__<tool>. `safeTools` are the read-only
// tools auto-approved without a confirmation card; when `requireApproval` is false ALL of the
// server's tools are auto-approved, otherwise non-safe tools route through the confirmation card
// (see runner.ts). The access token is short-lived and refreshed mid-session via
// IntegrationCredentialsFrame (keyed by `key`).
export interface McpIntegrationGrant {
  key: string;
  url: string;
  accessToken: string;
  safeTools: string[];
  requireApproval: boolean;
}

// Routing + credentials for a non-Anthropic model served by an Anthropic-compatible endpoint
// (e.g. GLM 5.2 via z.ai). The backend resolves this from the agent's model; the runner applies
// it by setting ANTHROPIC_BASE_URL/ANTHROPIC_AUTH_TOKEN (and removing ANTHROPIC_API_KEY) in the
// CLI child env for that turn. Absent/null on a frame => first-party Anthropic (container key).
// `authToken` is a secret — never log it (log `name` instead).
export interface ProviderConfig {
  name: string; // provider id, e.g. "zai" (logging/telemetry only)
  baseUrl: string; // e.g. "https://api.z.ai/api/anthropic"
  authToken: string; // operator-owned provider API key
  supportsEffort: boolean; // false => runner omits the SDK `effort` option for this model
  contextWindow: number; // fallback context window when the SDK doesn't report one
}

export interface ConfigureFrame {
  type: "configure";
  model: string | null; // null = let the runner use the SDK/agent-config default model
  permissionMode: PermissionMode;
  effort?: string; // reasoning effort (low|medium|high|xhigh); omitted = SDK/CLI default
  // Non-Anthropic provider routing for `model`, if any (see ProviderConfig). Absent/null = the
  // model is served by first-party Anthropic using the runner container's ANTHROPIC_API_KEY.
  provider?: ProviderConfig | null;
  systemPromptAppend?: string;
  git?: { token: string; login: string; repoUrl?: string };
  // The agent's attached Gmail integration, if any: a fresh OAuth access token for the
  // backing ("creator") mailbox, that account's address, and whether writes need a human.
  // Read/search Gmail tools run freely; send/modify go through the confirmation card when
  // requireSendApproval is set (see runner.ts). Refreshed mid-session via GmailCredentialsFrame.
  gmail?: { accessToken: string; email: string; requireSendApproval: boolean };
  // The agent's attached Google Drive integration, if any: a fresh OAuth access token for the
  // connected account, its address, and whether writes need approval. Like Gmail, this is an
  // in-process MCP server (drive_* tools); the token is refreshed via IntegrationCredentialsFrame
  // keyed "google-drive".
  drive?: { accessToken: string; email: string; requireApproval: boolean };
  // The agent's attached remote-MCP integrations (Linear/Notion/Granola/…), if any. Each is
  // mounted as a remote MCP server; tokens refreshed via IntegrationCredentialsFrame.
  mcpIntegrations?: McpIntegrationGrant[];
  // The agent's attached X (Twitter) integration, if any: a fresh OAuth 2.0 User Context access
  // token for the connected account and its @handle. Read-only in-process MCP server (x_* tools);
  // the token is refreshed mid-session via IntegrationCredentialsFrame keyed "x".
  x?: { accessToken: string; account: string };
}

// A file attached to the message that produced an inbox item. `url` is an origin-relative
// signed path (/api/attachments/…?e=…&sig=…); the runner prefixes the backend origin it
// already dials for its WebSocket.
export interface EnqueueAttachment {
  url: string;
  filename: string;
  mime: string;
  sizeBytes?: number;
}

export interface EnqueueFrame {
  type: "enqueue";
  items: Array<{ inboxId: string; text: string; attachments?: EnqueueAttachment[] }>;
}

export interface InterruptFrame {
  type: "interrupt";
}

// Ask the agent to compact/summarize its session context (the `/compact`
// slash command). Runs as its own turn when the agent next goes idle.
export interface CompactFrame {
  type: "compact";
}

// Ask the agent to clear its conversation/context window (Claude Code's `/clear`).
// Applied at the next idle boundary: the runner drops its current session so the
// next turn starts with an empty context. Memory files are separate (a different
// dir, re-injected via the system prompt each turn) so they're preserved. A pending
// compact is superseded — no point summarizing a context that's about to be dropped.
export interface ClearFrame {
  type: "clear";
}

export interface SetPermissionModeFrame {
  type: "set_permission_mode";
  mode: PermissionMode;
}

export interface SetModelFrame {
  type: "set_model";
  model: string;
  // Provider routing for the new model (see ProviderConfig). Carried alongside `model` so the
  // model swap and its credentials apply atomically at the runner's next turn boundary. Absent/
  // null => the new model is first-party Anthropic.
  provider?: ProviderConfig | null;
}

export interface SetEffortFrame {
  type: "set_effort";
  effort: string; // low|medium|high|xhigh; applies at the agent's next turn
}

export interface SendMessageResultFrame {
  type: "send_message_result";
  id: string;
  result: { ok: boolean; error?: string; messageId?: string };
}

export interface ReadHistoryResultFrame {
  type: "read_history_result";
  id: string;
  result: { ok: boolean; error?: string; text?: string; oldestSeq?: string | null };
}

export interface ScheduleCreateResultFrame {
  type: "schedule_create_result";
  id: string;
  result: { ok: boolean; error?: string; scheduleId?: string; nextRunAt?: string };
}

export interface ScheduleListResultFrame {
  type: "schedule_list_result";
  id: string;
  // text = a preformatted listing (id, cadence, next run, last result, prompt), like
  // read_history's transcript text.
  result: { ok: boolean; error?: string; text?: string };
}

export interface ScheduleCancelResultFrame {
  type: "schedule_cancel_result";
  id: string;
  result: { ok: boolean; error?: string };
}

export interface ConfirmResultFrame {
  type: "confirm_result";
  id: string;
  result: "allow" | "deny";
  denyMessage?: string;
  updatedInput?: Record<string, unknown>;
}

export interface GitCredentialsFrame {
  type: "git_credentials";
  token: string;
  login: string;
}

// Mid-session refresh of the Gmail OAuth access token (Google access tokens last ~1h). Pushed
// before each drain like GitCredentialsFrame, so a long-lived runner never begins a turn with an
// expired token. No-op for agents without a Gmail integration attached.
export interface GmailCredentialsFrame {
  type: "gmail_credentials";
  accessToken: string;
}

// Mid-session refresh of a remote-MCP integration's OAuth access token, keyed by integration key
// (linear/notion/granola/…). Same role as GmailCredentialsFrame for the mcpIntegrations grants:
// pushed before each drain so a long-lived runner re-mounts its MCP servers with a fresh token.
export interface IntegrationCredentialsFrame {
  type: "integration_credentials";
  key: string;
  accessToken: string;
}

// Backend -> runner: stop one of the agent's managed services by name (the profile panel's
// stop button). The runner kills the service's process group and reports the new list via a
// ServicesFrame. Unknown names are a no-op (the frame is advisory, not correlated).
export interface ServiceStopFrame {
  type: "service_stop";
  name: string;
}

export type BackendToRunner =
  | ConfigureFrame
  | EnqueueFrame
  | InterruptFrame
  | CompactFrame
  | ClearFrame
  | SetPermissionModeFrame
  | SetModelFrame
  | SetEffortFrame
  | SendMessageResultFrame
  | ReadHistoryResultFrame
  | ScheduleCreateResultFrame
  | ScheduleListResultFrame
  | ScheduleCancelResultFrame
  | ConfirmResultFrame
  | GitCredentialsFrame
  | GmailCredentialsFrame
  | IntegrationCredentialsFrame
  | ServiceStopFrame;
