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
  ma_session_id: string | null;
  repo: string | null;
  vault_id: string | null;
  repo_resource_id: string | null;
  mcp_credential_id: string | null;
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
  maSessionId?: string | null;
  repo?: string | null;
  vaultId?: string | null;
  repoResourceId?: string | null;
  mcpCredentialId?: string | null;
}): Promise<Participant> {
  const { rows } = await pool.query<Participant>(
    `insert into participants
       (kind, handle, display_name, ma_session_id, repo, vault_id, repo_resource_id, mcp_credential_id)
     values ($1, $2, $3, $4, $5, $6, $7, $8) returning *`,
    [
      p.kind, p.handle, p.displayName, p.maSessionId ?? null,
      p.repo ?? null, p.vaultId ?? null, p.repoResourceId ?? null, p.mcpCredentialId ?? null,
    ],
  );
  return rows[0];
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

export async function isMember(channelId: string, participantId: string): Promise<boolean> {
  const { rows } = await pool.query(
    `select 1 from channel_members where channel_id = $1 and participant_id = $2`,
    [channelId, participantId],
  );
  return rows.length > 0;
}

export async function resolveMentions(body: string): Promise<{ id: string; handle: string }[]> {
  const handles = [...new Set([...body.matchAll(/@([a-zA-Z0-9_]+)/g)].map((m) => m[1]))];
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
  ma_session_id: string;
  repo: string | null;
  vault_id: string | null;
  repo_resource_id: string | null;
  mcp_credential_id: string | null;
}

// Of the given participant ids, the ones that are agents (with their MA session id +
// GitHub provisioning, if any).
export async function agentsByIds(ids: string[]): Promise<AgentRow[]> {
  if (!ids.length) return [];
  const { rows } = await pool.query<AgentRow>(
    `select id, handle, ma_session_id, repo, vault_id, repo_resource_id, mcp_credential_id
     from participants
     where kind = 'agent' and ma_session_id is not null and id = any($1)`,
    [ids],
  );
  return rows;
}

export async function listChannels(
  participantId?: string,
): Promise<{ id: string; name: string; kind: string }[]> {
  if (participantId) {
    const { rows } = await pool.query(
      `select c.id, c.name, c.kind from channels c
       join channel_members cm on cm.channel_id = c.id
       where cm.participant_id = $1 order by c.created_at`,
      [participantId],
    );
    return rows;
  }
  const { rows } = await pool.query(`select id, name, kind from channels order by created_at`);
  return rows;
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
