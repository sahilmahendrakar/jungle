-- Operator-supplied Claude subscription (Max/Pro) OAuth token, minted by `claude setup-token`.
--
-- Stored on the HUMAN participant who uploaded it. Agents that participant CREATED
-- (participants.created_by, see 040_usage_admin.sql) then authenticate their Claude Code CLI child
-- with CLAUDE_CODE_OAUTH_TOKEN instead of the org ANTHROPIC_API_KEY, so their turns bill against
-- the subscription's rate limits. Scoping to the creator rather than the workspace matters: this
-- is a personal, per-seat credential, and a workspace co-member's agents must not spend it.
--
-- Writes are gated to an email allowlist (CLAUDE_SUBSCRIPTION_EMAILS, see
-- backend/src/subscription.ts) — deliberately narrower than ADMIN_EMAILS, since reading platform
-- usage and spending someone's personal quota are different privileges. The value is a long-lived
-- credential and is never returned to any client: publicParticipant strips it (participant reads
-- are `select *`), and the settings endpoint reports only whether one is configured.
--
-- No index: the only read is a by-primary-key join from an agent to its creator.

alter table participants add column if not exists claude_oauth_token text;

-- Supersedes the workspace-scoped index from an earlier draft of this migration; the
-- creator-scoped lookup doesn't use it. No-op if it was never created.
drop index if exists participants_claude_oauth_idx;
