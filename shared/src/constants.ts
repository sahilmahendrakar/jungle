// Shared validation constants, single source of truth for the backend (and frontend UI).

import type { PermissionMode } from "./runner-protocol.js";

// Agent handles: 2–30 chars, lowercase/digits/_/-, no leading symbol.
export const HANDLE_RE = /^[a-z0-9][a-z0-9_-]{1,29}$/;

// Model ids selectable for an agent. Membership list for validation; the catalog below carries
// the per-model metadata. Kept as a `const` tuple so `AllowedModel` stays a literal union.
export const ALLOWED_MODELS = [
  "claude-haiku-4-5-20251001",
  "claude-sonnet-5",
  "claude-opus-4-8",
  "glm-5.2",
  "kimi-k3",
  "kimi-k2.7-code",
] as const;
export type AllowedModel = (typeof ALLOWED_MODELS)[number];

// Which provider actually serves a model. "anthropic" = first-party (the runner container's
// ANTHROPIC_API_KEY); every other provider is an Anthropic-compatible endpoint the runner routes
// to by overriding ANTHROPIC_BASE_URL/ANTHROPIC_AUTH_TOKEN in the CLI child env. Add a new tier-1
// (Anthropic-compatible) model with one MODEL_CATALOG row + one PROVIDER_ENV entry (backend).
export type ModelProvider = "anthropic" | "zai" | "moonshot";

export interface ModelCatalogEntry {
  id: AllowedModel;
  label: string; // UI label, e.g. "GLM 5.2"
  hint: string; // UI hint under the label
  provider: ModelProvider;
  supportsEffort: boolean; // false => runner omits the Agent SDK `effort` option, UI disables it
  contextWindow: number; // runner fallback when the SDK doesn't report a context window
}

// Single source of truth for the model picker (backend validation + frontend UI derive from this).
// Order defines the picker order; the first entry is the default for new agents.
export const MODEL_CATALOG: readonly ModelCatalogEntry[] = [
  { id: "claude-opus-4-8", label: "Opus 4.8", hint: "Most capable", provider: "anthropic", supportsEffort: true, contextWindow: 200_000 },
  { id: "claude-sonnet-5", label: "Sonnet 5", hint: "Balanced", provider: "anthropic", supportsEffort: true, contextWindow: 200_000 },
  { id: "claude-haiku-4-5-20251001", label: "Haiku 4.5", hint: "Fastest", provider: "anthropic", supportsEffort: false, contextWindow: 200_000 },
  { id: "glm-5.2", label: "GLM 5.2", hint: "Open source · fast & cheap", provider: "zai", supportsEffort: false, contextWindow: 200_000 },
  { id: "kimi-k3", label: "Kimi K3", hint: "Open source · 1M context", provider: "moonshot", supportsEffort: true, contextWindow: 1_048_576 },
  { id: "kimi-k2.7-code", label: "Kimi K2.7 Code", hint: "Open source · 256K context", provider: "moonshot", supportsEffort: true, contextWindow: 262_144 },
];

// Catalog lookup by model id. Accepts null/undefined (agent's model override may be unset) so
// callers can pass `agent.model` directly.
export function catalogEntry(model: string | null | undefined): ModelCatalogEntry | undefined {
  return model ? MODEL_CATALOG.find((m) => m.id === model) : undefined;
}

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

// Creator-written agent persona (role/personality), injected verbatim into the agent's system
// prompt — bounded because it rides in every turn's system prompt.
export const PERSONA_MAX_LENGTH = 4000;

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
