import { useMemo } from "react";
import { Check, X } from "lucide-react";
import type { Participant } from "../../api";
import type { LiveTurn } from "../../ws/useLiveTurns";
import { WorkingDots } from "./layout";
import { buildItems, liveSummary, type ResultItem } from "./activity/sdkEvents";
import { cn } from "@/lib/utils";

// Live work anchored under the message that asked for it — the chat-native answer to "where do
// I watch an agent work in a channel?": the way replies live under a thread root, the work
// lives under the request. One chip per triggered agent; running chips carry a live one-line
// summary, finished ones settle into a quiet ✓/✗. Click-through opens the Activity view focused
// on that turn. (Live-session state: after a reload the agent's reply — with its own
// "view the work" affordance — is the durable record.)

function TurnChip({
  turn,
  agent,
  onOpenTurn,
}: {
  turn: LiveTurn;
  agent: Participant | undefined;
  onOpenTurn: (turn: LiveTurn) => void;
}) {
  const items = useMemo(
    () => buildItems(turn.events),
    [turn.events, turn.events.length], // eslint-disable-line react-hooks/exhaustive-deps
  );
  const result = turn.done
    ? (items.find((i) => i.kind === "result") as ResultItem | undefined)
    : undefined;
  const handle = agent?.handle ?? "agent";
  const secs =
    result?.durationMs != null
      ? `${(result.durationMs / 1000).toFixed(result.durationMs >= 60_000 ? 0 : 1)}s`
      : null;
  return (
    <button
      data-testid="turn-chip"
      data-state={turn.done ? "done" : "running"}
      onClick={() => onOpenTurn(turn)}
      title="View this work in Activity"
      className={cn(
        "flex w-fit max-w-full items-center gap-2 rounded-lg border px-2.5 py-1 text-left text-xs transition-colors",
        turn.done
          ? "border-border bg-muted/40 text-muted-foreground hover:bg-accent"
          : "border-emerald-500/30 bg-emerald-500/5 hover:bg-emerald-500/10",
      )}
    >
      {turn.done ? (
        result && !result.ok ? (
          <X className="size-3.5 shrink-0 text-destructive" />
        ) : (
          <Check className="size-3.5 shrink-0 text-emerald-600" />
        )
      ) : (
        <WorkingDots />
      )}
      <span className="min-w-0 truncate">
        <span className="font-medium text-foreground">@{handle}</span>{" "}
        <span className="text-muted-foreground">
          {turn.done
            ? `${result && !result.ok ? "failed" : "finished"}${secs ? ` · ${secs}` : ""}`
            : liveSummary(items)}
        </span>
      </span>
    </button>
  );
}

// All chips for one message (a multi-agent mention triggers several turns — one chip each).
// `contents` so each chip is a direct flex item of the shared footer row (reply chip + turn
// chips, all on one line) instead of nesting its own row inside that row.
export function MessageTurnChips({
  turns,
  personById,
  onOpenTurn,
}: {
  turns: LiveTurn[];
  personById: (id: string) => Participant | undefined;
  onOpenTurn: (turn: LiveTurn) => void;
}) {
  if (!turns.length) return null;
  return (
    <div data-testid="turn-chips" className="contents">
      {turns.map((t) => (
        <TurnChip key={`${t.agentId}:${t.turnId}`} turn={t} agent={personById(t.agentId)} onOpenTurn={onOpenTurn} />
      ))}
    </div>
  );
}
