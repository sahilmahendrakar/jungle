import { useMemo, useState } from "react";
import { Activity as ActivityIcon, Bot, ChevronRight, MessageSquare, X } from "lucide-react";
import type { Participant } from "../../api";
import type { LiveTurn } from "../../ws/useLiveTurns";
import { STATUS_DOT, STATUS_LABEL, STATUS_RANK, type ToolConfirm } from "../../lib/chat";
import { buildItems, liveSummary } from "./activity/sdkEvents";
import { ItemRow } from "./activity/Transcript";
import { PersonAvatar, EmptyState } from "./panels";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

// The channel's agents at a glance — the "give me the overview" surface (header 🤖 button →
// this right panel). Active agents float to the top; each row shows status + live "now" line and
// expands in place to the current turn's transcript. A channel-scoped slice of mission control.

function RosterRow({
  agent,
  turn,
  pendingConfirms,
  onMessage,
  onOpenActivity,
}: {
  agent: Participant;
  turn: LiveTurn | undefined;
  pendingConfirms: number;
  onMessage: (id: string) => void;
  onOpenActivity: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const status = agent.status ?? "idle";
  const working = status === "working";
  const items = useMemo(
    () => (working && turn && !turn.done ? buildItems(turn.events) : []),
    [working, turn, turn?.events.length, turn?.done], // eslint-disable-line react-hooks/exhaustive-deps
  );
  const now = working ? (items.length ? liveSummary(items) : "starting…") : null;

  return (
    <div className="rounded-lg border bg-card">
      <div className="flex items-center gap-2.5 p-2.5">
        <PersonAvatar name={agent.display_name} handle={agent.handle} size="sm" />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span className="truncate text-sm font-medium">{agent.display_name}</span>
            <span
              className={cn("size-1.5 shrink-0 rounded-full", STATUS_DOT[status])}
              title={STATUS_LABEL[status]}
            />
          </div>
          <div className="truncate text-xs text-muted-foreground">
            {now ?? STATUS_LABEL[status]}
            {pendingConfirms > 0 && (
              <span className="ml-1 font-medium text-amber-600 dark:text-amber-500">
                · {pendingConfirms} to approve
              </span>
            )}
          </div>
        </div>
        <Button
          variant="ghost"
          size="icon"
          data-testid="roster-message"
          onClick={() => onMessage(agent.id)}
          className="size-7 shrink-0 text-muted-foreground"
          title="Message"
        >
          <MessageSquare className="size-4" />
        </Button>
        {working && (
          <button
            data-testid="roster-expand"
            onClick={() => setOpen((o) => !o)}
            className="flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-accent"
            title="Live activity"
          >
            <ChevronRight className={cn("size-4 transition-transform", open && "rotate-90")} />
          </button>
        )}
      </div>
      {open && working && (
        <div className="max-h-56 space-y-0.5 overflow-y-auto border-t px-2 py-1.5">
          {items.length ? (
            items.map((it) => <ItemRow key={it.key} item={it} turnDone={false} />)
          ) : (
            <div className="px-2 py-1 text-xs text-muted-foreground">Waiting for the first event…</div>
          )}
          <button
            onClick={() => onOpenActivity(agent.id)}
            className="mt-1 flex items-center gap-1 px-2 text-xs text-primary hover:underline"
          >
            <ActivityIcon className="size-3.5" /> Open full activity
          </button>
        </div>
      )}
    </div>
  );
}

export function ChannelRoster({
  channelName,
  agents,
  liveTurns,
  confirms,
  onClose,
  onMessage,
  onOpenActivity,
}: {
  channelName: string;
  agents: Participant[];
  liveTurns: Map<string, LiveTurn>;
  confirms: ToolConfirm[];
  onClose: () => void;
  onMessage: (id: string) => void;
  onOpenActivity: (id: string) => void;
}) {
  const sorted = useMemo(
    () =>
      [...agents].sort(
        (a, b) =>
          STATUS_RANK[a.status ?? "idle"] - STATUS_RANK[b.status ?? "idle"] ||
          a.display_name.localeCompare(b.display_name),
      ),
    [agents],
  );
  const confirmsByAgent = useMemo(() => {
    const m = new Map<string, number>();
    for (const c of confirms) if (c.agentId) m.set(c.agentId, (m.get(c.agentId) ?? 0) + 1);
    return m;
  }, [confirms]);

  return (
    <div className="flex h-full flex-col">
      <header className="flex h-14 shrink-0 items-center gap-2 border-b px-4">
        <Bot className="size-4 text-muted-foreground" />
        <h2 className="min-w-0 flex-1 truncate text-sm font-semibold">
          Agents in #{channelName}
        </h2>
        <Button
          variant="ghost"
          size="icon"
          data-testid="roster-close"
          onClick={onClose}
          className="size-8 text-muted-foreground"
        >
          <X className="size-4" />
        </Button>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        {sorted.length === 0 ? (
          <div className="flex h-full flex-col justify-center">
            <EmptyState icon={<Bot className="size-6" />}>
              No agents in this channel yet. @mention one to bring it in.
            </EmptyState>
          </div>
        ) : (
          <div className="space-y-2">
            {sorted.map((a) => (
              <RosterRow
                key={a.id}
                agent={a}
                turn={liveTurns.get(a.id)}
                pendingConfirms={confirmsByAgent.get(a.id) ?? 0}
                onMessage={onMessage}
                onOpenActivity={onOpenActivity}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
