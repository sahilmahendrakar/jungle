import { useEffect, useMemo, useRef, useState } from "react";
import { Activity, ChevronRight } from "lucide-react";
import type { Participant } from "../../api";
import type { LiveTurn } from "../../ws/useLiveTurns";
import { WorkingDots } from "./layout";
import { buildItems, liveSummary } from "./activity/sdkEvents";
import { ItemRow } from "./activity/Transcript";
import { cn } from "@/lib/utils";

// The ambient "agents are working here" strip above the composer — one row per busy agent with a
// live one-line summary of what it's doing right now, expandable in place to the current turn's
// transcript. This is how a channel sees agent work without leaving the conversation (the full
// history stays in the Activity view).

function AgentRow({
  agent,
  turn,
  onOpenActivity,
}: {
  agent: Participant;
  turn: LiveTurn | undefined;
  onOpenActivity: (agentId: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const waking = agent.status === "waking";
  const items = useMemo(
    () => (turn && !turn.done ? buildItems(turn.events) : []),
    [turn, turn?.events.length, turn?.done], // eslint-disable-line react-hooks/exhaustive-deps
  );
  const summary = waking ? "waking up…" : items.length ? liveSummary(items) : "starting…";

  // Keep the expanded transcript pinned to the newest item.
  const bodyRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const el = bodyRef.current;
    if (open && el) el.scrollTop = el.scrollHeight;
  }, [open, items.length]);

  return (
    <div className="min-w-0">
      <button
        type="button"
        data-testid="channel-activity-row"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full min-w-0 items-center gap-2 rounded-md px-2 py-1 text-left text-sm transition-colors hover:bg-muted/60"
      >
        <WorkingDots />
        <span className="min-w-0 flex-1 truncate">
          <span className="font-medium text-foreground">@{agent.handle}</span>{" "}
          <span className="text-muted-foreground">{summary}</span>
        </span>
        <span
          role="link"
          tabIndex={0}
          data-testid="channel-activity-open-full"
          onClick={(e) => {
            e.stopPropagation();
            onOpenActivity(agent.id);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.stopPropagation();
              onOpenActivity(agent.id);
            }
          }}
          title="Open full activity"
          className="flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground/60 transition-colors hover:bg-accent hover:text-foreground"
        >
          <Activity className="size-3.5" />
        </span>
        <ChevronRight
          className={cn(
            "size-3.5 shrink-0 text-muted-foreground/50 transition-transform",
            open && "rotate-90",
          )}
        />
      </button>
      {open && (
        <div
          ref={bodyRef}
          data-testid="channel-activity-transcript"
          className="mx-2 mb-1.5 max-h-64 space-y-0.5 overflow-y-auto rounded-md border bg-background/60 px-1.5 py-1.5"
        >
          {items.length === 0 ? (
            <div className="px-2 py-1 text-xs text-muted-foreground">
              {waking ? "Machine is starting up…" : "Waiting for the first event…"}
            </div>
          ) : (
            items.map((it) => <ItemRow key={it.key} item={it} turnDone={false} />)
          )}
        </div>
      )}
    </div>
  );
}

export function ChannelActivity({
  busyAgents,
  liveTurns,
  onOpenActivity,
}: {
  // Agents working/waking in the open conversation, from live `people` status.
  busyAgents: Participant[];
  liveTurns: Map<string, LiveTurn>;
  onOpenActivity: (agentId: string) => void;
}) {
  if (!busyAgents.length) return null;
  return (
    <div
      data-testid="channel-activity"
      className="mx-3 mb-1 rounded-xl border bg-card/60 p-1 shadow-sm md:mx-5"
    >
      {busyAgents.map((a) => (
        <AgentRow key={a.id} agent={a} turn={liveTurns.get(a.id)} onOpenActivity={onOpenActivity} />
      ))}
    </div>
  );
}
