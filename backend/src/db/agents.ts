import type { AttachmentMeta } from "@jungle/shared";
import { pool } from "./pool";
import { withTransaction } from "./tx";

export interface AgentRow {
  id: string;
  workspace_id: string;
  handle: string;
  display_name: string;
  repo: string | null;
  model: string | null;
  mode: string;
  effort: string; // reasoning effort: low|medium|high|xhigh (default 'medium')
  runtime: string; // 'sdk'
  runner_token: string | null;
  runner_provider: string;
  runner_meta: Record<string, unknown> | null;
}

// The column list backing every AgentRow query (kept in one place so the shape can't drift).
const AGENT_COLUMNS = `id, workspace_id, handle, display_name, repo, model, mode, effort, runtime,
                       runner_token, runner_provider, runner_meta`;

// The workspace an agent belongs to (for scoping workspace-wide broadcasts of its events/status).
export async function getAgentWorkspaceId(agentId: string): Promise<string | null> {
  const { rows } = await pool.query<{ workspace_id: string }>(
    `select workspace_id from participants where id = $1`,
    [agentId],
  );
  return rows[0]?.workspace_id ?? null;
}

// Of the given participant ids, the ones that are agents.
export async function agentsByIds(ids: string[]): Promise<AgentRow[]> {
  if (!ids.length) return [];
  const { rows } = await pool.query<AgentRow>(
    `select ${AGENT_COLUMNS} from participants where kind = 'agent' and id = any($1)`,
    [ids],
  );
  return rows;
}

// The agent bound to a runner_token. Authenticates a runner's inbound WebSocket.
// Returns the full AgentRow so the caller can build `configure`.
export async function agentByRunnerToken(token: string): Promise<AgentRow | null> {
  if (!token) return null;
  const { rows } = await pool.query<AgentRow>(
    `select ${AGENT_COLUMNS} from participants where kind = 'agent' and runner_token = $1`,
    [token],
  );
  return rows[0] ?? null;
}

// Fetch a single agent by id, for the runner registry / lifecycle.
export async function getAgentRow(id: string): Promise<AgentRow | null> {
  const { rows } = await pool.query<AgentRow>(
    `select ${AGENT_COLUMNS} from participants where kind = 'agent' and id = $1`,
    [id],
  );
  return rows[0] ?? null;
}

// All sdk agents, for the idle-stop sweeper and boot reconciliation (they iterate every agent
// regardless of connection state).
export async function listSdkAgents(): Promise<AgentRow[]> {
  const { rows } = await pool.query<AgentRow>(
    `select ${AGENT_COLUMNS} from participants where kind = 'agent' and runtime = 'sdk'`,
  );
  return rows;
}

export interface RunnerMeta {
  machineId?: string;
  volumeId?: string;
}

// Provider handle for an agent's runner (Fly: {machineId, volumeId}; null for docker/unprovisioned).
export async function getRunnerMeta(agentId: string): Promise<RunnerMeta | null> {
  const { rows } = await pool.query<{ runner_meta: RunnerMeta | null }>(
    `select runner_meta from participants where id = $1`,
    [agentId],
  );
  return rows[0]?.runner_meta ?? null;
}

export async function setRunnerMeta(agentId: string, meta: RunnerMeta): Promise<void> {
  await pool.query(`update participants set runner_meta = $2 where id = $1`, [
    agentId,
    JSON.stringify(meta),
  ]);
}

export async function clearRunnerMeta(agentId: string): Promise<void> {
  await pool.query(`update participants set runner_meta = null where id = $1`, [agentId]);
}

// --- SDK runner: durable inbox + event log ---

// Per-dispatch context that rides on each inbox item: the cascade budget the turn's replies
// inherit, the channel/thread the dispatch was triggered in (confirm-card placement, default
// thread routing, crash notices), and — for scheduled turns — the schedule that fired. Persisted
// so it survives backend restarts; the ACTIVE context for an agent is the context of its most
// recently consumed item (latestConsumedContext), not an in-memory map.
export interface DispatchContext {
  budget: number;
  channelId: string;
  threadRootId: string | null;
  scheduleId?: string;
}

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
  context?: DispatchContext,
): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    `insert into agent_inbox (agent_id, text, attachments, context) values ($1, $2, $3, $4)
     returning id`,
    [
      agentId,
      text,
      attachments?.length ? JSON.stringify(attachments) : null,
      context ? JSON.stringify(context) : null,
    ],
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

// Record which turn is consuming these inbox items (the runner's `turn_started`). Does NOT touch
// delivered_at — durable delivery is only confirmed by `consumed` (markInboxConsumed).
export async function markInboxTurnStarted(
  agentId: string,
  inboxIds: string[],
  turnId: string,
): Promise<void> {
  if (!inboxIds.length) return;
  await pool.query(
    `update agent_inbox set turn_id = $3 where agent_id = $1 and id = any($2::uuid[])`,
    [agentId, inboxIds, turnId],
  );
}

// The agent's ACTIVE dispatch context: the context of its most recently consumed inbox item.
// Context is written at enqueue but only takes effect when the runner consumes the item — so a
// second dispatch queued behind a running turn can't clobber the live turn's routing. Within one
// consumed batch (delivered_at ties), the last-enqueued item wins — matching what the agent most
// recently read. Restart-safe: pure Postgres, no in-memory state.
export async function latestConsumedContext(agentId: string): Promise<DispatchContext | null> {
  const { rows } = await pool.query<{ context: DispatchContext }>(
    `select context from agent_inbox
     where agent_id = $1 and delivered_at is not null and context is not null
     order by delivered_at desc, created_at desc limit 1`,
    [agentId],
  );
  return rows[0]?.context ?? null;
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

// Fully delete an agent participant and everything tied to it. Most FKs cascade off
// participants (agent_inbox, agent_events, channel_members, channel_reads, github identity),
// but messages.sender_id is RESTRICT — so we must clear the agent's messages by hand, in a
// transaction. We also drop any DM channels the agent belonged to (a DM with a deleted agent
// is meaningless and would otherwise linger with a single member).
export async function deleteAgent(agentId: string): Promise<void> {
  await withTransaction(async (client) => {
    // DM channels the agent is a member of — deleting the channel cascades its members +
    // messages (including the human's side of the DM), which is what we want for a 1:1 DM.
    await client.query(
      `delete from channels
        where kind = 'dm'
          and id in (select channel_id from channel_members where participant_id = $1)`,
      [agentId],
    );
    // Threads bookkeeping BEFORE deleting the agent's remaining (group-channel) messages:
    // 1. Roots the agent replied to — their denormed reply_count/last_reply_at must be
    //    recomputed after its replies are gone (persistMessage only ever increments).
    const { rows: affectedRoots } = await client.query<{ id: string }>(
      `select distinct thread_root_id as id from messages
        where sender_id = $1 and thread_root_id is not null`,
      [agentId],
    );
    // 2. Threads the agent ROOTED — thread_root_id is ON DELETE CASCADE, so deleting the root
    //    would silently take other participants' replies with it. Detach those replies into
    //    top-level messages instead (their content/order survive via the channel seq stream).
    await client.query(
      `update messages
          set thread_root_id = null, also_to_channel = false
        where sender_id <> $1
          and thread_root_id in (select id from messages where sender_id = $1)`,
      [agentId],
    );
    // Remaining messages the agent sent in group channels (sender_id is RESTRICT, no cascade).
    // Its own replies to its own roots go via the root's cascade or this delete — either is fine.
    await client.query(`delete from messages where sender_id = $1`, [agentId]);
    // Recompute the denormed thread summary on surviving roots (deleted roots simply no longer
    // match). count(*)=0 also nulls last_reply_at, matching a never-replied message.
    await client.query(
      `update messages r
          set reply_count   = (select count(*) from messages m where m.thread_root_id = r.id),
              last_reply_at = (select max(m.created_at) from messages m where m.thread_root_id = r.id)
        where r.id = any($1::uuid[])`,
      [affectedRoots.map((r) => r.id)],
    );
    // The participant row — cascades agent_inbox, agent_events, channel_members, channel_reads,
    // and the github identity row.
    await client.query(`delete from participants where id = $1`, [agentId]);
  });
}
