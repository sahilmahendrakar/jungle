// GENERATED FILE — do not edit. Source of truth: shared/src/runner-protocol.ts
// Regenerate with `npm run build` (runs scripts/sync-protocol.mjs) in the runner package.

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

export interface ConfigureFrame {
  type: "configure";
  model: string | null; // null = let the runner use the SDK/agent-config default model
  permissionMode: PermissionMode;
  effort?: string; // reasoning effort (low|medium|high|xhigh); omitted = SDK/CLI default
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

export interface SetPermissionModeFrame {
  type: "set_permission_mode";
  mode: PermissionMode;
}

export interface SetModelFrame {
  type: "set_model";
  model: string;
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

export type BackendToRunner =
  | ConfigureFrame
  | EnqueueFrame
  | InterruptFrame
  | CompactFrame
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
  | IntegrationCredentialsFrame;
