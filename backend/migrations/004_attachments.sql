-- Attachments: files (images, docs, …) that ride on chat messages, stored via the backend's
-- Storage seam (local disk today, S3-compatible later — keys are S3-shaped).
-- Upload-first flow (Slack-style): a row is created at upload time with message_id null;
-- posting the message links it. Rows never linked are GC'd by the backend after 24h.

create table if not exists attachments (
  id           uuid primary key default gen_random_uuid(),
  uploader_id  uuid not null references participants(id) on delete cascade,
  message_id   uuid references messages(id) on delete cascade,
  filename     text not null,
  mime         text not null,
  size_bytes   bigint not null,
  storage_key  text not null,
  width        int,          -- images only (layout hint for the UI)
  height       int,
  created_at   timestamptz not null default now()
);
create index if not exists attachments_message_idx on attachments (message_id);
create index if not exists attachments_orphan_idx on attachments (created_at)
  where message_id is null;

-- Inbox items carry the triggering message's attachment refs (id/filename/mime/size as jsonb);
-- download URLs are signed fresh at drain time so items that sat in the inbox don't expire.
alter table agent_inbox add column if not exists attachments jsonb;
