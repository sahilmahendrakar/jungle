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

// Reasoning-effort levels an agent may run at (maps to the Agent SDK `effort` option, which
// guides thinking depth and how many tool-call iterations a turn takes). Lower effort = fewer
// thinking tokens and fewer round-trips = less context re-read = cheaper. `medium` is the default
// for new/existing agents; bump repo/coding agents to `high`/`xhigh`. Models without effort
// support (e.g. Haiku 4.5) silently ignore it — the CLI downgrades for the selected model.
export const EFFORT_LEVELS = ["low", "medium", "high", "xhigh"] as const;
export type EffortLevel = (typeof EFFORT_LEVELS)[number];
export const DEFAULT_EFFORT: EffortLevel = "medium";

export function isAllowedEffort(effort: string): effort is EffortLevel {
  return (EFFORT_LEVELS as readonly string[]).includes(effort);
}

export function isSdkMode(mode: string): mode is PermissionMode {
  return (SDK_MODES as readonly string[]).includes(mode);
}

// --- Schedules (scheduled agent turns) ---

// Live schedules per agent ("live" = could still fire: pending or paused; completed one-shots
// don't count). A standing-spend cap, enforced backend-side on both the tool and HTTP paths.
export const MAX_SCHEDULES_PER_AGENT = 10;
// Tightest recurring cadence allowed. Validated by sampling the next few fires of the cron
// expression and requiring every consecutive gap to be at least this.
export const MIN_SCHEDULE_INTERVAL_MINUTES = 15;
// A schedule whose turns fail this many times in a row is auto-paused (with a channel notice)
// so a crash-looping schedule can't silently burn tokens forever.
export const SCHEDULE_MAX_CONSECUTIVE_FAILURES = 3;
// The standing instruction must be self-contained but bounded (it's inlined into turn prompts).
export const SCHEDULE_PROMPT_MAX_LENGTH = 4000;
