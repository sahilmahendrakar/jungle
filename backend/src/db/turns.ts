import { pool } from "./pool";
import type { DispatchContext } from "./agents";

// Durable turn <-> message anchoring (see migrations/020_turn_chips.sql). A turn starts anchored
// to the message that triggered it; a follow-up spliced into a turn already in progress joins the
// SAME turn instead of starting a new one, so it needs its own anchor row too.

// Ensure the turn row exists, and anchor `context.messageId` to it if given. Idempotent — safe to
// call once per batch a turn consumes (the original dispatch, and any later spliced-in one).
// Returns whether the message anchor was newly added (so callers only broadcast on real news).
export async function ensureTurn(
  agentId: string,
  turnId: string,
  context: DispatchContext | null,
): Promise<boolean> {
  await pool.query(
    `insert into agent_turns (agent_id, turn_id, channel_id, thread_root_id)
     values ($1, $2, $3, $4)
     on conflict (agent_id, turn_id) do nothing`,
    [agentId, turnId, context?.channelId ?? null, context?.threadRootId ?? null],
  );
  if (!context?.messageId) return false;
  const { rowCount } = await pool.query(
    `insert into agent_turn_messages (agent_id, turn_id, message_id)
     values ($1, $2, $3)
     on conflict (agent_id, turn_id, message_id) do nothing`,
    [agentId, turnId, context.messageId],
  );
  return (rowCount ?? 0) > 0;
}

// A turn ended (ok or not). Idempotent no-op once already marked done (turn_done can't double-fire
// per turn, but this guards against a stray replay).
export async function finishTurn(agentId: string, turnId: string, ok: boolean): Promise<void> {
  await pool.query(
    `update agent_turns set done_at = now(), ok = $3
     where agent_id = $1 and turn_id = $2 and done_at is null`,
    [agentId, turnId, ok],
  );
}

export interface TurnChip {
  turn_id: string;
  agent_id: string;
  message_ids: string[];
  started_at: string;
  done_at: string | null;
  ok: boolean | null;
  duration_ms: number | null;
}

// Recent turns anchored to a message in this channel — the hydration path for chips surviving a
// reload. Bounded to a recent window so the query stays cheap on a busy, long-lived channel.
export async function channelTurnChips(channelId: string): Promise<TurnChip[]> {
  const { rows } = await pool.query<{
    turn_id: string;
    agent_id: string;
    message_ids: string[];
    started_at: string;
    done_at: string | null;
    ok: boolean | null;
  }>(
    `select t.turn_id, t.agent_id, t.started_at, t.done_at, t.ok,
            array_agg(tm.message_id) as message_ids
     from agent_turns t
     join agent_turn_messages tm on tm.agent_id = t.agent_id and tm.turn_id = t.turn_id
     where t.channel_id = $1 and t.started_at > now() - interval '24 hours'
     group by t.agent_id, t.turn_id, t.started_at, t.done_at, t.ok
     order by t.started_at desc
     limit 200`,
    [channelId],
  );
  return rows.map((r) => ({
    ...r,
    duration_ms:
      r.done_at != null ? new Date(r.done_at).getTime() - new Date(r.started_at).getTime() : null,
  }));
}

export interface QueuedChip {
  agent_id: string;
  message_id: string;
}

// Inbox items still waiting behind a busy turn, anchored to a message in this channel — lets a
// reload show "queued" chips for dispatches that haven't started a turn yet.
export async function channelQueuedChips(channelId: string): Promise<QueuedChip[]> {
  const { rows } = await pool.query<QueuedChip>(
    `select agent_id, context->>'messageId' as message_id
     from agent_inbox
     where delivered_at is null
       and context->>'channelId' = $1
       and context->>'messageId' is not null`,
    [channelId],
  );
  return rows;
}
