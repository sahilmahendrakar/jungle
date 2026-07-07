import type { Deliverable, DeliverableKind } from "@jungle/shared";
import { pool } from "./pool";

// Deliverables: durable work artifacts extracted from agent messages (see
// migrations/018_deliverables.sql and services/deliverables.ts). Plain data access.

// The join that decorates a deliverables row into the wire shape (agent handle + channel name).
const DELIVERABLE_SELECT = `
  select d.id, d.agent_id, p.handle as agent_handle,
         d.channel_id, c.name as channel_name, c.kind as channel_kind,
         d.message_id, d.kind, d.title, d.url, d.created_at
  from deliverables d
  join participants p on p.id = d.agent_id
  join channels c on c.id = d.channel_id`;

// Insert extracted links, returning only the genuinely NEW rows (the (workspace_id, url) unique
// constraint swallows re-posts of the same artifact). Callers broadcast just the returned rows.
export async function insertDeliverables(
  rows: Array<{
    workspaceId: string;
    agentId: string;
    channelId: string;
    messageId: string;
    kind: DeliverableKind;
    title: string | null;
    url: string;
  }>,
): Promise<Deliverable[]> {
  if (!rows.length) return [];
  const inserted = await pool.query<{ id: number }>(
    `insert into deliverables (workspace_id, agent_id, channel_id, message_id, kind, title, url)
     select * from unnest($1::uuid[], $2::uuid[], $3::uuid[], $4::uuid[], $5::text[], $6::text[], $7::text[])
     on conflict (workspace_id, url) do nothing
     returning id`,
    [
      rows.map((r) => r.workspaceId),
      rows.map((r) => r.agentId),
      rows.map((r) => r.channelId),
      rows.map((r) => r.messageId),
      rows.map((r) => r.kind),
      rows.map((r) => r.title),
      rows.map((r) => r.url),
    ],
  );
  if (!inserted.rows.length) return [];
  const { rows: full } = await pool.query<Deliverable>(
    `${DELIVERABLE_SELECT} where d.id = any($1::bigint[]) order by d.id`,
    [inserted.rows.map((r) => r.id)],
  );
  return full;
}

// The requester's deliverables feed, newest first: artifacts from channels they belong to (a
// deliverable posted in someone else's DM stays theirs). Page backwards with `before` = the
// smallest id already held.
export async function listDeliverables(
  workspaceId: string,
  participantId: string,
  opts: { before?: number; limit?: number } = {},
): Promise<Deliverable[]> {
  const limit = Math.min(200, Math.max(1, opts.limit ?? 50));
  const { rows } = await pool.query<Deliverable>(
    `${DELIVERABLE_SELECT}
     join channel_members cm on cm.channel_id = d.channel_id and cm.participant_id = $2
     where d.workspace_id = $1 ${opts.before != null ? "and d.id < $4" : ""}
     order by d.id desc limit $3`,
    opts.before != null
      ? [workspaceId, participantId, limit, opts.before]
      : [workspaceId, participantId, limit],
  );
  return rows;
}
