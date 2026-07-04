// Domain / wire types shared between the backend (which produces them) and the frontend
// (which consumes them). These describe the shapes that actually cross the HTTP/WS boundary.
// Server-only fields (e.g. a participant's runner_token) are NOT here — they live in
// backend-local row types that extend these.

export type Kind = "human" | "agent";

// One of an agent's four live statuses. Working = actively running a turn; Idle = connected,
// waiting; Sleeping = machine stopped to save cost; Waking = machine starting, not yet connected.
export type AgentStatus = "working" | "idle" | "sleeping" | "waking";

// The public shape of a participant row (everything persisted except server-only secrets like
// runner_token). This is what the backend serializes; the DB row type extends it server-side.
export interface ParticipantBase {
  id: string;
  kind: Kind;
  handle: string;
  display_name: string;
  repo: string | null;
  firebase_uid: string | null;
  email: string | null;
  avatar_url: string | null;
  model: string | null; // agent model override (null = agent-config default)
  mode: string; // an SDK permission mode: default|acceptEdits|plan|bypassPermissions|dontAsk
  effort: string; // reasoning effort: low|medium|high|xhigh (default 'medium'); see EFFORT_LEVELS
  runtime: string; // 'sdk' (all agents; legacy 'ma' rows may exist on old databases)
  // Context-window occupancy reported by the runner after each turn (null = no report yet).
  context_tokens: number | null;
  context_max_tokens: number | null;
  context_updated_at: string | null;
  runner_provider: string; // 'docker' | 'fly' — which Provisioner impl owns this agent's runner
  runner_meta: Record<string, unknown> | null; // provider handles (Fly: {machineId, volumeId})
}

// A participant as sent to clients: the public row plus a live `status` (agents only, computed
// from the runner connection at serialization time — not persisted).
export interface Participant extends ParticipantBase {
  status?: AgentStatus;
}

// The attachment fields stored on an upload. A signed download `url` is added at the edge by
// the backend (attachments.withUrls) to produce `Attachment` — the url is never stored.
export interface AttachmentMeta {
  id: string;
  filename: string;
  mime: string;
  size_bytes: number;
  width: number | null;
  height: number | null;
}

// An attachment as sent to clients: stored metadata plus an origin-relative signed download
// path (prefix with the API origin to fetch).
export interface Attachment extends AttachmentMeta {
  url: string;
}

export interface Message {
  id: string;
  channel_id: string;
  seq: string; // bigint serialized as string
  sender_id: string;
  sender_handle: string;
  body: string;
  created_at: string;
  cascade_budget: number | null;
  // Threads: null on top-level messages; the root message's id on replies. also_to_channel
  // marks a reply that was also echoed into the main timeline. reply_count/last_reply_at are
  // denormed on the ROOT (0/null elsewhere) and drive the "N replies" footer + Threads view.
  thread_root_id: string | null;
  also_to_channel: boolean;
  reply_count: number;
  last_reply_at: string | null;
  mentions: { id: string; handle: string }[];
  attachments: AttachmentMeta[];
}

// A message as sent to clients (WS `message` frame + REST message responses): like Message,
// but each attachment carries a signed download `url` (added at the edge by withUrls).
export interface WireMessage extends Omit<Message, "attachments"> {
  attachments: Attachment[];
}

// A channel/DM row as returned by the channel list (GET /api/channels).
export interface ChannelListItem {
  id: string;
  name: string;
  kind: string;
  dm_with: string | null; // for dm channels: the other member's handle
  unread_count: number; // messages after the requester's last_read_seq, excluding their own
  has_mention: boolean; // any unread message @mentions the requester
  member_agent_ids: string[]; // agent members (drives the row's status dot)
}

// A followed thread with unread replies, for the "Threads" view (GET /api/threads/unread).
export interface UnreadThread {
  root_id: string;
  channel_id: string;
  channel_name: string;
  root_sender_handle: string;
  root_body: string;
  reply_count: number;
  last_reply_at: string | null;
  unread_count: number; // replies after the requester's thread last_read_seq, excluding their own
}

// A single Claude Agent SDK stream message persisted for an sdk agent. `event` is the raw SDK
// message JSON (system/assistant/user/result); render defensively (shapes may vary).
export interface AgentEvent {
  id: number;
  turn_id: string;
  event: unknown;
  created_at: string;
}
