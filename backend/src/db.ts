import "./env";
import pg from "pg";

const { Pool } = pg;
export const pool = new Pool({ connectionString: process.env.DATABASE_URL });

export type Kind = "human" | "agent";

export interface Participant {
  id: string;
  kind: Kind;
  handle: string;
  display_name: string;
  repo: string | null;
  firebase_uid: string | null;
  email: string | null;
  avatar_url: string | null;
  model: string | null; // agent model override (null = agent-config default)
  mode: string; // an SDK permission mode: default|acceptEdits|plan|bypassPermissions|dontAsk
  runtime: string; // 'sdk' (all agents; legacy 'ma' rows may exist on old databases)
  runner_token: string | null; // per-agent runner secret
}

export interface PersistedMessage {
  id: string;
  channel_id: string;
  seq: string; // bigint serialized as string
  sender_id: string;
  sender_handle: string;
  body: string;
  created_at: string;
  cascade_budget: number | null;
  mentions: { id: string; handle: string }[];
}

export async function createParticipant(p: {
  kind: Kind;
  handle: string;
  displayName: string;
  repo?: string | null;
  firebaseUid?: string | null;
  email?: string | null;
  avatarUrl?: string | null;
  model?: string | null;
  mode?: string | null;
  runtime?: string | null;
  runnerToken?: string | null;
}): Promise<Participant> {
  const { rows } = await pool.query<Participant>(
    `insert into participants
       (kind, handle, display_name, repo, firebase_uid, email, avatar_url,
        model, mode, runtime, runner_token)
     values ($1, $2, $3, $4, $5, $6, $7, $8, coalesce($9, 'default'),
             coalesce($10, 'sdk'), $11)
     returning *`,
    [
      p.kind, p.handle, p.displayName, p.repo ?? null,
      p.firebaseUid ?? null, p.email ?? null, p.avatarUrl ?? null,
      p.model ?? null, p.mode ?? null, p.runtime ?? null, p.runnerToken ?? null,
    ],
  );
  return rows[0];
}

// Patch an agent's editable config (display name / permission mode). Agents only; returns the
// updated row (null if the id isn't an agent). No-op patches just return the current row.
export async function updateAgentConfig(
  id: string,
  patch: { displayName?: string; mode?: string; model?: string },
): Promise<Participant | null> {
  const sets: string[] = [];
  const vals: unknown[] = [];
  if (patch.displayName !== undefined) {
    vals.push(patch.displayName);
    sets.push(`display_name = $${vals.length}`);
  }
  if (patch.mode !== undefined) {
    vals.push(patch.mode);
    sets.push(`mode = $${vals.length}`);
  }
  if (patch.model !== undefined) {
    vals.push(patch.model);
    sets.push(`model = $${vals.length}`);
  }
  if (!sets.length) {
    const p = await getParticipant(id);
    return p && p.kind === "agent" ? p : null;
  }
  vals.push(id);
  const { rows } = await pool.query<Participant>(
    `update participants set ${sets.join(", ")} where id = $${vals.length} and kind = 'agent' returning *`,
    vals,
  );
  return rows[0] ?? null;
}

// Look up the human participant linked to a Firebase Auth uid (null if not onboarded yet).
export async function getParticipantByFirebaseUid(uid: string): Promise<Participant | null> {
  const { rows } = await pool.query<Participant>(
    `select * from participants where firebase_uid = $1`,
    [uid],
  );
  return rows[0] ?? null;
}

// Is a handle free? (case-insensitive; handles are unique). Used to validate onboarding.
export async function handleAvailable(handle: string): Promise<boolean> {
  const { rows } = await pool.query(`select 1 from participants where lower(handle) = lower($1)`, [handle]);
  return rows.length === 0;
}

export async function createChannel(c: {
  name: string;
  kind: "channel" | "dm";
  memberHandles: string[];
}): Promise<{ id: string; name: string; kind: string }> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    const { rows } = await client.query(
      `insert into channels (name, kind) values ($1, $2) returning *`,
      [c.name, c.kind],
    );
    const channel = rows[0];
    if (c.memberHandles.length) {
      await client.query(
        `insert into channel_members (channel_id, participant_id)
         select $1, id from participants where handle = any($2)`,
        [channel.id, c.memberHandles],
      );
    }
    await client.query("commit");
    return channel;
  } catch (e) {
    await client.query("rollback");
    throw e;
  } finally {
    client.release();
  }
}

export async function channelMemberIds(channelId: string): Promise<string[]> {
  const { rows } = await pool.query<{ participant_id: string }>(
    `select participant_id from channel_members where channel_id = $1`,
    [channelId],
  );
  return rows.map((r) => r.participant_id);
}

// Add a participant to a channel (idempotent). Used to auto-add an @mentioned agent so it
// can reply in the channel it was summoned into.
export async function addChannelMember(channelId: string, participantId: string): Promise<void> {
  await pool.query(
    `insert into channel_members (channel_id, participant_id) values ($1, $2)
     on conflict do nothing`,
    [channelId, participantId],
  );
}

export async function isMember(channelId: string, participantId: string): Promise<boolean> {
  const { rows } = await pool.query(
    `select 1 from channel_members where channel_id = $1 and participant_id = $2`,
    [channelId, participantId],
  );
  return rows.length > 0;
}

export async function resolveMentions(body: string): Promise<{ id: string; handle: string }[]> {
  // Handles may contain hyphens (e.g. "sahils-agent"), so include "-" in the mention charset.
  const handles = [...new Set([...body.matchAll(/@([a-zA-Z0-9_-]+)/g)].map((m) => m[1]))];
  if (!handles.length) return [];
  const { rows } = await pool.query<{ id: string; handle: string }>(
    `select id, handle from participants where handle = any($1)`,
    [handles],
  );
  return rows;
}

// All participants, for the dev sign-in screen (newest last).
export async function listParticipants(): Promise<Participant[]> {
  const { rows } = await pool.query<Participant>(
    `select * from participants order by created_at`,
  );
  return rows;
}

export async function getParticipant(id: string): Promise<Participant | null> {
  const { rows } = await pool.query<Participant>(`select * from participants where id = $1`, [id]);
  return rows[0] ?? null;
}

// The persistence half of the routing rule: store the message (assign seq), record
// mentions. Idempotent on (sender_id, client_msg_id) for optimistic-send dedupe.
export async function persistMessage(args: {
  channelId: string;
  senderId: string;
  body: string;
  clientMsgId?: string | null;
  cascadeBudget?: number | null;
}): Promise<PersistedMessage> {
  const mentions = await resolveMentions(args.body);
  const client = await pool.connect();
  try {
    await client.query("begin");
    const ins = await client.query(
      `insert into messages (channel_id, sender_id, body, client_msg_id, cascade_budget)
       values ($1, $2, $3, $4, $5)
       on conflict (sender_id, client_msg_id) where client_msg_id is not null do nothing
       returning *`,
      [args.channelId, args.senderId, args.body, args.clientMsgId ?? null, args.cascadeBudget ?? null],
    );
    let msg = ins.rows[0];
    if (msg) {
      if (mentions.length) {
        await client.query(
          `insert into mentions (message_id, participant_id) select $1, unnest($2::uuid[])`,
          [msg.id, mentions.map((m) => m.id)],
        );
      }
    } else {
      // conflict (duplicate client_msg_id) — return the existing row
      const ex = await client.query(
        `select * from messages where sender_id = $1 and client_msg_id = $2`,
        [args.senderId, args.clientMsgId],
      );
      msg = ex.rows[0];
    }
    await client.query("commit");
    const sender = await getParticipant(msg.sender_id);
    return {
      id: msg.id,
      channel_id: msg.channel_id,
      seq: String(msg.seq),
      sender_id: msg.sender_id,
      sender_handle: sender?.handle ?? "?",
      body: msg.body,
      created_at: msg.created_at,
      cascade_budget: msg.cascade_budget ?? null,
      mentions,
    };
  } catch (e) {
    await client.query("rollback");
    throw e;
  } finally {
    client.release();
  }
}

export async function getMessages(channelId: string, afterSeq = 0): Promise<PersistedMessage[]> {
  const { rows } = await pool.query(
    `select m.*, p.handle as sender_handle
     from messages m join participants p on p.id = m.sender_id
     where m.channel_id = $1 and m.seq > $2
     order by m.seq`,
    [channelId, afterSeq],
  );
  return rows.map((r) => ({
    id: r.id,
    channel_id: r.channel_id,
    seq: String(r.seq),
    sender_id: r.sender_id,
    sender_handle: r.sender_handle,
    body: r.body,
    created_at: r.created_at,
    cascade_budget: r.cascade_budget ?? null,
    mentions: [],
  }));
}

export async function getChannel(
  id: string,
): Promise<{ id: string; name: string; kind: string } | null> {
  const { rows } = await pool.query(`select id, name, kind from channels where id = $1`, [id]);
  return rows[0] ?? null;
}

// Recent messages oldest -> newest, rendered for feeding an agent context on mention.
export async function getRecentContext(channelId: string, limit = 20): Promise<string> {
  const { rows } = await pool.query<{ handle: string; body: string }>(
    `select p.handle, m.body from messages m join participants p on p.id = m.sender_id
     where m.channel_id = $1 order by m.seq desc limit $2`,
    [channelId, limit],
  );
  return rows
    .reverse()
    .map((r) => `@${r.handle}: ${r.body}`)
    .join("\n");
}

export interface AgentRow {
  id: string;
  handle: string;
  display_name: string;
  repo: string | null;
  model: string | null;
  mode: string;
  runtime: string; // 'sdk'
  runner_token: string | null;
}

// Of the given participant ids, the ones that are agents.
export async function agentsByIds(ids: string[]): Promise<AgentRow[]> {
  if (!ids.length) return [];
  const { rows } = await pool.query<AgentRow>(
    `select id, handle, display_name, repo, model, mode, runtime, runner_token
     from participants
     where kind = 'agent' and id = any($1)`,
    [ids],
  );
  return rows;
}

// The agent bound to a runner_token. Authenticates a runner's inbound WebSocket.
// Returns the full AgentRow so the caller can build `configure`.
export async function agentByRunnerToken(token: string): Promise<AgentRow | null> {
  if (!token) return null;
  const { rows } = await pool.query<AgentRow>(
    `select id, handle, display_name, repo, model, mode, runtime, runner_token
     from participants
     where kind = 'agent' and runner_token = $1`,
    [token],
  );
  return rows[0] ?? null;
}

// Fetch a single agent by id, for the runner registry / lifecycle.
export async function getAgentRow(id: string): Promise<AgentRow | null> {
  const { rows } = await pool.query<AgentRow>(
    `select id, handle, display_name, repo, model, mode, runtime, runner_token
     from participants
     where kind = 'agent' and id = $1`,
    [id],
  );
  return rows[0] ?? null;
}

// --- SDK runner: durable inbox + event log ---

export interface InboxItem {
  id: string;
  text: string;
}

// Queue one composed input for an sdk agent. Returns the new row's id.
export async function enqueueInboxItem(agentId: string, text: string): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    `insert into agent_inbox (agent_id, text) values ($1, $2) returning id`,
    [agentId, text],
  );
  return rows[0].id;
}

// Undelivered inbox items for an agent, oldest first — the drain set.
export async function pendingInbox(agentId: string): Promise<InboxItem[]> {
  const { rows } = await pool.query<InboxItem>(
    `select id, text from agent_inbox
     where agent_id = $1 and delivered_at is null order by created_at`,
    [agentId],
  );
  return rows;
}

// Mark inbox items delivered (the runner acked them via `consumed`), recording the turn.
export async function markInboxConsumed(
  agentId: string,
  inboxIds: string[],
  turnId: string | null,
): Promise<void> {
  if (!inboxIds.length) return;
  await pool.query(
    `update agent_inbox set delivered_at = now(), turn_id = coalesce(turn_id, $3)
     where agent_id = $1 and id = any($2::uuid[]) and delivered_at is null`,
    [agentId, inboxIds, turnId],
  );
}

// Persist one SDK stream event from a runner (for the Activity feed).
export async function insertAgentEvent(
  agentId: string,
  turnId: string | null,
  event: unknown,
): Promise<void> {
  await pool.query(
    `insert into agent_events (agent_id, turn_id, event) values ($1, $2, $3)`,
    [agentId, turnId, JSON.stringify(event)],
  );
}

// Page of persisted SDK events for an agent, newest-first (Activity feed history).
// `before` (an event id) pages backwards; rows come back newest-first, caller reverses.
export async function listAgentEvents(
  agentId: string,
  opts: { before?: number; limit?: number } = {},
): Promise<{ id: number; turn_id: string | null; event: unknown; created_at: string }[]> {
  const limit = Math.min(Math.max(opts.limit ?? 200, 1), 500);
  const { rows } = await pool.query(
    `select id, turn_id, event, created_at from agent_events
     where agent_id = $1 and ($2::bigint is null or id < $2)
     order by id desc limit $3`,
    [agentId, opts.before ?? null, limit],
  );
  return rows;
}

export interface ChannelListItem {
  id: string;
  name: string;
  kind: string;
  dm_with: string | null;
  unread_count: number; // messages after the requester's last_read_seq, excluding their own
  has_mention: boolean; // any unread message @mentions the requester
}

export async function listChannels(participantId?: string): Promise<ChannelListItem[]> {
  if (participantId) {
    // For DMs, also surface the other member's handle so the UI can label it "@them".
    // unread_count / has_mention are computed in one aggregate pass (no N+1): for each channel
    // the participant belongs to, join its messages newer than the participant's last_read_seq
    // (0 if they've never read it), skip messages they sent themselves, and count them / flag
    // whether any is a mention of them.
    const { rows } = await pool.query(
      `select c.id, c.name, c.kind,
              case when c.kind = 'dm' then (
                select p.handle from channel_members m
                join participants p on p.id = m.participant_id
                where m.channel_id = c.id and m.participant_id <> $1 limit 1
              ) end as dm_with,
              count(msg.id)::int as unread_count,
              coalesce(bool_or(mention.participant_id is not null), false) as has_mention
       from channels c
       join channel_members cm on cm.channel_id = c.id
       left join channel_reads cr on cr.channel_id = c.id and cr.participant_id = $1
       left join messages msg
              on msg.channel_id = c.id
             and msg.seq > coalesce(cr.last_read_seq, 0)
             and msg.sender_id <> $1
       left join mentions mention
              on mention.message_id = msg.id and mention.participant_id = $1
       where cm.participant_id = $1
       group by c.id, c.name, c.kind, c.created_at
       order by c.created_at`,
      [participantId],
    );
    return rows;
  }
  const { rows } = await pool.query(
    `select id, name, kind, null as dm_with, 0 as unread_count, false as has_mention
     from channels order by created_at`,
  );
  return rows;
}

// Mark a channel read for a participant: set last_read_seq to `seq` (defaulting to the
// channel's current max message seq). Never lowers an existing marker (greatest()), so a stale
// client read can't un-read newer messages. Upsert keyed on (channel, participant).
export async function markChannelRead(
  channelId: string,
  participantId: string,
  seq?: number | null,
): Promise<number> {
  const target =
    seq != null && Number.isFinite(seq)
      ? String(seq)
      : (
          await pool.query<{ max: string | null }>(
            `select max(seq)::text as max from messages where channel_id = $1`,
            [channelId],
          )
        ).rows[0]?.max ?? "0";
  const { rows } = await pool.query<{ last_read_seq: string }>(
    `insert into channel_reads (channel_id, participant_id, last_read_seq, updated_at)
     values ($1, $2, $3, now())
     on conflict (channel_id, participant_id) do update
       set last_read_seq = greatest(channel_reads.last_read_seq, excluded.last_read_seq),
           updated_at = now()
     returning last_read_seq::text`,
    [channelId, participantId, target],
  );
  return Number(rows[0]?.last_read_seq ?? 0);
}

export async function getChannelByNameForMember(
  name: string,
  participantId: string,
): Promise<{ id: string; name: string; kind: string } | null> {
  const { rows } = await pool.query(
    `select c.id, c.name, c.kind from channels c
     join channel_members cm on cm.channel_id = c.id
     where c.name = $1 and cm.participant_id = $2 order by c.created_at limit 1`,
    [name, participantId],
  );
  return rows[0] ?? null;
}

export async function getParticipantByHandle(handle: string): Promise<Participant | null> {
  const { rows } = await pool.query<Participant>(`select * from participants where handle = $1`, [handle]);
  return rows[0] ?? null;
}

// --- GitHub identities (Step 7) ---

export interface GithubIdentity {
  participant_id: string;
  github_login: string;
  github_user_id: string; // bigint serialized as string
  access_token: string;
  refresh_token: string | null;
  access_expires_at: string | null;
  refresh_expires_at: string | null;
  scopes: string | null;
}

// Store (or replace) the GitHub account connected to a participant.
export async function upsertGithubIdentity(i: {
  participantId: string;
  githubLogin: string;
  githubUserId: number;
  accessToken: string;
  refreshToken: string | null;
  accessExpiresAt: Date | null;
  refreshExpiresAt: Date | null;
  scopes: string | null;
}): Promise<void> {
  await pool.query(
    `insert into github_identities
       (participant_id, github_login, github_user_id, access_token, refresh_token,
        access_expires_at, refresh_expires_at, scopes, updated_at)
     values ($1,$2,$3,$4,$5,$6,$7,$8, now())
     on conflict (participant_id) do update set
       github_login = excluded.github_login,
       github_user_id = excluded.github_user_id,
       access_token = excluded.access_token,
       refresh_token = excluded.refresh_token,
       access_expires_at = excluded.access_expires_at,
       refresh_expires_at = excluded.refresh_expires_at,
       scopes = excluded.scopes,
       updated_at = now()`,
    [
      i.participantId, i.githubLogin, i.githubUserId, i.accessToken, i.refreshToken,
      i.accessExpiresAt, i.refreshExpiresAt, i.scopes,
    ],
  );
}

export async function getGithubIdentity(participantId: string): Promise<GithubIdentity | null> {
  const { rows } = await pool.query<GithubIdentity>(
    `select participant_id, github_login, github_user_id::text as github_user_id,
            access_token, refresh_token, access_expires_at, refresh_expires_at, scopes
     from github_identities where participant_id = $1`,
    [participantId],
  );
  return rows[0] ?? null;
}

// Persist refreshed tokens (after a refresh_token grant).
export async function updateGithubTokens(i: {
  participantId: string;
  accessToken: string;
  refreshToken: string | null;
  accessExpiresAt: Date | null;
  refreshExpiresAt: Date | null;
}): Promise<void> {
  await pool.query(
    `update github_identities set
       access_token = $2, refresh_token = $3,
       access_expires_at = $4, refresh_expires_at = $5, updated_at = now()
     where participant_id = $1`,
    [i.participantId, i.accessToken, i.refreshToken, i.accessExpiresAt, i.refreshExpiresAt],
  );
}

export async function deleteGithubIdentity(participantId: string): Promise<void> {
  await pool.query(`delete from github_identities where participant_id = $1`, [participantId]);
}

// Find the 1:1 DM channel between two participants, creating it if needed.
// Full participant rows for a channel's members (for the members panel).
export async function channelMembers(channelId: string): Promise<Participant[]> {
  const { rows } = await pool.query<Participant>(
    `select p.* from channel_members m
     join participants p on p.id = m.participant_id
     where m.channel_id = $1
     order by p.kind, p.display_name`,
    [channelId],
  );
  return rows;
}

// Remove a member from a channel. Returns true if a row was actually removed.
export async function removeChannelMember(channelId: string, participantId: string): Promise<boolean> {
  const { rowCount } = await pool.query(
    `delete from channel_members where channel_id = $1 and participant_id = $2`,
    [channelId, participantId],
  );
  return (rowCount ?? 0) > 0;
}

// Delete a channel entirely. channel_members + messages (+ mentions) cascade via FKs.
export async function deleteChannel(channelId: string): Promise<void> {
  await pool.query(`delete from channels where id = $1`, [channelId]);
}

export async function findOrCreateDm(aId: string, bId: string): Promise<string> {
  const found = await pool.query(
    `select c.id from channels c
     where c.kind = 'dm'
       and (select count(*) from channel_members m where m.channel_id = c.id) = 2
       and exists (select 1 from channel_members m where m.channel_id = c.id and m.participant_id = $1)
       and exists (select 1 from channel_members m where m.channel_id = c.id and m.participant_id = $2)
     limit 1`,
    [aId, bId],
  );
  if (found.rows[0]) return found.rows[0].id;
  const client = await pool.connect();
  try {
    await client.query("begin");
    const { rows } = await client.query(`insert into channels (name, kind) values ('dm', 'dm') returning id`);
    const cid = rows[0].id;
    await client.query(
      `insert into channel_members (channel_id, participant_id) values ($1, $2), ($1, $3)`,
      [cid, aId, bId],
    );
    await client.query("commit");
    return cid;
  } catch (e) {
    await client.query("rollback");
    throw e;
  } finally {
    client.release();
  }
}
