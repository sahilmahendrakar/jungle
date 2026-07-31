-- Agent ownership as a first-class concept, split out of participants.created_by.
--
-- Until now created_by carried two different meanings at once:
--   * provenance  — who made this agent, an audit fact that should never change; and
--   * ownership   — the human whose Claude subscription pays for its turns, whose daily spend cap
--                   it counts against, and whose connected accounts back its integrations.
--
-- Conflating them was fine while only humans created agents. It broke the moment an AGENT started
-- creating agents (@jungle's create_agent tool passes `actor.id`, which is then an agent id):
--   * getClaudeOauthTokenForAgent joined a single hop to created_by and required a token there.
--     An agent never has one, so the turn silently fell back to the org ANTHROPIC_API_KEY —
--     the owner's subscription was simply not found.
--   * usage.ts / spendLimits.ts resolved the owner the same single-hop way, and their fallback to
--     the workspace admin only fired when created_by IS NULL. A non-null-but-agent creator slipped
--     through both, so usage landed with owner_email NULL and the agent got its own invisible
--     'participant:<agent-id>' spend account with a second, unadministrable daily cap.
--   * integrations/backing.ts, alone, got it right: its ownerOf() walked created_by up to the first
--     human. So one agent could resolve integrations through its owner's accounts while billing its
--     turns to the org key — the two subsystems disagreeing about the same agent.
--
-- So: created_by keeps provenance and is never rewritten again; owner_id names the human. It is
-- nullable on purpose — an agent whose owner left the workspace falls back to the org key rather
-- than being stranded, which is the same graceful degradation an owner without a token already got.
--
-- INVARIANT (upheld in code — a cross-row rule Postgres can't express as a CHECK): owner_id must
-- reference a participant with kind='human' in the same workspace as the agent. db/participants.ts
-- setAgentOwner enforces it on write; services/ownership.ts resolveOwner enforces it on assignment.

alter table participants add column if not exists owner_id uuid references participants(id) on delete set null;
create index if not exists participants_owner_id_idx on participants (owner_id);

-- Backfill: walk created_by up to the first human, mirroring integrations/backing.ts ownerOf() —
-- the one implementation that was already correct. `cycle` guards a chain that loops back on itself
-- (a bad 040 backfill could in principle have produced one); Postgres's CYCLE clause stops the walk
-- instead of erroring, so a cycle degrades to "no owner found" and falls through to the fallback.
with recursive chain(agent_id, at_id, workspace_id, depth) as (
    select a.id, a.created_by, a.workspace_id, 1
      from participants a
     where a.kind = 'agent' and a.created_by is not null
  union all
    select c.agent_id, p.created_by, c.workspace_id, c.depth + 1
      from chain c
      join participants p on p.id = c.at_id
     where p.kind = 'agent' and p.created_by is not null and c.depth < 16
),
resolved as (
  select distinct on (c.agent_id) c.agent_id, h.id as owner_id
    from chain c
    join participants h on h.id = c.at_id
   where h.kind = 'human' and h.workspace_id = c.workspace_id
   order by c.agent_id, c.depth asc
)
update participants a
   set owner_id = r.owner_id
  from resolved r
 where a.id = r.agent_id and a.owner_id is null;

-- Anything the walk couldn't resolve (no creator recorded, creator deleted, creator in another
-- workspace, or a cycle) falls back to the workspace's admin, else its earliest human — the exact
-- rule 040 used for created_by and that usage.ts/spendLimits.ts used as their IS NULL fallback, so
-- no agent's spend account moves as a result of this migration alone.
update participants a
   set owner_id = (
     select h.id from participants h
      where h.workspace_id = a.workspace_id and h.kind = 'human'
      order by (h.role = 'admin') desc, h.created_at asc
      limit 1
   )
 where a.kind = 'agent' and a.owner_id is null;

-- Restore provenance for agents whose created_by was overwritten to make ownership work before
-- owner_id existed. @jungle's adoption path (services/jungleAgent.ts) rewrote created_by so the
-- workspace's subscriber would pay, and outreach-agent was repointed by hand during the incident
-- that prompted this migration. Both are now expressed by owner_id, so created_by can go back to
-- meaning "who actually made this" wherever we can still recover it. We only recover the hand-fix:
-- the @jungle rewrites are not distinguishable from genuine creations, and adopting them is
-- harmless now that nothing reads created_by for ownership.
update participants
   set created_by = '63e3149c-938e-45bd-b6c5-038d9044a774'
 where id = '46fb8d6d-b00c-4462-8f47-bf45842a9dad'
   and created_by = '9ca62385-a05e-471c-a720-f32f045442f1'
   and exists (select 1 from participants where id = '63e3149c-938e-45bd-b6c5-038d9044a774');
