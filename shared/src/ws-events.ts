// The app WebSocket contract (the browser client <-> backend socket at /api). Distinct from the
// runner protocol (see runner-protocol.ts). The backend emits ServerEvent frames (some to one
// socket, most fanned out to a channel or broadcast to all); the client sends ClientFrame frames.

import type { AgentStatus, Deliverable, Participant, WireMessage } from "./domain.js";

// ---- Server -> client ----

// Sent to a socket right after it authenticates.
export interface ConnectedEvent {
  type: "connected";
  participantId: string;
}

// Sent to a socket when its last inbound frame could not be processed.
export interface ErrorEvent {
  type: "error";
  error: string;
}

// A new (or thread-reply) message in a channel the recipient belongs to.
export interface MessageEvent {
  type: "message";
  message: WireMessage;
}

// An agent's live status changed (working/idle/sleeping/waking).
export interface AgentStatusChangedEvent {
  type: "agent_status_changed";
  agentId: string;
  status: AgentStatus;
}

// A self-hosted device's control connection came up or went down. Fanned out to the sockets of
// the device's OWNER account (a device is account-scoped, not workspace-scoped), so an open
// Environments page flips the online dot without a refetch. The agents running on that device
// emit their own agent_status_changed (offline/idle) separately.
export interface DeviceStatusChangedEvent {
  type: "device_status_changed";
  deviceId: string;
  online: boolean;
}

// A channel's membership changed (added/removed member); clients refetch members.
export interface MembersChangedEvent {
  type: "members_changed";
  channelId: string;
}

// A channel was deleted.
export interface ChannelDeletedEvent {
  type: "channel_deleted";
  channelId: string;
}

// A participant's editable fields changed (profile save). Carries the public participant.
export interface ParticipantUpdatedEvent {
  type: "participant_updated";
  participant: Participant;
}

// A participant (agent) was permanently deleted.
export interface ParticipantDeletedEvent {
  type: "participant_deleted";
  participantId: string;
}

// Where an agent's current turn came from: the channel (and thread/message) whose dispatch the
// runner consumed. This is what lets the client show work WHERE IT WAS REQUESTED — the trigger
// message's chip, the DM strip, the sidebar working-dot — instead of in every channel the agent
// happens to be a member of. Absent for turns with no dispatch context (e.g. compaction).
export interface TurnContext {
  channelId?: string;
  threadRootId?: string | null;
  messageId?: string; // the message whose dispatch triggered this turn
}

// A turn began: which agent, which turn, and where it was triggered from.
export interface AgentTurnEvent {
  type: "agent_turn";
  agentId: string;
  turnId: string;
  context: TurnContext | null;
}

// One raw SDK stream message from an agent's turn, for the live Activity transcript. Carries the
// turn's context on every frame so a client that loads mid-turn still learns the turn's home.
export interface AgentEventEvent {
  type: "agent_event";
  agentId: string;
  turnId: string;
  event: unknown;
  context?: TurnContext | null;
}

// A dispatch landed in the agent's inbox behind a turn already in progress — no turn_id yet
// (that only exists once the runner actually starts or splices it in). Lets the triggering
// message show a "queued — waiting for @agent" chip immediately instead of nothing.
export interface AgentQueuedEvent {
  type: "agent_queued";
  agentId: string;
  context: TurnContext;
}

// An agent's context-window occupancy after a turn (drives the profile usage meter).
export interface AgentContextEvent {
  type: "agent_context";
  agentId: string;
  tokens: number;
  maxTokens: number;
}

// An agent's long-term memory (MEMORY.md mirror) changed. Content is intentionally not carried
// (it can be ~12KB): an open profile panel refetches GET /api/agents/:id/memory.
export interface AgentMemoryChangedEvent {
  type: "agent_memory_changed";
  agentId: string;
}

// An always-ask agent is requesting confirmation for a sensitive tool call.
export interface ToolConfirmationRequestEvent {
  type: "tool_confirmation_request";
  confirmId: string;
  channelId: string;
  agentId: string;
  agentHandle: string;
  agentName: string;
  tool: string;
  input: unknown;
}

// A pending tool confirmation was resolved (by a human, or auto-denied on timeout — no `by`).
export interface ToolConfirmationResolvedEvent {
  type: "tool_confirmation_resolved";
  confirmId: string;
  channelId: string;
  result: "allow" | "deny";
  by?: string;
}

// A schedule in the recipient's workspace changed (created/updated/deleted, including fires and
// auto-pauses, which are updates). Coarse by design: clients refetch the schedule list.
export interface ScheduleChangedEvent {
  type: "schedule_changed";
  scheduleId: string;
  action: "created" | "updated" | "deleted";
}

// An agent shipped a work artifact (a PR opened, a doc written, …) — extracted from the links in
// its message at send time. Carries the full row so the Deliverables feed appends without a refetch.
export interface DeliverableCreatedEvent {
  type: "deliverable_created";
  deliverable: Deliverable;
}

export type ServerEvent =
  | ConnectedEvent
  | ErrorEvent
  | MessageEvent
  | AgentStatusChangedEvent
  | DeviceStatusChangedEvent
  | MembersChangedEvent
  | ChannelDeletedEvent
  | ParticipantUpdatedEvent
  | ParticipantDeletedEvent
  | AgentTurnEvent
  | AgentEventEvent
  | AgentQueuedEvent
  | AgentContextEvent
  | AgentMemoryChangedEvent
  | ToolConfirmationRequestEvent
  | ToolConfirmationResolvedEvent
  | ScheduleChangedEvent
  | DeliverableCreatedEvent;

// ---- Client -> server ----

// Post a message (or thread reply) to a channel. Needs a body and/or pre-uploaded
// attachmentIds. threadRootId makes it a thread reply; alsoToChannel echoes that reply into
// the main channel timeline.
export interface ClientPostFrame {
  type: "post";
  channelId: string;
  body?: string;
  clientMsgId?: string;
  attachmentIds?: string[];
  threadRootId?: string | null;
  alsoToChannel?: boolean;
}

export type ClientFrame = ClientPostFrame;
