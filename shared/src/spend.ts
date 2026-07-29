// Spend caps: how much an ACCOUNT may spend per day, per provider.
//
// Why this exists: agents run turns against operator-owned API keys (the org ANTHROPIC_API_KEY,
// or z.ai/Moonshot keys for routed models), so a single account can spend real money without
// ever seeing a bill. A cap bounds that. It is enforced backend-side at the one point where
// queued work becomes a turn (runners.drain) — not in the UI.
//
// Two deliberate choices:
//
//   * The period is the UTC CALENDAR DAY, not a rolling 24h window. A rolling window is fairer
//     but its reset time is a moving target that can't be stated in one sentence; "resets at
//     00:00 UTC" can be, and the person hitting the cap is the one who has to understand it.
//   * A turn billed to someone's PERSONAL Claude subscription (see backend/src/subscription.ts)
//     does not count and is never capped — they're spending their own quota, not ours. The SDK
//     still reports a notional cost for those turns, so usage rows carry a `subscription` flag
//     and the cap query excludes them rather than trusting the dollar figure.

import { catalogEntry, type ModelProvider } from "./constants.js";

// Providers a cap can be set for. Mirrors ModelProvider — kept as a value (the type alone can't
// be iterated) so the admin UI and backend validation share one list.
export const MODEL_PROVIDERS: readonly ModelProvider[] = ["anthropic", "zai", "moonshot"] as const;

// How each provider is named to humans (admin UI, and the notice a capped agent posts).
export const PROVIDER_LABEL: Record<ModelProvider, string> = {
  anthropic: "Anthropic",
  zai: "z.ai",
  moonshot: "Moonshot",
};

// Platform default daily cap per provider, in USD. `null` = uncapped.
//
// Only Anthropic is capped by default: it's the expensive first-party key every account can reach
// without any setup. The routed providers are cheap and only reachable on models that are still
// upgrade-gated in the picker, so a default cap there would be noise. An admin can set one per
// account (spend_limits) either way.
export const DEFAULT_DAILY_LIMIT_USD: Record<ModelProvider, number | null> = {
  anthropic: 5,
  zai: null,
  moonshot: null,
};

export function isModelProvider(v: unknown): v is ModelProvider {
  return typeof v === "string" && (MODEL_PROVIDERS as readonly string[]).includes(v);
}

// Whose quota a model id spends. The catalog is the authority, but the model ids the SDK REPORTS
// in a turn's usage aren't always catalog ids — subagents and compaction show up as full dated
// names ("claude-sonnet-4-5-20250929"), and a catalog entry can be retired while its spend history
// lives on. So: exact catalog match first, then a family prefix. Returns null for a model we can't
// classify, which counts against no cap rather than guessing.
//
// Keep the prefixes in step with the backfill in backend/migrations/043_spend_limits.sql.
export function providerForModelId(model: string | null | undefined): ModelProvider | null {
  const entry = catalogEntry(model);
  if (entry) return entry.provider;
  const m = (model ?? "").trim().toLowerCase();
  if (m.startsWith("claude")) return "anthropic";
  if (m.startsWith("glm")) return "zai";
  if (m.startsWith("kimi")) return "moonshot";
  return null;
}

// Start of the current cap period (00:00 UTC today) and its end (00:00 UTC tomorrow, i.e. when
// the cap resets). Computed in JS rather than SQL so the boundary is explicit and timezone-proof
// regardless of the database session's TimeZone setting.
export function spendPeriodStart(now: Date = new Date()): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

export function spendPeriodEnd(now: Date = new Date()): Date {
  return new Date(spendPeriodStart(now).getTime() + 24 * 3600_000);
}

// Why an agent's queued work isn't running: the account is over its cap for the provider its
// model routes to. Carried from the enforcement point (runners.drain) to the notice the agent
// posts in the channel it was invoked from.
export interface SpendBlock {
  provider: ModelProvider;
  limitUsd: number;
  spentUsd: number;
  // ISO — 00:00 UTC tomorrow, when the period rolls over and the queued work drains.
  resetAt: string;
}

// The user-facing explanation, shared by every surface a capped agent can be invoked from
// (Jungle channel, Slack, Telegram, iMessage). Written for the person who just @mentioned the
// agent: what happened, that their message isn't lost, when it runs, and who to ask for more.
export function spendBlockedNotice(block: SpendBlock, supportEmail: string): string {
  const money = (n: number) => `$${n.toFixed(2)}`;
  const hours = Math.max(1, Math.round((new Date(block.resetAt).getTime() - Date.now()) / 3600_000));
  return (
    `⚠️ **Daily usage limit reached** — I can't start a turn right now.\n\n` +
    `This account has used ${money(block.spentUsd)} of its ${money(block.limitUsd)} daily ` +
    `${PROVIDER_LABEL[block.provider]} limit. The limit resets at 00:00 UTC ` +
    `(about ${hours} ${hours === 1 ? "hour" : "hours"} from now), and anything you've sent me is ` +
    `still queued — I'll pick it up then.\n\n` +
    `Need a higher limit? Email ${supportEmail}.`
  );
}
