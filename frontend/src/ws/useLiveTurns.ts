import { useCallback, useEffect, useRef, useState } from "react";
import type { TurnContext } from "@jungle/shared";
import type { AgentEvent } from "../api";

// A bounded, always-on buffer of each agent's CURRENT turn, fed from the workspace-wide
// agent_turn/agent_event WS frames. Powers the ambient "what is this agent doing right now"
// surfaces (trigger-message chips, DM activity strip, agent hover cards, channel roster,
// sidebar working-dots) without opening the full Activity view.
//
// Each turn carries its CONTEXT — the channel/thread/message whose dispatch triggered it — so
// surfaces can show work where it was requested instead of everywhere the agent is a member.
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

const MAX_EVENTS_PER_TURN = 300;
const VERSION_THROTTLE_MS = 250;

export function useLiveTurns(): {
  liveTurnsRef: React.RefObject<Map<string, LiveTurn>>;
  liveVersion: number;
  ingestLiveEvent: (
    agentId: string,
    turnId: string | null,
    event: unknown, // null for context-only frames (agent_turn)
    context?: TurnContext | null,
  ) => void;
} {
  const liveTurnsRef = useRef<Map<string, LiveTurn>>(new Map());
  const [liveVersion, setLiveVersion] = useState(0);
  const flushTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const ingestLiveEvent = useCallback(
    (agentId: string, turnId: string | null, event: unknown, context?: TurnContext | null) => {
      if (!turnId) return;
      const map = liveTurnsRef.current;
      let turn = map.get(agentId);
      if (!turn || turn.turnId !== turnId) {
        turn = { agentId, turnId, context: null, events: [], done: false, startedAt: Date.now() };
        map.set(agentId, turn);
      }
      // Context is set once and kept — it rides on every event frame, so a client that loads
      // mid-turn picks it up from whichever frame arrives first.
      if (context && !turn.context) turn.context = context;
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
        if ((event as { type?: string } | null)?.type === "result") turn.done = true;
      }
      if (!flushTimer.current) {
        flushTimer.current = setTimeout(() => {
          flushTimer.current = null;
          setLiveVersion((v) => v + 1);
        }, VERSION_THROTTLE_MS);
      }
    },
    [],
  );

  useEffect(
    () => () => {
      if (flushTimer.current) clearTimeout(flushTimer.current);
    },
    [],
  );

  return { liveTurnsRef, liveVersion, ingestLiveEvent };
}
