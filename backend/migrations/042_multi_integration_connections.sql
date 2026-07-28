-- 042_multi_integration_connections.sql — allow multiple connections per (user, integration key).
--
-- integration_connections was one row per (participant_id, integration_key) — a user could link
-- at most one X account or one Notion workspace, ever. Re-key by a surrogate `id` so a user can
-- hold several connections for the same integration (e.g. two X accounts); agents bind to one
-- specific connection by id (agent_integrations.config.connectionId) instead of implicitly "the"
-- connection for their user+key (config.backingParticipantId). See backend/src/db/connections.ts.
--
-- Only X and Notion get "connect another account" in the UI for now, but every connection-based
-- integration sharing this table (linear, granola, google-drive, google-calendar, posthog,
-- mixpanel) moves to connectionId too, since they run through the same adapter plumbing
-- (mcp-remote.ts / mcp-oauth.ts, plus x.ts / google-drive.ts / google-calendar.ts which mirror
-- it by hand). resolveConfig auto-picks the sole connection when there's exactly one, which is
-- all those integrations will ever have without a UI to add a second. gmail/github are untouched
-- — they're backed by google_identities / github_identities, not this table.

alter table integration_connections add column if not exists id uuid default gen_random_uuid();
update integration_connections set id = gen_random_uuid() where id is null;
alter table integration_connections alter column id set not null;

alter table integration_connections drop constraint if exists integration_connections_pkey;
alter table integration_connections add primary key (id);

create index if not exists integration_connections_participant_key_idx
  on integration_connections (participant_id, integration_key);

-- Backfill: config.backingParticipantId -> config.connectionId on every agent_integrations row
-- for a connection-based integration. Pre-migration there was at most one connection per
-- (participant, key), so the join below is unambiguous.
update agent_integrations ai
set config = (ai.config - 'backingParticipantId') || jsonb_build_object('connectionId', ic.id::text)
from integration_connections ic
where ai.integration_key = ic.integration_key
  and ai.config ->> 'backingParticipantId' = ic.participant_id::text
  and ai.config ? 'backingParticipantId';
