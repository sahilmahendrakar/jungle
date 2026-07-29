// Admin (operator) view: platform-wide usage + spend, rolled up by account.
//
// Every shape here is served by /api/admin/* and gated on the operator allowlist (ADMIN_EMAILS,
// see backend/src/admins.ts) — a normal user never receives any of it. Dollar figures are the
// Agent SDK's OWN per-turn cost estimates summed up (result.modelUsage[model].costUSD); for
// models routed to a non-Anthropic provider (GLM/kimi via z.ai) the SDK prices them at
// Anthropic-ish rates, so those rows read high relative to what the provider actually bills.

import type { ModelProvider } from "./constants.js";

// The lookback every admin query is scoped to.
export type AdminWindow = "24h" | "7d" | "30d" | "all";

export const ADMIN_WINDOWS: AdminWindow[] = ["24h", "7d", "30d", "all"];

export function isAdminWindow(v: unknown): v is AdminWindow {
  return typeof v === "string" && (ADMIN_WINDOWS as string[]).includes(v);
}

// Token counts as reported by the SDK. `total` is the sum of all four — the number worth showing
// in one column, since cache reads dominate volume while fresh input/output dominate cost.
export interface AdminTokens {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
}

// Platform-wide counters. The *_total fields are all-time (how big the platform is); everything
// else is scoped to the requested window (what happened lately).
export interface AdminTotals {
  users: number; // distinct human accounts (by email)
  workspaces: number;
  agents: number;
  activeAgents: number; // agents that ran a turn inside the window
  turns: number;
  messages: number; // messages sent in the window (humans + agents)
  tokens: AdminTokens;
  costUsd: number;
}

// One bucket of platform spend (UTC), oldest first — the overview chart's series. Buckets are
// days, except in the 24h window where they are hours (see AdminOverview.granularity).
export interface AdminDailyPoint {
  date: string; // YYYY-MM-DD, or YYYY-MM-DDTHH:00Z for hourly buckets
  costUsd: number;
  turns: number;
  tokens: number;
}

export interface AdminModelUsage {
  model: string;
  turns: number;
  tokens: number;
  costUsd: number;
}

export interface AdminOverview {
  window: AdminWindow;
  since: string | null; // ISO; null for "all"
  totals: AdminTotals;
  granularity: "hour" | "day";
  daily: AdminDailyPoint[];
  models: AdminModelUsage[]; // window spend by model, most expensive first
}

// One account = one human, identified by email across every workspace they belong to (the same
// Google account is a separate participant row per workspace). `key` is what the agents endpoint
// takes to drill in.
export interface AdminAccount {
  key: string; // lower(email), or "participant:<id>" for a participant with no email (dev rows)
  email: string | null;
  name: string | null;
  avatarUrl: string | null;
  workspaces: { id: string; name: string; role: string }[];
  agents: number; // agents they created (all-time)
  activeAgents: number; // ...that ran a turn in the window
  turns: number;
  tokens: AdminTokens;
  costUsd: number;
  joinedAt: string; // earliest participant row for this account
  lastActiveAt: string | null; // last agent turn attributed to them (in any window)
}

// One agent's usage inside the window. `agentId` is null and `deleted` true for an agent that
// has since been removed — its spend still counts, which is the point of keeping the history.
export interface AdminAgentUsage {
  agentId: string | null;
  handle: string;
  displayName: string | null;
  workspaceName: string | null;
  model: string | null; // the agent's configured model (null = default)
  provider: string | null; // docker | fly | self_hosted
  deleted: boolean;
  turns: number;
  tokens: AdminTokens;
  costUsd: number;
  lastActiveAt: string | null;
}

// --- Spend caps (operator-editable) -------------------------------------------------------------

// One provider's cap for one account, plus what's been spent against it today. `limitUsd` is the
// EFFECTIVE limit: the per-account override when there is one, else the platform default — with
// `isDefault` saying which, so the UI can show "default" instead of a value the operator never set.
// `limitUsd: null` = uncapped (either the default is uncapped, or an operator set it to unlimited).
export interface AdminProviderLimit {
  provider: ModelProvider;
  limitUsd: number | null;
  isDefault: boolean;
  spentUsd: number; // billed to our keys today (UTC day); subscription-billed turns excluded
  blocked: boolean; // spentUsd >= limitUsd — this account's agents on this provider won't start
  updatedAt: string | null; // when an operator last set the override
  updatedByEmail: string | null;
}

// Every provider's cap for one account. Always carries a row per provider in MODEL_PROVIDERS, so
// the editor renders the same shape whether or not overrides exist.
export interface AdminAccountLimits {
  accountKey: string;
  // ISO — 00:00 UTC tomorrow, when today's spend resets. Echoed so the UI needn't recompute it.
  resetAt: string;
  providers: AdminProviderLimit[];
}

// A single recent turn, newest first — the "activity" tail of the admin view.
export interface AdminActivityItem {
  at: string;
  agentId: string | null;
  agentHandle: string;
  ownerEmail: string | null;
  workspaceName: string | null;
  model: string;
  turnId: string | null;
  tokens: number;
  costUsd: number;
  durationMs: number | null;
  ok: boolean;
}
