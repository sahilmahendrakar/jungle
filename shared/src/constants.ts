// Shared validation constants, single source of truth for the backend (and frontend UI).

import type { PermissionMode } from "./runner-protocol.js";

// Agent handles: 2–30 chars, lowercase/digits/_/-, no leading symbol.
export const HANDLE_RE = /^[a-z0-9][a-z0-9_-]{1,29}$/;

// Where a user is told to write when they hit a platform limit they can't lift themselves (today:
// the daily spend cap — see spend.ts). One constant so the address in a capped agent's channel
// notice and the one in the UI can't drift apart.
export const SUPPORT_EMAIL = "sahil.mahendrakar@gmail.com";

// Model ids selectable for an agent. Membership list for validation; the catalog below carries
// the per-model metadata. Kept as a `const` tuple so `AllowedModel` stays a literal union.
export const ALLOWED_MODELS = [
  "claude-haiku-4-5-20251001",
  "claude-sonnet-5",
  "claude-opus-5",
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
  // Gated behind a paid upgrade: the picker shows it grayed out with an upgrade tooltip and
  // won't let you select it. NOT a backend restriction — agents already on a gated model keep
  // running, and the API still accepts it (so ungating is a one-flag change here).
  requiresUpgrade?: boolean;
}

// Single source of truth for the model picker (backend validation + frontend UI derive from this).
// Order defines the picker order: selectable models first (the first entry is DEFAULT_MODEL, the
// default for new agents), upgrade-gated ones below.
//
// The Anthropic models are ungated: what used to be an upgrade wall is now a per-account daily
// SPEND cap (see spend.ts + backend/src/services/spend.ts), which bounds the cost directly
// instead of by proxy. GLM stays gated — it's routed to z.ai on our key and isn't part of the
// first-party offering.
export const MODEL_CATALOG: readonly ModelCatalogEntry[] = [
  { id: "kimi-k3", label: "Kimi K3", hint: "Open source · 1M context", provider: "moonshot", supportsEffort: true, contextWindow: 1_048_576 },
  { id: "kimi-k2.7-code", label: "Kimi K2.7 Code", hint: "Open source · 256K context", provider: "moonshot", supportsEffort: true, contextWindow: 262_144 },
  { id: "claude-haiku-4-5-20251001", label: "Haiku 4.5", hint: "Fastest", provider: "anthropic", supportsEffort: false, contextWindow: 200_000 },
  { id: "claude-sonnet-5", label: "Sonnet 5", hint: "Balanced", provider: "anthropic", supportsEffort: true, contextWindow: 200_000 },
  { id: "claude-opus-5", label: "Opus 5", hint: "Most capable", provider: "anthropic", supportsEffort: true, contextWindow: 200_000 },
  { id: "glm-5.2", label: "GLM 5.2", hint: "Open source · fast & cheap", provider: "zai", supportsEffort: false, contextWindow: 200_000, requiresUpgrade: true },
];

// Default model for a new agent — the first freely-selectable catalog entry.
export const DEFAULT_MODEL: AllowedModel = MODEL_CATALOG.find((m) => !m.requiresUpgrade)!.id;

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

// Permission mode a new agent starts on: full autonomy (never asks for tool confirmations).
// Every agent-creation path defaults to this; the creator can still dial it down in the picker.
export const DEFAULT_AGENT_MODE: PermissionMode = "bypassPermissions";

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

// --- Agent status (the Slack-style, agent-authored "what I'm working on" line) ---
//
// NOT to be confused with AgentStatus in domain.ts, which is live PRESENCE (working/idle/sleeping/
// …) derived from the runner connection. This is the short human-readable line the agent sets for
// itself with the set_status tool; it persists across turns and sleep until the agent changes it.

// The length bounds (STATUS_TEXT_MAX_LENGTH / STATUS_EMOJI_MAX_LENGTH) are NOT here — they live in
// runner-protocol.ts, the only shared file the runner can see, so the tool schema and the backend
// validator can share one definition. They still reach importers as `@jungle/shared` exports.
//
// A status older than this is rendered dimmed with a "may be out of date" hint. Statuses are never
// auto-deleted on age — an agent legitimately sits on "Waiting on PR review" overnight — but after
// this long the UI stops presenting it as current. The real freshness mechanism is that the runner
// shows the agent its own status every turn, so it can update or clear it (see runner.ts).
export const STATUS_STALE_AFTER_MS = 12 * 60 * 60 * 1000;
