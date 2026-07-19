import { useMemo, useState } from "react";
import {
  Activity as ActivityIcon,
  Bot,
  ExternalLink,
  MessageSquare,
  Plus,
  Search,
  ShieldQuestion,
  Users,
} from "lucide-react";
import type { Deliverable, Participant } from "./api";
import { STATUS_DOT, STATUS_LABEL, fmtRelative, fmtTokens, type ToolConfirm } from "./lib/chat";
import type { LiveTurn } from "./ws/useLiveTurns";
import { buildItems, liveSummary } from "./components/chat/activity/sdkEvents";
import { shortDeliverableUrl } from "./components/chat/deliverableCards";
import { ViewShell } from "./components/chat/ViewShell";
import { PersonAvatar } from "./components/chat/panels";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

// Mission control: the whole team at a glance — humans and agents. Agents show live status, what
// they're doing right now, what's waiting on you, and the last thing they shipped; humans show
// who they are and a quick DM path. The landing view when no conversation is open: the product
// is a team of workers, and this is the floor you walk in onto.

type KindFilter = "all" | "human" | "agent";

const KIND_TABS: { value: KindFilter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "human", label: "Humans" },
  { value: "agent", label: "Agents" },
];

function matchesQuery(p: Participant, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return (
    p.display_name.toLowerCase().includes(q) ||
    p.handle.toLowerCase().includes(q) ||
    `@${p.handle}`.toLowerCase().includes(q)
  );
}

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

// A human teammate: identity + a DM path. None of the agent machinery (status, context, runs).
function PersonCard({
  person,
  onOpenDm,
  onOpenProfile,
}: {
  person: Participant;
  onOpenDm: (personId: string) => void;
  onOpenProfile: (personId: string) => void;
}) {
  return (
    <div
      data-testid="person-card"
      className="flex flex-col rounded-xl border bg-card p-4 shadow-sm transition-colors hover:border-primary/30"
    >
      <div className="flex items-start gap-3">
        <button onClick={() => onOpenProfile(person.id)} className="shrink-0 transition-opacity hover:opacity-80">
          <PersonAvatar name={person.display_name} handle={person.handle} />
        </button>
        <div className="min-w-0 flex-1">
          <button
            onClick={() => onOpenProfile(person.id)}
            className="block max-w-full truncate text-sm font-semibold hover:underline"
          >
            {person.display_name}
          </button>
          <div className="truncate text-xs text-muted-foreground">@{person.handle}</div>
        </div>
        <span className="inline-flex shrink-0 items-center rounded-full border px-2 py-0.5 text-[11px] font-medium text-muted-foreground">
          Human
        </span>
      </div>

      <div className="mt-3 min-h-10 space-y-1.5 text-xs text-muted-foreground/60">
        <div className="truncate">
          {person.role === "admin" ? "Admin" : "Member"}
          {person.email ? ` · ${person.email}` : ""}
        </div>
      </div>

      <div className="mt-3 flex items-center gap-2 border-t pt-3">
        <Button
          size="sm"
          variant="outline"
          data-testid="person-card-dm"
          onClick={() => onOpenDm(person.id)}
          className="h-7 gap-1.5 text-xs"
        >
          <MessageSquare className="size-3.5" /> Message
        </Button>
      </div>
    </div>
  );
}

export function AgentsHome({
  participants,
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
  participants: Participant[];
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
  const [query, setQuery] = useState("");
  const [kindFilter, setKindFilter] = useState<KindFilter>("all");

  const confirmsByAgent = useMemo(() => {
    const m = new Map<string, number>();
    for (const c of confirms) {
      if (c.agentId) m.set(c.agentId, (m.get(c.agentId) ?? 0) + 1);
    }
    return m;
  }, [confirms]);

  const kindCounts = useMemo(() => {
    let humans = 0;
    let agents = 0;
    for (const p of participants) {
      if (p.kind === "agent") agents++;
      else humans++;
    }
    return { all: participants.length, human: humans, agent: agents };
  }, [participants]);

  // Kind filter + name/handle search, then working agents float to the top; then those with
  // something waiting; then the rest by name.
  const visible = useMemo(() => {
    const rank = (p: Participant) =>
      p.kind === "agent" && (p.status === "working" || p.status === "waking")
        ? 0
        : (confirmsByAgent.get(p.id) ?? 0) > 0
          ? 1
          : 2;
    return participants
      .filter((p) => (kindFilter === "all" ? true : p.kind === kindFilter))
      .filter((p) => matchesQuery(p, query))
      .sort((a, b) => rank(a) - rank(b) || a.display_name.localeCompare(b.display_name));
  }, [participants, kindFilter, query, confirmsByAgent]);

  const lastShippedByAgent = useMemo(() => {
    const m = new Map<string, Deliverable>();
    for (const d of deliverables) if (!m.has(d.agent_id)) m.set(d.agent_id, d); // newest-first list
    return m;
  }, [deliverables]);

  const searching = query.trim().length > 0 || kindFilter !== "all";

  return (
    <ViewShell
      icon={<Users className="size-5" />}
      title="Team"
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
      {/* Search by name or handle, with a humans/agents filter on the right. */}
      <div className="mb-4 flex items-center gap-2">
        <div className="relative min-w-0 flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground/60" />
          <Input
            data-testid="team-search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search by name or handle…"
            className="pl-9"
          />
        </div>
        <div
          data-testid="team-kind-filter"
          className="flex shrink-0 items-center rounded-lg border bg-muted/40 p-0.5"
        >
          {KIND_TABS.map((tab) => (
            <button
              key={tab.value}
              data-testid={`team-filter-${tab.value}`}
              data-active={kindFilter === tab.value || undefined}
              onClick={() => setKindFilter(tab.value)}
              className={cn(
                "rounded-md px-2.5 py-1 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground",
                kindFilter === tab.value && "bg-background text-foreground shadow-sm",
              )}
            >
              {tab.label}
              <span className="ml-1 text-[10px] tabular-nums text-muted-foreground/60">
                {kindCounts[tab.value]}
              </span>
            </button>
          ))}
        </div>
      </div>

      {participants.length === 0 ? (
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
      ) : visible.length === 0 ? (
        <div className="rounded-xl border border-dashed p-10 text-center" data-testid="team-no-results">
          <Search className="mx-auto size-8 text-muted-foreground/50" />
          <p className="mt-3 text-sm font-medium">No one matches</p>
          <p className="mx-auto mt-1 max-w-sm text-sm text-muted-foreground">
            Try a different name or handle
            {kindFilter !== "all" ? ", or widen the filter to everyone" : ""}.
          </p>
          {searching && (
            <Button
              variant="outline"
              className="mt-4"
              data-testid="team-clear-search"
              onClick={() => {
                setQuery("");
                setKindFilter("all");
              }}
            >
              Clear search
            </Button>
          )}
        </div>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2">
          {visible.map((p) =>
            p.kind === "agent" ? (
              <AgentCard
                key={p.id}
                agent={p}
                turn={liveTurns.get(p.id)}
                pendingConfirms={confirmsByAgent.get(p.id) ?? 0}
                lastShipped={lastShippedByAgent.get(p.id)}
                onOpenDm={onOpenDm}
                onOpenActivity={onOpenActivity}
                onOpenProfile={onOpenProfile}
                onOpenApprovals={onOpenApprovals}
              />
            ) : (
              <PersonCard
                key={p.id}
                person={p}
                onOpenDm={onOpenDm}
                onOpenProfile={onOpenProfile}
              />
            ),
          )}
        </div>
      )}
    </ViewShell>
  );
}
