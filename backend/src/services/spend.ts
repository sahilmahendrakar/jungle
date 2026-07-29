import {
  DEFAULT_DAILY_LIMIT_USD,
  MODEL_PROVIDERS,
  providerForModelId,
  spendPeriodEnd,
  spendPeriodStart,
  type AdminAccountLimits,
  type AdminProviderLimit,
  type ModelProvider,
  type SpendBlock,
} from "@jungle/shared";
import * as db from "../db";

// The daily spend cap: policy on top of db/spendLimits.ts.
//
// What it does: before an agent's queued work becomes a turn, check whether the ACCOUNT that owns
// the agent has already spent its daily allowance on the provider that agent's model routes to. If
// it has, the turn doesn't start — the work stays queued and drains after 00:00 UTC.
//
// Enforced in runners.drain() (see runners.ts), which is the one funnel every trigger path goes
// through: a channel mention, a DM, a schedule firing, a workflow step, a Liana surface. Gating
// there instead of at each enqueue site means a new trigger path can't accidentally bypass it.
//
// Two carve-outs, both deliberate:
//   * An account whose turns are billed to its own Claude subscription is never capped on
//     Anthropic — it isn't spending our key. (Routed providers still are: a subscription doesn't
//     pay for z.ai.)
//   * A model we can't attribute to a provider counts against nothing, rather than being blocked
//     by a cap we can't measure.

export type { SpendBlock };

// The provider an AGENT's configured model spends against. A null/unset model means the agent runs
// the CLI's own default, which is an Anthropic model — so it bills the org ANTHROPIC_API_KEY and
// belongs to the anthropic cap.
export function providerForAgentModel(model: string | null | undefined): ModelProvider | null {
  return model ? providerForModelId(model) : "anthropic";
}

// The cap in force for one account+provider: the stored override if there is one (including an
// explicit "uncapped" null), else the platform default. Null = uncapped.
function effectiveLimit(
  provider: ModelProvider,
  overrides: Map<string, db.SpendLimitRow>,
): { limitUsd: number | null; isDefault: boolean; row: db.SpendLimitRow | null } {
  const row = overrides.get(provider) ?? null;
  if (!row) return { limitUsd: DEFAULT_DAILY_LIMIT_USD[provider], isDefault: true, row: null };
  const raw = row.limit_usd;
  const limitUsd = raw == null ? null : Number(raw);
  return {
    limitUsd: limitUsd != null && Number.isFinite(limitUsd) ? limitUsd : null,
    isDefault: false,
    row,
  };
}

// Is this agent's account over its cap? Returns the details to tell the user, or null to proceed.
//
// Called on every drain that has work to push, so it is written to bail out before touching the
// database whenever it can: an uncapped provider (the common case for routed models) costs nothing.
export async function blockedFor(agent: {
  id: string;
  model: string | null;
}): Promise<SpendBlock | null> {
  const provider = providerForAgentModel(agent.model);
  if (!provider) return null; // unclassifiable model — nothing to meter it against

  const accountKey = await db.accountKeyForAgent(agent.id);
  if (!accountKey) return null; // no owning account (deleted mid-turn) — don't strand the work

  const { limitUsd } = effectiveLimit(provider, await db.getSpendLimits(accountKey));
  if (limitUsd == null) return null; // uncapped
  if (limitUsd <= 0) {
    // A cap of $0 means "this account may not spend at all" — block without querying spend.
    return { provider, limitUsd, spentUsd: 0, resetAt: spendPeriodEnd().toISOString() };
  }

  // Subscription-billed Anthropic turns don't touch our key, so the cap doesn't apply to them.
  // Checked after the limit lookup because it's the rarer case (only allowlisted operators can
  // store a token) and this way an uncapped account never pays for the query.
  if (provider === "anthropic" && (await db.getClaudeOauthTokenForAgent(agent.id))) return null;

  const spentUsd = await db.spentSince(accountKey, provider, spendPeriodStart());
  if (spentUsd < limitUsd) return null;
  return { provider, limitUsd, spentUsd, resetAt: spendPeriodEnd().toISOString() };
}

// --- Admin read/write -----------------------------------------------------------------------

// Every provider's cap and today's spend for one account — the admin editor's payload. Always
// returns a row per provider so the editor renders the same shape with or without overrides.
export async function accountLimits(accountKey: string): Promise<AdminAccountLimits> {
  const periodStart = spendPeriodStart();
  const [overrides, spent] = await Promise.all([
    db.getSpendLimits(accountKey),
    db.spentByProviderSince(accountKey, periodStart),
  ]);
  const providers: AdminProviderLimit[] = MODEL_PROVIDERS.map((provider) => {
    const { limitUsd, isDefault, row } = effectiveLimit(provider, overrides);
    const spentUsd = spent[provider] ?? 0;
    return {
      provider,
      limitUsd,
      isDefault,
      spentUsd,
      blocked: limitUsd != null && spentUsd >= limitUsd,
      updatedAt: row?.updated_at ?? null,
      updatedByEmail: row?.updated_by_email ?? null,
    };
  });
  return { accountKey, resetAt: spendPeriodEnd().toISOString(), providers };
}

// Set one account's cap for one provider. `limitUsd` null = explicitly uncapped; pass `reset` to
// drop the override and fall back to the platform default instead.
export async function setAccountLimit(
  accountKey: string,
  provider: ModelProvider,
  limitUsd: number | null,
  opts: { reset?: boolean; byEmail?: string | null } = {},
): Promise<AdminAccountLimits> {
  if (opts.reset) await db.deleteSpendLimit(accountKey, provider);
  else await db.upsertSpendLimit(accountKey, provider, limitUsd, opts.byEmail ?? null);
  return accountLimits(accountKey);
}
