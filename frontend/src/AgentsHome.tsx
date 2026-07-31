import { useMemo, useState, type ReactNode } from "react";
import {
  Activity as ActivityIcon,
  Bot,
  ExternalLink,
  MessageSquare,
  Plus,
  Search,
  ShieldQuestion,
  Users,
  Zap,
} from "lucide-react";
import type { Deliverable, Participant } from "./api";
import {
  STATUS_DOT,
  STATUS_LABEL,
  STATUS_RANK,
  fmtRelative,
  fmtTokens,
  type ToolConfirm,
} from "./lib/chat";
import type { LiveTurn } from "./ws/useLiveTurns";
import { buildItems, liveSummary } from "./components/chat/activity/sdkEvents";
import { shortDeliverableUrl } from "./components/chat/deliverableCards";
import { ViewShell } from "./components/chat/ViewShell";
import { AgentStatusLine } from "./components/chat/AgentStatusLine";
import { PersonAvatar } from "./components/chat/panels";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

// Mission control: the whole team at a glance — humans and agents. The landing view when no
// conversation is open: the product is a team of workers, and this is the floor you walk in onto.
//
// The page is organised by ATTENTION, in three sections, each hidden when empty:
//
//   ⚡ Working now — agents running a turn right now. Rich cards in a grid: what they're on (their
//                   own status line), what they're doing this second (the live tool line), and
//                   anything blocked on you.
//   Agents        — everyone else: idle, sleeping, offline. Compact rows.
//   People        — humans. Compact rows.
//
// Sorting alone used to carry this ("working floats to the top"), but with no visual boundary you
// couldn't see where working ENDED or count it at a glance. Sections make the ordering legible,
// and the density difference between a card and a row is itself the signal about where to look: a
// working agent earns four lines of screen, a sleeping one earns two.

type KindFilter = "all" | "human" | "agent";

const KIND_TABS: { value: KindFilter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "human", label: "Humans" },
  { value: "agent", label: "Agents" },
];

// "Working now" = actually running, or about to be. `waking` belongs here rather than below: the
// machine is starting because work is already queued, so the agent is busy from the user's point
// of view even though no turn has begun yet.
function isActive(p: Participant): boolean {
  return p.kind === "agent" && (p.status === "working" || p.status === "waking");
}

function matchesQuery(p: Participant, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return (
    p.display_name.toLowerCase().includes(q) ||
    p.handle.toLowerCase().includes(q) ||
    `@${p.handle}`.toLowerCase().includes(q) ||
    // Searching what someone is working ON is as natural as searching their name.
    (p.status_text ?? "").toLowerCase().includes(q)
  );
}

// The presence chip (dot + Working/Idle/Sleeping/…). Shared by the card and the row so the two
// treatments of the same fact can't drift.
function PresenceChip({ agent, bordered }: { agent: Participant; bordered?: boolean }) {
  const status = agent.status ?? "idle";
  const working = status === "working";
  return (
    <span
      data-testid="agent-card-status"
      data-status={status}
      className={cn(
        "inline-flex shrink-0 items-center gap-1.5 text-[11px] font-medium",
        bordered && "rounded-full border px-2 py-0.5",
        working ? "border-emerald-500/30 text-emerald-600 dark:text-emerald-400" : "text-muted-foreground",
      )}
    >
      <span className={cn("size-1.5 rounded-full", STATUS_DOT[status])} />
      {STATUS_LABEL[status]}
    </span>
  );
}

// A currently-working agent: the full treatment. Status headline, live activity, approvals, and
// both actions. These are the only cards on the page, which is what makes them read as "here".
function AgentCard({
  agent,
  turn,
  pendingConfirms,
  onOpenDm,
  onOpenActivity,
  onOpenProfile,
  onOpenApprovals,
}: {
  agent: Participant;
  turn: LiveTurn | undefined;
  pendingConfirms: number;
  onOpenDm: (agentId: string) => void;
  onOpenActivity: (agentId: string) => void;
  onOpenProfile: (agentId: string) => void;
  onOpenApprovals: () => void;
}) {
  // The one-line "now" summary from the live turn buffer — tool-level and ephemeral.
  const now = useMemo(() => {
    if (!turn || turn.done) return null;
    return liveSummary(buildItems(turn.events));
  }, [turn, turn?.events.length, turn?.done]); // eslint-disable-line react-hooks/exhaustive-deps

  const ctxPct =
    agent.context_tokens && agent.context_max_tokens
      ? Math.min(100, Math.round((agent.context_tokens / agent.context_max_tokens) * 100))
      : null;

  return (
    <div
      data-testid="agent-card"
      data-variant="card"
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
        <PresenceChip agent={agent} bordered />
      </div>

      {/* The two layers, in order of how long they stay true: the agent's own task-level status,
          then the tool it's on this second. When it never set a status the live line is promoted
          into the headline slot, so a working agent's card is never empty. */}
      <div className="mt-3 min-h-10 space-y-1.5 text-xs">
        {agent.status_text ? (
          <>
            <AgentStatusLine agent={agent} emphasis />
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
          </>
        ) : (
          <button
            onClick={() => onOpenActivity(agent.id)}
            className="flex w-full items-center gap-1.5 truncate text-left text-muted-foreground hover:text-foreground"
            title="Open activity"
          >
            <ActivityIcon className="size-3.5 shrink-0 text-emerald-500" />
            <span className="truncate">{now ?? "Starting…"}</span>
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
      </div>

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

// A not-currently-working agent: two lines. Keeps the `agent-card` testid — it's still "this
// agent's entry on the team page", which is what every lookup (tests included) means by it;
// `data-variant` tells the two treatments apart.
function AgentRow({
  agent,
  pendingConfirms,
  lastShipped,
  onOpenDm,
  onOpenActivity,
  onOpenProfile,
  onOpenApprovals,
}: {
  agent: Participant;
  pendingConfirms: number;
  lastShipped: Deliverable | undefined;
  onOpenDm: (agentId: string) => void;
  onOpenActivity: (agentId: string) => void;
  onOpenProfile: (agentId: string) => void;
  onOpenApprovals: () => void;
}) {
  const status = agent.status ?? "idle";
  return (
    <div
      data-testid="agent-card"
      data-variant="row"
      className="flex items-center gap-3 rounded-lg border bg-card px-3 py-2.5 transition-colors hover:border-primary/30"
    >
      <button
        onClick={() => onOpenProfile(agent.id)}
        className="shrink-0 transition-opacity hover:opacity-80"
      >
        <PersonAvatar name={agent.display_name} handle={agent.handle} size="sm" />
      </button>
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-2">
          <button
            onClick={() => onOpenProfile(agent.id)}
            className="truncate text-sm font-medium hover:underline"
          >
            {agent.display_name}
          </button>
          <span className="hidden truncate text-xs text-muted-foreground sm:inline">@{agent.handle}</span>
          <PresenceChip agent={agent} />
        </div>
        {/* Best available answer to "what's it on?", most durable first: its own status, then the
            last thing it shipped, then why it's quiet. */}
        <div className="mt-0.5 flex min-w-0 items-center gap-2 text-xs">
          {agent.status_text ? (
            <AgentStatusLine agent={agent} />
          ) : lastShipped ? (
            <a
              href={lastShipped.url}
              target="_blank"
              rel="noreferrer"
              className="flex min-w-0 items-center gap-1.5 truncate text-muted-foreground hover:text-foreground"
            >
              <ExternalLink className="size-3.5 shrink-0" />
              <span className="truncate">
                Shipped {lastShipped.title ?? shortDeliverableUrl(lastShipped.url)}
              </span>
              <span className="shrink-0">· {fmtRelative(lastShipped.created_at)}</span>
            </a>
          ) : (
            <span className="truncate text-muted-foreground/60">
              {status === "offline"
                ? "Device offline — messages queue until it reconnects."
                : status === "sleeping"
                  ? "Asleep — wakes on message."
                  : "Ready for work."}
            </span>
          )}
          {pendingConfirms > 0 && (
            <button
              onClick={onOpenApprovals}
              data-testid="agent-card-approvals"
              className="flex shrink-0 items-center gap-1 font-medium text-amber-600 hover:underline dark:text-amber-500"
            >
              <ShieldQuestion className="size-3.5" />
              {pendingConfirms} to approve
            </button>
          )}
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-0.5">
        <Button
          variant="ghost"
          size="icon"
          data-testid="agent-card-dm"
          onClick={() => onOpenDm(agent.id)}
          className="size-8 text-muted-foreground"
          title="Message"
        >
          <MessageSquare className="size-4" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          data-testid="agent-card-activity"
          onClick={() => onOpenActivity(agent.id)}
          className="size-8 text-muted-foreground"
          title="Activity"
        >
          <ActivityIcon className="size-4" />
        </Button>
      </div>
    </div>
  );
}

// A human teammate: identity + a DM path. None of the agent machinery (status, context, runs).
function PersonRow({
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
      className="flex items-center gap-3 rounded-lg border bg-card px-3 py-2.5 transition-colors hover:border-primary/30"
    >
      <button
        onClick={() => onOpenProfile(person.id)}
        className="shrink-0 transition-opacity hover:opacity-80"
      >
        <PersonAvatar name={person.display_name} handle={person.handle} size="sm" />
      </button>
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-2">
          <button
            onClick={() => onOpenProfile(person.id)}
            className="truncate text-sm font-medium hover:underline"
          >
            {person.display_name}
          </button>
          <span className="hidden truncate text-xs text-muted-foreground sm:inline">@{person.handle}</span>
        </div>
        <div className="mt-0.5 truncate text-xs text-muted-foreground/60">
          {person.role === "admin" ? "Admin" : "Member"}
          {person.email ? ` · ${person.email}` : ""}
        </div>
      </div>
      <Button
        variant="ghost"
        size="icon"
        data-testid="person-card-dm"
        onClick={() => onOpenDm(person.id)}
        className="size-8 shrink-0 text-muted-foreground"
        title="Message"
      >
        <MessageSquare className="size-4" />
      </Button>
    </div>
  );
}

// A section heading with its count. The count is half the point — "how many are working right
// now?" should be answerable without counting cards.
function SectionTitle({
  icon,
  label,
  count,
  testId,
}: {
  icon?: ReactNode;
  label: string;
  count: number;
  testId: string;
}) {
  return (
    <h3
      data-testid={testId}
      data-count={count}
      className="mb-2 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground"
    >
      {icon}
      {label}
      <span className="tabular-nums text-muted-foreground/60">· {count}</span>
    </h3>
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

  // Kind filter + search, then split into the three sections. Working agents lead with the ones
  // BLOCKED on a human: an agent stuck at an approval card isn't making progress, so it's the
  // most actionable thing on the page even though it reads as "working".
  const { working, idle, people } = useMemo(() => {
    const visible = participants
      .filter((p) => (kindFilter === "all" ? true : p.kind === kindFilter))
      .filter((p) => matchesQuery(p, query));
    const byName = (a: Participant, b: Participant) => a.display_name.localeCompare(b.display_name);
    return {
      working: visible
        .filter(isActive)
        .sort(
          (a, b) =>
            (confirmsByAgent.get(b.id) ?? 0) - (confirmsByAgent.get(a.id) ?? 0) || byName(a, b),
        ),
      idle: visible
        .filter((p) => p.kind === "agent" && !isActive(p))
        .sort(
          (a, b) =>
            STATUS_RANK[a.status ?? "idle"] - STATUS_RANK[b.status ?? "idle"] || byName(a, b),
        ),
      people: visible.filter((p) => p.kind === "human").sort(byName),
    };
  }, [participants, kindFilter, query, confirmsByAgent]);

  const lastShippedByAgent = useMemo(() => {
    const m = new Map<string, Deliverable>();
    for (const d of deliverables) if (!m.has(d.agent_id)) m.set(d.agent_id, d); // newest-first list
    return m;
  }, [deliverables]);

  const searching = query.trim().length > 0 || kindFilter !== "all";
  const nothingVisible = working.length + idle.length + people.length === 0;

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
      {/* Search by name, handle, or what someone's working on, with a humans/agents filter. */}
      <div className="mb-4 flex items-center gap-2">
        <div className="relative min-w-0 flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground/60" />
          <Input
            data-testid="team-search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search by name, handle, or what they're working on…"
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
      ) : nothingVisible ? (
        <div className="rounded-xl border border-dashed p-10 text-center" data-testid="team-no-results">
          <Search className="mx-auto size-8 text-muted-foreground/50" />
          <p className="mt-3 text-sm font-medium">No one matches</p>
          <p className="mx-auto mt-1 max-w-sm text-sm text-muted-foreground">
            Try a different name, handle, or status
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
        <div className="space-y-6">
          {working.length > 0 && (
            <section data-testid="team-section-working">
              <SectionTitle
                testId="team-working-title"
                icon={<Zap className="size-3.5 text-emerald-500" />}
                label="Working now"
                count={working.length}
              />
              <div className="grid gap-3 sm:grid-cols-2">
                {working.map((p) => (
                  <AgentCard
                    key={p.id}
                    agent={p}
                    turn={liveTurns.get(p.id)}
                    pendingConfirms={confirmsByAgent.get(p.id) ?? 0}
                    onOpenDm={onOpenDm}
                    onOpenActivity={onOpenActivity}
                    onOpenProfile={onOpenProfile}
                    onOpenApprovals={onOpenApprovals}
                  />
                ))}
              </div>
            </section>
          )}

          {idle.length > 0 && (
            <section data-testid="team-section-agents">
              <SectionTitle testId="team-agents-title" label="Agents" count={idle.length} />
              <div className="space-y-2">
                {idle.map((p) => (
                  <AgentRow
                    key={p.id}
                    agent={p}
                    pendingConfirms={confirmsByAgent.get(p.id) ?? 0}
                    lastShipped={lastShippedByAgent.get(p.id)}
                    onOpenDm={onOpenDm}
                    onOpenActivity={onOpenActivity}
                    onOpenProfile={onOpenProfile}
                    onOpenApprovals={onOpenApprovals}
                  />
                ))}
              </div>
            </section>
          )}

          {people.length > 0 && (
            <section data-testid="team-section-people">
              <SectionTitle testId="team-people-title" label="People" count={people.length} />
              <div className="space-y-2">
                {people.map((p) => (
                  <PersonRow key={p.id} person={p} onOpenDm={onOpenDm} onOpenProfile={onOpenProfile} />
                ))}
              </div>
            </section>
          )}
        </div>
      )}
    </ViewShell>
  );
}
