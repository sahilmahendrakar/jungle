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
  team_id: string;
  slack_user_id: string;
  owner_participant_id: string;
  dm_channel_id: string | null;
  origin_channel_id: string | null;
  origin_thread_ts: string | null;
  deliver_to: string[]; // "slack" | "imessage" (text[] — future channels are values, not columns)
}

export async function setLianaDeliverTo(workflowId: string, deliverTo: string[]): Promise<void> {
  await pool.query(`update liana_workflows set deliver_to = $2 where workflow_id = $1`, [
    workflowId,
    deliverTo,
  ]);
}

export async function insertLianaWorkflow(l: {
  workflowId: string;
  teamId: string;
  slackUserId: string;
  ownerParticipantId: string;
  originChannelId?: string | null;
  originThreadTs?: string | null;
  deliverTo?: string[];
}): Promise<LianaWorkflowRow> {
  const { rows } = await pool.query<LianaWorkflowRow>(
    `insert into liana_workflows
       (workflow_id, team_id, slack_user_id, owner_participant_id, origin_channel_id, origin_thread_ts, deliver_to)
     values ($1, $2, $3, $4, $5, $6, $7) returning *`,
    [
      l.workflowId,
      l.teamId,
      l.slackUserId,
      l.ownerParticipantId,
      l.originChannelId ?? null,
      l.originThreadTs ?? null,
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

export async function listLianaWorkflowsForOwner(
  teamId: string,
  slackUserId: string,
): Promise<LianaWorkflowRow[]> {
  const { rows } = await pool.query<LianaWorkflowRow>(
    `select * from liana_workflows where team_id = $1 and slack_user_id = $2 order by created_at desc`,
    [teamId, slackUserId],
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

// --- Per-user model settings (migration 029) ---

export interface LianaSettings {
  participant_id: string;
  liana_model: string | null;
  workflow_model: string | null;
}

export async function getLianaSettings(participantId: string): Promise<LianaSettings | null> {
  const { rows } = await pool.query<LianaSettings>(
    `select participant_id, liana_model, workflow_model from liana_settings where participant_id = $1`,
    [participantId],
  );
  return rows[0] ?? null;
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
     returning participant_id, liana_model, workflow_model`,
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

// Cadence edit for a workflow's backing schedule row (web PATCH). The ticker reads cron/timezone
// on each fire, so updating the row + next_run_at is the whole change.
export async function updateBackingScheduleCadence(
  workflowId: string,
  cron: string,
  timezone: string,
  nextRunAt: string,
): Promise<void> {
  await pool.query(
    `update schedules set cron = $2, timezone = $3, next_run_at = $4 where workflow_id = $1`,
    [workflowId, cron, timezone, nextRunAt],
  );
}
