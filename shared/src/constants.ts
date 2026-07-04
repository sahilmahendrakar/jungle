// Shared validation constants, single source of truth for the backend (and frontend UI).

import type { PermissionMode } from "./runner-protocol.js";

// Agent handles: 2–30 chars, lowercase/digits/_/-, no leading symbol.
export const HANDLE_RE = /^[a-z0-9][a-z0-9_-]{1,29}$/;

// Anthropic model ids selectable for an agent.
export const ALLOWED_MODELS = [
  "claude-haiku-4-5-20251001",
  "claude-sonnet-5",
  "claude-opus-4-8",
] as const;
export type AllowedModel = (typeof ALLOWED_MODELS)[number];

// SDK permission modes an agent may be configured with (mirrors the protocol's PermissionMode).
export const SDK_MODES = [
  "default",
  "acceptEdits",
  "plan",
  "bypassPermissions",
  "dontAsk",
] as const;

export function isAllowedModel(model: string): model is AllowedModel {
  return (ALLOWED_MODELS as readonly string[]).includes(model);
}

export function isSdkMode(mode: string): mode is PermissionMode {
  return (SDK_MODES as readonly string[]).includes(mode);
}
