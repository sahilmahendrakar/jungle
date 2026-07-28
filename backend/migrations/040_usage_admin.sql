-- Usage + spend tracking, and the account attribution the admin view rolls it up by.
--
-- Every SDK `result` stream message a runner forwards carries the turn's token counts and the
-- SDK's own cost estimate (per model, in `modelUsage`). Those messages are already persisted in
-- agent_events for the Activity feed, but as raw jsonb they're unusable for aggregation — this
-- table is the extracted, indexed form: one row per (result event, model).
--
-- Rows deliberately DENORMALIZE the agent + owner (handle, email, name): agents get deleted all
-- the time, and spend history has to outlive them, so every reference is `on delete set null` and
-- the labels are captured at write time. Live rows are written by backend/src/db/usage.ts; the
-- backfill at the bottom of this file recovers everything already sitting in agent_events.

create table if not exists agent_usage (
  id                  bigserial primary key,
  -- The SDK result message's uuid — stable per event, so the live path and the backfill below
  -- can't double-count the same turn. One result can report several models (subagents,
  -- compaction), hence the key is (event_uuid, model).
  event_uuid          text,
  agent_id            uuid references participants(id) on delete set null,
  agent_handle        text not null,
  workspace_id        uuid references workspaces(id) on delete set null,
  -- The human account the agent belongs to (participants.created_by), captured at write time.
  owner_id            uuid references participants(id) on delete set null,
  owner_email         text,
  owner_name          text,
  turn_id             text,
  model               text not null,
  input_tokens        bigint not null default 0,
  output_tokens       bigint not null default 0,
  cache_read_tokens   bigint not null default 0,
  cache_write_tokens  bigint not null default 0,
  web_search_requests integer not null default 0,
  -- The SDK's own cost estimate for this model's share of the turn (result.modelUsage[m].costUSD).
  cost_usd            numeric(14, 6) not null default 0,
  duration_ms         integer,
  ok                  boolean not null default true,
  created_at          timestamptz not null default now()
);

create unique index if not exists agent_usage_event_model_idx
  on agent_usage (event_uuid, model) where event_uuid is not null;
create index if not exists agent_usage_created_idx on agent_usage (created_at desc);
create index if not exists agent_usage_owner_idx on agent_usage (lower(owner_email), created_at desc);
create index if not exists agent_usage_agent_idx on agent_usage (agent_id, created_at desc);
create index if not exists agent_usage_workspace_idx on agent_usage (workspace_id, created_at desc);

-- Who created an agent. Until now an agent was only tied to its workspace, so per-user usage had
-- nothing to attribute to. Set on POST /api/agents from here on; backfilled below.
alter table participants add column if not exists created_by uuid references participants(id) on delete set null;
create index if not exists participants_created_by_idx on participants (created_by);

-- Backfill created_by for existing agents: the workspace's admin (earliest one), else its earliest
-- human. A best guess — nothing recorded the real creator — but in a workspace with one human it
-- is exactly right, which is the common case.
update participants a
set created_by = (
  select h.id from participants h
  where h.workspace_id = a.workspace_id and h.kind = 'human'
  order by (h.role = 'admin') desc, h.created_at asc
  limit 1
)
where a.kind = 'agent' and a.created_by is null;

-- Backfill usage from every `result` event already in agent_events. `modelUsage` is an object of
-- model -> {inputTokens, outputTokens, cacheReadInputTokens, cacheCreationInputTokens, costUSD};
-- events predating it (or error results) simply contribute no rows.
insert into agent_usage (
  event_uuid, agent_id, agent_handle, workspace_id, owner_id, owner_email, owner_name,
  turn_id, model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
  web_search_requests, cost_usd, duration_ms, ok, created_at
)
select
  e.event ->> 'uuid',
  a.id,
  a.handle,
  a.workspace_id,
  o.id,
  o.email,
  o.display_name,
  e.turn_id,
  m.key,
  coalesce((m.value ->> 'inputTokens')::bigint, 0),
  coalesce((m.value ->> 'outputTokens')::bigint, 0),
  coalesce((m.value ->> 'cacheReadInputTokens')::bigint, 0),
  coalesce((m.value ->> 'cacheCreationInputTokens')::bigint, 0),
  coalesce((m.value ->> 'webSearchRequests')::int, 0),
  coalesce((m.value ->> 'costUSD')::numeric, 0),
  nullif((e.event ->> 'duration_ms'), '')::int,
  coalesce((e.event ->> 'is_error')::boolean, false) = false,
  e.created_at
from agent_events e
join participants a on a.id = e.agent_id
left join participants o on o.id = a.created_by
cross join lateral jsonb_each(e.event -> 'modelUsage') m
where e.event ->> 'type' = 'result'
  and jsonb_typeof(e.event -> 'modelUsage') = 'object'
  and e.event ->> 'uuid' is not null
on conflict do nothing;
