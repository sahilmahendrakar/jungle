// The app WebSocket contract (the browser client <-> backend socket at /api). Distinct from the
// runner protocol (see runner-protocol.ts). The backend emits ServerEvent frames (some to one
// socket, most fanned out to a channel or broadcast to all); the client sends ClientFrame frames.

import type { AgentStatus, Deliverable, Participant, WireMessage } from "./domain.js";
import type { SlackChannelLink } from "./slack.js";

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

// The reply to a client `ping`. This is the client's ONLY way to prove the socket is still alive:
// the browser WebSocket API answers protocol-level pings itself and never surfaces them to JS, so
// liveness has to ride at the application level. Without it a half-open socket (laptop sleep, wifi
// switch, an idle NAT dropping the flow) sits at readyState OPEN forever, fires no `close`, and
// the tab goes quiet until the user reloads.
export interface PongEvent {
  type: "pong";
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

// A channel was created with the recipient already a member (fanned out to those members).
// Coarse by design, like members_changed: clients refetch their channel list rather than trying
// to splice a row in with the right unread/ordering state. DMs are NOT announced this way — an
// empty DM isn't worth a sidebar row, and the first message in one is what makes it appear (the
// client refetches when a message arrives for a channel it doesn't know).
export interface ChannelCreatedEvent {
  type: "channel_created";
  channelId: string;
}

// A participant's editable fields changed. Two sources: a human saving the profile form, and an
// agent calling set_status (which is why this can fire many times a minute during a busy turn —
// clients replace the roster entry, they don't refetch). Carries the public participant.
export interface ParticipantUpdatedEvent {
  type: "participant_updated";
  participant: Participant;
}

// A participant joined the workspace — an agent someone (or some agent) just created, a human who
// accepted an invite, a Slack shadow user. Broadcast workspace-wide so every open client adds them
// to the roster: the Team page, member pickers, @-autocomplete. The counterpart of
// participant_deleted; without it a brand-new agent is invisible (and un-mentionable) to everyone
// who didn't create it until they refresh. Carries the PUBLIC row (no runner_token).
export interface ParticipantCreatedEvent {
  type: "participant_created";
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

// An agent's managed services (service_* tools: dev servers, watchers) changed. Like memory,
// content doesn't ride in the broadcast: an open profile panel refetches
// GET /api/agents/:id/services.
export interface AgentServicesChangedEvent {
  type: "agent_services_changed";
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

// A workflow in the recipient's workspace changed (created/updated/deleted — including draft
// edits by the Architect, which is what makes the builder's live preview work). Coarse by
// design, like schedule_changed: clients refetch the workflow.
export interface WorkflowChangedEvent {
  type: "workflow_changed";
  workflowId: string;
  action: "created" | "updated" | "deleted";
}

// A workflow run started or changed status (done/stalled/stopped). Clients refetch the run
// (or the workflow's run list).
export interface WorkflowRunChangedEvent {
  type: "workflow_run_changed";
  workflowId: string;
  runId: string;
}

// An agent shipped a work artifact (a PR opened, a doc written, …) — extracted from the links in
// its message at send time. Carries the full row so the Deliverables feed appends without a refetch.
export interface DeliverableCreatedEvent {
  type: "deliverable_created";
  deliverable: Deliverable;
}

// A channel's Slack mirror binding changed (linked, unlinked, or moved to the 'error' state).
// `link` is null when the channel was unlinked. Broadcast workspace-wide so every client's
// channel header updates. SlackChannelLink comes from ./slack.
export interface SlackLinkChangedEvent {
  type: "slack_link_changed";
  channelId: string;
  link: SlackChannelLink | null;
}

export type ServerEvent =
  | ConnectedEvent
  | ErrorEvent
  | PongEvent
  | MessageEvent
  | AgentStatusChangedEvent
  | DeviceStatusChangedEvent
  | MembersChangedEvent
  | ChannelDeletedEvent
  | ChannelCreatedEvent
  | ParticipantUpdatedEvent
  | ParticipantCreatedEvent
  | ParticipantDeletedEvent
  | AgentTurnEvent
  | AgentEventEvent
  | AgentQueuedEvent
  | AgentContextEvent
  | AgentMemoryChangedEvent
  | AgentServicesChangedEvent
  | ToolConfirmationRequestEvent
  | ToolConfirmationResolvedEvent
  | ScheduleChangedEvent
  | WorkflowChangedEvent
  | WorkflowRunChangedEvent
  | DeliverableCreatedEvent
  | SlackLinkChangedEvent;

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

// Application-level liveness probe; the server answers with a `pong`. Sent on a timer by the web
// client, which reconnects if the replies stop coming (see PongEvent).
export interface ClientPingFrame {
  type: "ping";
}

export type ClientFrame = ClientPostFrame | ClientPingFrame;
