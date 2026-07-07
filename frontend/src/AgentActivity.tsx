import { useState } from "react";
import { interruptAgent, type AgentEvent, type AgentStatus, type Participant } from "./api";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { avatarClass, initials } from "@/lib/people";
import { cn } from "@/lib/utils";
import { Activity as ActivityIcon, SendHorizonal, Square } from "lucide-react";
import { ActivityTranscript } from "./components/chat/ActivityTranscript";
import { STATUS_DOT, STATUS_LABEL } from "./lib/chat";

// Live status dot + label (single source of truth for colors/labels: lib/chat.ts).
function StatusDot({ status }: { status: AgentStatus }) {
  return (
    <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
      <span className={cn("size-2 rounded-full", STATUS_DOT[status])} />
      {STATUS_LABEL[status]}
    </span>
  );
}

// The agent Activity view: a Claude-Code-style live transcript (turns of raw SDK events, parsed by
// sdkEvents + rendered by Transcript's TurnSection) with paginated history, plus a steering footer
// to DM the agent. This file is the shell — data loading, scroll/pin, stop, and layout.
export function AgentActivity({
  agent,
  events,
  focusTurnId,
  onClose,
  onSteer,
}: {
  agent: Participant;
  // Live-merged events for this agent, oldest-first, owned by the parent (buffered while open).
  events: AgentEvent[];
  // Open scrolled to this turn ("view the work behind this message").
  focusTurnId?: string | null;
  onClose: () => void;
  // Send a normal DM to the agent (flows through the inbox to the next turn boundary).
  onSteer: (agent: Participant, body: string) => Promise<void>;
}) {
  const isSdk = agent.runtime === "sdk";
  const [steer, setSteer] = useState("");
  const [stopping, setStopping] = useState(false);
  const [err, setErr] = useState("");

  async function stop() {
    if (stopping) return;
    setStopping(true);
    setErr("");
    try {
      const r = await interruptAgent(agent.id);
      if (!r.ok) setErr(r.error ?? "failed to stop agent");
      // On success the runner's turn_done/state broadcast flips agent.status back to idle.
    } catch (e) {
      setErr(String((e as Error).message ?? e));
    } finally {
      setStopping(false);
    }
  }

  async function sendSteer() {
    const body = steer.trim();
    if (!body) return;
    setSteer("");
    try {
      await onSteer(agent, body);
    } catch (e) {
      setErr(String((e as Error).message ?? e));
    }
  }

  const status: AgentStatus = agent.status ?? "idle";
  const running = status === "working";

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent
        data-testid="agent-activity"
        className={cn(
          // Mobile: full-screen sheet (no rounded corners, edge-to-edge).
          "flex h-screen-dvh max-h-none w-screen max-w-none flex-col gap-0 overflow-hidden rounded-none border-0 p-0",
          // Desktop: centered panel.
          "md:h-[85vh] md:max-h-[85vh] md:w-[92vw] md:max-w-3xl md:rounded-xl md:border",
        )}
      >
        {/* Header: identity + status + stop */}
        <DialogHeader className="flex flex-row items-center gap-3 border-b px-4 py-3">
          <Avatar className="size-9 rounded-md">
            <AvatarFallback className={cn(avatarClass(agent.handle), "rounded-md text-xs")}>
              {initials(agent.display_name)}
            </AvatarFallback>
          </Avatar>
          <div className="min-w-0 flex-1">
            <DialogTitle className="flex items-center gap-2 text-base">
              <span className="truncate">{agent.display_name}</span>
              <ActivityIcon className="size-4 shrink-0 text-muted-foreground" />
            </DialogTitle>
            <div className="mt-0.5 flex items-center gap-2 text-xs text-muted-foreground">
              <span className="truncate">@{agent.handle}</span>
              {isSdk && (
                <>
                  <span aria-hidden>·</span>
                  <StatusDot status={status} />
                </>
              )}
            </div>
          </div>
          {isSdk && running && (
            <Button
              data-testid="activity-stop"
              variant="destructive"
              size="sm"
              onClick={stop}
              disabled={stopping}
              className="mr-8 h-8 gap-1.5"
            >
              <Square className="size-3.5" />
              {stopping ? "Stopping…" : "Stop"}
            </Button>
          )}
        </DialogHeader>

        <ActivityTranscript agent={agent} events={events} running={running} focusTurnId={focusTurnId} />

        {err && (
          <div className="mx-4 mb-1 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-1.5 text-sm text-destructive">
            {err}
          </div>
        )}

        {/* Steering footer */}
        {isSdk && (
          <div className="border-t p-3">
            <div className="flex items-end gap-2 rounded-xl border bg-card p-2 shadow-sm focus-within:border-ring focus-within:ring-[3px] focus-within:ring-ring/20">
              <Input
                data-testid="activity-steer-input"
                value={steer}
                onChange={(e) => setSteer(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    sendSteer();
                  }
                }}
                placeholder={`Message @${agent.handle}…`}
                className="border-0 bg-transparent shadow-none focus-visible:ring-0"
              />
              <Button
                data-testid="activity-steer-send"
                onClick={sendSteer}
                size="icon"
                className="shrink-0"
                aria-label="Send message"
              >
                <SendHorizonal className="size-4" />
              </Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
