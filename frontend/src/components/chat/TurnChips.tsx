import { useMemo } from "react";
import { Check, Clock, X } from "lucide-react";
import type { Participant } from "../../api";
import type { QueuedTurn, TurnChipData } from "../../ws/useLiveTurns";
import { WorkingDots } from "./layout";
import { buildItems, liveSummary } from "./activity/sdkEvents";
import { cn } from "@/lib/utils";

// Live work anchored under the message that asked for it — the chat-native answer to "where do
// I watch an agent work in a channel?": the way replies live under a thread root, the work
// lives under the request. One chip per triggered agent (or per turn, if a follow-up got
// spliced into a turn already running — both messages then point at the SAME chip); running
// chips carry a live one-line summary, finished ones settle into a quiet ✓/✗, and a dispatch
// still waiting behind a busy agent shows a neutral "queued" chip until its turn exists. Click-
// through opens the Activity view focused on that turn. Durable across reload — the chip's
// ok/duration/messageIds are seeded from the backend's agent_turns table, not just live events.

function TurnChip({
  turn,
  agent,
  onOpenTurn,
}: {
  turn: TurnChipData;
  agent: Participant | undefined;
  onOpenTurn: (turn: TurnChipData) => void;
}) {
  const items = useMemo(
    () => buildItems(turn.events),
    [turn.events, turn.events.length], // eslint-disable-line react-hooks/exhaustive-deps
  );
  const handle = agent?.handle ?? "agent";
  const secs =
    turn.durationMs != null
      ? `${(turn.durationMs / 1000).toFixed(turn.durationMs >= 60_000 ? 0 : 1)}s`
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
        turn.ok === false ? (
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
            ? `${turn.ok === false ? "failed" : "finished"}${secs ? ` · ${secs}` : ""}`
            : items.length
              ? liveSummary(items)
              : "starting…"}
        </span>
      </span>
    </button>
  );
}

// A dispatch waiting behind a turn already in progress — no turn_id yet, so nothing to click
// through to. Settles into a real TurnChip (or folds into the running one it spliced into) once
// the runner actually picks it up.
function QueuedChip({ agentId, agent }: { agentId: string; agent: Participant | undefined }) {
  return (
    <div
      data-testid="queued-chip"
      className="flex w-fit max-w-full items-center gap-2 rounded-lg border border-border bg-muted/40 px-2.5 py-1 text-xs text-muted-foreground"
    >
      <Clock className="size-3.5 shrink-0" />
      <span className="min-w-0 truncate">
        <span className="font-medium text-foreground">@{agent?.handle ?? agentId}</span> queued…
      </span>
    </div>
  );
}

// All chips for one message (a multi-agent mention triggers several turns — one chip each).
// `contents` so each chip is a direct flex item of the shared footer row (reply chip + turn
// chips, all on one line) instead of nesting its own row inside that row.
export function MessageTurnChips({
  turns,
  queued,
  personById,
  onOpenTurn,
}: {
  turns: TurnChipData[];
  queued: QueuedTurn[];
  personById: (id: string) => Participant | undefined;
  onOpenTurn: (turn: TurnChipData) => void;
}) {
  if (!turns.length && !queued.length) return null;
  return (
    <div data-testid="turn-chips" className="contents">
      {queued.map((q) => (
        <QueuedChip key={`queued:${q.agentId}:${q.messageId}`} agentId={q.agentId} agent={personById(q.agentId)} />
      ))}
      {turns.map((t) => (
        <TurnChip key={`${t.agentId}:${t.turnId}`} turn={t} agent={personById(t.agentId)} onOpenTurn={onOpenTurn} />
      ))}
    </div>
  );
}
