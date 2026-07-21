-- Liana channels: iMessage (via Linq) joins Slack as a delivery + chat surface.
--
-- deliver_to: which channels a workflow's run output goes to. A text[] (not booleans) so future
-- channels (telegram, ...) are a value, not a migration. Default '{slack}' — every pre-existing
-- workflow keeps exactly its current behavior.
alter table liana_workflows
  add column if not exists deliver_to text[] not null default '{slack}';

-- One phone per participant, linked from web Settings via a texted verification code. The
-- pending_draft_id carries the conversational YES/NO confirm state for workflows drafted over
-- iMessage (texting has no buttons).
create table if not exists liana_phone_links (
  participant_id    uuid primary key references participants(id) on delete cascade,
  phone             text not null unique, -- E.164
  verified_at       timestamptz,
  verify_code       text,
  verify_expires_at timestamptz,
  pending_draft_id  uuid references workflows(id) on delete set null,
  linq_chat_id      text,
  created_at        timestamptz not null default now()
);
