import type { UnreadThread } from "@jungle/shared";
import { pool } from "./pool";
import { formatContextLines, type ContextRow } from "./context";

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
  const { rows } = await pool.query<ContextRow>(
    `select p.handle, m.body,
            (select array_agg(a.filename order by a.created_at)
             from attachments a where a.message_id = m.id) as att
     from messages m join participants p on p.id = m.sender_id
     where m.id = $1 or m.thread_root_id = $1
     order by m.seq desc limit $2`,
    [rootId, limit],
  );
  return formatContextLines(rows);
}
