-- Liana channels: Telegram joins Slack + iMessage as a delivery + chat surface.
--
-- Linking is a t.me deep link (no code typing): web Settings mints link_code, the user opens
-- https://t.me/<bot>?start=<code>, and the bot's /start handler binds the chat to the
-- participant. pending_draft_id carries the conversational YES/NO confirm state, exactly like
-- liana_phone_links (Telegram drafts confirm in-chat, not with Slack buttons).
create table if not exists liana_telegram_links (
  participant_id     uuid primary key references participants(id) on delete cascade,
  chat_id            bigint unique,       -- null until /start completes the link
  telegram_user_id   bigint,
  telegram_username  text,
  link_code          text unique,
  link_code_expires_at timestamptz,
  verified_at        timestamptz,
  pending_draft_id   uuid references workflows(id) on delete set null,
  created_at         timestamptz not null default now()
);
