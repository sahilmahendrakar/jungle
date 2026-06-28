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
}): Promise<Participant> {
  const { rows } = await pool.query<Participant>(
    `insert into participants (kind, handle, display_name, ma_session_id)
     values ($1, $2, $3, $4) returning *`,
    [p.kind, p.handle, p.displayName, p.maSessionId ?? null],
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

// Of the given participant ids, the ones that are agents (with their MA session id).
export async function agentsByIds(
  ids: string[],
): Promise<{ id: string; handle: string; ma_session_id: string }[]> {
  if (!ids.length) return [];
  const { rows } = await pool.query<{ id: string; handle: string; ma_session_id: string }>(
    `select id, handle, ma_session_id from participants
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
