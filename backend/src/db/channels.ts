import type { ChannelListItem } from "@jungle/shared";
import { pool } from "./pool";
import { withTransaction } from "./tx";
import type { Participant } from "./participants";

export async function createChannel(c: {
  name: string;
  kind: "channel" | "dm";
  memberHandles: string[];
}): Promise<{ id: string; name: string; kind: string }> {
  return withTransaction(async (client) => {
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
    return channel;
  });
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

export async function getChannel(
  id: string,
): Promise<{ id: string; name: string; kind: string } | null> {
  const { rows } = await pool.query(`select id, name, kind from channels where id = $1`, [id]);
  return rows[0] ?? null;
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
              coalesce(bool_or(mention.participant_id is not null), false) as has_mention,
              -- Agent members as a correlated subquery (not a join) so it can't fan out and
              -- distort the unread_count above. Drives the row's live status dot in the UI.
              coalesce((
                select array_agg(ap.id)
                from channel_members acm
                join participants ap on ap.id = acm.participant_id and ap.kind = 'agent'
                where acm.channel_id = c.id
              ), '{}') as member_agent_ids
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
    `select c.id, c.name, c.kind, null as dm_with, 0 as unread_count, false as has_mention,
            coalesce((
              select array_agg(ap.id)
              from channel_members acm
              join participants ap on ap.id = acm.participant_id and ap.kind = 'agent'
              where acm.channel_id = c.id
            ), '{}') as member_agent_ids
     from channels c order by c.created_at`,
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
  return withTransaction(async (client) => {
    const { rows } = await client.query(`insert into channels (name, kind) values ('dm', 'dm') returning id`);
    const cid = rows[0].id;
    await client.query(
      `insert into channel_members (channel_id, participant_id) values ($1, $2), ($1, $3)`,
      [cid, aId, bId],
    );
    return cid;
  });
}
