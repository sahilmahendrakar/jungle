import type { ReactNode } from "react";
import type { Participant } from "../../api";
import { AgentHoverCard } from "./AgentHoverCard";
import { cn } from "@/lib/utils";

// The @mention badge — one component for every surface that renders a resolved mention: message
// bodies (via Markdown's `a` renderer) and the composer (via ComposerInput's mirror overlay).
// Wrapped in AgentHoverCard, so agents get the hover overlay everywhere (humans render through
// unchanged); clicking opens the participant's profile. Callers only reach for this once a
// handle has resolved to a known participant — unknown handles stay plain text.
export function MentionBadge({
  person,
  onOpenProfile,
  className,
  tabIndex,
  children,
}: {
  person: Participant;
  onOpenProfile?: (id: string) => void;
  className?: string;
  tabIndex?: number;
  // Defaults to @display_name (chat history). The composer passes the raw "@handle" text so the
  // badge occupies exactly the typed text's width and the mirror overlay stays aligned.
  children?: ReactNode;
}) {
  return (
    <AgentHoverCard agentId={person.id}>
      <button
        type="button"
        data-testid="mention-badge"
        tabIndex={tabIndex}
        onClick={() => onOpenProfile?.(person.id)}
        className={cn(
          "rounded px-1 py-0.5 align-baseline font-medium text-primary bg-primary/10 hover:bg-primary/20",
          className,
        )}
      >
        {children ?? `@${person.display_name}`}
      </button>
    </AgentHoverCard>
  );
}
