-- Agent self-set status: the Slack-style "what I'm working on" line an agent writes for itself
-- with the set_status tool ("🔧 Fixing the login redirect").
--
-- Deliberately NOT the same thing as the `status` field clients already see on a participant —
-- that one is live PRESENCE (working/idle/sleeping/waking/offline), computed per-request from the
-- runner connection and never stored. This is stored precisely because it must outlive the turn:
-- an idle agent waiting on a PR review is the case the whole feature exists for.
--
-- Only agents ever have one; the columns stay null on human rows. Nullable with no default, so
-- every existing agent starts with no status rather than a fake one.
alter table participants
  add column if not exists status_text       text,
  add column if not exists status_emoji      text,
  add column if not exists status_updated_at timestamptz,
  -- Optional auto-clear (the tool's clearAfterMinutes / Slack's "clear after"). Enforced at READ
  -- time — the serializer nulls an expired status out — so there is no sweeper job to run, and a
  -- backend that was down over the expiry still does the right thing on the next read.
  add column if not exists status_expires_at timestamptz;
