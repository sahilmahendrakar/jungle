import type { PoolClient } from "pg";
import { pool } from "./pool";

// Data access for the Slack integration (migrations/023_slack.sql, 045_slack_agent_app.sql). All
// bridge logic lives in services/slackBridge.ts + services/slackAgentBridge.ts and the routes in
// http/routes/slack.ts — this module is plain SQL.
//
// A workspace can hold TWO installs, distinguished by `kind`: the original channel-mirror app
// ('mirror') and the agent app that backs @jungle's Slack DM ('agent'). They are separate Slack
// apps because `features.agent_view` is an irreversible per-app switch. Every function here
// defaults to 'mirror' so existing callers keep their exact behavior.

export type SlackInstallKind = "mirror" | "agent";

export interface SlackInstall {
  workspace_id: string;
  team_id: string;
  team_name: string | null;
  bot_token: string;
  bot_user_id: string;
  bot_id: string | null;
  scopes: string | null;
  installed_by: string | null;
  status: "active" | "revoked";
  kind: SlackInstallKind;
  created_at: string;
}

// One row is either a channel mirror (dm_agent_id null — the original feature) or an agent's DM
// binding (dm_agent_id set: a Jungle DM channel <-> a Slack IM "D…"). Modelling the DM as a link
// is what lets ingress and the entire transactional outbox serve DMs with no new code.
export interface SlackChannelLinkRow {
  id: string;
  workspace_id: string;
  jungle_channel_id: string;
  slack_team_id: string;
  slack_channel_id: string;
  slack_channel_name: string | null;
  status: "active" | "error";
  last_error: string | null;
  created_by: string | null;
  install_kind: SlackInstallKind;
  dm_agent_id: string | null;
  dm_slack_user_id: string | null;
  created_at: string;
}

export interface SlackUserLink {
  slack_team_id: string;
  slack_user_id: string;
  participant_id: string;
  kind: "shadow" | "linked";
}

export interface SlackMessageLink {
  jungle_message_id: string;
  slack_team_id: string;
  slack_channel_id: string;
  slack_ts: string;
  slack_thread_ts: string | null;
  origin: "slack" | "jungle";
}

// --- Installs ---

export async function upsertSlackInstall(i: {
  workspaceId: string;
  teamId: string;
  teamName: string | null;
  botToken: string;
  botUserId: string;
  botId: string | null;
  scopes: string | null;
  installedBy: string | null;
  kind?: SlackInstallKind;
}): Promise<SlackInstall> {
  const { rows } = await pool.query<SlackInstall>(
    `insert into slack_installs
       (workspace_id, team_id, team_name, bot_token, bot_user_id, bot_id, scopes, installed_by, status, kind)
     values ($1, $2, $3, $4, $5, $6, $7, $8, 'active', $9)
     on conflict (workspace_id, kind) do update set
       team_id = excluded.team_id, team_name = excluded.team_name, bot_token = excluded.bot_token,
       bot_user_id = excluded.bot_user_id, bot_id = excluded.bot_id, scopes = excluded.scopes,
       installed_by = excluded.installed_by, status = 'active'
     returning *`,
    [i.workspaceId, i.teamId, i.teamName, i.botToken, i.botUserId, i.botId, i.scopes, i.installedBy, i.kind ?? "mirror"],
  );
  return rows[0];
}

export async function getSlackInstallByWorkspace(
  workspaceId: string,
  kind: SlackInstallKind = "mirror",
): Promise<SlackInstall | null> {
  const { rows } = await pool.query<SlackInstall>(
    `select * from slack_installs where workspace_id = $1 and kind = $2`,
    [workspaceId, kind],
  );
  return rows[0] ?? null;
}

export async function getSlackInstallByTeam(
  teamId: string,
  kind: SlackInstallKind = "mirror",
): Promise<SlackInstall | null> {
  const { rows } = await pool.query<SlackInstall>(
    `select * from slack_installs where team_id = $1 and kind = $2`,
    [teamId, kind],
  );
  return rows[0] ?? null;
}

export async function setInstallStatus(
  workspaceId: string,
  status: "active" | "revoked",
  kind: SlackInstallKind = "mirror",
): Promise<void> {
  await pool.query(`update slack_installs set status = $2 where workspace_id = $1 and kind = $3`, [
    workspaceId,
    status,
    kind,
  ]);
}

export async function deleteSlackInstall(
  workspaceId: string,
  kind: SlackInstallKind = "mirror",
): Promise<void> {
  await pool.query(`delete from slack_installs where workspace_id = $1 and kind = $2`, [workspaceId, kind]);
}

// --- Channel links ---

export async function createChannelLink(l: {
  workspaceId: string;
  jungleChannelId: string;
  slackTeamId: string;
  slackChannelId: string;
  slackChannelName: string | null;
  createdBy: string | null;
  installKind?: SlackInstallKind;
  dmAgentId?: string | null;
  dmSlackUserId?: string | null;
}): Promise<SlackChannelLinkRow> {
  const { rows } = await pool.query<SlackChannelLinkRow>(
    `insert into slack_channel_links
       (workspace_id, jungle_channel_id, slack_team_id, slack_channel_id, slack_channel_name,
        created_by, install_kind, dm_agent_id, dm_slack_user_id)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     returning *`,
    [
      l.workspaceId,
      l.jungleChannelId,
      l.slackTeamId,
      l.slackChannelId,
      l.slackChannelName,
      l.createdBy,
      l.installKind ?? "mirror",
      l.dmAgentId ?? null,
      l.dmSlackUserId ?? null,
    ],
  );
  return rows[0];
}

// The DM binding for one (agent, Slack user) pair, if it exists. Used to decide whether an inbound
// message.im needs a fresh binding or already has one.
export async function getDmLink(
  agentId: string,
  slackUserId: string,
): Promise<SlackChannelLinkRow | null> {
  const { rows } = await pool.query<SlackChannelLinkRow>(
    `select * from slack_channel_links where dm_agent_id = $1 and dm_slack_user_id = $2`,
    [agentId, slackUserId],
  );
  return rows[0] ?? null;
}

export async function getLinkByJungleChannel(jungleChannelId: string): Promise<SlackChannelLinkRow | null> {
  const { rows } = await pool.query<SlackChannelLinkRow>(
    `select * from slack_channel_links where jungle_channel_id = $1`,
    [jungleChannelId],
  );
  return rows[0] ?? null;
}

export async function getLinkBySlackChannel(
  teamId: string,
  slackChannelId: string,
): Promise<SlackChannelLinkRow | null> {
  const { rows } = await pool.query<SlackChannelLinkRow>(
    `select * from slack_channel_links where slack_team_id = $1 and slack_channel_id = $2`,
    [teamId, slackChannelId],
  );
  return rows[0] ?? null;
}

export async function deleteChannelLink(jungleChannelId: string): Promise<boolean> {
  const { rowCount } = await pool.query(
    `delete from slack_channel_links where jungle_channel_id = $1`,
    [jungleChannelId],
  );
  return (rowCount ?? 0) > 0;
}

// Flip a link into the 'error' state (halts enqueue + ingress) with a reason, for the UI badge.
export async function setLinkError(linkId: string, error: string): Promise<SlackChannelLinkRow | null> {
  const { rows } = await pool.query<SlackChannelLinkRow>(
    `update slack_channel_links set status = 'error', last_error = $2 where id = $1 returning *`,
    [linkId, error],
  );
  return rows[0] ?? null;
}

// --- User links ---

export async function getUserLink(teamId: string, slackUserId: string): Promise<SlackUserLink | null> {
  const { rows } = await pool.query<SlackUserLink>(
    `select * from slack_user_links where slack_team_id = $1 and slack_user_id = $2`,
    [teamId, slackUserId],
  );
  return rows[0] ?? null;
}

export async function insertUserLink(l: {
  teamId: string;
  slackUserId: string;
  participantId: string;
  kind: "shadow" | "linked";
}): Promise<void> {
  await pool.query(
    `insert into slack_user_links (slack_team_id, slack_user_id, participant_id, kind)
     values ($1, $2, $3, $4)
     on conflict (slack_team_id, slack_user_id) do nothing`,
    [l.teamId, l.slackUserId, l.participantId, l.kind],
  );
}

// --- Message links ---

export async function insertMessageLink(
  l: {
    jungleMessageId: string;
    teamId: string;
    slackChannelId: string;
    slackTs: string;
    slackThreadTs: string | null;
    origin: "slack" | "jungle";
  },
  client?: PoolClient,
): Promise<void> {
  await (client ?? pool).query(
    `insert into slack_message_links
       (jungle_message_id, slack_team_id, slack_channel_id, slack_ts, slack_thread_ts, origin)
     values ($1, $2, $3, $4, $5, $6)
     on conflict (jungle_message_id) do nothing`,
    [l.jungleMessageId, l.teamId, l.slackChannelId, l.slackTs, l.slackThreadTs, l.origin],
  );
}

export async function getMessageLinkByJungleId(jungleMessageId: string): Promise<SlackMessageLink | null> {
  const { rows } = await pool.query<SlackMessageLink>(
    `select * from slack_message_links where jungle_message_id = $1`,
    [jungleMessageId],
  );
  return rows[0] ?? null;
}

// Forget a message mapping — used after the Slack copy is deleted (services/messages.ts), so a
// later thread reply can't try to hang off a ts that no longer exists.
export async function deleteMessageLink(jungleMessageId: string): Promise<void> {
  await pool.query(`delete from slack_message_links where jungle_message_id = $1`, [jungleMessageId]);
}

export async function getMessageLinkBySlackTs(
  teamId: string,
  slackChannelId: string,
  slackTs: string,
): Promise<SlackMessageLink | null> {
  const { rows } = await pool.query<SlackMessageLink>(
    `select * from slack_message_links
     where slack_team_id = $1 and slack_channel_id = $2 and slack_ts = $3`,
    [teamId, slackChannelId, slackTs],
  );
  return rows[0] ?? null;
}

// --- Event dedupe ---

// Record an event_id; returns true if it was NEW (i.e. safe to process), false if already seen.
export async function recordSlackEvent(eventId: string): Promise<boolean> {
  const { rowCount } = await pool.query(
    `insert into slack_events (event_id) values ($1) on conflict (event_id) do nothing`,
    [eventId],
  );
  return (rowCount ?? 0) > 0;
}

export async function pruneSlackEvents(olderThanHours = 24): Promise<void> {
  await pool.query(
    `delete from slack_events where received_at < now() - ($1 || ' hours')::interval`,
    [String(olderThanHours)],
  );
}

// --- Outbox (egress) ---

// Enqueue a mirror-to-Slack job IF the channel is linked and active. Runs inside persistMessage's
// transaction (message + mirror-intent commit atomically). No-op when the channel isn't linked.
export async function enqueueOutboxIfLinked(
  client: PoolClient,
  channelId: string,
  messageId: string,
): Promise<void> {
  await client.query(
    `insert into slack_outbox (link_id, jungle_message_id)
     select id, $2 from slack_channel_links where jungle_channel_id = $1 and status = 'active'`,
    [channelId, messageId],
  );
}

// Everything the egress ticker needs to post one message, joined in one claim.
export interface OutboxJob {
  outbox_id: string;
  attempts: number;
  message_id: string;
  body: string;
  thread_root_id: string | null;
  also_to_channel: boolean;
  sender_display_name: string;
  sender_avatar_url: string | null;
  link_id: string;
  slack_channel_id: string;
  slack_team_id: string;
  bot_token: string;
  bot_id: string | null;
  install_kind: SlackInstallKind;
  workspace_id: string;
}

// Claim due jobs (pending, due, under an active link + active install), oldest first per link.
// FOR UPDATE OF the outbox row + SKIP LOCKED so overlapping tickers claim disjoint rows.
export async function claimDueOutbox(client: PoolClient, limit = 50): Promise<OutboxJob[]> {
  const { rows } = await client.query<OutboxJob>(
    `select o.id as outbox_id, o.attempts,
            m.id as message_id, m.body, m.thread_root_id, m.also_to_channel,
            p.display_name as sender_display_name, p.avatar_url as sender_avatar_url,
            l.id as link_id, l.slack_channel_id, l.slack_team_id,
            i.bot_token, i.bot_id, i.kind as install_kind, i.workspace_id
     from slack_outbox o
     -- Deleted messages (soft delete, migration 048) drop out of the drain: a message deleted
     -- between the post and the mirror must not still show up in Slack. softDeleteMessage also
     -- removes the pending job outright — this is the belt to that suspenders, and it covers a
     -- job already claimed by an in-flight ticker.
     join messages m on m.id = o.jungle_message_id and m.deleted_at is null
     join participants p on p.id = m.sender_id
     join slack_channel_links l on l.id = o.link_id
     -- Match the install that OWNS this link: a workspace can have both the mirror app and the
     -- agent app installed, and posting a DM reply with the mirror's token would speak as the
     -- wrong bot (or fail outright).
     join slack_installs i on i.workspace_id = l.workspace_id and i.kind = l.install_kind
     where o.status = 'pending' and o.next_attempt_at <= now()
       and l.status = 'active' and i.status = 'active'
     order by o.link_id, o.id
     for update of o skip locked
     limit $1`,
    [limit],
  );
  return rows;
}

// Lease claimed rows: push next_attempt_at out so a crash mid-send doesn't wedge them (they
// simply become due again after the lease). Runs in the same txn as claimDueOutbox.
export async function leaseOutbox(client: PoolClient, outboxIds: string[], seconds: number): Promise<void> {
  if (!outboxIds.length) return;
  await client.query(
    `update slack_outbox set next_attempt_at = now() + ($2 || ' seconds')::interval
     where id = any($1::bigint[])`,
    [outboxIds, String(seconds)],
  );
}

export async function markOutboxDelivered(outboxId: string, client?: PoolClient): Promise<void> {
  await (client ?? pool).query(
    `update slack_outbox set status = 'delivered' where id = $1`,
    [outboxId],
  );
}

// Transient failure: bump attempts + back off. Caller supplies the next attempt time.
export async function bumpOutboxRetry(outboxId: string, nextAttemptAt: string, error: string): Promise<void> {
  await pool.query(
    `update slack_outbox set attempts = attempts + 1, next_attempt_at = $2, last_error = $3 where id = $1`,
    [outboxId, nextAttemptAt, error],
  );
}

export async function markOutboxFailed(outboxId: string, error: string): Promise<void> {
  await pool.query(
    `update slack_outbox set status = 'failed', last_error = $2 where id = $1`,
    [outboxId, error],
  );
}

// 429 backpressure: push out ALL of a link's pending rows (Slack's ~1 msg/sec/channel limit is
// per channel, so the whole link's queue must wait, not just this row). Doesn't touch attempts.
export async function deferLinkOutbox(linkId: string, untilIso: string): Promise<void> {
  await pool.query(
    `update slack_outbox set next_attempt_at = greatest(next_attempt_at, $2)
     where link_id = $1 and status = 'pending'`,
    [linkId, untilIso],
  );
}
