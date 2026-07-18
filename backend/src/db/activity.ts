import type { ActivityFilters, ActivityItem, ActivityMessage, Deliverable } from "@jungle/shared";
import { pool } from "./pool";

// The Activity feed (GET /api/activity): one merged, newest-first stream of the requester's
// messages and deliverables, scoped to channels they belong to. Messages and deliverables are
// queried separately (each mirrors its existing feed's shape) and merged in JS — over-fetching
// one extra page per branch is trivial at this scale and keeps each query legible.
//
// Default message scope ("relevant to me", when no from/to/person/direction filter is set):
//   · anything I sent
//   · anything in my DMs (received — sent is already covered above)
//   · anything @mentioning me
//   · replies on threads I started or replied in
// Explicit person-ish filters (from/to/person/direction) REPLACE that default scope — they're
// how you ask about someone else. Membership scoping (the channel_members join) always applies.
//
// The message/deliverable WHERE builders are shared with message search (db/messages.ts's
// searchMessages), so `from:@pip in:#general` means the same thing in both places.

// Positional-param accumulator: $1 = workspace, $2 = requester; every later value gets $n.
export class SqlParams {
  values: unknown[];
  constructor(workspaceId: string, meId: string) {
    this.values = [workspaceId, meId];
  }
  add(v: unknown): string {
    this.values.push(v);
    return `$${this.values.length}`;
  }
}

// "m @mentions the handle $h" (mt/pt = mentions join for that handle).
const MENTIONS_HANDLE = (h: string) =>
  `exists (select 1 from mentions mt join participants pt on pt.id = mt.participant_id
           where mt.message_id = m.id and pt.handle = ${h})`;

// "c is a DM shared with the handle $h".
const DM_WITH_HANDLE = (h: string) =>
  `exists (select 1 from channel_members cm3 join participants p3 on p3.id = cm3.participant_id
           where cm3.channel_id = c.id and p3.handle = ${h})`;

const MENTIONS_ME = `exists (select 1 from mentions mn where mn.message_id = m.id and mn.participant_id = $2)`;

// "m is a reply on a thread I started or replied in".
const THREAD_RELEVANT = `(m.thread_root_id is not null and exists (
    select 1 from messages root
    where root.id = m.thread_root_id
      and (root.sender_id = $2
           or exists (select 1 from messages sib
                      where sib.thread_root_id = root.id and sib.sender_id = $2))))`;

// "to:@h" = mentioned them or in your DM with them. Reused by person: (from OR to).
function toPredicate(h: string): string {
  return `(${MENTIONS_HANDLE(h)} or (c.kind = 'dm' and ${DM_WITH_HANDLE(h)}))`;
}

// Message-branch WHERE clauses for filters f, given aliases m (messages), c (channels),
// p (sender participants). `defaultScope` adds the "relevant to me" clause when no person-ish
// filter is set — true for the Activity feed, false for search (search is channel-scoped only).
export function messageWhere(
  f: ActivityFilters,
  p: SqlParams,
  { defaultScope }: { defaultScope: boolean },
): string[] {
  const where: string[] = [];
  if (f.from) where.push(`p.handle = ${p.add(f.from)}`);
  if (f.to) where.push(toPredicate(p.add(f.to)));
  if (f.person) {
    const h = p.add(f.person);
    where.push(`(p.handle = ${h} or ${toPredicate(h)})`);
  }
  if (f.inChannel) where.push(`c.kind = 'channel' and lower(c.name) = ${p.add(f.inChannel)}`);
  if (f.inDm) where.push(`c.kind = 'dm' and ${DM_WITH_HANDLE(p.add(f.inDm))}`);
  if (f.direction === "sent") where.push(`m.sender_id = $2`);
  else if (f.direction === "received") {
    where.push(`m.sender_id <> $2`);
    where.push(`(c.kind = 'dm' or ${MENTIONS_ME} or ${THREAD_RELEVANT})`);
  } else if (f.direction === "mentions") {
    where.push(`m.sender_id <> $2`);
    where.push(MENTIONS_ME);
  }
  if (defaultScope && !f.from && !f.to && !f.person && !f.direction) {
    where.push(`(m.sender_id = $2 or c.kind = 'dm' or ${MENTIONS_ME} or ${THREAD_RELEVANT})`);
  }
  if (f.text) {
    where.push(
      `to_tsvector('english', m.body) @@ websearch_to_tsquery('english', ${p.add(f.text)})`,
    );
  }
  return where;
}

// Deliverable-branch WHERE clauses (aliases d, c, p = agent). Returns null when the filters ask
// for something deliverables can't satisfy (received/mentions/to) — callers skip the branch.
export function deliverableWhere(f: ActivityFilters, p: SqlParams): string[] | null {
  if (f.direction === "received" || f.direction === "mentions" || f.to) return null;
  const where: string[] = [];
  if (f.from) where.push(`p.handle = ${p.add(f.from)}`);
  if (f.person) where.push(`p.handle = ${p.add(f.person)}`); // "their" deliverables
  if (f.direction === "sent") where.push(`d.agent_id = $2`); // meaningful when an agent views
  if (f.inChannel) where.push(`c.kind = 'channel' and lower(c.name) = ${p.add(f.inChannel)}`);
  if (f.inDm) where.push(`c.kind = 'dm' and ${DM_WITH_HANDLE(p.add(f.inDm))}`);
  if (f.kind) where.push(`d.kind = ${p.add(f.kind)}`);
  if (f.text) {
    const t = p.add(`%${f.text}%`);
    where.push(`(coalesce(d.title, '') ilike ${t} or d.url ilike ${t})`);
  }
  return where;
}

async function listActivityMessages(
  workspaceId: string,
  meId: string,
  f: ActivityFilters,
  before: string | undefined,
  limit: number,
): Promise<ActivityMessage[]> {
  const p = new SqlParams(workspaceId, meId);
  const where = ["c.workspace_id = $1", ...messageWhere(f, p, { defaultScope: true })];
  if (before) where.push(`m.created_at < ${p.add(before)}`);
  const lim = p.add(limit);
  const { rows } = await pool.query<ActivityMessage>(
    `select m.id as message_id, m.channel_id, c.name as channel_name, c.kind as channel_kind,
            (select p2.handle from channel_members cm2
             join participants p2 on p2.id = cm2.participant_id
             where c.kind = 'dm' and cm2.channel_id = c.id and cm2.participant_id <> $2
             limit 1) as dm_with,
            m.thread_root_id, p.handle as sender_handle, m.body, m.created_at,
            ${MENTIONS_ME} as mentions_me
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

async function listActivityDeliverables(
  workspaceId: string,
  meId: string,
  f: ActivityFilters,
  before: string | undefined,
  limit: number,
): Promise<Deliverable[]> {
  const p = new SqlParams(workspaceId, meId);
  const dw = deliverableWhere(f, p);
  if (!dw) return [];
  const where = ["d.workspace_id = $1", ...dw];
  if (before) where.push(`d.created_at < ${p.add(before)}`);
  const lim = p.add(limit);
  const { rows } = await pool.query<Deliverable>(
    `select d.id, d.agent_id, p.handle as agent_handle,
            d.channel_id, c.name as channel_name, c.kind as channel_kind,
            d.message_id, d.kind, d.title, d.url, d.created_at
     from deliverables d
     join participants p on p.id = d.agent_id
     join channels c on c.id = d.channel_id
     join channel_members cm on cm.channel_id = d.channel_id and cm.participant_id = $2
     where ${where.join(" and ")}
     order by d.created_at desc
     limit ${lim}`,
    p.values,
  );
  return rows;
}

// Deliverables can't satisfy received/mentions/to scopes — those are message-only.
export function deliverablesSatisfiable(f: ActivityFilters): boolean {
  return f.direction !== "received" && f.direction !== "mentions" && !f.to;
}

// The merged feed. `before` is the created_at of the oldest item the client already holds
// (keyset on ts — a same-ms tie across pages could repeat/skip an item; harmless here).
export async function listActivity(
  workspaceId: string,
  meId: string,
  filters: ActivityFilters,
  opts: { before?: string; limit?: number } = {},
): Promise<{ items: ActivityItem[]; hasMore: boolean }> {
  const limit = Math.min(100, Math.max(1, opts.limit ?? 50));
  const wantDeliverables = filters.type !== "messages" && deliverablesSatisfiable(filters);
  const wantMessages = filters.type !== "deliverables";

  const [messages, deliverables] = await Promise.all([
    wantMessages
      ? listActivityMessages(workspaceId, meId, filters, opts.before, limit + 1)
      : Promise.resolve([]),
    wantDeliverables
      ? listActivityDeliverables(workspaceId, meId, filters, opts.before, limit + 1)
      : Promise.resolve([]),
  ]);

  const items: ActivityItem[] = [
    ...messages.map((m): ActivityItem => ({ type: "message", message: m })),
    ...deliverables.map((d): ActivityItem => ({ type: "deliverable", deliverable: d })),
  ].sort((a, b) => {
    // pg hands created_at back as Date objects (they ISO-serialize over the wire).
    const ta = a.type === "message" ? a.message.created_at : a.deliverable.created_at;
    const tb = b.type === "message" ? b.message.created_at : b.deliverable.created_at;
    return new Date(tb).getTime() - new Date(ta).getTime();
  });

  const hasMore = items.length > limit;
  return { items: items.slice(0, limit), hasMore };
}

// type:deliverables in the ⌘K palette: deliverables matching the text/filters, newest first.
export function searchDeliverables(
  workspaceId: string,
  meId: string,
  filters: ActivityFilters,
  limit = 30,
): Promise<Deliverable[]> {
  return listActivityDeliverables(
    workspaceId,
    meId,
    filters,
    undefined,
    Math.min(50, Math.max(1, limit)),
  );
}
