-- Liana in channels: run output delivers to the conversation Liana was invoked in, not just a DM.
--
-- Slack already records origin_channel_id (028) — delivery now honors it instead of always
-- opening a DM. Telegram gains group support, so a workflow born in a Telegram group needs its
-- own delivery destination: origin_telegram_chat_id. Null = deliver to the owner's private
-- Telegram chat (the DM case, as before). Mirrors origin_channel_id's role for Slack.
alter table liana_workflows
  add column if not exists origin_telegram_chat_id bigint;

-- Web escape hatch: when true, deliver to the owner's personal DM even though the workflow was
-- born in a channel/group. Non-destructive — origin_* stays recorded so the user can switch back.
alter table liana_workflows
  add column if not exists deliver_dm_override boolean not null default false;
