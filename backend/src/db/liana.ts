import { pool } from "./pool";

// Liana data access: the Slack-first workflow product's ownership layer. A Liana workflow is a
// normal workflows row; these tables record which Slack team/user owns it and where runs deliver.
// See migrations/028_liana.sql.

export interface LianaInstall {
  team_id: string;
  team_name: string | null;
  workspace_id: string;
  bot_token: string;
  bot_user_id: string;
  scopes: string | null;
  status: "active" | "revoked";
}

export async function upsertLianaInstall(i: {
  teamId: string;
  teamName: string | null;
  workspaceId: string;
  botToken: string;
  botUserId: string;
  scopes: string | null;
}): Promise<LianaInstall> {
  const { rows } = await pool.query<LianaInstall>(
    `insert into liana_slack_installs (team_id, team_name, workspace_id, bot_token, bot_user_id, scopes, status)
     values ($1, $2, $3, $4, $5, $6, 'active')
     on conflict (team_id) do update set
       team_name = excluded.team_name, bot_token = excluded.bot_token,
       bot_user_id = excluded.bot_user_id, scopes = excluded.scopes, status = 'active'
     returning *`,
    [i.teamId, i.teamName, i.workspaceId, i.botToken, i.botUserId, i.scopes],
  );
  return rows[0];
}

export async function getLianaInstall(teamId: string): Promise<LianaInstall | null> {
  const { rows } = await pool.query<LianaInstall>(
    `select * from liana_slack_installs where team_id = $1`,
    [teamId],
  );
  return rows[0] ?? null;
}

export async function setLianaInstallStatus(teamId: string, status: "active" | "revoked"): Promise<void> {
  await pool.query(`update liana_slack_installs set status = $2 where team_id = $1`, [teamId, status]);
}

export interface LianaWorkflowRow {
  workflow_id: string;
  // Slack ownership context — null for workflows created by accounts with no Slack install
  // (iMessage/Telegram-only). The owner is always owner_participant_id.
  team_id: string | null;
  slack_user_id: string | null;
  owner_participant_id: string;
  dm_channel_id: string | null;
  origin_channel_id: string | null;
  origin_thread_ts: string | null;
  // The Telegram chat runs deliver to (a group chat, or a DM chat). Null = fall back to the
  // owner's private link chat. Mirrors origin_channel_id's role for Slack (bigint -> string).
  origin_telegram_chat_id: string | null;
  // Web toggle: deliver to the owner's personal DM even though this workflow was born in a
  // channel/group. Origin stays recorded, so it's reversible.
  deliver_dm_override: boolean;
  deliver_to: string[]; // "slack" | "imessage" | "telegram" (text[] — surfaces are values, not columns)
}

export async function setLianaDmOverride(workflowId: string, dmOnly: boolean): Promise<void> {
  await pool.query(`update liana_workflows set deliver_dm_override = $2 where workflow_id = $1`, [
    workflowId,
    dmOnly,
  ]);
}

export async function setLianaDeliverTo(workflowId: string, deliverTo: string[]): Promise<void> {
  await pool.query(`update liana_workflows set deliver_to = $2 where workflow_id = $1`, [
    workflowId,
    deliverTo,
  ]);
}

export async function insertLianaWorkflow(l: {
  workflowId: string;
  teamId: string | null;
  slackUserId: string | null;
  ownerParticipantId: string;
  originChannelId?: string | null;
  originThreadTs?: string | null;
  originTelegramChatId?: number | string | null;
  deliverTo?: string[];
}): Promise<LianaWorkflowRow> {
  const { rows } = await pool.query<LianaWorkflowRow>(
    `insert into liana_workflows
       (workflow_id, team_id, slack_user_id, owner_participant_id,
        origin_channel_id, origin_thread_ts, origin_telegram_chat_id, deliver_to)
     values ($1, $2, $3, $4, $5, $6, $7, $8) returning *`,
    [
      l.workflowId,
      l.teamId,
      l.slackUserId,
      l.ownerParticipantId,
      l.originChannelId ?? null,
      l.originThreadTs ?? null,
      l.originTelegramChatId ?? null,
      l.deliverTo ?? ["slack"],
    ],
  );
  return rows[0];
}

export async function getLianaWorkflow(workflowId: string): Promise<LianaWorkflowRow | null> {
  const { rows } = await pool.query<LianaWorkflowRow>(
    `select * from liana_workflows where workflow_id = $1`,
    [workflowId],
  );
  return rows[0] ?? null;
}

export async function listLianaWorkflowsForOwner(participantId: string): Promise<LianaWorkflowRow[]> {
  const { rows } = await pool.query<LianaWorkflowRow>(
    `select * from liana_workflows where owner_participant_id = $1 order by created_at desc`,
    [participantId],
  );
  return rows;
}

// Unconfirmed drafts born in the same conversation (origin channel + thread). A new draft in a
// conversation supersedes these — with memory, "make it 9am" re-drafts rather than stacking.
export async function listLianaDraftsByOrigin(
  ownerParticipantId: string,
  originChannelId: string,
  originThreadTs: string | null,
): Promise<LianaWorkflowRow[]> {
  const { rows } = await pool.query<LianaWorkflowRow>(
    `select lw.* from liana_workflows lw
     join workflows w on w.id = lw.workflow_id
     where lw.owner_participant_id = $1
       and lw.origin_channel_id = $2
       and lw.origin_thread_ts is not distinct from $3
       and w.status = 'draft'`,
    [ownerParticipantId, originChannelId, originThreadTs],
  );
  return rows;
}

export async function setLianaDmChannel(workflowId: string, dmChannelId: string): Promise<void> {
  await pool.query(`update liana_workflows set dm_channel_id = $2 where workflow_id = $1`, [
    workflowId,
    dmChannelId,
  ]);
}

// Insert-once delivery record. Returns true if this call claimed the delivery (caller should
// post to Slack), false if a previous attempt already recorded one (skip — idempotent).
export async function claimLianaDelivery(runId: string): Promise<boolean> {
  const { rowCount } = await pool.query(
    `insert into liana_deliveries (run_id, status) values ($1, 'delivered')
     on conflict (run_id) do nothing`,
    [runId],
  );
  return (rowCount ?? 0) > 0;
}

export async function markLianaDeliveryFailed(runId: string, error: string): Promise<void> {
  await pool.query(
    `update liana_deliveries set status = 'failed', error = $2 where run_id = $1`,
    [runId, error.slice(0, 500)],
  );
}

// Record the per-channel outcome map for a run's delivery ({"slack":"ok","imessage":"skipped: …"}).
export async function recordLianaDeliveryChannels(runId: string, channels: Record<string, string>): Promise<void> {
  await pool.query(`update liana_deliveries set channels = $2 where run_id = $1`, [runId, JSON.stringify(channels)]);
}

export interface LianaDeliveryRow {
  run_id: string;
  status: string;
  error: string | null;
  channels: Record<string, string>;
  delivered_at: string;
}

export async function getLianaDelivery(runId: string): Promise<LianaDeliveryRow | null> {
  const { rows } = await pool.query<LianaDeliveryRow>(
    `select run_id, status, error, channels, delivered_at from liana_deliveries where run_id = $1`,
    [runId],
  );
  return rows[0] ?? null;
}

// --- Phone links (iMessage channel, migration 030) ---

export interface LianaPhoneLink {
  participant_id: string;
  phone: string;
  verified_at: string | null;
  verify_code: string | null;
  verify_expires_at: string | null;
  pending_draft_id: string | null;
  linq_chat_id: string | null;
}

export async function getPhoneLink(participantId: string): Promise<LianaPhoneLink | null> {
  const { rows } = await pool.query<LianaPhoneLink>(
    `select * from liana_phone_links where participant_id = $1`,
    [participantId],
  );
  return rows[0] ?? null;
}

export async function getPhoneLinkByPhone(phone: string): Promise<LianaPhoneLink | null> {
  const { rows } = await pool.query<LianaPhoneLink>(
    `select * from liana_phone_links where phone = $1`,
    [phone],
  );
  return rows[0] ?? null;
}

// Start (or restart) verification: one row per participant, phone replaceable until verified.
export async function upsertPhoneLink(
  participantId: string,
  phone: string,
  code: string,
  expiresAt: string,
): Promise<void> {
  await pool.query(
    `insert into liana_phone_links (participant_id, phone, verify_code, verify_expires_at, verified_at)
     values ($1, $2, $3, $4, null)
     on conflict (participant_id) do update set
       phone = excluded.phone, verify_code = excluded.verify_code,
       verify_expires_at = excluded.verify_expires_at, verified_at = null`,
    [participantId, phone, code, expiresAt],
  );
}

export async function markPhoneVerified(participantId: string): Promise<void> {
  await pool.query(
    `update liana_phone_links set verified_at = now(), verify_code = null, verify_expires_at = null
     where participant_id = $1`,
    [participantId],
  );
}

export async function deletePhoneLink(participantId: string): Promise<void> {
  await pool.query(`delete from liana_phone_links where participant_id = $1`, [participantId]);
}

export async function setPhonePendingDraft(participantId: string, draftId: string | null): Promise<void> {
  await pool.query(`update liana_phone_links set pending_draft_id = $2 where participant_id = $1`, [
    participantId,
    draftId,
  ]);
}

export async function setPhoneLinqChat(participantId: string, chatId: string): Promise<void> {
  await pool.query(`update liana_phone_links set linq_chat_id = $2 where participant_id = $1`, [
    participantId,
    chatId,
  ]);
}

// Liana install lookup by workspace — the bridge from an iMessage sender (phone -> participant ->
// workspace) back to the Slack-rooted ownership context (team_id) workflows are keyed by.
export async function getLianaInstallByWorkspace(workspaceId: string): Promise<LianaInstall | null> {
  const { rows } = await pool.query<LianaInstall>(
    `select * from liana_slack_installs where workspace_id = $1 and status = 'active' limit 1`,
    [workspaceId],
  );
  return rows[0] ?? null;
}

// --- Telegram links (Telegram channel, migration 031) ---

export interface LianaTelegramLink {
  participant_id: string;
  chat_id: string | null; // bigint — pg returns it as a string
  telegram_user_id: string | null;
  telegram_username: string | null;
  link_code: string | null;
  link_code_expires_at: string | null;
  verified_at: string | null;
  pending_draft_id: string | null;
}

export async function getTelegramLink(participantId: string): Promise<LianaTelegramLink | null> {
  const { rows } = await pool.query<LianaTelegramLink>(
    `select * from liana_telegram_links where participant_id = $1`,
    [participantId],
  );
  return rows[0] ?? null;
}

export async function getTelegramLinkByChat(chatId: number): Promise<LianaTelegramLink | null> {
  const { rows } = await pool.query<LianaTelegramLink>(
    `select * from liana_telegram_links where chat_id = $1`,
    [chatId],
  );
  return rows[0] ?? null;
}

// Resolve a sender by their Telegram user id (not the chat) — the group case, where one chat
// holds many users. telegram_user_id isn't unique (a Telegram user could link more than one
// Liana account), so prefer the most recently verified link.
export async function getTelegramLinkByUser(telegramUserId: number): Promise<LianaTelegramLink | null> {
  const { rows } = await pool.query<LianaTelegramLink>(
    `select * from liana_telegram_links
     where telegram_user_id = $1 and verified_at is not null
     order by verified_at desc limit 1`,
    [telegramUserId],
  );
  return rows[0] ?? null;
}

// Start (or restart) linking: one row per participant, replaceable until /start completes it.
export async function upsertTelegramLinkCode(
  participantId: string,
  code: string,
  expiresAt: string,
): Promise<void> {
  await pool.query(
    `insert into liana_telegram_links (participant_id, link_code, link_code_expires_at)
     values ($1, $2, $3)
     on conflict (participant_id) do update set
       link_code = excluded.link_code, link_code_expires_at = excluded.link_code_expires_at`,
    [participantId, code, expiresAt],
  );
}

// Complete a deep-link /start: bind the chat to whoever holds the (unexpired) code. Returns the
// linked row, or null when the code is unknown/expired. Clearing any other row on this chat_id
// first keeps the unique constraint happy if someone relinks from a fresh Liana account.
export async function completeTelegramLink(args: {
  code: string;
  chatId: number;
  telegramUserId: number;
  username: string | null;
}): Promise<LianaTelegramLink | null> {
  await pool.query(
    `update liana_telegram_links set chat_id = null, verified_at = null
     where chat_id = $1 and link_code is distinct from $2`,
    [args.chatId, args.code],
  );
  const { rows } = await pool.query<LianaTelegramLink>(
    `update liana_telegram_links set
       chat_id = $2, telegram_user_id = $3, telegram_username = $4,
       verified_at = now(), link_code = null, link_code_expires_at = null
     where link_code = $1 and link_code_expires_at > now()
     returning *`,
    [args.code, args.chatId, args.telegramUserId, args.username],
  );
  return rows[0] ?? null;
}

export async function deleteTelegramLink(participantId: string): Promise<void> {
  await pool.query(`delete from liana_telegram_links where participant_id = $1`, [participantId]);
}

export async function setTelegramPendingDraft(participantId: string, draftId: string | null): Promise<void> {
  await pool.query(
    `update liana_telegram_links set pending_draft_id = $2 where participant_id = $1`,
    [participantId, draftId],
  );
}

// --- Per-user model settings (migration 029) ---

export interface LianaSettings {
  participant_id: string;
  liana_model: string | null;
  workflow_model: string | null;
  // The owner's persistent Liana agent (participants row), and whether the agent path is live for
  // them (migration 037). Null/false = the legacy stateless intake still answers.
  liana_agent_id: string | null;
  agent_enabled: boolean;
}

export async function getLianaSettings(participantId: string): Promise<LianaSettings | null> {
  const { rows } = await pool.query<LianaSettings>(
    `select participant_id, liana_model, workflow_model, liana_agent_id, agent_enabled
       from liana_settings where participant_id = $1`,
    [participantId],
  );
  return rows[0] ?? null;
}

// Record the owner's persistent Liana agent id (upsert — the settings row may not exist yet).
export async function setLianaAgentId(participantId: string, agentId: string): Promise<void> {
  await pool.query(
    `insert into liana_settings (participant_id, liana_agent_id)
     values ($1, $2)
     on conflict (participant_id) do update set liana_agent_id = excluded.liana_agent_id, updated_at = now()`,
    [participantId, agentId],
  );
}

// Reverse of liana_agent_id: the owner (participant id) whose Liana agent this is, or null. Used
// when a Liana agent finalizes a workflow, to register its ownership + delivery under the owner.
export async function getLianaOwnerByAgentId(agentId: string): Promise<string | null> {
  const { rows } = await pool.query<{ participant_id: string }>(
    `select participant_id from liana_settings where liana_agent_id = $1`,
    [agentId],
  );
  return rows[0]?.participant_id ?? null;
}

// Flip the per-owner rollout flag for the Liana-agent path (upsert).
export async function setLianaAgentEnabled(participantId: string, enabled: boolean): Promise<void> {
  await pool.query(
    `insert into liana_settings (participant_id, agent_enabled)
     values ($1, $2)
     on conflict (participant_id) do update set agent_enabled = excluded.agent_enabled, updated_at = now()`,
    [participantId, enabled],
  );
}

export async function upsertLianaSettings(
  participantId: string,
  patch: { lianaModel?: string | null; workflowModel?: string | null },
): Promise<LianaSettings> {
  const { rows } = await pool.query<LianaSettings>(
    `insert into liana_settings (participant_id, liana_model, workflow_model)
     values ($1, $2, $3)
     on conflict (participant_id) do update set
       liana_model    = case when $4 then excluded.liana_model    else liana_settings.liana_model end,
       workflow_model = case when $5 then excluded.workflow_model else liana_settings.workflow_model end,
       updated_at = now()
     returning participant_id, liana_model, workflow_model, liana_agent_id, agent_enabled`,
    [
      participantId,
      patch.lianaModel ?? null,
      patch.workflowModel ?? null,
      patch.lianaModel !== undefined,
      patch.workflowModel !== undefined,
    ],
  );
  return rows[0];
}

// Reverse of getUserLink: which Slack user a participant is, in a given team. Used when
// generating web-app links for an owner we resolved earlier.
export async function getSlackUserIdForParticipant(
  teamId: string,
  participantId: string,
): Promise<string | null> {
  const { rows } = await pool.query<{ slack_user_id: string }>(
    `select slack_user_id from slack_user_links where slack_team_id = $1 and participant_id = $2 limit 1`,
    [teamId, participantId],
  );
  return rows[0]?.slack_user_id ?? null;
}

// --- Account link codes (migration 032) ---

// Single-use codes binding a Slack identity to whoever completes Google sign-in on the web.
export interface LianaLinkCode {
  code: string;
  team_id: string;
  slack_user_id: string;
}

export async function insertLianaLinkCode(args: {
  code: string;
  teamId: string;
  slackUserId: string;
  expiresAt: string;
}): Promise<void> {
  // Opportunistic prune keeps the table tiny without a sweeper.
  await pool.query(`delete from liana_link_codes where expires_at < now() - interval '1 day'`);
  await pool.query(
    `insert into liana_link_codes (code, team_id, slack_user_id, expires_at) values ($1, $2, $3, $4)`,
    [args.code, args.teamId, args.slackUserId, args.expiresAt],
  );
}

// Redeem a code exactly once; null when unknown, expired, or already used.
export async function consumeLianaLinkCode(code: string): Promise<LianaLinkCode | null> {
  const { rows } = await pool.query<LianaLinkCode>(
    `update liana_link_codes set used_at = now()
     where code = $1 and used_at is null and expires_at > now()
     returning code, team_id, slack_user_id`,
    [code],
  );
  return rows[0] ?? null;
}

// --- Conversational memory (migration 033) ---

export interface LianaMessage {
  role: "user" | "assistant";
  body: string;
}

const MEMORY_BODY_MAX = 1500; // per-message cap keeps the intake context bounded
const MEMORY_KEEP_DAYS = 7; // TTL doubles as privacy hygiene

export async function appendLianaMessage(
  participantId: string,
  convoKey: string,
  role: "user" | "assistant",
  body: string,
): Promise<void> {
  const trimmed = body.trim();
  if (!trimmed) return;
  await pool.query(
    `insert into liana_messages (participant_id, convo_key, role, body) values ($1, $2, $3, $4)`,
    [participantId, convoKey, role, trimmed.slice(0, MEMORY_BODY_MAX)],
  );
  // Prune on write (index-assisted, so this stays cheap) — no sweeper process needed.
  await pool.query(
    `delete from liana_messages
     where participant_id = $1 and convo_key = $2 and created_at < now() - make_interval(days => $3)`,
    [participantId, convoKey, MEMORY_KEEP_DAYS],
  );
}

// The read window: last `limit` messages within `maxAgeHours`, oldest first. A conversation that
// went quiet for a day starts fresh — stale context is worse than none.
export async function recentLianaMessages(
  participantId: string,
  convoKey: string,
  limit = 12,
  maxAgeHours = 24,
): Promise<LianaMessage[]> {
  const { rows } = await pool.query<LianaMessage>(
    `select role, body from (
       select role, body, created_at from liana_messages
       where participant_id = $1 and convo_key = $2 and created_at > now() - make_interval(hours => $4)
       order by created_at desc limit $3
     ) recent order by created_at asc`,
    [participantId, convoKey, limit, maxAgeHours],
  );
  return rows;
}

// Cadence edit for a workflow's backing schedule row (web PATCH). The ticker reads cron/timezone
// on each fire, so updating the row + next_run_at is the whole change. run_at is nulled so a row
// that was previously one-shot flips cleanly back to recurring (the mig-012 check requires
// cron+timezone set XOR run_at set).
export async function updateBackingScheduleCadence(
  workflowId: string,
  cron: string,
  timezone: string,
  nextRunAt: string,
): Promise<void> {
  await pool.query(
    `update schedules set cron = $2, timezone = $3, run_at = null, next_run_at = $4 where workflow_id = $1`,
    [workflowId, cron, timezone, nextRunAt],
  );
}

// Flip a workflow's backing schedule row to a one-shot at `runAt` (recurring -> one-time edit).
// cron/timezone are nulled to satisfy the mig-012 check constraint; next_run_at = run_at so the
// ticker fires it once, then completes it.
export async function updateBackingScheduleOnce(workflowId: string, runAt: string): Promise<void> {
  await pool.query(
    `update schedules set cron = null, timezone = null, run_at = $2, next_run_at = $2 where workflow_id = $1`,
    [workflowId, runAt],
  );
}
