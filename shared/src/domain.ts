// Domain / wire types shared between the backend (which produces them) and the frontend
// (which consumes them). These describe the shapes that actually cross the HTTP/WS boundary.
// Server-only fields (e.g. a participant's runner_token) are NOT here — they live in
// backend-local row types that extend these.

export type Kind = "human" | "agent";

// One of an agent's live statuses. Working = actively running a turn; Idle = connected,
// waiting; Sleeping = machine stopped to save cost; Waking = machine starting, not yet connected;
// Offline = a self-hosted agent whose device/daemon is not connected (the backend cannot wake it —
// queued work waits until the device comes back online). Offline is distinct from Sleeping, which
// the platform CAN wake on demand.
export type AgentStatus = "working" | "idle" | "sleeping" | "waking" | "offline";

// The provisioners an agent's runner can run under. 'docker'/'fly' are cloud sandboxes the backend
// owns; 'self_hosted' runs on a user's own registered device (see RunnerHost) via a daemon that
// dials the host-control channel (shared/src/host-protocol.ts).
export const RUNNER_PROVIDERS = ["docker", "fly", "self_hosted"] as const;
export type RunnerProvider = (typeof RUNNER_PROVIDERS)[number];

// The public shape of a participant row (everything persisted except server-only secrets like
// runner_token). This is what the backend serializes; the DB row type extends it server-side.
export interface ParticipantBase {
  id: string;
  kind: Kind;
  workspace_id: string; // the workspace this participant belongs to (Slack-style multi-tenancy)
  role: string; // membership role within the workspace: 'admin' | 'member'
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
  runner_provider: string; // RunnerProvider — which Provisioner impl owns this agent's runner
  // Provider handles (Fly: {machineId, volumeId}; self_hosted: {hostId, host?: {hostname,…}}).
  runner_meta: Record<string, unknown> | null;
  // Creator-written role/personality injected into the agent's system prompt (agents; null = none).
  // The agent's MEMORY.md mirror is NOT here — it can be large, so clients fetch it on demand
  // via GET /api/agents/:id/memory.
  persona: string | null;
}

// A participant as sent to clients: the public row plus a live `status` (agents only, computed
// from the runner connection at serialization time — not persisted). `memory_changed_at` is
// client-side only: stamped when an agent_memory_changed broadcast lands, so an open profile's
// Memory section knows to refetch.
export interface Participant extends ParticipantBase {
  status?: AgentStatus;
  memory_changed_at?: string;
}

// --- Self-hosted devices (a registered machine that can run agents) ---

// Who, besides the owner, may assign an agent to run on a device. 'owner_only' (default) = only
// the account that registered it; 'workspace_members' = any member of a workspace the owner has
// shared the device into (shared_workspace_ids). Running an agent on a device is code execution
// with the owner's OS privileges, so this defaults closed.
export type DeviceAssignPolicy = "owner_only" | "workspace_members";

// A machine a user registered with `jungle-agents connect`. Account-scoped (owned by a Google
// account, selectable across that account's workspaces). `online` is derived at serialization
// time from whether the device's control connection is live; `running_agents` counts agents
// currently executing on it. Server-only fields (the device token hash) never appear here.
export interface RunnerHost {
  id: string;
  name: string; // user-editable; defaults to the hostname
  hostname: string | null;
  platform: string | null; // process.platform, e.g. 'darwin' | 'linux'
  arch: string | null; // process.arch, e.g. 'arm64' | 'x64'
  runner_version: string | null;
  assign_policy: DeviceAssignPolicy;
  shared_workspace_ids: string[]; // workspaces the device is shared into (workspace_members policy)
  // Whether agents on this device run in an isolated per-agent workspace (true, the default) or
  // directly in the directory `jungle-agents connect` was run from (false). False = the agent has
  // the user's real files in its cwd; per-agent state (memory/session/git-creds) stays isolated.
  sandboxed: boolean;
  created_at: string;
  last_seen_at: string | null;
  online: boolean; // derived: control channel currently connected
  running_agents: number; // derived: agents with a live runner on this device
}

// --- Workspaces (Slack-style multi-tenancy) ---

// A workspace as sent to clients.
export interface Workspace {
  id: string;
  name: string;
}

// The Google identity behind a signed-in user (before/independent of any workspace participant).
export interface GoogleProfile {
  uid: string;
  email: string | null;
  name: string | null;
  picture: string | null;
}

// One of a signed-in account's workspace memberships: the workspace, the account's participant in
// it (handle/role/etc.), and whether GitHub is connected for that participant.
export interface Membership {
  workspace: Workspace;
  participant: Participant;
  github: { connected: boolean; login?: string };
}

// GET /api/me: the signed-in Google account and every workspace it belongs to. `suggestedHandle`
// seeds the handle field when creating/joining a workspace.
export interface Me {
  profile: GoogleProfile;
  memberships: Membership[];
  suggestedHandle: string;
}

// GET /api/invites/:token: what a would-be joiner sees before accepting an invite link.
export interface InviteInfo {
  valid: boolean; // false = unknown / revoked / expired token
  workspaceName?: string;
  alreadyMember?: boolean; // the signed-in account is already in this workspace
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
  // Agent messages: the runner turn that produced this message (null for human messages and
  // for agent sends outside a tracked turn). Drives the "view the work" affordance.
  turn_id: string | null;
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
  member_agent_ids: string[]; // agent members of this channel
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

// The link kinds recognized as durable work artifacts (see backend services/deliverables.ts —
// classification lives there; this union is the wire vocabulary).
export type DeliverableKind =
  | "github_pr"
  | "github_issue"
  | "github"
  | "notion"
  | "google_doc"
  | "google_drive"
  | "linear"
  | "granola";

// A durable work artifact an agent produced (a PR opened, a doc written, …), extracted from the
// links in its messages. Powers the Deliverables feed + inline artifact cards.
export interface Deliverable {
  id: number;
  agent_id: string;
  agent_handle: string;
  channel_id: string;
  channel_name: string;
  channel_kind: string;
  message_id: string;
  kind: DeliverableKind;
  title: string | null;
  url: string;
  created_at: string;
}

// One message search hit (GET /api/search), scoped to channels the requester belongs to.
export interface SearchResult {
  message_id: string;
  channel_id: string;
  channel_name: string;
  channel_kind: string;
  dm_with: string | null; // for dm channels: the other member's handle
  thread_root_id: string | null;
  sender_handle: string;
  body: string;
  created_at: string;
}
