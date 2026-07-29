-- Per-account, per-provider daily spend caps — and the two usage columns needed to enforce them.
--
-- Background: agents spend operator-owned API keys (the org ANTHROPIC_API_KEY, or the z.ai /
-- Moonshot keys for routed models), so an account can run up a real bill it never sees. Until now
-- the only brake was the model picker's `requiresUpgrade` flag, which gated Anthropic models
-- entirely. This replaces that proxy with a direct cost bound: a dollars-per-day cap per account
-- per provider, defaulting to $5/day of Anthropic (shared/src/spend.ts) and editable per account
-- from the admin view. Enforcement lives in backend/src/services/spend.ts, applied in
-- runners.drain() — the single point where queued inbox work becomes a turn.
--
-- Also retires the Opus 4.8 catalog entry in favour of Opus 5 (see the tail of this file).

-- 1. Which provider's quota a usage row consumed -------------------------------------------------
--
-- agent_usage.model is the model the SDK reported, which is enough to derive a provider but only
-- via a mapping that lives in TypeScript (shared MODEL_CATALOG) and drifts as models come and go.
-- Recording the provider at write time freezes the answer alongside the spend, the same way the
-- table already freezes the agent handle and owner email (see 040_usage_admin.sql).
alter table agent_usage add column if not exists provider text;

-- Was this turn billed to a PERSONAL Claude subscription instead of the org API key? (041 lets an
-- allowlisted operator put their own `claude setup-token` behind the agents they create.) The SDK
-- still reports a notional cost for those turns, so the dollar figure alone can't distinguish
-- them — without this flag a subscription user would be capped on spend that never hit our bill.
-- Cap queries filter on `subscription = false`.
alter table agent_usage add column if not exists subscription boolean not null default false;

-- Backfill provider for existing rows from the model id. Mirrors MODEL_CATALOG's provider column,
-- by prefix so subagent/compaction model ids (which carry full dated names) map too. Anything
-- unrecognized stays null and simply never counts against a cap.
update agent_usage
   set provider = case
     when model like 'claude%' then 'anthropic'
     when model like 'glm%'    then 'zai'
     when model like 'kimi%'   then 'moonshot'
     else null
   end
 where provider is null;

-- `subscription` stays false for every backfilled row. Subscription auth shipped 2026-07-28, so a
-- small tail of pre-existing operator turns is attributed to the org key here. Deliberate: those
-- rows are historical reporting only, and the operator accounts are uncapped in practice anyway.

-- The cap's hot query: today's spend for one account on one provider. The account key is the same
-- expression db/usage.ts groups by (ACCOUNT_KEY) — kept as an expression index rather than a
-- materialized column so the two can't disagree. Partial on `subscription = false` because that's
-- the only slice a cap ever reads.
create index if not exists agent_usage_account_provider_idx
  on agent_usage (
    coalesce(lower(owner_email), 'participant:' || owner_id::text, 'unattributed'),
    provider,
    created_at desc
  )
  where subscription = false;

-- 2. The caps themselves -------------------------------------------------------------------------
--
-- Keyed by ACCOUNT KEY (lower(email), or 'participant:<id>' for a row with no email) rather than a
-- participant id, because one human is a SEPARATE participant row per workspace: a cap has to
-- follow the person across every workspace they're in, which is exactly what the admin view's
-- account grouping already means. Not a foreign key for the same reason — the key is an identity,
-- not a row.
--
-- limit_usd null = explicitly uncapped. A MISSING row = fall back to the platform default
-- (shared/src/spend.ts DEFAULT_DAILY_LIMIT_USD), so deleting a row is how an operator reverts to
-- the default rather than pinning today's default value forever.
create table if not exists spend_limits (
  account_key      text not null,
  provider         text not null,
  limit_usd        numeric(12, 2),
  -- Audit: which operator last set this, and when. Email (not a participant id) to match the
  -- ADMIN_EMAILS allowlist the admin API authenticates against.
  updated_by_email text,
  updated_at       timestamptz not null default now(),
  primary key (account_key, provider)
);

-- 3. Opus 4.8 -> Opus 5 --------------------------------------------------------------------------
--
-- Opus 5 replaces Opus 4.8 in MODEL_CATALOG, so 'claude-opus-4-8' is no longer an allowed model:
-- an agent left on it would fail validation on its next update and show an empty model picker.
-- Move them over. (agent_usage rows keep the old model id — that's spend history, not config.)
update participants set model = 'claude-opus-5' where model = 'claude-opus-4-8';
