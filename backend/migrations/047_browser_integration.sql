-- Browser integration: agents drive a real, logged-in cloud browser (Browserbase) for sites with
-- no usable API — LinkedIn, X writes, and anything else behind a login wall.
--
-- The durable half needs NO new table. A "logged-in browser profile" is a Browserbase Context id,
-- which is exactly a long-lived per-user credential, so it lives in `integration_connections` like
-- every other connection:
--
--   integration_key  = 'browser'
--   access_token     = the Browserbase context id (the credential — it IS the logged-in state)
--   external_account = display label, e.g. 'LinkedIn'
--   extra            = { "site": "linkedin" }
--   needs_reconnect  = true once a session check finds the site has logged us out
--
-- That buys multi-account support (a user may hold LinkedIn + X + a second LinkedIn), the existing
-- Reconnect affordance for dead grants, and the generic connect/callback routes, for free.
--
-- What DOES need a table is the sign-in handshake, because it is not an OAuth round-trip: a human
-- has to sit in front of a live browser for up to 15 minutes while we watch its cookie jar. That
-- is a piece of short-lived server-side state with no natural home, hence this one table.
--
-- Security note on why the request id is the unit of sharing: Browserbase's live-view URL is a
-- BEARER CAPABILITY — anyone holding it drives the browser. Jungle messages are persisted,
-- ⌘K-searchable, and mirrored into Slack, so that URL must never appear in one. Instead the agent
-- posts a link to /browser-signin/<request id>, and the backend mints the live-view URL only after
-- authorizing the viewer against participant_id below.
--
-- Apply with: psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f backend/migrations/047_browser_integration.sql
-- (Mirrored into backend/db/schema.sql — keep both in sync.)

create table if not exists browser_signin_requests (
  id              uuid primary key default gen_random_uuid(),
  -- The human who must log in, and the ONLY participant allowed to open the live view. An agent
  -- cannot sign in on someone's behalf; it can only ask.
  participant_id  uuid not null references participants(id) on delete cascade,
  -- The agent that asked, when the request came from a browser_signin tool call. Null for a
  -- request the user started themselves from Settings → Connections.
  agent_id        uuid references participants(id) on delete cascade,
  -- Site key from the shared BROWSER_SITES catalog ('linkedin', 'x', …).
  site            text not null,
  -- Browserbase context this sign-in writes into. Created up front so a retry after an expiry
  -- tops up the SAME profile rather than stranding the old one (contexts live until deleted).
  context_id      text not null,
  -- The live Browserbase session backing the live view. Null once released.
  session_id      text,
  status          text not null default 'pending'
                    check (status in ('pending', 'completed', 'expired', 'failed')),
  -- The connection row this produced, once the login succeeded.
  connection_id   uuid references integration_connections(id) on delete set null,
  -- Browserbase free tier caps a session at 15 minutes; the watcher gives up before then and
  -- releases rather than letting an abandoned session bill against the allowance.
  expires_at      timestamptz not null,
  created_at      timestamptz not null default now(),
  completed_at    timestamptz
);

-- "Does this person have a sign-in waiting?" — drives the chat card's live state and stops us
-- opening a second session for a site that already has one pending.
create index if not exists browser_signin_requests_participant_idx
  on browser_signin_requests (participant_id, status);

-- The sweeper's scan: expire pending requests whose deadline has passed.
create index if not exists browser_signin_requests_pending_idx
  on browser_signin_requests (expires_at) where status = 'pending';
