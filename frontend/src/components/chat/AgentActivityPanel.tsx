import { useState } from "react";
import { ArrowLeft, SendHorizonal, Square, X } from "lucide-react";
import { interruptAgent, type AgentEvent, type AgentStatus, type Participant } from "../../api";
import { STATUS_DOT, STATUS_LABEL } from "../../lib/chat";
import { ActivityTranscript } from "./ActivityTranscript";
import { PersonAvatar } from "./panels";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

// The agent Activity view as a RIGHT-PANEL surface (not a modal): the live Claude-Code-style
// transcript + a steer box, so you can watch an agent work and nudge it without leaving your
// channel or opening its DM. Header identity click → profile; optional back arrow returns to the
// roster it was opened from. Steering posts to the agent's DM quietly (App handles routing) so
// you stay put.
export function AgentActivityPanel({
  agent,
  events,
  focusTurnId,
  onBack,
  onClose,
  onOpenProfile,
  onSteer,
}: {
  agent: Participant;
  events: AgentEvent[];
  focusTurnId?: string | null;
  // When set, a ← back arrow returns here (e.g. the channel roster it was opened from).
  onBack?: () => void;
  onClose: () => void;
  onOpenProfile: (id: string) => void;
  onSteer: (agent: Participant, body: string) => Promise<void>;
}) {
  const [steer, setSteer] = useState("");
  const [stopping, setStopping] = useState(false);
  const [err, setErr] = useState("");
  const status: AgentStatus = agent.status ?? "idle";
  const running = status === "working";

  async function stop() {
    if (stopping) return;
    setStopping(true);
    setErr("");
    try {
      const r = await interruptAgent(agent.id);
      if (!r.ok) setErr(r.error ?? "failed to stop agent");
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

  return (
    <div className="flex h-full flex-col">
      {/* Header: back / identity + status / stop / close */}
      <header className="flex h-14 shrink-0 items-center gap-2 border-b px-3">
        {onBack && (
          <Button
            variant="ghost"
            size="icon"
            data-testid="activity-panel-back"
            onClick={onBack}
            className="size-8 shrink-0 text-muted-foreground"
            title="Back"
          >
            <ArrowLeft className="size-4" />
          </Button>
        )}
        <button
          data-testid="activity-panel-identity"
          onClick={() => onOpenProfile(agent.id)}
          className="flex min-w-0 flex-1 items-center gap-2.5 rounded-md px-1 py-1 text-left transition-colors hover:bg-accent"
          title="View profile"
        >
          <PersonAvatar name={agent.display_name} handle={agent.handle} size="sm" />
          <div className="min-w-0">
            <div className="truncate text-sm font-semibold">{agent.display_name}</div>
            <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <span className={cn("size-1.5 rounded-full", STATUS_DOT[status])} />
              {STATUS_LABEL[status]}
            </div>
          </div>
        </button>
        {running && (
          <Button
            variant="outline"
            size="sm"
            data-testid="activity-panel-stop"
            onClick={stop}
            disabled={stopping}
            className="h-8 shrink-0 gap-1.5 text-muted-foreground"
          >
            <Square className="size-3.5" />
            {stopping ? "Stopping…" : "Stop"}
          </Button>
        )}
        <Button
          variant="ghost"
          size="icon"
          data-testid="activity-panel-close"
          onClick={onClose}
          className="size-8 shrink-0 text-muted-foreground"
        >
          <X className="size-4" />
        </Button>
      </header>

      <ActivityTranscript agent={agent} events={events} running={running} focusTurnId={focusTurnId} />

      {err && (
        <div className="mx-3 mb-1 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-1.5 text-xs text-destructive">
          {err}
        </div>
      )}

      {/* Steer footer — posts to the agent quietly; you stay in your current view. */}
      <div className="border-t p-3">
        <div className="flex items-end gap-2 rounded-xl border bg-card p-2 shadow-sm focus-within:border-ring focus-within:ring-[3px] focus-within:ring-ring/20">
          <Input
            data-testid="activity-panel-steer"
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
            data-testid="activity-panel-steer-send"
            onClick={sendSteer}
            size="icon"
            className="shrink-0"
            aria-label="Send message"
          >
            <SendHorizonal className="size-4" />
          </Button>
        </div>
      </div>
    </div>
  );
}
