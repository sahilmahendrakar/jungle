// Jungle agent-runner protocol (v1). See docs/runner-protocol.md — authoritative.
// Frames are JSON text messages over one outbound WebSocket.

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
  input: { to: string; body: string };
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
  | ConfirmRequestFrame
  | TurnDoneFrame
  | FatalFrame;

// ---- Backend -> runner ----

export interface ConfigureFrame {
  type: "configure";
  model: string;
  permissionMode: PermissionMode;
  systemPromptAppend?: string;
  git?: { token: string; login: string; repoUrl?: string };
}

export interface EnqueueFrame {
  type: "enqueue";
  items: Array<{ inboxId: string; text: string }>;
}

export interface InterruptFrame {
  type: "interrupt";
}

export interface SetPermissionModeFrame {
  type: "set_permission_mode";
  mode: PermissionMode;
}

export interface SetModelFrame {
  type: "set_model";
  model: string;
}

export interface SendMessageResultFrame {
  type: "send_message_result";
  id: string;
  result: { ok: boolean; error?: string; messageId?: string };
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
  | SetPermissionModeFrame
  | SetModelFrame
  | SendMessageResultFrame
  | ConfirmResultFrame
  | GitCredentialsFrame;
