-- Participant-scoped API tokens: programmatic access to the HTTP API and the /mcp server as a
-- specific participant. The plaintext token ("jgl_<hex>") is shown once at mint and only its
-- sha256 hex lives here. A token acts AS its participant — same workspace scoping and the same
-- permissions the participant has in routes/guards. Rows bound to an agent with name
-- 'jungle integration' are minted/rotated automatically by the jungle integration adapter
-- (backend/src/integrations/jungle.ts); deleting the row revokes the token immediately.

create table if not exists api_tokens (
  id             uuid primary key default gen_random_uuid(),
  participant_id uuid not null references participants(id) on delete cascade,
  name           text not null,
  token_hash     text not null,                -- sha256 hex of the plaintext token
  created_by     uuid references participants(id) on delete set null,
  created_at     timestamptz not null default now(),
  last_used_at   timestamptz
);

create unique index if not exists api_tokens_hash_idx on api_tokens (token_hash);
create index if not exists api_tokens_participant_idx on api_tokens (participant_id);
