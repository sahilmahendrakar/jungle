import type { Participant } from "../../api";
import { fmtAge, statusIsStale } from "../../lib/chat";
import { cn } from "@/lib/utils";

// The agent's self-set status — the Slack-style "what I'm working on" line it writes with the
// set_status tool. ONE renderer, used by every surface that shows it (Team page cards and rows,
// the hover card, the channel roster, the profile panel), so the four can't drift in wording,
// truncation, or how they treat a stale status.
//
// Not to be confused with the presence dot (STATUS_DOT/STATUS_LABEL in lib/chat): that's
// "working/idle/sleeping", computed from the runner connection. These two render side by side and
// answer different questions — presence is "is it here?", this is "what is it on?".
//
// Age is always shown. That's deliberate: a status with no timestamp invites you to read it as
// current, and the whole risk of this feature is a day-old line masquerading as live.

export function AgentStatusLine({
  agent,
  className,
  // Larger, foreground-weight treatment for the surfaces where the status is the headline (the
  // Team page's working cards, the profile). Default is the muted inline treatment for rows.
  emphasis = false,
}: {
  agent: Participant;
  className?: string;
  emphasis?: boolean;
}) {
  if (!agent.status_text) return null;
  const stale = statusIsStale(agent.status_updated_at);
  const age = fmtAge(agent.status_updated_at);
  return (
    <span
      data-testid="agent-status-line"
      data-stale={stale || undefined}
      title={
        stale
          ? `"${agent.status_text}" — set ${age} ago, so it may be out of date`
          : agent.status_text
      }
      className={cn(
        "flex min-w-0 items-center gap-1.5 text-xs",
        emphasis ? "text-foreground" : "text-muted-foreground",
        // Dimmed rather than hidden: it may still be accurate, and it's the agent's own words.
        stale && "opacity-60",
        className,
      )}
    >
      {agent.status_emoji && (
        <span aria-hidden className="shrink-0 text-sm leading-none">
          {agent.status_emoji}
        </span>
      )}
      <span className="truncate">{agent.status_text}</span>
      {age && (
        <span className="shrink-0 text-[10px] tabular-nums text-muted-foreground/60">· {age}</span>
      )}
    </span>
  );
}
