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
  | ConfirmRequestFrame
  | TurnDoneFrame
  | ContextUsageFrame
  | FatalFrame;

// ---- Backend -> runner ----

export interface ConfigureFrame {
  type: "configure";
  model: string | null; // null = let the runner use the SDK/agent-config default model
  permissionMode: PermissionMode;
  effort?: string; // reasoning effort (low|medium|high|xhigh); omitted = SDK/CLI default
  systemPromptAppend?: string;
  git?: { token: string; login: string; repoUrl?: string };
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
  | ConfirmResultFrame
  | GitCredentialsFrame;
