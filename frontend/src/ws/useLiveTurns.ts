import { useCallback, useEffect, useRef, useState } from "react";
import type { AgentEvent } from "../api";

// A bounded, always-on buffer of each agent's CURRENT turn, fed from the workspace-wide
// agent_event WS frames. Powers the ambient "what is this agent doing right now" surfaces
// (channel activity card, agents overview) without opening the full Activity view.
//
// Perf shape: SDK events stream at token rate while an agent works, so the buffer lives in a
// ref and consumers re-render off a throttled version counter (~4/s), not per frame.

export interface LiveTurn {
  agentId: string;
  turnId: string;
  events: AgentEvent[]; // this turn only, oldest-first, capped
  done: boolean; // a result event arrived (kept until the next turn starts)
  startedAt: number;
}

const MAX_EVENTS_PER_TURN = 300;
const VERSION_THROTTLE_MS = 250;

export function useLiveTurns(): {
  liveTurnsRef: React.RefObject<Map<string, LiveTurn>>;
  liveVersion: number;
  ingestLiveEvent: (agentId: string, turnId: string | null, event: unknown) => void;
} {
  const liveTurnsRef = useRef<Map<string, LiveTurn>>(new Map());
  const [liveVersion, setLiveVersion] = useState(0);
  const flushTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const ingestLiveEvent = useCallback((agentId: string, turnId: string | null, event: unknown) => {
    if (!turnId) return;
    const map = liveTurnsRef.current;
    let turn = map.get(agentId);
    if (!turn || turn.turnId !== turnId) {
      turn = { agentId, turnId, events: [], done: false, startedAt: Date.now() };
      map.set(agentId, turn);
    }
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
    if ((event as { type?: string } | null)?.type === "result") turn.done = true;
    if (!flushTimer.current) {
      flushTimer.current = setTimeout(() => {
        flushTimer.current = null;
        setLiveVersion((v) => v + 1);
      }, VERSION_THROTTLE_MS);
    }
  }, []);

  useEffect(
    () => () => {
      if (flushTimer.current) clearTimeout(flushTimer.current);
    },
    [],
  );

  return { liveTurnsRef, liveVersion, ingestLiveEvent };
}
