import { useCallback, useEffect, useRef, useState } from "react";
import type { TurnContext } from "@jungle/shared";
import type { AgentEvent, QueuedChipRow, TurnChipRow } from "../api";

// A bounded, always-on buffer of each agent's CURRENT turn, fed from the workspace-wide
// agent_turn/agent_event WS frames. Powers the ambient "what is this agent doing right now"
// surfaces (the DM activity strip, agent hover cards, channel roster, sidebar working-dots)
// without opening the full Activity view. Keyed by agentId: an agent only runs one turn at a
// time, so its single "current" slot is all these surfaces need.
//
// Each turn carries its CONTEXT — the channel/thread/message whose dispatch triggered it — so
// surfaces can show work where it was requested instead of everywhere the agent is a member of.
//
// Perf shape: SDK events stream at token rate while an agent works, so the buffer lives in a
// ref and consumers re-render off a throttled version counter (~4/s), not per frame.

export interface LiveTurn {
  agentId: string;
  turnId: string;
  context: TurnContext | null; // null until an agent_turn / context-carrying frame arrives
  events: AgentEvent[]; // this turn only, oldest-first, capped
  done: boolean; // a result event arrived (kept until the next turn starts)
  startedAt: number;
}

// The trigger-message chip's data: keyed by turn (agentId+turnId), NOT by agent alone — unlike
// LiveTurn above, a channel can hold chips for several of the same agent's turns at once (each
// anchored to a different message), so a single per-agent slot would lose all but the latest.
// One turn can anchor MULTIPLE messages (a follow-up spliced into a turn already running joins
// the same turn instead of starting a new one) — that's what messageIds captures.
export interface TurnChipData {
  agentId: string;
  turnId: string;
  messageIds: string[];
  events: AgentEvent[]; // live only — empty for a hydrated (reload-recovered) turn
  done: boolean;
  ok: boolean | null;
  durationMs: number | null;
  startedAt: number;
}

// A dispatch waiting in the agent's inbox behind a turn already in progress — no turn_id yet.
export interface QueuedTurn {
  agentId: string;
  messageId: string;
  channelId: string;
}

const MAX_EVENTS_PER_TURN = 300;
const VERSION_THROTTLE_MS = 250;

function turnKey(agentId: string, turnId: string): string {
  return `${agentId}:${turnId}`;
}

// Parse the SDK's terminal "result" event the same way the Activity transcript does (see
// activity/sdkEvents.ts's `kind: "result"` handling) — duplicated narrowly here rather than
// imported, since this hook has no reason to depend on the transcript-rendering module.
function resultFromEvent(event: unknown): { ok: boolean; durationMs: number | null } | null {
  const e = event as { type?: string; is_error?: boolean; subtype?: string; duration_ms?: number } | null;
  if (e?.type !== "result") return null;
  return {
    ok: e.is_error !== true && (e.subtype ?? "success") === "success",
    durationMs: typeof e.duration_ms === "number" ? e.duration_ms : null,
  };
}

export function useLiveTurns(): {
  liveTurnsRef: React.RefObject<Map<string, LiveTurn>>;
  turnChipsRef: React.RefObject<Map<string, TurnChipData>>;
  queuedRef: React.RefObject<Map<string, QueuedTurn>>;
  liveVersion: number;
  ingestLiveEvent: (
    agentId: string,
    turnId: string | null,
    event: unknown, // null for context-only frames (agent_turn)
    context?: TurnContext | null,
  ) => void;
  ingestQueued: (agentId: string, context: TurnContext) => void;
  // Seed durable (reload-recovered) chip data for a channel, merged with whatever's already
  // tracked live — a live/already-hydrated entry always wins, so this never clobbers fresher
  // state that arrived while the fetch was in flight.
  hydrateChannel: (channelId: string, turns: TurnChipRow[], queued: QueuedChipRow[]) => void;
} {
  const liveTurnsRef = useRef<Map<string, LiveTurn>>(new Map());
  const turnChipsRef = useRef<Map<string, TurnChipData>>(new Map());
  const queuedRef = useRef<Map<string, QueuedTurn>>(new Map());
  const [liveVersion, setLiveVersion] = useState(0);
  const flushTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const bump = useCallback(() => {
    if (!flushTimer.current) {
      flushTimer.current = setTimeout(() => {
        flushTimer.current = null;
        setLiveVersion((v) => v + 1);
      }, VERSION_THROTTLE_MS);
    }
  }, []);

  const ingestLiveEvent = useCallback(
    (agentId: string, turnId: string | null, event: unknown, context?: TurnContext | null) => {
      if (!turnId) return;
      // Per-agent "current turn" slot (ambient status surfaces) — unchanged shape/semantics.
      const map = liveTurnsRef.current;
      let turn = map.get(agentId);
      if (!turn || turn.turnId !== turnId) {
        turn = { agentId, turnId, context: null, events: [], done: false, startedAt: Date.now() };
        map.set(agentId, turn);
      }
      if (context && !turn.context) turn.context = context;

      // Per-turn chip slot (trigger-message chips) — reused across calls for the same turn, so a
      // splice's later context.messageId ADDS to the anchor set instead of replacing it, and a
      // hydrated-then-still-running turn keeps accumulating into the same entry.
      const key = turnKey(agentId, turnId);
      let chip = turnChipsRef.current.get(key);
      if (!chip) {
        chip = { agentId, turnId, messageIds: [], events: [], done: false, ok: null, durationMs: null, startedAt: Date.now() };
        turnChipsRef.current.set(key, chip);
      }
      if (context?.messageId && !chip.messageIds.includes(context.messageId)) {
        chip.messageIds.push(context.messageId);
        queuedRef.current.delete(context.messageId); // it's anchored to a real turn now
      }

      if (event != null) {
        turn.events.push({
          id: Date.now() + Math.random(), // synthetic id (matches the Activity view's live buffer)
          turn_id: turnId,
          event,
          created_at: new Date().toISOString(),
        });
        if (turn.events.length > MAX_EVENTS_PER_TURN) {
          // Keep the head (the inbound trigger orients the turn) and the fresh tail.
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
    },
    [bump],
  );

  const ingestQueued = useCallback(
    (agentId: string, context: TurnContext) => {
      if (!context.messageId || !context.channelId) return;
      queuedRef.current.set(context.messageId, {
        agentId,
        messageId: context.messageId,
        channelId: context.channelId,
      });
      bump();
    },
    [bump],
  );

  const hydrateChannel = useCallback(
    (channelId: string, turns: TurnChipRow[], queued: QueuedChipRow[]) => {
      for (const t of turns) {
        const key = turnKey(t.agent_id, t.turn_id);
        if (turnChipsRef.current.has(key)) continue; // live (or already-hydrated) data wins
        turnChipsRef.current.set(key, {
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
      const alreadyAnchored = new Set<string>();
      for (const chip of turnChipsRef.current.values()) {
        for (const mid of chip.messageIds) alreadyAnchored.add(mid);
      }
      for (const q of queued) {
        if (queuedRef.current.has(q.message_id) || alreadyAnchored.has(q.message_id)) continue;
        queuedRef.current.set(q.message_id, { agentId: q.agent_id, messageId: q.message_id, channelId });
      }
      bump();
    },
    [bump],
  );

  useEffect(
    () => () => {
      if (flushTimer.current) clearTimeout(flushTimer.current);
    },
    [],
  );

  return { liveTurnsRef, turnChipsRef, queuedRef, liveVersion, ingestLiveEvent, ingestQueued, hydrateChannel };
}
