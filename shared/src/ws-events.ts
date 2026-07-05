// The app WebSocket contract (the browser client <-> backend socket at /api). Distinct from the
// runner protocol (see runner-protocol.ts). The backend emits ServerEvent frames (some to one
// socket, most fanned out to a channel or broadcast to all); the client sends ClientFrame frames.

import type { AgentStatus, Participant, WireMessage } from "./domain.js";

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

// One raw SDK stream message from an agent's turn, for the live Activity transcript.
export interface AgentEventEvent {
  type: "agent_event";
  agentId: string;
  turnId: string;
  event: unknown;
}

// An agent's context-window occupancy after a turn (drives the profile usage meter).
export interface AgentContextEvent {
  type: "agent_context";
  agentId: string;
  tokens: number;
  maxTokens: number;
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

export type ServerEvent =
  | ConnectedEvent
  | ErrorEvent
  | MessageEvent
  | AgentStatusChangedEvent
  | MembersChangedEvent
  | ChannelDeletedEvent
  | ParticipantUpdatedEvent
  | ParticipantDeletedEvent
  | AgentEventEvent
  | AgentContextEvent
  | ToolConfirmationRequestEvent
  | ToolConfirmationResolvedEvent
  | ScheduleChangedEvent;

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
