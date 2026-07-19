// A bounded, always-on buffer of each agent's CURRENT turn, fed from the workspace-wide
// agent_turn/agent_event/agent_queued WS frames. Powers the ambient "what is this agent doing
// right now" surfaces (trigger-message turn chips, Home working-dots) without opening the full
// Activity view. Verbatim port of frontend/src/ws/useLiveTurns.ts, reshaped for non-React use:
// the Maps live at module scope (mutated by the socket manager) and consumers re-render off a
// throttled `liveVersion` counter kept in the chat store — SDK events stream at token rate, so
// this never routes per-frame churn through React state.
import type { TurnContext } from "@jungle/shared";
import type { AgentEvent, TurnChipRow, QueuedChipRow } from "../lib/api";

export interface LiveTurn {
  agentId: string;
  turnId: string;
  context: TurnContext | null;
  events: AgentEvent[];
  done: boolean;
  startedAt: number;
}

export interface TurnChipData {
  agentId: string;
  turnId: string;
  messageIds: string[];
  events: AgentEvent[];
  done: boolean;
  ok: boolean | null;
  durationMs: number | null;
  startedAt: number;
}

export interface QueuedTurn {
  agentId: string;
  messageId: string;
  channelId: string;
}

const MAX_EVENTS_PER_TURN = 300;
const VERSION_THROTTLE_MS = 250;

export const liveTurns = new Map<string, LiveTurn>();
export const turnChips = new Map<string, TurnChipData>();
export const queued = new Map<string, QueuedTurn>();

const turnKey = (agentId: string, turnId: string) => `${agentId}:${turnId}`;

// The chat store registers this so a throttled tick can bump its `liveVersion` counter.
let bumpFn: (() => void) | null = null;
export function setLiveBump(fn: () => void) {
  bumpFn = fn;
}

let flushTimer: ReturnType<typeof setTimeout> | null = null;
function bump() {
  if (flushTimer) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    bumpFn?.();
  }, VERSION_THROTTLE_MS);
}

function resultFromEvent(event: unknown): { ok: boolean; durationMs: number | null } | null {
  const e = event as { type?: string; is_error?: boolean; subtype?: string; duration_ms?: number } | null;
  if (e?.type !== "result") return null;
  return {
    ok: e.is_error !== true && (e.subtype ?? "success") === "success",
    durationMs: typeof e.duration_ms === "number" ? e.duration_ms : null,
  };
}

export function ingestLiveEvent(
  agentId: string,
  turnId: string | null,
  event: unknown,
  context?: TurnContext | null,
) {
  if (!turnId) return;
  let turn = liveTurns.get(agentId);
  if (!turn || turn.turnId !== turnId) {
    turn = { agentId, turnId, context: null, events: [], done: false, startedAt: Date.now() };
    liveTurns.set(agentId, turn);
  }
  if (context && !turn.context) turn.context = context;

  const key = turnKey(agentId, turnId);
  let chip = turnChips.get(key);
  if (!chip) {
    chip = { agentId, turnId, messageIds: [], events: [], done: false, ok: null, durationMs: null, startedAt: Date.now() };
    turnChips.set(key, chip);
  }
  if (context?.messageId) {
    if (!chip.messageIds.includes(context.messageId)) chip.messageIds.push(context.messageId);
    queued.delete(context.messageId);
  }

  if (event != null) {
    turn.events.push({
      id: Date.now() + Math.random(),
      turn_id: turnId,
      event,
      created_at: new Date().toISOString(),
    });
    if (turn.events.length > MAX_EVENTS_PER_TURN) {
      turn.events = [...turn.events.slice(0, 5), ...turn.events.slice(-(MAX_EVENTS_PER_TURN - 5))];
    }
    chip.events = turn.events;
    const result = resultFromEvent(event);
    if (result) {
      turn.done = true;
      chip.done = true;
      chip.ok = result.ok;
      chip.durationMs = result.durationMs;
    }
  }
  bump();
}

export function ingestQueued(agentId: string, context: TurnContext) {
  if (!context.messageId || !context.channelId) return;
  for (const chip of turnChips.values()) {
    if (chip.agentId === agentId && !chip.done && chip.messageIds.includes(context.messageId)) return;
  }
  queued.set(context.messageId, { agentId, messageId: context.messageId, channelId: context.channelId });
  bump();
}

export function hydrateChannel(channelId: string, turns: TurnChipRow[], q: QueuedChipRow[]) {
  for (const t of turns) {
    const key = turnKey(t.agent_id, t.turn_id);
    if (turnChips.has(key)) continue; // live/already-hydrated wins
    turnChips.set(key, {
      agentId: t.agent_id,
      turnId: t.turn_id,
      messageIds: t.message_ids,
      events: [],
      done: t.done_at != null,
      ok: t.ok,
      durationMs: t.duration_ms,
      startedAt: new Date(t.started_at).getTime(),
    });
  }
  const runningAnchored = new Set<string>();
  for (const chip of turnChips.values()) {
    if (chip.done) continue;
    for (const mid of chip.messageIds) runningAnchored.add(`${chip.agentId}:${mid}`);
  }
  for (const item of q) {
    if (queued.has(item.message_id)) continue;
    if (runningAnchored.has(`${item.agent_id}:${item.message_id}`)) continue;
    queued.set(item.message_id, { agentId: item.agent_id, messageId: item.message_id, channelId });
  }
  bump();
}

export function resetLiveTurns() {
  liveTurns.clear();
  turnChips.clear();
  queued.clear();
}

// --- selectors (pure reads over the module Maps; call inside a liveVersion-subscribed render) ---

export function turnsForMessage(messageId: string): TurnChipData[] {
  const out: TurnChipData[] = [];
  for (const chip of turnChips.values()) if (chip.messageIds.includes(messageId)) out.push(chip);
  return out;
}

export function queuedForMessage(messageId: string): QueuedTurn | undefined {
  return queued.get(messageId);
}

export function channelHasRunningTurn(channelId: string): boolean {
  for (const turn of liveTurns.values()) {
    if (!turn.done && turn.context?.channelId === channelId) return true;
  }
  return false;
}

export function currentTurnForAgent(agentId: string): LiveTurn | undefined {
  return liveTurns.get(agentId);
}
