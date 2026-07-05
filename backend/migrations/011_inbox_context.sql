-- 011: persist per-dispatch context on inbox items.
--
-- The cascade budget, trigger channel/thread, and (later) firing schedule id used to live only
-- in orchestrator.ts's in-memory sdkContext map, keyed per agent and overwritten at ENQUEUE
-- time. That raced (a second dispatch queued behind a running turn clobbered the live turn's
-- routing) and was lost on backend restart while the inbox itself is durable — confirm cards
-- auto-denied, default thread placement broke. Now the context rides on the inbox item; the
-- active context is the most recently CONSUMED item's context (db/agents.ts
-- latestConsumedContext).
--
-- Apply with: psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f backend/migrations/011_inbox_context.sql

alter table agent_inbox add column if not exists context jsonb;

create index if not exists agent_inbox_ctx_idx on agent_inbox (agent_id, delivered_at desc)
  where context is not null;
