import type pg from "pg";
import type { Message as PersistedMessage, AttachmentMeta, SearchResult } from "@jungle/shared";
import type { ActivityFilters } from "@jungle/shared";
import { pool } from "./pool";
import { withTransaction } from "./tx";
import { resolveMentions, getParticipant } from "./participants";
import { attachmentsForMessages } from "./attachments";
import { formatContextLines, oldestSeqOf, type ContextRow } from "./context";
import { enqueueOutboxIfLinked } from "./slack";
import { SqlParams, messageWhere } from "./activity";

// Resolve a thread reply's root. Returns the id to store in thread_root_id, or throws if the
// target doesn't exist / is in another channel. Guarantees replies never nest: if the target
// is itself a reply, we thread onto ITS root (a reply's thread_root_id always points at a
// top-level message). Runs inside the caller's transaction.
async function resolveThreadRoot(
  client: pg.PoolClient,
  channelId: string,
  threadRootId: string,
): Promise<string> {
  const { rows } = await client.query<{
    id: string;
    channel_id: string;
    thread_root_id: string | null;
  }>(`select id, channel_id, thread_root_id from messages where id = $1`, [threadRootId]);
  const target = rows[0];
  if (!target) throw new Error("thread root message not found");
  if (target.channel_id !== channelId) throw new Error("thread root is in a different channel");
  // Flatten: if the target is itself a reply, use its root so threads stay one level deep.
  const rootId = target.thread_root_id ?? target.id;
  // A DELETED root still accepts replies as long as it's showing as a tombstone (it has live
  // replies, so the thread is open in front of someone). Once its last reply is gone the root
  // is invisible everywhere, and replying would resurrect it — refuse that.
  const { rows: rootRows } = await client.query<{ deleted_at: string | null; reply_count: number }>(
    `select deleted_at, reply_count from messages where id = $1`,
    [rootId],
  );
  const root = rootRows[0];
  if (root?.deleted_at && root.reply_count === 0) throw new Error("thread root message not found");
  return rootId;
}

// Deletion is soft (see migrations/048_message_delete.sql). These two predicates are the whole
// visibility rule and every read path uses one of them:
//   LIVE  — plain "not deleted", for anything that reads message CONTENT (agent context, search,
//           the activity feed, unread counts).
//   VISIBLE — LIVE, plus deleted thread roots that still have live replies. Those come back as
//           tombstones ("This message was deleted") so an open thread keeps its head instead of
//           losing its root. Once a tombstoned root's last reply is deleted its reply_count hits
//           0 and it drops out of here too, so tombstones are self-cleaning.
const LIVE = `m.deleted_at is null`;
const VISIBLE = `(m.deleted_at is null or (m.thread_root_id is null and m.reply_count > 0))`;

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
    deleted_at?: string | null;
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
    deleted_at: r.deleted_at ?? null,
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
  // Slack bridge: set to "slack" for a message INGESTED from Slack, so it isn't mirrored back out
  // (echo suppression at the source). Any other value (incl. undefined) enqueues a Slack-mirror
  // job if the channel is linked — see db/slack.ts enqueueOutboxIfLinked / services/slackBridge.ts.
  origin?: "slack" | null;
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
      // Bump the root's denormed thread summary in the same txn (O(1)). The counterweight is
      // softDeleteMessage, which RECOMPUTES it over live replies — this increment is the only
      // place that assumes the count never goes down, so the two must stay in step.
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
      // Transactional outbox: if this channel mirrors to Slack and the message didn't come FROM
      // Slack, enqueue a mirror job in the same txn (message + intent commit atomically). Covers
      // every persist call site — human posts, agent sends, schedule announces — for free.
      if (args.origin !== "slack") {
        await enqueueOutboxIfLinked(client, args.channelId, row.id);
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
     where m.channel_id = $1 and m.seq > $2 and ${VISIBLE}
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
     where (m.id = $1 or m.thread_root_id = $1) and ${VISIBLE}
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
     where m.channel_id = $1 and ${LIVE} order by m.seq desc limit $2`,
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
     where m.channel_id = $1 and ${LIVE} ${beforeSeq ? "and m.seq < $3" : ""}
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
// `filters` carries the shared token language (from:/to:/in:/is: — parsed from the query by the
// route); its free-text remainder is the tsquery. A filters-only query (no text) lists matching
// messages without ranking — same semantics as the Activity feed's message branch.
export async function searchMessages(
  workspaceId: string,
  participantId: string,
  filters: ActivityFilters,
  limit = 30,
): Promise<SearchResult[]> {
  const p = new SqlParams(workspaceId, participantId);
  const where = ["c.workspace_id = $1", ...messageWhere(filters, p, { defaultScope: false })];
  const lim = p.add(Math.min(50, Math.max(1, limit)));
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
     where ${where.join(" and ")}
     order by m.created_at desc
     limit ${lim}`,
    p.values,
  );
  return rows;
}

// --- Deletion ---

// The bits the delete endpoint needs to authorize: which channel the message lives in, who sent
// it, and whether the sender is an agent (agent messages can be deleted by any human member;
// a human's message only by its author). Null when the id doesn't exist.
export interface DeletableMessage {
  id: string;
  channel_id: string;
  sender_id: string;
  sender_kind: "human" | "agent";
  deleted_at: string | null;
}

// Has this message been deleted? Cheap re-check for paths that read a message id they captured
// earlier (the Slack egress drain re-checks between claiming a job and posting it).
export async function isMessageDeleted(messageId: string): Promise<boolean> {
  const { rows } = await pool.query<{ deleted_at: string | null }>(
    `select deleted_at from messages where id = $1`,
    [messageId],
  );
  return !rows[0] || rows[0].deleted_at != null;
}

export async function getDeletableMessage(messageId: string): Promise<DeletableMessage | null> {
  const { rows } = await pool.query<DeletableMessage>(
    `select m.id, m.channel_id, m.sender_id, p.kind as sender_kind, m.deleted_at
     from messages m join participants p on p.id = m.sender_id
     where m.id = $1`,
    [messageId],
  );
  return rows[0] ?? null;
}

export interface DeletedMessage {
  channelId: string;
  threadRootId: string | null;
  // The row stays visible as "This message was deleted" (a thread root with live replies).
  tombstone: boolean;
  // Blobs to drop from the Storage seam — done by the caller AFTER the txn commits, since
  // deleting a file isn't transactional (the attachment GC sweeps any that fail).
  storageKeys: string[];
  // The delete was a no-op because the message was already deleted (double-click, or our own
  // Slack mirror-delete echoing back in as a message_deleted event).
  alreadyDeleted: boolean;
}

// Soft-delete a message: stamp deleted_at, destroy the content, and clean up everything that
// pointed at it. Authorization is the caller's job (see http/routes/messages.ts).
//
// "Delete" here really does destroy: the body is blanked and the attachments/mentions/extracted
// deliverables are removed. What survives is the ROW — its id and its seq — because the channel's
// read markers, the thread tree and the reply_count denorm are all keyed off it (see the
// migration). Two things are also CANCELLED rather than cleaned up: an undelivered agent dispatch
// this message triggered (deleting a message you just @mentioned an agent in should call the
// agent off, not leave it working on text nobody can read) and an unsent Slack mirror job.
export async function softDeleteMessage(
  messageId: string,
  actorId: string | null,
): Promise<DeletedMessage | null> {
  return withTransaction(async (client) => {
    // Lock the row first: two clients deleting the same message must not both run the cleanup
    // (and the reply_count recompute below has to see a stable set of replies).
    const { rows } = await client.query<{
      id: string;
      channel_id: string;
      thread_root_id: string | null;
      deleted_at: string | null;
      reply_count: number;
    }>(
      `select id, channel_id, thread_root_id, deleted_at, reply_count
       from messages where id = $1 for update`,
      [messageId],
    );
    const msg = rows[0];
    if (!msg) return null;
    const liveReplies = async () =>
      Number(
        (
          await client.query<{ n: string }>(
            `select count(*) as n from messages where thread_root_id = $1 and deleted_at is null`,
            [msg.id],
          )
        ).rows[0].n,
      );
    if (msg.deleted_at) {
      return {
        channelId: msg.channel_id,
        threadRootId: msg.thread_root_id,
        tombstone: !msg.thread_root_id && (await liveReplies()) > 0,
        storageKeys: [],
        alreadyDeleted: true,
      };
    }

    await client.query(
      `update messages set deleted_at = now(), deleted_by = $2, body = '' where id = $1`,
      [messageId, actorId],
    );
    const { rows: blobs } = await client.query<{ storage_key: string }>(
      `delete from attachments where message_id = $1 returning storage_key`,
      [messageId],
    );
    // Mentions go too, or the deleted message keeps flagging its channel with a mention badge
    // that resolves to nothing (listChannels joins mentions to compute has_mention).
    await client.query(`delete from mentions where message_id = $1`, [messageId]);
    // Deliverables were extracted FROM this body; with the body gone the chip has no source.
    await client.query(`delete from deliverables where message_id = $1`, [messageId]);
    // Undelivered dispatch this message triggered — call the agent off.
    await client.query(
      `delete from agent_inbox where delivered_at is null and context->>'messageId' = $1`,
      [messageId],
    );
    // Un-drained Slack mirror job: don't post a message that no longer exists here.
    await client.query(
      `delete from slack_outbox where jungle_message_id = $1 and status = 'pending'`,
      [messageId],
    );

    // Thread bookkeeping. Deleting a REPLY lowers its root's denormed summary (persistMessage
    // only ever raises it); deleting a ROOT leaves its replies alone — they stay in the thread,
    // headed by the tombstone.
    if (msg.thread_root_id) {
      await client.query(
        `update messages r
            set reply_count   = (select count(*) from messages m
                                  where m.thread_root_id = r.id and m.deleted_at is null),
                last_reply_at = (select max(m.created_at) from messages m
                                  where m.thread_root_id = r.id and m.deleted_at is null)
          where r.id = $1`,
        [msg.thread_root_id],
      );
    }
    return {
      channelId: msg.channel_id,
      threadRootId: msg.thread_root_id,
      tombstone: !msg.thread_root_id && (await liveReplies()) > 0,
      storageKeys: blobs.map((b) => b.storage_key),
      alreadyDeleted: false,
    };
  });
}

// The channel a message belongs to (for membership checks on thread endpoints). Null if gone.
export async function getMessageChannelId(messageId: string): Promise<string | null> {
  const { rows } = await pool.query<{ channel_id: string }>(
    `select channel_id from messages where id = $1`,
    [messageId],
  );
  return rows[0]?.channel_id ?? null;
}
