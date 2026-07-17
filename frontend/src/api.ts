// Wire types are the single source of truth in @jungle/shared (also consumed by the backend).
// The frontend re-exports the ones it uses so components can keep importing from "./api".
import type {
  Participant,
  Attachment,
  UnreadThread,
  AgentEvent,
  AgentStatus,
  WireMessage,
  Me,
  GoogleProfile,
  Workspace,
  Membership,
  InviteInfo,
  AgentIntegration,
  Schedule,
  Deliverable,
  DeliverableKind,
  SearchResult,
  ExtractedLink,
  RunnerHost,
  SlackStatus,
  SlackChannelInfo,
  SlackChannelLink,
  AgentServiceInfo,
  Workflow,
  WorkflowRole,
  WorkflowRun,
  WorkflowTrigger,
  WorkflowTemplate,
} from "@jungle/shared";
export {
  INTEGRATION_TYPES,
  getIntegrationType,
  CONNECTION_TYPES,
  getConnectionType,
  connectionForIntegration,
  extractDeliverableLinks,
} from "@jungle/shared";
export type { IntegrationType, ConnectionType } from "@jungle/shared";
export type { ExtractedLink };
export type { SlackStatus, SlackChannelInfo, SlackChannelLink };

export type { Participant, Attachment, UnreadThread, AgentEvent, AgentStatus, AgentIntegration, RunnerHost };
export type { AgentServiceInfo };
export type { Schedule, Deliverable, DeliverableKind, SearchResult };
export type { Workflow, WorkflowRole, WorkflowRun, WorkflowTrigger, WorkflowTemplate };
export type { Me, GoogleProfile, Workspace, Membership, InviteInfo };
// A message as delivered to the client (attachments carry signed download urls).
export type Message = WireMessage;

// Backend base URL resolution, in priority order:
//   1. VITE_API_URL — explicit backend origin (e.g. https://54-85-220-156.sslip.io).
//      Set this in prod (Vercel) where the frontend and backend live on different hosts.
//      VITE_WS_URL overrides the WS origin; otherwise it's derived from VITE_API_URL
//      (http->ws, https->wss).
//   2. Fallback (local dev): same host the page was served from, port 3001.
const env = import.meta.env as Record<string, string | undefined>;
const apiUrl = env.VITE_API_URL?.replace(/\/+$/, "");

const host = typeof location !== "undefined" && location.hostname ? location.hostname : "localhost";
const secure = typeof location !== "undefined" && location.protocol === "https:";

const BASE = apiUrl ?? `${secure ? "https" : "http"}://${host}:3001`;
export const WS_BASE =
  env.VITE_WS_URL?.replace(/\/+$/, "") ??
  (apiUrl ? apiUrl.replace(/^http/, "ws") : `${secure ? "wss" : "ws"}://${host}:3001`);

// Last-known Firebase ID token, pushed in by the auth provider on onIdTokenChanged. This is a
// snapshot that can go stale (tokens expire ~hourly; the callback can lag a backgrounded tab), so
// it's only a fallback — authed requests prefer the token-getter below, which mints a fresh one.
let authToken: string | null = null;
export function setAuthToken(t: string | null) {
  authToken = t;
}
// Fresh-token getter registered by the auth provider (wraps Firebase's getIdToken, which returns
// the cached token when valid and transparently refreshes it when expired). Authed requests await
// this so the bearer is never stale — mirroring how the WS handshake already gets its token. Left
// null in the dev/test path (no Firebase); then requests fall back to the cached snapshot / the
// ?participantId= dev bypass.
let tokenGetter: (() => Promise<string | null>) | null = null;
export function setTokenGetter(fn: (() => Promise<string | null>) | null) {
  tokenGetter = fn;
}
// Resolve the bearer to attach to an authed request: a freshly minted token when a getter is
// registered, else the cached snapshot.
async function bearerToken(): Promise<string | null> {
  if (tokenGetter) {
    try {
      const t = await tokenGetter();
      if (t) return t;
    } catch {
      /* fall back to the cached snapshot below */
    }
  }
  return authToken;
}
// Dev/test identity (?as=<id>): when Firebase isn't configured there's no token, so
// requester-gated endpoints authenticate via a participantId the backend trusts under
// DEV_BYPASS. In production authToken is set and this stays null.
let devParticipantId: string | null = null;
export function setDevParticipantId(id: string | null) {
  devParticipantId = id;
}
// The active workspace (Firebase multi-tenancy): sent as X-Workspace-Id on every authed request so
// the backend resolves the caller's participant in the right workspace. Null in dev/no-token mode
// (the participantId already names a workspace).
let activeWorkspaceId: string | null = null;
export function setActiveWorkspaceId(id: string | null) {
  activeWorkspaceId = id;
}

// One request path for every backend call: resolves the URL, attaches auth (bearer token when
// present; dev participantId query param when there isn't one and `devAuth` is set), sends JSON,
// and throws a useful Error on a non-2xx so callers never silently swallow failures.
interface RequestOpts {
  method?: string;
  json?: unknown; // JSON body (sets content-type)
  body?: BodyInit; // raw body (e.g. an upload); takes precedence over `json`
  headers?: Record<string, string>;
  auth?: boolean; // attach the bearer token if we have one
  devAuth?: boolean; // append ?participantId= for the dev/no-token path
  errorMessage?: string; // fallback message if the response has no { error }
}

function buildUrl(path: string, devAuth: boolean): string {
  const url = `${BASE}${path}`;
  if (!devAuth || authToken || !devParticipantId) return url;
  return url + (url.includes("?") ? "&" : "?") + `participantId=${encodeURIComponent(devParticipantId)}`;
}

async function request<T>(path: string, opts: RequestOpts = {}): Promise<T> {
  const headers: Record<string, string> = { ...opts.headers };
  if (opts.auth) {
    const token = await bearerToken();
    if (token) headers.authorization = `Bearer ${token}`;
  }
  if (activeWorkspaceId) headers["x-workspace-id"] = activeWorkspaceId;
  let body = opts.body;
  if (opts.json !== undefined) {
    headers["content-type"] = headers["content-type"] ?? "application/json";
    body = JSON.stringify(opts.json);
  }
  const res = await fetch(buildUrl(path, opts.devAuth ?? false), {
    method: opts.method ?? (body ? "POST" : "GET"),
    headers,
    body,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data as { error?: string }).error ?? opts.errorMessage ?? "request failed");
  return data as T;
}

// One of an agent's four live statuses is exported above from @jungle/shared.

export interface Channel {
  id: string;
  name: string;
  kind: string;
  dm_with?: string | null; // for dm channels: the other member's handle
  unread_count?: number; // messages after my last_read_seq, excluding my own
  has_mention?: boolean; // any unread message @mentions me
  member_agent_ids?: string[]; // agent members of this channel
}

// Upload a file (upload-first, Slack-style): returns the stored Attachment whose id is
// then referenced by the WS `post` frame's attachmentIds. Max 25MB per file.
export function uploadAttachment(file: File): Promise<Attachment> {
  const mime = file.type || "application/octet-stream";
  const qs = `filename=${encodeURIComponent(file.name)}&mime=${encodeURIComponent(mime)}`;
  return request<Attachment>(`/api/attachments?${qs}`, {
    method: "POST",
    body: file,
    headers: { "content-type": "application/octet-stream" },
    auth: true,
    devAuth: true,
    errorMessage: "upload failed",
  });
}

// Attachment urls come back origin-relative (signed path); resolve against the API BASE.
export function attachmentUrl(a: Attachment): string {
  return `${BASE}${a.url}`;
}

export function listParticipants(): Promise<Participant[]> {
  return request<Participant[]>(`/api/participants`, {
    auth: true,
    devAuth: true,
    errorMessage: "failed to load participants",
  });
}

// Create a human participant, or (kind "agent") an agent. An agent starts as a blank chat
// agent unless `integrations` attaches one or more (e.g. [{key: "github", config: {repo}}]).
export function createParticipant(p: {
  kind: "human" | "agent";
  handle: string;
  displayName: string;
  integrations?: Array<{ key: string; config: Record<string, unknown> }>;
  model?: string;
  mode?: string;
  // Creator-written instructions/persona injected into the agent's system prompt (optional).
  persona?: string;
  // Environment: omitted = cloud default; "self_hosted" + hostId runs the agent on a registered
  // device (see listDevices).
  runnerProvider?: string;
  hostId?: string;
}): Promise<Participant> {
  const path = p.kind === "agent" ? "/api/agents" : "/api/participants";
  const json =
    p.kind === "agent"
      ? {
          handle: p.handle,
          displayName: p.displayName,
          ...(p.integrations?.length ? { integrations: p.integrations } : {}),
          ...(p.model ? { model: p.model } : {}),
          ...(p.mode ? { mode: p.mode } : {}),
          ...(p.persona ? { persona: p.persona } : {}),
          ...(p.runnerProvider ? { runnerProvider: p.runnerProvider } : {}),
          ...(p.hostId ? { hostId: p.hostId } : {}),
        }
      : { kind: "human", handle: p.handle, displayName: p.displayName };
  return request<Participant>(path, { json, auth: true, devAuth: true, errorMessage: "create failed" });
}

// --- Self-hosted devices (Environments) ---

// The signed-in account's registered devices (the Environments page).
export function listDevices(): Promise<RunnerHost[]> {
  return request<RunnerHost[]>(`/api/devices`, {
    auth: true,
    devAuth: true,
    errorMessage: "failed to load devices",
  });
}

// Rename a device or change its assign policy / shared workspaces / sandboxing (owner only).
export function updateDevice(
  id: string,
  patch: { name?: string; assignPolicy?: string; sharedWorkspaceIds?: string[]; sandboxed?: boolean },
): Promise<RunnerHost> {
  return request<RunnerHost>(`/api/devices/${id}`, {
    method: "PATCH",
    json: patch,
    auth: true,
    devAuth: true,
    errorMessage: "failed to update device",
  });
}

// Remove a device (revoke its token; its agents go offline until reassigned).
export function removeDevice(id: string): Promise<{ ok: boolean }> {
  return request<{ ok: boolean }>(`/api/devices/${id}`, {
    method: "DELETE",
    auth: true,
    devAuth: true,
    errorMessage: "failed to remove device",
  });
}

// Approve a device-code shown by `jungle-agents connect` on a machine (the /link page).
export function approveDeviceCode(userCode: string): Promise<{ ok: boolean }> {
  return request<{ ok: boolean }>(`/api/devices/auth/approve`, {
    json: { userCode },
    auth: true,
    devAuth: true,
    errorMessage: "failed to approve device",
  });
}

// Whether a device code is still valid + unapproved (drives the /link confirm page).
export function checkDeviceCode(userCode: string): Promise<{ valid: boolean }> {
  return request<{ valid: boolean }>(`/api/devices/auth/${encodeURIComponent(userCode)}`, {
    auth: true,
    devAuth: true,
    errorMessage: "failed to check code",
  });
}

// This agent's attached integrations (the settings panel's Integrations section).
export function listAgentIntegrations(agentId: string): Promise<AgentIntegration[]> {
  return request<AgentIntegration[]>(`/api/agents/${agentId}/integrations`, {
    auth: true,
    devAuth: true,
    errorMessage: "failed to load integrations",
  });
}

// Attach or reconfigure one integration on an agent (e.g. key "github", config {repo}).
export function setAgentIntegration(
  agentId: string,
  key: string,
  config: Record<string, unknown>,
): Promise<AgentIntegration> {
  return request<AgentIntegration>(`/api/agents/${agentId}/integrations/${key}`, {
    method: "PUT",
    json: { config },
    auth: true,
    devAuth: true,
    errorMessage: "failed to add integration",
  });
}

export function removeAgentIntegration(agentId: string, key: string): Promise<{ ok: boolean }> {
  return request(`/api/agents/${agentId}/integrations/${key}`, {
    method: "DELETE",
    auth: true,
    devAuth: true,
    errorMessage: "failed to remove integration",
  });
}

// --- Per-USER OAuth connections for connection-based integrations (Linear/Notion/Granola/Drive).
// You connect your accounts once in Settings → Connections (like GitHub/Gmail); agents then attach
// the integration and act with your connection. Separate from attaching the integration to an agent. ---

export interface IntegrationConnectionStatus {
  connected: boolean;
  externalAccount?: string | null;
}

// Per-integration connection status for the current user, keyed by integration key.
export type IntegrationStatuses = Record<string, IntegrationConnectionStatus>;

// Begin connecting: returns the provider authorize URL for the SPA to navigate to. With
// `popup: true` the callback returns a self-closing page instead of redirecting to /settings,
// so the flow can run in window.open without losing SPA state (see lib/connections.tsx).
export function integrationConnectUrl(key: string, opts?: { popup?: boolean }): Promise<{ url: string }> {
  return request(`/api/integrations/${key}/connect-url`, {
    method: "POST",
    json: { popup: opts?.popup === true },
    auth: true,
    devAuth: true,
    errorMessage: "failed to start connect",
  });
}

export function getIntegrationStatuses(): Promise<IntegrationStatuses> {
  return request<IntegrationStatuses>(`/api/integrations/status`, {
    auth: true,
    devAuth: true,
    errorMessage: "failed to load integration connections",
  });
}

export function disconnectIntegration(key: string): Promise<{ ok: boolean }> {
  return request(`/api/integrations/${key}/connection`, {
    method: "DELETE",
    auth: true,
    devAuth: true,
    errorMessage: "failed to disconnect",
  });
}

// --- Slack integration (workspace-scoped install + per-channel mirroring) ---

export function getSlackStatus(): Promise<SlackStatus> {
  return request<SlackStatus>(`/api/slack/status`, {
    auth: true,
    devAuth: true,
    errorMessage: "failed to load Slack status",
  });
}

export function slackInstallUrl(opts?: { popup?: boolean }): Promise<{ url: string }> {
  return request(`/api/slack/install-url`, {
    method: "POST",
    json: { popup: opts?.popup === true },
    auth: true,
    devAuth: true,
    errorMessage: "failed to start Slack install",
  });
}

export function disconnectSlack(): Promise<{ ok: boolean }> {
  return request(`/api/slack/install`, {
    method: "DELETE",
    auth: true,
    devAuth: true,
    errorMessage: "failed to disconnect Slack",
  });
}

export function listSlackChannels(): Promise<SlackChannelInfo[]> {
  return request<SlackChannelInfo[]>(`/api/slack/channels`, {
    auth: true,
    devAuth: true,
    errorMessage: "failed to list Slack channels",
  });
}

export function getChannelSlackLink(channelId: string): Promise<{ link: SlackChannelLink | null }> {
  return request(`/api/channels/${channelId}/slack-link`, {
    auth: true,
    devAuth: true,
    errorMessage: "failed to load Slack link",
  });
}

export function linkChannelToSlack(channelId: string, slackChannelId: string): Promise<{ link: SlackChannelLink }> {
  return request(`/api/channels/${channelId}/slack-link`, {
    method: "POST",
    json: { slackChannelId },
    auth: true,
    devAuth: true,
    errorMessage: "failed to link channel to Slack",
  });
}

export function unlinkChannelFromSlack(channelId: string): Promise<{ ok: boolean }> {
  return request(`/api/channels/${channelId}/slack-link`, {
    method: "DELETE",
    auth: true,
    devAuth: true,
    errorMessage: "failed to unlink channel from Slack",
  });
}

// The agent's long-term memory (its MEMORY.md mirror, reported by the runner after turns that
// change it). Fetched on demand — it doesn't ride in participant payloads.
export function getAgentMemory(
  id: string,
): Promise<{ memory: string | null; updatedAt: string | null }> {
  return request(`/api/agents/${id}/memory`, {
    auth: true,
    devAuth: true,
    errorMessage: "failed to load memory",
  });
}

// The agent's managed services (service_* tools: dev servers, watchers), as last reported by
// its runner. Fetched on demand like memory.
export function getAgentServices(
  id: string,
): Promise<{ services: AgentServiceInfo[]; updatedAt: string | null }> {
  return request(`/api/agents/${id}/services`, {
    auth: true,
    devAuth: true,
    errorMessage: "failed to load services",
  });
}

// Stop one of an agent's managed services. The fresh list arrives via an
// agent_services_changed broadcast once the runner has killed the process group.
export function stopAgentService(id: string, name: string): Promise<{ ok: boolean }> {
  return request(`/api/agents/${id}/services/${encodeURIComponent(name)}/stop`, {
    method: "POST",
    auth: true,
    devAuth: true,
    errorMessage: "failed to stop service",
  });
}

// Update an agent's editable config from its profile page. `mode` is applied live; for sdk
// agents `model` is applied at the agent's next turn boundary. `persona` (creator-written
// role/personality) lands in the agent's system prompt at its next turn; empty string clears it.
export function updateAgent(
  id: string,
  patch: { displayName?: string; mode?: string; model?: string; effort?: string; persona?: string },
): Promise<Participant> {
  return request<Participant>(`/api/agents/${id}`, {
    method: "PATCH",
    json: patch,
    auth: true,
    devAuth: true,
    errorMessage: "failed to update agent",
  });
}

// Permanently delete an agent: tears down its runner/container and removes all of its data
// (its DMs and the messages it sent). Irreversible.
export function deleteAgent(id: string): Promise<{ ok: boolean; error?: string }> {
  return request(`/api/agents/${id}`, {
    method: "DELETE",
    auth: true,
    devAuth: true,
    errorMessage: "failed to delete agent",
  });
}

export interface AgentEventsPage {
  events: AgentEvent[]; // oldest-first within the page
  runner: { connected: boolean; state: "idle" | "running"; status?: AgentStatus };
}

// Fetch a page of an sdk agent's activity transcript. Page backwards with
// `before` = the smallest id you already hold.
export function fetchAgentEvents(
  id: string,
  opts: { before?: number; limit?: number } = {},
): Promise<AgentEventsPage> {
  const qs = new URLSearchParams();
  if (opts.before != null) qs.set("before", String(opts.before));
  if (opts.limit != null) qs.set("limit", String(opts.limit));
  const q = qs.toString();
  return request<AgentEventsPage>(`/api/agents/${id}/events${q ? `?${q}` : ""}`, {
    auth: true,
    devAuth: true,
    errorMessage: "failed to load activity",
  });
}

// Stop an sdk agent's currently-running turn.
export function interruptAgent(id: string): Promise<{ ok: boolean; error?: string }> {
  return request(`/api/agents/${id}/interrupt`, {
    method: "POST",
    auth: true,
    devAuth: true,
    errorMessage: "failed to stop agent",
  });
}

// Ask an sdk agent to compact/summarize its session context. Runs when the agent is next
// idle; the profile meter updates when the runner reports the post-compaction usage. If the
// agent's machine was asleep, `waking: true` comes back — the request is queued and runs once
// its runner reconnects.
export function compactAgent(id: string): Promise<{ ok: boolean; waking?: boolean; error?: string }> {
  return request(`/api/agents/${id}/compact`, {
    method: "POST",
    auth: true,
    devAuth: true,
    errorMessage: "failed to compact context",
  });
}

// Ask an sdk agent to clear its conversation/context window (Claude Code's `/clear`). The
// runner drops the session at the next idle boundary; the meter drops to 0% when the runner
// reports the emptied window. `waking: true` if the agent was asleep — the clear runs once its
// runner reconnects. Memory files are untouched.
export function clearAgentContext(id: string): Promise<{ ok: boolean; waking?: boolean; error?: string }> {
  return request(`/api/agents/${id}/clear`, {
    method: "POST",
    auth: true,
    devAuth: true,
    errorMessage: "failed to clear context",
  });
}

export function listChannels(participantId: string): Promise<Channel[]> {
  // participantId is the dev/no-token identity (read by the backend under DEV_BYPASS). In
  // Firebase mode the bearer token identifies the requester and this query param is ignored.
  return request<Channel[]>(`/api/channels?participantId=${participantId}`, {
    auth: true,
    errorMessage: "failed to load channels",
  });
}

// Mark a channel read for the current user: advances my last_read_seq to the channel's max
// message seq (or the supplied `seq`). Requester-gated; uses the dev participantId path when
// there's no Firebase token.
export function markChannelRead(
  channelId: string,
  seq?: number,
): Promise<{ ok: boolean; lastReadSeq: number }> {
  return request(`/api/channels/${channelId}/read`, {
    method: "POST",
    json: seq != null ? { seq } : {},
    auth: true,
    devAuth: true,
    errorMessage: "failed to mark read",
  });
}

// Create a channel (kind "channel") or DM (kind "dm") with the given member handles.
export function createChannel(c: {
  name: string;
  kind: "channel" | "dm";
  memberHandles: string[];
}): Promise<Channel> {
  return request<Channel>(`/api/channels`, {
    json: c,
    auth: true,
    devAuth: true,
    errorMessage: "failed to create channel",
  });
}

export function getMessages(channelId: string): Promise<Message[]> {
  return request<Message[]>(`/api/channels/${channelId}/messages`, {
    auth: true,
    devAuth: true,
    errorMessage: "failed to load messages",
  });
}

export interface TurnChipRow {
  turn_id: string;
  agent_id: string;
  message_ids: string[];
  started_at: string;
  done_at: string | null;
  ok: boolean | null;
  duration_ms: number | null;
}

export interface QueuedChipRow {
  agent_id: string;
  message_id: string;
}

// Durable turn chips for a channel (recent running/finished turns + still-queued dispatches),
// keyed to the messages that triggered them. Hydrates chips on channel open / reload; live
// updates ride the app WS (agent_turn/agent_event/agent_queued).
export function getChannelTurnChips(
  channelId: string,
): Promise<{ turns: TurnChipRow[]; queued: QueuedChipRow[] }> {
  return request(`/api/channels/${channelId}/turn-chips`, {
    auth: true,
    devAuth: true,
    errorMessage: "failed to load turn chips",
  });
}

// --- Threads ---

// Full transcript of one thread (root + replies, seq order). Used to lazy-load a thread the
// client doesn't already hold locally (e.g. opened from the Threads view in another channel).
export function getThread(channelId: string, rootId: string): Promise<Message[]> {
  return request<Message[]>(`/api/channels/${channelId}/threads/${rootId}`, {
    auth: true,
    devAuth: true,
    errorMessage: "failed to load thread",
  });
}

// Mark a thread read for the current user (participation-gated thread unreads): advances my
// per-thread last_read_seq to the thread's max seq (or the supplied `seq`).
export function markThreadRead(
  rootId: string,
  seq?: number,
): Promise<{ ok: boolean; lastReadSeq: number }> {
  return request(`/api/threads/${rootId}/read`, {
    method: "POST",
    json: seq != null ? { seq } : {},
    auth: true,
    devAuth: true,
    errorMessage: "failed to mark thread read",
  });
}

// My followed threads (authored root / replied / @mentioned) that have unread replies.
export function listUnreadThreads(): Promise<UnreadThread[]> {
  return request<UnreadThread[]>(`/api/threads/unread`, {
    auth: true,
    devAuth: true,
    errorMessage: "failed to load threads",
  });
}

// Find-or-create a 1:1 DM with another participant.
export function createDm(participantId: string, otherId: string): Promise<{ id: string; kind: string }> {
  return request(`/api/dms`, {
    json: { participantId, otherId },
    auth: true,
    devAuth: true,
    errorMessage: "failed to open DM",
  });
}

// Approve or deny a pending tool confirmation from an always_ask agent.
export function confirmToolCall(confirmId: string, decision: "allow" | "deny"): Promise<{ ok: boolean }> {
  return request(`/api/agents/confirm`, {
    json: { confirmId, decision },
    auth: true,
    devAuth: true,
    errorMessage: "failed to submit decision",
  });
}

// A pending confirmation as listed by GET /api/confirmations (same payload as the WS card).
export interface PendingConfirmation {
  confirmId: string;
  channelId: string;
  agentId: string;
  agentHandle: string;
  agentName: string;
  tool: string;
  input: unknown;
  createdAt: string;
}

// Every confirmation still awaiting my decision. Called on load/reconnect to rebuild the
// approvals badge/inbox (the WS fan-out only reaches sockets open at request time).
export function listPendingConfirms(): Promise<PendingConfirmation[]> {
  return request<{ confirmations: PendingConfirmation[] }>(`/api/confirmations`, {
    auth: true,
    devAuth: true,
    errorMessage: "failed to load approvals",
  }).then((r) => r.confirmations);
}

// My deliverables feed (work artifacts agents shipped), newest first. Page backwards with
// `before` = the smallest id already held.
export function listDeliverables(opts: { before?: number; limit?: number } = {}): Promise<Deliverable[]> {
  const qs = new URLSearchParams();
  if (opts.before != null) qs.set("before", String(opts.before));
  if (opts.limit != null) qs.set("limit", String(opts.limit));
  const q = qs.toString();
  return request<{ deliverables: Deliverable[] }>(`/api/deliverables${q ? `?${q}` : ""}`, {
    auth: true,
    devAuth: true,
    errorMessage: "failed to load deliverables",
  }).then((r) => r.deliverables);
}

// Full-text message search across my channels (the ⌘K palette).
export function searchMessages(q: string, limit = 20): Promise<SearchResult[]> {
  const qs = new URLSearchParams({ q, limit: String(limit) });
  return request<{ results: SearchResult[] }>(`/api/search?${qs.toString()}`, {
    auth: true,
    devAuth: true,
    errorMessage: "search failed",
  }).then((r) => r.results);
}

// --- Channel members + delete ---

export function listChannelMembers(channelId: string): Promise<Participant[]> {
  return request<Participant[]>(`/api/channels/${channelId}/members`, {
    auth: true,
    devAuth: true,
    errorMessage: "failed to load members",
  });
}

// Add a participant (by handle) to a channel. Returns the added participant.
export function addChannelMember(channelId: string, handle: string): Promise<Participant> {
  return request<Participant>(`/api/channels/${channelId}/members`, {
    json: { handle },
    auth: true,
    devAuth: true,
    errorMessage: "failed to add member",
  });
}

export function removeChannelMember(channelId: string, participantId: string): Promise<{ ok: boolean }> {
  return request(`/api/channels/${channelId}/members/${participantId}`, {
    method: "DELETE",
    auth: true,
    devAuth: true,
    errorMessage: "failed to remove member",
  });
}

export function deleteChannel(channelId: string): Promise<{ ok: boolean }> {
  return request(`/api/channels/${channelId}`, {
    method: "DELETE",
    auth: true,
    devAuth: true,
    errorMessage: "failed to delete channel",
  });
}

// --- Schedules (scheduled agent turns) ---

export interface ScheduleInput {
  agentId: string;
  channelId: string;
  prompt: string;
  cron?: string;
  timezone?: string;
  runAt?: string;
}

export function listSchedules(): Promise<Schedule[]> {
  return request<{ schedules: Schedule[] }>(`/api/schedules`, {
    auth: true,
    devAuth: true,
    errorMessage: "failed to load schedules",
  }).then((r) => r.schedules);
}

export function createSchedule(body: ScheduleInput): Promise<Schedule> {
  return request<Schedule>(`/api/schedules`, {
    json: body,
    auth: true,
    devAuth: true,
    errorMessage: "failed to create schedule",
  });
}

export function updateSchedule(
  id: string,
  patch: {
    prompt?: string;
    cron?: string | null;
    timezone?: string | null;
    runAt?: string | null;
    channelId?: string;
    paused?: boolean;
  },
): Promise<Schedule> {
  return request<Schedule>(`/api/schedules/${id}`, {
    method: "PATCH",
    json: patch,
    auth: true,
    devAuth: true,
    errorMessage: "failed to update schedule",
  });
}

export function deleteSchedule(id: string): Promise<{ ok: boolean }> {
  return request(`/api/schedules/${id}`, {
    method: "DELETE",
    auth: true,
    devAuth: true,
    errorMessage: "failed to delete schedule",
  });
}

// --- Workflows (teams of agents on a trigger; see shared/src/workflows.ts) ---

export function listWorkflows(): Promise<Workflow[]> {
  return request<{ workflows: Workflow[] }>(`/api/workflows`, {
    auth: true,
    devAuth: true,
    errorMessage: "failed to load workflows",
  }).then((r) => r.workflows);
}

export function getWorkflow(id: string): Promise<Workflow> {
  return request<Workflow>(`/api/workflows/${id}`, {
    auth: true,
    devAuth: true,
    errorMessage: "failed to load workflow",
  });
}

export function listWorkflowRuns(id: string): Promise<WorkflowRun[]> {
  return request<{ runs: WorkflowRun[] }>(`/api/workflows/${id}/runs`, {
    auth: true,
    devAuth: true,
    errorMessage: "failed to load runs",
  }).then((r) => r.runs);
}

export function listWorkflowTemplates(): Promise<WorkflowTemplate[]> {
  return request<{ templates: WorkflowTemplate[] }>(`/api/workflow-templates`, {
    auth: true,
    devAuth: true,
    errorMessage: "failed to load templates",
  }).then((r) => r.templates);
}

export function createWorkflowDraft(body: { templateId?: string; name?: string }): Promise<Workflow> {
  return request<Workflow>(`/api/workflows`, {
    json: body,
    auth: true,
    devAuth: true,
    errorMessage: "failed to create workflow",
  });
}

export function updateWorkflow(
  id: string,
  patch: {
    name?: string;
    description?: string;
    emoji?: string | null;
    playbook?: string;
    roster?: WorkflowRole[];
    trigger?: WorkflowTrigger;
    paused?: boolean;
  },
): Promise<Workflow> {
  return request<Workflow>(`/api/workflows/${id}`, {
    method: "PATCH",
    json: patch,
    auth: true,
    devAuth: true,
    errorMessage: "failed to update workflow",
  });
}

export function deleteWorkflow(id: string): Promise<{ ok: boolean }> {
  return request(`/api/workflows/${id}`, {
    method: "DELETE",
    auth: true,
    devAuth: true,
    errorMessage: "failed to delete workflow",
  });
}

// --- Identity / workspaces (Firebase auth) ---

// The signed-in Google account and all workspaces it belongs to.
export function getMe(): Promise<Me> {
  return request<Me>(`/api/me`, { auth: true, errorMessage: "failed to load profile" });
}

// Is a handle free within a workspace (by id) or an invite's workspace (by token)?
export function checkHandle(
  handle: string,
  scope: { workspaceId?: string; invite?: string } = {},
): Promise<{ available: boolean; valid: boolean }> {
  const qs = new URLSearchParams({ handle });
  if (scope.workspaceId) qs.set("workspaceId", scope.workspaceId);
  if (scope.invite) qs.set("invite", scope.invite);
  return request(`/api/handle-available?${qs.toString()}`, { errorMessage: "failed to check handle" });
}

// Create a new workspace; the caller becomes its admin. Returns the workspace + the caller's
// participant in it.
export function createWorkspace(args: {
  name: string;
  handle: string;
  displayName: string;
}): Promise<{ workspace: Workspace; participant: Participant }> {
  return request(`/api/workspaces`, { json: args, auth: true, errorMessage: "failed to create workspace" });
}

// Preview an invite link (workspace name + validity). No auth required, but if signed in the
// response also says whether you're already a member.
export function getInvite(token: string): Promise<InviteInfo> {
  return request<InviteInfo>(`/api/invites/${token}`, { auth: true, errorMessage: "failed to load invite" });
}

// Join a workspace via an invite link. Idempotent if you're already a member.
export function acceptInvite(token: string, handle: string, displayName: string): Promise<Participant> {
  return request<Participant>(`/api/invites/${token}/accept`, {
    json: { handle, displayName },
    auth: true,
    errorMessage: "failed to join workspace",
  });
}

export interface Invite {
  token: string;
  expires_at: string | null;
  created_at: string;
}

// Admin: the workspace's active invite links.
export function listInvites(workspaceId: string): Promise<Invite[]> {
  return request<Invite[]>(`/api/workspaces/${workspaceId}/invites`, {
    auth: true,
    devAuth: true,
    errorMessage: "failed to load invites",
  });
}

// Admin: create a new invite link (optional expiry in days).
export function createInvite(workspaceId: string, expiresInDays?: number): Promise<Invite> {
  return request<Invite>(`/api/workspaces/${workspaceId}/invites`, {
    json: expiresInDays != null ? { expiresInDays } : {},
    auth: true,
    devAuth: true,
    errorMessage: "failed to create invite",
  });
}

// Admin: revoke an invite link.
export function revokeInvite(token: string): Promise<{ ok: boolean }> {
  return request(`/api/invites/${token}/revoke`, {
    method: "POST",
    auth: true,
    devAuth: true,
    errorMessage: "failed to revoke invite",
  });
}

export function githubConnectUrl(opts?: { popup?: boolean }): Promise<{ url: string }> {
  return request(`/api/github/connect-url`, {
    method: "POST",
    json: { popup: opts?.popup === true },
    auth: true,
    errorMessage: "failed to start GitHub connect",
  });
}

// Disconnect the current user's GitHub account (removes stored tokens).
export function disconnectGithub(): Promise<{ ok: boolean }> {
  return request(`/api/github/connection`, {
    method: "DELETE",
    auth: true,
    errorMessage: "failed to disconnect GitHub",
  });
}

export interface GithubStatus {
  connected: boolean;
  login?: string;
  installUrl: string | null;
  installationCount: number;
  repoCount: number;
}

export function getGithubStatus(): Promise<GithubStatus> {
  return request<GithubStatus>(`/api/github/status`, {
    auth: true,
    errorMessage: "failed to load GitHub status",
  });
}

// --- Google (Gmail) connection: per-user OAuth, mirrors the GitHub connect flow above. Backs
// the Gmail agent integration; surfaced in Settings → Connections. ---

export function googleConnectUrl(opts?: { popup?: boolean }): Promise<{ url: string }> {
  return request(`/api/google/connect-url`, {
    method: "POST",
    json: { popup: opts?.popup === true },
    auth: true,
    errorMessage: "failed to start Google connect",
  });
}

export function disconnectGoogle(): Promise<{ ok: boolean }> {
  return request(`/api/google/connection`, {
    method: "DELETE",
    auth: true,
    errorMessage: "failed to disconnect Google",
  });
}

export interface GoogleStatus {
  connected: boolean;
  email?: string;
}

export function getGoogleStatus(): Promise<GoogleStatus> {
  return request<GoogleStatus>(`/api/google/status`, {
    auth: true,
    errorMessage: "failed to load Google status",
  });
}

export interface Repo {
  full_name: string;
  private: boolean;
  pushed_at: string | null;
}

// List the user's GitHub repos for the picker. A 409 (GitHub not connected) is returned as
// { connected: false } rather than thrown, so the UI can fall back to manual entry.
export async function listGithubRepos(): Promise<{ connected: boolean; repos?: Repo[]; error?: string }> {
  const token = await bearerToken();
  return fetch(`${BASE}/api/github/repos`, {
    headers: token ? { authorization: `Bearer ${token}` } : {},
  }).then(async (r) => {
    const j = await r.json().catch(() => ({}));
    if (r.status === 409) return { connected: false, error: (j as { error?: string }).error };
    if (!r.ok) throw new Error((j as { error?: string }).error ?? "failed to list repos");
    return j as { connected: boolean; repos: Repo[] };
  });
}
