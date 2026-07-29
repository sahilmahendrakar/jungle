import type { ModelProvider } from "@jungle/shared";
import { pool } from "./pool";

// Data access for the daily spend cap: reading today's spend out of agent_usage, and the
// per-account overrides in spend_limits. Policy (which limit applies, whether an agent is over it)
// lives in services/spend.ts — this module only queries.
//
// See migrations/043_spend_limits.sql for why caps are keyed by ACCOUNT KEY rather than
// participant id.

// The account key expression. MUST stay identical to db/usage.ts's ACCOUNT_KEY and to the
// expression index in migrations/043 — the admin view's account rows, this cap, and that index all
// have to mean the same "account" or a cap silently applies to the wrong person (or scans).
const ACCOUNT_KEY = `coalesce(lower(owner_email), 'participant:' || owner_id::text, 'unattributed')`;

function num(v: unknown): number {
  const n = typeof v === "string" ? Number(v) : (v as number);
  return Number.isFinite(n) ? n : 0;
}

// The account an agent's spend lands on. Same resolution as usage.ts's write path: the recorded
// creator, else the workspace's admin (earliest human) — so the cap reads the account that the
// usage rows were (and will be) written against.
export async function accountKeyForAgent(agentId: string): Promise<string | null> {
  const { rows } = await pool.query<{ account_key: string }>(
    `select coalesce(lower(o.email), 'participant:' || o.id::text, 'unattributed') as account_key
       from participants a
       left join lateral (
         select h.id, h.email
           from participants h
          where h.id = a.created_by
             or (a.created_by is null and h.workspace_id = a.workspace_id and h.kind = 'human')
          order by (h.id = a.created_by) desc, (h.role = 'admin') desc, h.created_at asc
          limit 1
       ) o on true
      where a.id = $1`,
    [agentId],
  );
  return rows[0]?.account_key ?? null;
}

// Dollars this account has spent on this provider since `since`, EXCLUDING turns billed to a
// personal Claude subscription (those spend the operator's own quota, not ours — see
// migrations/043). Rows whose provider we couldn't classify count against nothing.
export async function spentSince(
  accountKey: string,
  provider: ModelProvider,
  since: Date,
): Promise<number> {
  const { rows } = await pool.query<{ cost_usd: string }>(
    `select coalesce(sum(cost_usd), 0) as cost_usd
       from agent_usage
      where ${ACCOUNT_KEY} = $1
        and provider = $2
        and subscription = false
        and created_at >= $3`,
    [accountKey, provider, since],
  );
  return num(rows[0]?.cost_usd);
}

// Same, but every provider at once — the admin editor shows all of them side by side.
export async function spentByProviderSince(
  accountKey: string,
  since: Date,
): Promise<Record<string, number>> {
  const { rows } = await pool.query<{ provider: string | null; cost_usd: string }>(
    `select provider, coalesce(sum(cost_usd), 0) as cost_usd
       from agent_usage
      where ${ACCOUNT_KEY} = $1
        and subscription = false
        and created_at >= $2
      group by provider`,
    [accountKey, since],
  );
  const out: Record<string, number> = {};
  for (const r of rows) if (r.provider) out[r.provider] = num(r.cost_usd);
  return out;
}

export interface SpendLimitRow {
  account_key: string;
  provider: string;
  limit_usd: string | null;
  updated_by_email: string | null;
  updated_at: string;
}

// The overrides stored for one account, by provider. A provider absent from the map has no
// override and falls back to the platform default.
export async function getSpendLimits(accountKey: string): Promise<Map<string, SpendLimitRow>> {
  const { rows } = await pool.query<SpendLimitRow>(
    `select account_key, provider, limit_usd, updated_by_email, updated_at
       from spend_limits where account_key = $1`,
    [accountKey],
  );
  return new Map(rows.map((r) => [r.provider, r]));
}

// Set (or replace) one account's cap for one provider. `limitUsd` null = explicitly uncapped,
// which is DIFFERENT from having no row: an explicit null pins "uncapped" even if the platform
// default later becomes stricter.
export async function upsertSpendLimit(
  accountKey: string,
  provider: ModelProvider,
  limitUsd: number | null,
  updatedByEmail: string | null,
): Promise<void> {
  await pool.query(
    `insert into spend_limits (account_key, provider, limit_usd, updated_by_email, updated_at)
     values ($1, $2, $3, $4, now())
     on conflict (account_key, provider) do update
       set limit_usd = excluded.limit_usd,
           updated_by_email = excluded.updated_by_email,
           updated_at = now()`,
    [accountKey, provider, limitUsd, updatedByEmail],
  );
}

// Drop the override so the account falls back to the platform default.
export async function deleteSpendLimit(accountKey: string, provider: ModelProvider): Promise<void> {
  await pool.query(`delete from spend_limits where account_key = $1 and provider = $2`, [
    accountKey,
    provider,
  ]);
}
