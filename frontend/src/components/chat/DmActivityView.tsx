import type { AgentEvent, Participant } from "../../api";
import { ActivityTranscript } from "./ActivityTranscript";

// The "View activity" mode for an agent DM: swaps the message list for the same live transcript
// the full-screen Activity dialog shows, in place, under the DM's own header/composer (no modal
// chrome, no steer footer — the DM's Composer already sends the agent a message).
export function DmActivityView({ agent, events }: { agent: Participant; events: AgentEvent[] }) {
  const running = (agent.status ?? "idle") === "working";
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <ActivityTranscript agent={agent} events={events} running={running} />
    </div>
  );
}
