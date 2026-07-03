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
  // Threads: null on top-level messages; the root message's id on replies. also_to_channel
  // marks a reply that was also echoed into the main timeline. reply_count/last_reply_at are
  // denormed on the ROOT (0/null elsewhere) and drive the "N replies" footer + Threads view.
  thread_root_id: string | null;
  also_to_channel: boolean;
  reply_count: number;
  last_reply_at: string | null;
  mentions: { id: string; handle: string }[];
  attachments: AttachmentMeta[];
}

// The attachment fields that ride on messages (a signed download url is added at the edge
// by attachments.withUrls — never stored).
export interface AttachmentMeta {
  id: string;
  filename: string;
  mime: string;
  size_bytes: number;
  width: number | null;
  height: number | null;
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
// mentions, link any pre-uploaded attachments. Idempotent on (sender_id, client_msg_id)
// for optimistic-send dedupe.
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
}): Promise<PersistedMessage> {
  const mentions = await resolveMentions(args.body);
  const client = await pool.connect();
  try {
    await client.query("begin");
    const rootId = args.threadRootId
      ? await resolveThreadRoot(client, args.channelId, args.threadRootId)
      : null;
    const alsoToChannel = !!rootId && !!args.alsoToChannel;
    const ins = await client.query(
      `insert into messages
         (channel_id, sender_id, body, client_msg_id, cascade_budget, thread_root_id, also_to_channel)
       values ($1, $2, $3, $4, $5, $6, $7)
       on conflict (sender_id, client_msg_id) where client_msg_id is not null do nothing
       returning *`,
      [
        args.channelId, args.senderId, args.body, args.clientMsgId ?? null,
        args.cascadeBudget ?? null, rootId, alsoToChannel,
      ],
    );
    let msg = ins.rows[0];
    let attachments: AttachmentMeta[] = [];
    if (msg) {
      // Bump the root's denormed thread summary in the same txn (O(1), no drift — there's no
      // single-message delete anywhere in the app).
      if (rootId) {
        await client.query(
          `update messages
             set reply_count = reply_count + 1, last_reply_at = $2
           where id = $1`,
          [rootId, msg.created_at],
        );
      }
      if (mentions.length) {
        await client.query(
          `insert into mentions (message_id, participant_id) select $1, unnest($2::uuid[])`,
          [msg.id, mentions.map((m) => m.id)],
        );
      }
      if (args.attachmentIds?.length) {
        // Only the sender's own not-yet-linked uploads attach; anything else is silently
        // dropped (prevents attaching someone else's upload or re-linking a sent file).
        const linked = await client.query<AttachmentMeta>(
          `update attachments set message_id = $1
           where id = any($2::uuid[]) and uploader_id = $3 and message_id is null
           returning id, filename, mime, size_bytes, width, height`,
          [msg.id, args.attachmentIds, args.senderId],
        );
        attachments = linked.rows;
      }
    } else {
      // conflict (duplicate client_msg_id) — return the existing row
      const ex = await client.query(
        `select * from messages where sender_id = $1 and client_msg_id = $2`,
        [args.senderId, args.clientMsgId],
      );
      msg = ex.rows[0];
      attachments = (await attachmentsForMessages([msg.id])).get(msg.id) ?? [];
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
      thread_root_id: msg.thread_root_id ?? null,
      also_to_channel: msg.also_to_channel ?? false,
      reply_count: msg.reply_count ?? 0,
      last_reply_at: msg.last_reply_at ?? null,
      mentions,
      attachments,
    };
  } catch (e) {
    await client.query("rollback");
    throw e;
  } finally {
    client.release();
  }
}

// Row -> PersistedMessage. `mentions` isn't loaded here (history render doesn't need them —
// they're only carried on live WS frames, matching the pre-threads behavior).
function rowToMessage(r: any, attachments: AttachmentMeta[]): PersistedMessage {
  return {
    id: r.id,
    channel_id: r.channel_id,
    seq: String(r.seq),
    sender_id: r.sender_id,
    sender_handle: r.sender_handle,
    body: r.body,
    created_at: r.created_at,
    cascade_budget: r.cascade_budget ?? null,
    thread_root_id: r.thread_root_id ?? null,
    also_to_channel: r.also_to_channel ?? false,
    reply_count: r.reply_count ?? 0,
    last_reply_at: r.last_reply_at ?? null,
    mentions: [],
    attachments,
  };
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

// --- Attachments ---

export interface AttachmentRow extends AttachmentMeta {
  uploader_id: string;
  message_id: string | null;
  storage_key: string;
  created_at: string;
}

// Record an upload (message_id starts null; persistMessage links it on post).
export async function createAttachment(a: {
  uploaderId: string;
  filename: string;
  mime: string;
  sizeBytes: number;
  storageKey: string;
  width?: number | null;
  height?: number | null;
}): Promise<AttachmentRow> {
  const { rows } = await pool.query<AttachmentRow>(
    `insert into attachments (uploader_id, filename, mime, size_bytes, storage_key, width, height)
     values ($1, $2, $3, $4, $5, $6, $7) returning *`,
    [a.uploaderId, a.filename, a.mime, a.sizeBytes, a.storageKey, a.width ?? null, a.height ?? null],
  );
  return rows[0];
}

export async function getAttachment(id: string): Promise<AttachmentRow | null> {
  const { rows } = await pool.query<AttachmentRow>(`select * from attachments where id = $1`, [id]);
  return rows[0] ?? null;
}

// Attachment metas for a set of messages, grouped by message id (avoids N+1 in getMessages).
export async function attachmentsForMessages(
  messageIds: string[],
): Promise<Map<string, AttachmentMeta[]>> {
  const out = new Map<string, AttachmentMeta[]>();
  if (!messageIds.length) return out;
  const { rows } = await pool.query(
    `select message_id, id, filename, mime, size_bytes, width, height
     from attachments where message_id = any($1::uuid[]) order by created_at`,
    [messageIds],
  );
  for (const r of rows) {
    const list = out.get(r.message_id) ?? [];
    list.push({
      id: r.id, filename: r.filename, mime: r.mime,
      size_bytes: Number(r.size_bytes), width: r.width, height: r.height,
    });
    out.set(r.message_id, list);
  }
  return out;
}

// Uploads never linked to a message within maxAgeHours (abandoned composer uploads) — GC set.
export async function orphanAttachments(
  maxAgeHours: number,
): Promise<{ id: string; storage_key: string }[]> {
  const { rows } = await pool.query(
    `select id, storage_key from attachments
     where message_id is null and created_at < now() - make_interval(hours => $1)`,
    [maxAgeHours],
  );
  return rows;
}

export async function deleteAttachmentRow(id: string): Promise<void> {
  await pool.query(`delete from attachments where id = $1`, [id]);
}

// Every storage key with a live row (the GC blob sweep keeps only these).
export async function knownStorageKeys(): Promise<Set<string>> {
  const { rows } = await pool.query<{ storage_key: string }>(`select storage_key from attachments`);
  return new Set(rows.map((r) => r.storage_key));
}

export async function getChannel(
  id: string,
): Promise<{ id: string; name: string; kind: string } | null> {
  const { rows } = await pool.query(`select id, name, kind from channels where id = $1`, [id]);
  return rows[0] ?? null;
}

// Recent messages oldest -> newest, rendered for feeding an agent context on mention.
// Attached files are noted by name; the triggering message's files are delivered to the
// runner separately (saved into its workspace).
export async function getRecentContext(channelId: string, limit = 20): Promise<string> {
  const { rows } = await pool.query<{ handle: string; body: string; att: string[] | null }>(
    `select p.handle, m.body,
            (select array_agg(a.filename order by a.created_at)
             from attachments a where a.message_id = m.id) as att
     from messages m join participants p on p.id = m.sender_id
     where m.channel_id = $1 order by m.seq desc limit $2`,
    [channelId, limit],
  );
  return rows
    .reverse()
    .map((r) => `@${r.handle}: ${r.body}${r.att?.length ? ` [attached: ${r.att.join(", ")}]` : ""}`)
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
  // Attachment refs from the triggering message; drain signs fresh download URLs.
  attachments: AttachmentMeta[] | null;
}

// Queue one composed input for an sdk agent. Returns the new row's id.
export async function enqueueInboxItem(
  agentId: string,
  text: string,
  attachments?: AttachmentMeta[],
): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    `insert into agent_inbox (agent_id, text, attachments) values ($1, $2, $3) returning id`,
    [agentId, text, attachments?.length ? JSON.stringify(attachments) : null],
  );
  return rows[0].id;
}

// Undelivered inbox items for an agent, oldest first — the drain set.
export async function pendingInbox(agentId: string): Promise<InboxItem[]> {
  const { rows } = await pool.query<InboxItem>(
    `select id, text, attachments from agent_inbox
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
             -- Thread replies don't count toward the CHANNEL badge (they have their own
             -- per-thread unread state, see listUnreadThreads). Only top-level messages and
             -- replies explicitly echoed to the channel do. This is the same predicate the
             -- client uses to decide timeline vs. thread-pane placement — keep them in sync;
             -- dropping it here silently re-inflates the channel badge with thread chatter.
             and (msg.thread_root_id is null or msg.also_to_channel)
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

// --- Threads ---

// The channel a message belongs to (for membership checks on thread endpoints). Null if gone.
export async function getMessageChannelId(messageId: string): Promise<string | null> {
  const { rows } = await pool.query<{ channel_id: string }>(
    `select channel_id from messages where id = $1`,
    [messageId],
  );
  return rows[0]?.channel_id ?? null;
}

// Participation predicate (DERIVED, no thread_participants table): a participant "follows" a
// thread iff they authored the root, replied in it, or were @mentioned on any of its messages.
// Reading a thread does NOT subscribe you (matches Slack). This SQL fragment is reused by the
// unread query and the read gate; $1 = participant id, root = the outer `messages` row aliased
// as `root`.
const FOLLOWS_THREAD_SQL = `(
  root.sender_id = $1
  or exists (select 1 from messages r where r.thread_root_id = root.id and r.sender_id = $1)
  or exists (
    select 1 from mentions mn join messages tm on tm.id = mn.message_id
    where mn.participant_id = $1 and (tm.id = root.id or tm.thread_root_id = root.id)
  )
)`;

// True if `participantId` follows the thread rooted at `rootId` (see FOLLOWS_THREAD_SQL).
export async function followsThread(rootId: string, participantId: string): Promise<boolean> {
  const { rows } = await pool.query<{ ok: boolean }>(
    `select ${FOLLOWS_THREAD_SQL} as ok from messages root where root.id = $2`,
    [participantId, rootId],
  );
  return !!rows[0]?.ok;
}

export interface UnreadThread {
  root_id: string;
  channel_id: string;
  channel_name: string;
  root_sender_handle: string;
  root_body: string;
  reply_count: number;
  last_reply_at: string | null;
  unread_count: number; // replies after my thread last_read_seq, excluding my own
}

// The requester's followed threads that have unread replies, newest activity first. Scoped to
// channels they're a member of. Unread = replies with seq > their thread_reads.last_read_seq
// (0 if never opened), excluding their own — the exact live aggregate-join pattern listChannels
// uses against channel_reads, just keyed on the thread root.
export async function listUnreadThreads(participantId: string): Promise<UnreadThread[]> {
  const { rows } = await pool.query<UnreadThread>(
    `select root.id as root_id, root.channel_id, c.name as channel_name,
            rp.handle as root_sender_handle, root.body as root_body,
            root.reply_count, root.last_reply_at,
            count(reply.id)::int as unread_count
     from messages root
     join channels c on c.id = root.channel_id
     join channel_members cm on cm.channel_id = c.id and cm.participant_id = $1
     join participants rp on rp.id = root.sender_id
     left join thread_reads tr on tr.root_id = root.id and tr.participant_id = $1
     left join messages reply
            on reply.thread_root_id = root.id
           and reply.seq > coalesce(tr.last_read_seq, 0)
           and reply.sender_id <> $1
     where root.thread_root_id is null
       and root.reply_count > 0
       and ${FOLLOWS_THREAD_SQL}
     group by root.id, root.channel_id, c.name, rp.handle, root.body, root.reply_count, root.last_reply_at
     having count(reply.id) > 0
     order by root.last_reply_at desc nulls last`,
    [participantId],
  );
  return rows;
}

// Mark a thread read for a participant: set thread_reads.last_read_seq to `seq` (default: the
// thread's current max seq). Never lowers an existing marker. Mirrors markChannelRead.
export async function markThreadRead(
  rootId: string,
  participantId: string,
  seq?: number | null,
): Promise<number> {
  const target =
    seq != null && Number.isFinite(seq)
      ? String(seq)
      : (
          await pool.query<{ max: string | null }>(
            `select max(seq)::text as max from messages where id = $1 or thread_root_id = $1`,
            [rootId],
          )
        ).rows[0]?.max ?? "0";
  const { rows } = await pool.query<{ last_read_seq: string }>(
    `insert into thread_reads (root_id, participant_id, last_read_seq, updated_at)
     values ($1, $2, $3, now())
     on conflict (root_id, participant_id) do update
       set last_read_seq = greatest(thread_reads.last_read_seq, excluded.last_read_seq),
           updated_at = now()
     returning last_read_seq::text`,
    [rootId, participantId, target],
  );
  return Number(rows[0]?.last_read_seq ?? 0);
}

// Agents that participate in a thread (authored the root or replied in it). Drives the "no @
// needed to reply to an agent" auto-trigger: a bare human reply wakes these agents.
export async function agentIdsInThread(rootId: string): Promise<string[]> {
  const { rows } = await pool.query<{ id: string }>(
    `select distinct p.id
     from messages m join participants p on p.id = m.sender_id
     where p.kind = 'agent' and (m.id = $1 or m.thread_root_id = $1)`,
    [rootId],
  );
  return rows.map((r) => r.id);
}

// Thread transcript for an agent's turn input (root + replies, oldest-first). Same line format
// as getRecentContext so the agent sees the thread it's replying in, not the whole channel.
export async function getThreadContext(rootId: string, limit = 40): Promise<string> {
  const { rows } = await pool.query<{ handle: string; body: string; att: string[] | null }>(
    `select p.handle, m.body,
            (select array_agg(a.filename order by a.created_at)
             from attachments a where a.message_id = m.id) as att
     from messages m join participants p on p.id = m.sender_id
     where m.id = $1 or m.thread_root_id = $1
     order by m.seq desc limit $2`,
    [rootId, limit],
  );
  return rows
    .reverse()
    .map((r) => `@${r.handle}: ${r.body}${r.att?.length ? ` [attached: ${r.att.join(", ")}]` : ""}`)
    .join("\n");
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

// Fully delete an agent participant and everything tied to it. Most FKs cascade off
// participants (agent_inbox, agent_events, channel_members, channel_reads, github identity),
// but messages.sender_id is RESTRICT — so we must clear the agent's messages by hand, in a
// transaction. We also drop any DM channels the agent belonged to (a DM with a deleted agent
// is meaningless and would otherwise linger with a single member).
export async function deleteAgent(agentId: string): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    // DM channels the agent is a member of — deleting the channel cascades its members +
    // messages (including the human's side of the DM), which is what we want for a 1:1 DM.
    await client.query(
      `delete from channels
        where kind = 'dm'
          and id in (select channel_id from channel_members where participant_id = $1)`,
      [agentId],
    );
    // Remaining messages the agent sent in group channels (sender_id is RESTRICT, no cascade).
    await client.query(`delete from messages where sender_id = $1`, [agentId]);
    // The participant row — cascades agent_inbox, agent_events, channel_members, channel_reads,
    // and the github identity row.
    await client.query(`delete from participants where id = $1`, [agentId]);
    await client.query("commit");
  } catch (e) {
    await client.query("rollback");
    throw e;
  } finally {
    client.release();
  }
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
