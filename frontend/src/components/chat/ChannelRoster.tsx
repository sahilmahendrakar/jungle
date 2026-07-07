import { useMemo } from "react";
import { Activity as ActivityIcon, Bot, MessageSquare, X } from "lucide-react";
import type { Participant } from "../../api";
import type { LiveTurn } from "../../ws/useLiveTurns";
import { STATUS_DOT, STATUS_LABEL, STATUS_RANK, type ToolConfirm } from "../../lib/chat";
import { buildItems, liveSummary } from "./activity/sdkEvents";
import { PersonAvatar, EmptyState } from "./panels";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

// The channel's agents at a glance — the "give me the overview" surface (header 🤖 button →
// this right panel). Active agents float to the top; each row shows status + live "now" line.
// Click the row → the agent's profile; the Activity button → the activity+steer panel (which
// keeps a ← back to this roster). A channel-scoped slice of mission control.

function RosterRow({
  agent,
  turn,
  pendingConfirms,
  onOpenProfile,
  onMessage,
  onOpenActivity,
}: {
  agent: Participant;
  turn: LiveTurn | undefined;
  pendingConfirms: number;
  onOpenProfile: (id: string) => void;
  onMessage: (id: string) => void;
  onOpenActivity: (id: string) => void;
}) {
  const status = agent.status ?? "idle";
  const working = status === "working";
  const now = useMemo(
    () => (working && turn && !turn.done ? (buildItems(turn.events).length ? liveSummary(buildItems(turn.events)) : "starting…") : null),
    [working, turn, turn?.events.length, turn?.done], // eslint-disable-line react-hooks/exhaustive-deps
  );

  return (
    <div
      data-testid="roster-row"
      className="flex items-center gap-2.5 rounded-lg border bg-card p-2.5 transition-colors hover:border-primary/30"
    >
      {/* Card body → profile */}
      <button
        data-testid="roster-open-profile"
        onClick={() => onOpenProfile(agent.id)}
        className="flex min-w-0 flex-1 items-center gap-2.5 text-left"
      >
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
      </button>
      <Button
        variant="ghost"
        size="icon"
        data-testid="roster-activity"
        onClick={() => onOpenActivity(agent.id)}
        className={cn("size-7 shrink-0 text-muted-foreground", working && "text-emerald-600 dark:text-emerald-400")}
        title="View activity"
      >
        <ActivityIcon className="size-4" />
      </Button>
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
    </div>
  );
}

export function ChannelRoster({
  channelName,
  agents,
  liveTurns,
  confirms,
  onClose,
  onOpenProfile,
  onMessage,
  onOpenActivity,
}: {
  channelName: string;
  agents: Participant[];
  liveTurns: Map<string, LiveTurn>;
  confirms: ToolConfirm[];
  onClose: () => void;
  onOpenProfile: (id: string) => void;
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
                onOpenProfile={onOpenProfile}
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
