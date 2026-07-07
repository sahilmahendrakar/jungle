import { createContext, useContext, useMemo, type ReactNode } from "react";
import { Activity as ActivityIcon, MessageSquare } from "lucide-react";
import type { Participant } from "../../api";
import type { LiveTurn } from "../../ws/useLiveTurns";
import { STATUS_DOT, STATUS_LABEL } from "../../lib/chat";
import { buildItems, liveSummary } from "./activity/sdkEvents";
import { PersonAvatar } from "./panels";
import { Button } from "@/components/ui/button";
import { HoverCard, HoverCardContent, HoverCardTrigger } from "@/components/ui/hover-card";
import { cn } from "@/lib/utils";

// The universal PULL surface for "what is this agent doing?": hover any @mention, sender avatar,
// or name and get the agent's status + live activity line + quick actions — in any channel, any
// context, with zero ambient footprint. The data (live turns, actions, roster) is provided once
// at the app root via AgentCardProvider so mentions deep inside Markdown can render a card
// knowing only an agent id.

interface AgentCardCtx {
  getAgent: (id: string) => Participant | undefined;
  getLiveTurn: (id: string) => LiveTurn | undefined;
  onMessage: (id: string) => void;
  onOpenActivity: (id: string) => void;
  onOpenProfile: (id: string) => void;
  // Bumps when live turns change, so cards recompute their "now" line.
  version: number;
}

const Ctx = createContext<AgentCardCtx | null>(null);

export function AgentCardProvider({
  value,
  children,
}: {
  value: AgentCardCtx;
  children: ReactNode;
}) {
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

// The card body — also reused verbatim by the roster panel's expanded rows.
export function AgentLiveLine({ turn }: { turn: LiveTurn | undefined }) {
  const summary = useMemo(() => {
    if (!turn || turn.done) return null;
    return liveSummary(buildItems(turn.events));
  }, [turn, turn?.events.length, turn?.done]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!summary) return null;
  return (
    <span className="flex items-center gap-1.5 text-xs text-emerald-600 dark:text-emerald-400">
      <ActivityIcon className="size-3.5 shrink-0" />
      <span className="truncate">{summary}</span>
    </span>
  );
}

function CardInner({ agent, ctx }: { agent: Participant; ctx: AgentCardCtx }) {
  const status = agent.status ?? "idle";
  const turn = ctx.getLiveTurn(agent.id);
  return (
    <div className="p-3">
      <div className="flex items-start gap-3">
        <button onClick={() => ctx.onOpenProfile(agent.id)} className="shrink-0">
          <PersonAvatar name={agent.display_name} handle={agent.handle} />
        </button>
        <div className="min-w-0 flex-1">
          <button
            onClick={() => ctx.onOpenProfile(agent.id)}
            className="block max-w-full truncate text-left text-sm font-semibold hover:underline"
          >
            {agent.display_name}
          </button>
          <div className="truncate text-xs text-muted-foreground">@{agent.handle}</div>
        </div>
        <span className="mt-0.5 flex shrink-0 items-center gap-1.5 text-[11px] font-medium text-muted-foreground">
          <span className={cn("size-1.5 rounded-full", STATUS_DOT[status])} />
          {STATUS_LABEL[status]}
        </span>
      </div>
      {agent.status === "working" && (
        <div className="mt-2 rounded-lg border bg-muted/40 px-2.5 py-1.5">
          <AgentLiveLine turn={turn} />
          {(!turn || turn.done) && <span className="text-xs text-muted-foreground">Working…</span>}
        </div>
      )}
      {agent.persona && (
        <p className="mt-2 line-clamp-2 text-xs text-muted-foreground">{agent.persona}</p>
      )}
      <div className="mt-3 flex gap-2">
        <Button
          size="sm"
          variant="outline"
          data-testid="hovercard-message"
          onClick={() => ctx.onMessage(agent.id)}
          className="h-7 flex-1 gap-1.5 text-xs"
        >
          <MessageSquare className="size-3.5" /> Message
        </Button>
        <Button
          size="sm"
          variant="ghost"
          data-testid="hovercard-activity"
          onClick={() => ctx.onOpenActivity(agent.id)}
          className="h-7 flex-1 gap-1.5 text-xs text-muted-foreground"
        >
          <ActivityIcon className="size-3.5" /> Activity
        </Button>
      </div>
    </div>
  );
}

// Wrap any trigger (a mention badge, an avatar, a name) to attach the agent card on hover.
// Renders children unchanged when there's no provider or the id isn't an agent (humans get no
// card), so it's safe to wrap every sender.
export function AgentHoverCard({
  agentId,
  children,
  asChild = true,
}: {
  agentId: string;
  children: ReactNode;
  asChild?: boolean;
}) {
  const ctx = useContext(Ctx);
  const agent = ctx?.getAgent(agentId);
  if (!ctx || !agent || agent.kind !== "agent") return <>{children}</>;
  return (
    <HoverCard openDelay={200} closeDelay={100}>
      <HoverCardTrigger asChild={asChild}>{children}</HoverCardTrigger>
      <HoverCardContent data-testid="agent-hover-card">
        <CardInner agent={agent} ctx={ctx} />
      </HoverCardContent>
    </HoverCard>
  );
}
