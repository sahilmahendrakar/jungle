import type pg from "pg";
import type { Message as PersistedMessage, AttachmentMeta, SearchResult } from "@jungle/shared";
import { pool } from "./pool";
import { withTransaction } from "./tx";
import { resolveMentions, getParticipant } from "./participants";
import { attachmentsForMessages } from "./attachments";
import { formatContextLines, oldestSeqOf, type ContextRow } from "./context";

// Resolve a thread reply's root. Returns the id to store in thread_root_id, or throws if the
// target doesn't exist / is in another channel. Guarantees replies never nest: if the target
// is itself a reply, we thread onto ITS root (a reply's thread_root_id always points at a
// top-level message). Runs inside the caller's transaction.
async function resolveThreadRoot(
  client: pg.PoolClient,
  channelId: string,
  threadRootId: string,
): Promise<string> {
  const { rows } = await client.query<{ id: string; channel_id: string; thread_root_id: string | null }>(
    `select id, channel_id, thread_root_id from messages where id = $1`,
    [threadRootId],
  );
  const target = rows[0];
  if (!target) throw new Error("thread root message not found");
  if (target.channel_id !== channelId) throw new Error("thread root is in a different channel");
  // Flatten: if the target is itself a reply, use its root so threads stay one level deep.
  return target.thread_root_id ?? target.id;
}

// Row -> PersistedMessage. `mentions` defaults to [] (history render doesn't need them — they're
// only carried on live WS frames, matching the pre-threads behavior); persistMessage passes the
// resolved mentions for the live frame it returns.
function rowToMessage(
  r: {
    id: string;
    channel_id: string;
    seq: string | number;
    sender_id: string;
    sender_handle: string;
    body: string;
    created_at: string;
    cascade_budget?: number | null;
    thread_root_id?: string | null;
    also_to_channel?: boolean | null;
    reply_count?: number | null;
    last_reply_at?: string | null;
    turn_id?: string | null;
  },
  attachments: AttachmentMeta[],
  mentions: { id: string; handle: string }[] = [],
): PersistedMessage {
  return {
    id: r.id,
    channel_id: r.channel_id,
    seq: String(r.seq),
    sender_id: r.sender_id,
    sender_handle: r.sender_handle,
    body: r.body,
    created_at: r.created_at,
    cascade_budget: r.cascade_budget ?? null,
    turn_id: r.turn_id ?? null,
    thread_root_id: r.thread_root_id ?? null,
    also_to_channel: r.also_to_channel ?? false,
    reply_count: r.reply_count ?? 0,
    last_reply_at: r.last_reply_at ?? null,
    mentions,
    attachments,
  };
}

// The persistence half of the routing rule: store the message (assign seq), record mentions,
// link any pre-uploaded attachments. Idempotent on (sender_id, client_msg_id) for optimistic-
// send dedupe.
export async function persistMessage(args: {
  channelId: string;
  senderId: string;
  body: string;
  clientMsgId?: string | null;
  cascadeBudget?: number | null;
  attachmentIds?: string[];
  // Threads: set to reply into a thread. also_to_channel additionally echoes the reply into
  // the main timeline (ignored when threadRootId is absent).
  threadRootId?: string | null;
  alsoToChannel?: boolean;
  // Agent sends only: the runner turn that produced this message (see RunnerHooks).
  turnId?: string | null;
}): Promise<PersistedMessage> {
  const mentions = await resolveMentions(args.channelId, args.body);
  const { msg, attachments } = await withTransaction(async (client) => {
    const rootId = args.threadRootId
      ? await resolveThreadRoot(client, args.channelId, args.threadRootId)
      : null;
    const alsoToChannel = !!rootId && !!args.alsoToChannel;
    const ins = await client.query(
      `insert into messages
         (channel_id, sender_id, body, client_msg_id, cascade_budget, thread_root_id, also_to_channel, turn_id)
       values ($1, $2, $3, $4, $5, $6, $7, $8)
       on conflict (sender_id, client_msg_id) where client_msg_id is not null do nothing
       returning *`,
      [
        args.channelId, args.senderId, args.body, args.clientMsgId ?? null,
        args.cascadeBudget ?? null, rootId, alsoToChannel, args.turnId ?? null,
      ],
    );
    let row = ins.rows[0];
    let attachments: AttachmentMeta[] = [];
    if (row) {
      // Bump the root's denormed thread summary in the same txn (O(1), no drift — there's no
      // single-message delete anywhere in the app).
      if (rootId) {
        await client.query(
          `update messages
             set reply_count = reply_count + 1, last_reply_at = $2
           where id = $1`,
          [rootId, row.created_at],
        );
      }
      if (mentions.length) {
        await client.query(
          `insert into mentions (message_id, participant_id) select $1, unnest($2::uuid[])`,
          [row.id, mentions.map((m) => m.id)],
        );
      }
      if (args.attachmentIds?.length) {
        // Only the sender's own not-yet-linked uploads attach; anything else is silently
        // dropped (prevents attaching someone else's upload or re-linking a sent file).
        const linked = await client.query<AttachmentMeta>(
          `update attachments set message_id = $1
           where id = any($2::uuid[]) and uploader_id = $3 and message_id is null
           returning id, filename, mime, size_bytes, width, height`,
          [row.id, args.attachmentIds, args.senderId],
        );
        attachments = linked.rows;
      }
    } else {
      // conflict (duplicate client_msg_id) — return the existing row
      const ex = await client.query(
        `select * from messages where sender_id = $1 and client_msg_id = $2`,
        [args.senderId, args.clientMsgId],
      );
      row = ex.rows[0];
      attachments = (await attachmentsForMessages([row.id])).get(row.id) ?? [];
    }
    return { msg: row, attachments };
  });
  const sender = await getParticipant(msg.sender_id);
  return rowToMessage({ ...msg, sender_handle: sender?.handle ?? "?" }, attachments, mentions);
}

// Backfill/reconnect path: return EVERYTHING in the channel after afterSeq — roots AND thread
// replies. The client buckets roots→timeline and replies→thread pane. Deliberately NOT
// filtered by thread_root_id: filtering here would leave an open thread pane with a gap after
// reconnect and force a second sync path. (The channel-unread aggregate in listChannels is a
// different story — that one DOES filter; see the comment there.)
export async function getMessages(channelId: string, afterSeq = 0): Promise<PersistedMessage[]> {
  const { rows } = await pool.query(
    `select m.*, p.handle as sender_handle
     from messages m join participants p on p.id = m.sender_id
     where m.channel_id = $1 and m.seq > $2
     order by m.seq`,
    [channelId, afterSeq],
  );
  const atts = await attachmentsForMessages(rows.map((r) => r.id));
  return rows.map((r) => rowToMessage(r, atts.get(r.id) ?? []));
}

// A single thread: the root message followed by its replies, in seq order. Used to lazy-load a
// thread the client doesn't already have locally (and by the thread-open path).
export async function getThreadMessages(rootId: string): Promise<PersistedMessage[]> {
  const { rows } = await pool.query(
    `select m.*, p.handle as sender_handle
     from messages m join participants p on p.id = m.sender_id
     where m.id = $1 or m.thread_root_id = $1
     order by m.seq`,
    [rootId],
  );
  const atts = await attachmentsForMessages(rows.map((r) => r.id));
  return rows.map((r) => rowToMessage(r, atts.get(r.id) ?? []));
}

// Recent messages oldest -> newest, rendered for feeding an agent context on mention. Attached
// files are noted by name; the triggering message's files are delivered to the runner separately
// (saved into its workspace).
export async function getRecentContext(channelId: string, limit = 20): Promise<string> {
  const { rows } = await pool.query<ContextRow>(
    `select p.handle, m.body,
            (select array_agg(a.filename order by a.created_at)
             from attachments a where a.message_id = m.id) as att
     from messages m join participants p on p.id = m.sender_id
     where m.channel_id = $1 order by m.seq desc limit $2`,
    [channelId, limit],
  );
  return formatContextLines(rows);
}

export interface ContextPage {
  text: string; // oldest -> newest, same rendering as getRecentContext
  oldestSeq: string | null; // pass as `beforeSeq` to page further back; null once exhausted
}

// Agent-facing "read more history" tool backing: a page of channel context older than
// `beforeSeq` (or the most recent page, when omitted). Unlike getRecentContext this is a real
// backward cursor — getMessages/getRecentContext only ever expose a forward (afterSeq) cursor,
// which is fine for reconnect backfill but can't page an agent further into the past on demand.
export async function getChannelHistoryBefore(
  channelId: string,
  limit: number,
  beforeSeq?: string,
): Promise<ContextPage> {
  const { rows } = await pool.query<ContextRow>(
    `select p.handle, m.body, m.seq,
            (select array_agg(a.filename order by a.created_at)
             from attachments a where a.message_id = m.id) as att
     from messages m join participants p on p.id = m.sender_id
     where m.channel_id = $1 ${beforeSeq ? "and m.seq < $3" : ""}
     order by m.seq desc limit $2`,
    beforeSeq ? [channelId, limit, beforeSeq] : [channelId, limit],
  );
  const oldestSeq = oldestSeqOf(rows);
  return { text: formatContextLines(rows), oldestSeq };
}

// Full-text search over the requester's channels (GET /api/search), newest first.
// websearch_to_tsquery parses free text safely ("fix login", quoted phrases, -exclusions); the
// predicate matches migrations/019's GIN expression index exactly. dm_with mirrors the channel
// list's shape so the client can label DM hits with the other member's handle.
export async function searchMessages(
  workspaceId: string,
  participantId: string,
  query: string,
  limit = 30,
): Promise<SearchResult[]> {
  const { rows } = await pool.query<SearchResult>(
    `select m.id as message_id, m.channel_id, c.name as channel_name, c.kind as channel_kind,
            (select p2.handle from channel_members cm2
             join participants p2 on p2.id = cm2.participant_id
             where c.kind = 'dm' and cm2.channel_id = c.id and cm2.participant_id <> $2
             limit 1) as dm_with,
            m.thread_root_id, p.handle as sender_handle, m.body, m.created_at
     from messages m
     join channels c on c.id = m.channel_id
     join channel_members cm on cm.channel_id = m.channel_id and cm.participant_id = $2
     join participants p on p.id = m.sender_id
     where c.workspace_id = $1
       and to_tsvector('english', m.body) @@ websearch_to_tsquery('english', $3)
     order by m.seq desc
     limit $4`,
    [workspaceId, participantId, query, Math.min(50, Math.max(1, limit))],
  );
  return rows;
}

// The channel a message belongs to (for membership checks on thread endpoints). Null if gone.
export async function getMessageChannelId(messageId: string): Promise<string | null> {
  const { rows } = await pool.query<{ channel_id: string }>(
    `select channel_id from messages where id = $1`,
    [messageId],
  );
  return rows[0]?.channel_id ?? null;
}
