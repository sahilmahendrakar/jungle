import { useMemo } from "react";
import {
  Activity as ActivityIcon,
  Bot,
  ExternalLink,
  MessageSquare,
  Plus,
  ShieldQuestion,
} from "lucide-react";
import type { Deliverable, Participant } from "./api";
import { STATUS_DOT, STATUS_LABEL, fmtRelative, fmtTokens, type ToolConfirm } from "./lib/chat";
import type { LiveTurn } from "./ws/useLiveTurns";
import { buildItems, liveSummary } from "./components/chat/activity/sdkEvents";
import { shortDeliverableUrl } from "./components/chat/deliverableCards";
import { ViewShell } from "./components/chat/ViewShell";
import { PersonAvatar } from "./components/chat/panels";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

// Mission control: every agent at a glance — live status, what it's doing right now, what's
// waiting on you, and the last thing it shipped. The landing view when no conversation is open:
// the product is a team of workers, and this is the floor you walk in onto.

function AgentCard({
  agent,
  turn,
  pendingConfirms,
  lastShipped,
  onOpenDm,
  onOpenActivity,
  onOpenProfile,
  onOpenApprovals,
}: {
  agent: Participant;
  turn: LiveTurn | undefined;
  pendingConfirms: number;
  lastShipped: Deliverable | undefined;
  onOpenDm: (agentId: string) => void;
  onOpenActivity: (agentId: string) => void;
  onOpenProfile: (agentId: string) => void;
  onOpenApprovals: () => void;
}) {
  const status = agent.status ?? "idle";
  const working = status === "working";
  // The one-line "now" summary from the live turn buffer (only while actually working).
  const now = useMemo(() => {
    if (!working || !turn || turn.done) return null;
    return liveSummary(buildItems(turn.events));
  }, [working, turn, turn?.events.length, turn?.done]); // eslint-disable-line react-hooks/exhaustive-deps

  const ctxPct =
    agent.context_tokens && agent.context_max_tokens
      ? Math.min(100, Math.round((agent.context_tokens / agent.context_max_tokens) * 100))
      : null;

  return (
    <div
      data-testid="agent-card"
      className="flex flex-col rounded-xl border bg-card p-4 shadow-sm transition-colors hover:border-primary/30"
    >
      <div className="flex items-start gap-3">
        <button onClick={() => onOpenProfile(agent.id)} className="shrink-0 transition-opacity hover:opacity-80">
          <PersonAvatar name={agent.display_name} handle={agent.handle} />
        </button>
        <div className="min-w-0 flex-1">
          <button
            onClick={() => onOpenProfile(agent.id)}
            className="block max-w-full truncate text-sm font-semibold hover:underline"
          >
            {agent.display_name}
          </button>
          <div className="truncate text-xs text-muted-foreground">@{agent.handle}</div>
        </div>
        <span
          data-testid="agent-card-status"
          data-status={status}
          className={cn(
            "inline-flex shrink-0 items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] font-medium",
            working ? "border-emerald-500/30 text-emerald-600 dark:text-emerald-400" : "text-muted-foreground",
          )}
        >
          <span className={cn("size-1.5 rounded-full", STATUS_DOT[status])} />
          {STATUS_LABEL[status]}
        </span>
      </div>

      {/* What it's doing / what it last shipped / what's blocked on you. */}
      <div className="mt-3 min-h-10 space-y-1.5 text-xs">
        {now && (
          <button
            onClick={() => onOpenActivity(agent.id)}
            className="flex w-full items-center gap-1.5 truncate text-left text-muted-foreground hover:text-foreground"
            title="Open activity"
          >
            <ActivityIcon className="size-3.5 shrink-0 text-emerald-500" />
            <span className="truncate">{now}</span>
          </button>
        )}
        {pendingConfirms > 0 && (
          <button
            onClick={onOpenApprovals}
            data-testid="agent-card-approvals"
            className="flex items-center gap-1.5 font-medium text-amber-600 hover:underline dark:text-amber-500"
          >
            <ShieldQuestion className="size-3.5 shrink-0" />
            {pendingConfirms} approval{pendingConfirms === 1 ? "" : "s"} waiting on you
          </button>
        )}
        {lastShipped && (
          <a
            href={lastShipped.url}
            target="_blank"
            rel="noreferrer"
            className="flex items-center gap-1.5 truncate text-muted-foreground hover:text-foreground"
          >
            <ExternalLink className="size-3.5 shrink-0" />
            <span className="truncate">
              Shipped {lastShipped.title ?? shortDeliverableUrl(lastShipped.url)}
            </span>
            <span className="shrink-0">· {fmtRelative(lastShipped.created_at)}</span>
          </a>
        )}
        {!now && !pendingConfirms && !lastShipped && (
          <div className="text-muted-foreground/60">
            {status === "offline"
              ? "Device offline — messages queue until it reconnects."
              : status === "sleeping"
                ? "Asleep — wakes on message."
                : "Ready for work."}
          </div>
        )}
      </div>

      {/* Context meter (only once the runner has reported) + actions. */}
      <div className="mt-3 flex items-center gap-2 border-t pt-3">
        <Button
          size="sm"
          variant="outline"
          data-testid="agent-card-dm"
          onClick={() => onOpenDm(agent.id)}
          className="h-7 gap-1.5 text-xs"
        >
          <MessageSquare className="size-3.5" /> Message
        </Button>
        <Button
          size="sm"
          variant="ghost"
          data-testid="agent-card-activity"
          onClick={() => onOpenActivity(agent.id)}
          className="h-7 gap-1.5 text-xs text-muted-foreground"
        >
          <ActivityIcon className="size-3.5" /> Activity
        </Button>
        {ctxPct != null && (
          <span
            className="ml-auto text-[10px] tabular-nums text-muted-foreground/60"
            title={`Context: ${fmtTokens(agent.context_tokens!)} / ${fmtTokens(agent.context_max_tokens!)} tokens`}
          >
            ctx {ctxPct}%
          </span>
        )}
      </div>
    </div>
  );
}

export function AgentsHome({
  agents,
  liveTurns,
  confirms,
  deliverables,
  sidebarOpen,
  onOpenDrawer,
  onExpandSidebar,
  onOpenDm,
  onOpenActivity,
  onOpenProfile,
  onOpenApprovals,
  onAddAgent,
}: {
  agents: Participant[];
  liveTurns: Map<string, LiveTurn>;
  confirms: ToolConfirm[];
  deliverables: Deliverable[];
  sidebarOpen: boolean;
  onOpenDrawer: () => void;
  onExpandSidebar: () => void;
  onOpenDm: (agentId: string) => void;
  onOpenActivity: (agentId: string) => void;
  onOpenProfile: (agentId: string) => void;
  onOpenApprovals: () => void;
  onAddAgent: () => void;
}) {
  // Working agents float to the top; then those with something waiting; then the rest by name.
  const sorted = useMemo(() => {
    const confirmsByAgent = new Map<string, number>();
    for (const c of confirms) {
      if (c.agentId) confirmsByAgent.set(c.agentId, (confirmsByAgent.get(c.agentId) ?? 0) + 1);
    }
    const rank = (a: Participant) =>
      a.status === "working" || a.status === "waking" ? 0 : (confirmsByAgent.get(a.id) ?? 0) > 0 ? 1 : 2;
    return [...agents].sort(
      (a, b) => rank(a) - rank(b) || a.display_name.localeCompare(b.display_name),
    );
  }, [agents, confirms]);

  const lastShippedByAgent = useMemo(() => {
    const m = new Map<string, Deliverable>();
    for (const d of deliverables) if (!m.has(d.agent_id)) m.set(d.agent_id, d); // newest-first list
    return m;
  }, [deliverables]);

  return (
    <ViewShell
      icon={<Bot className="size-5" />}
      title="Agents"
      sidebarOpen={sidebarOpen}
      onOpenDrawer={onOpenDrawer}
      onExpandSidebar={onExpandSidebar}
      testId="agents-home"
      actions={
        <Button size="sm" data-testid="agents-home-add" onClick={onAddAgent}>
          <Plus className="size-4" /> New agent
        </Button>
      }
    >
      {agents.length === 0 ? (
        <div className="rounded-xl border border-dashed p-10 text-center">
          <Bot className="mx-auto size-8 text-muted-foreground/50" />
          <p className="mt-3 text-sm font-medium">No agents yet</p>
          <p className="mx-auto mt-1 max-w-sm text-sm text-muted-foreground">
            Agents are persistent teammates: DM one or @mention it in a channel and it does real
            work — writes code, opens PRs, manages docs — while you watch live.
          </p>
          <Button className="mt-4" onClick={onAddAgent}>
            <Plus className="size-4" /> Add your first agent
          </Button>
        </div>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2">
          {sorted.map((a) => (
            <AgentCard
              key={a.id}
              agent={a}
              turn={liveTurns.get(a.id)}
              pendingConfirms={confirms.filter((c) => c.agentId === a.id).length}
              lastShipped={lastShippedByAgent.get(a.id)}
              onOpenDm={onOpenDm}
              onOpenActivity={onOpenActivity}
              onOpenProfile={onOpenProfile}
              onOpenApprovals={onOpenApprovals}
            />
          ))}
        </div>
      )}
    </ViewShell>
  );
}
