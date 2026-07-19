// Mobile API client — a near-verbatim port of frontend/src/api.ts. Wire types are the single
// source of truth in @jungle/shared. The only substantive differences from the web version:
//   - base-URL resolution comes from lib/config (Expo env + dev switcher), not import.meta.env
//     / location, and is read per-call via getBase() so the in-app server switcher takes effect.
//   - uploadAttachment takes a local file descriptor and streams it with expo-file-system
//     (RN fetch with a file body is unreliable for raw octet-stream uploads).
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
  Workflow,
  WorkflowRun,
  WorkflowTemplate,
} from "@jungle/shared";
import { File } from "expo-file-system";
import { getBase } from "./config";

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

export type { Participant, Attachment, UnreadThread, AgentEvent, AgentStatus, AgentIntegration, RunnerHost };
export type { Schedule, Deliverable, DeliverableKind, SearchResult };
export type { Workflow, WorkflowRun, WorkflowTemplate };
export type { Me, GoogleProfile, Workspace, Membership, InviteInfo };
// A message as delivered to the client (attachments carry signed download urls).
export type Message = WireMessage;

// Last-known Firebase ID token, pushed in by the auth provider on onIdTokenChanged. A snapshot
// that can go stale; the token-getter below is preferred (mints a fresh one).
let authToken: string | null = null;
export function setAuthToken(t: string | null) {
  authToken = t;
}
// Fresh-token getter registered by the auth provider (wraps Firebase getIdToken). Authed requests
// await this so the bearer is never stale.
let tokenGetter: (() => Promise<string | null>) | null = null;
export function setTokenGetter(fn: (() => Promise<string | null>) | null) {
  tokenGetter = fn;
}
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
// Dev/test identity (?participantId=): used only when Firebase isn't configured (a dev-bypass
// backend). In production authToken is set and this stays null.
let devParticipantId: string | null = null;
export function setDevParticipantId(id: string | null) {
  devParticipantId = id;
}
// The active workspace: sent as X-Workspace-Id on every authed request so the backend resolves the
// caller's participant in the right workspace.
let activeWorkspaceId: string | null = null;
export function setActiveWorkspaceId(id: string | null) {
  activeWorkspaceId = id;
}
export function getActiveWorkspaceId(): string | null {
  return activeWorkspaceId;
}

interface RequestOpts {
  method?: string;
  json?: unknown;
  body?: BodyInit;
  headers?: Record<string, string>;
  auth?: boolean;
  devAuth?: boolean;
  errorMessage?: string;
}

function buildUrl(path: string, devAuth: boolean): string {
  const url = `${getBase()}${path}`;
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

export interface Channel {
  id: string;
  name: string;
  kind: string;
  dm_with?: string | null;
  unread_count?: number;
  has_mention?: boolean;
  member_agent_ids?: string[];
}

// A local file chosen from the picker/camera, ready to upload.
export interface LocalFile {
  uri: string;
  name: string;
  mime?: string;
}

// Upload a file (upload-first, Slack-style): streams the raw bytes to the attachments endpoint and
// returns the stored Attachment whose id is then referenced by the WS `post` frame. Max 25MB.
// expo-file-system's File implements Blob, so it can be passed straight as the octet-stream body
// (the reliable raw-upload path from RN).
export async function uploadAttachment(file: LocalFile): Promise<Attachment> {
  const mime = file.mime || "application/octet-stream";
  const qs = `filename=${encodeURIComponent(file.name)}&mime=${encodeURIComponent(mime)}`;
  const headers: Record<string, string> = { "content-type": "application/octet-stream" };
  const token = await bearerToken();
  if (token) headers.authorization = `Bearer ${token}`;
  if (activeWorkspaceId) headers["x-workspace-id"] = activeWorkspaceId;
  const res = await fetch(buildUrl(`/api/attachments?${qs}`, true), {
    method: "POST",
    headers,
    body: new File(file.uri),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data as { error?: string }).error ?? "upload failed");
  return data as Attachment;
}

// Attachment urls come back origin-relative (signed path); resolve against the API base.
export function attachmentUrl(a: Attachment): string {
  return `${getBase()}${a.url}`;
}

export function listParticipants(): Promise<Participant[]> {
  return request<Participant[]>(`/api/participants`, {
    auth: true,
    devAuth: true,
    errorMessage: "failed to load participants",
  });
}

export function createParticipant(p: {
  kind: "human" | "agent";
  handle: string;
  displayName: string;
  integrations?: Array<{ key: string; config: Record<string, unknown> }>;
  model?: string;
  mode?: string;
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
          ...(p.runnerProvider ? { runnerProvider: p.runnerProvider } : {}),
          ...(p.hostId ? { hostId: p.hostId } : {}),
        }
      : { kind: "human", handle: p.handle, displayName: p.displayName };
  return request<Participant>(path, { json, auth: true, devAuth: true, errorMessage: "create failed" });
}

// --- Self-hosted devices (Environments) ---

export function listDevices(): Promise<RunnerHost[]> {
  return request<RunnerHost[]>(`/api/devices`, {
    auth: true,
    devAuth: true,
    errorMessage: "failed to load devices",
  });
}

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

export function removeDevice(id: string): Promise<{ ok: boolean }> {
  return request<{ ok: boolean }>(`/api/devices/${id}`, {
    method: "DELETE",
    auth: true,
    devAuth: true,
    errorMessage: "failed to remove device",
  });
}

// --- Agent config / activity ---

export function listAgentIntegrations(agentId: string): Promise<AgentIntegration[]> {
  return request<AgentIntegration[]>(`/api/agents/${agentId}/integrations`, {
    auth: true,
    devAuth: true,
    errorMessage: "failed to load integrations",
  });
}

export function getAgentMemory(id: string): Promise<{ memory: string | null; updatedAt: string | null }> {
  return request(`/api/agents/${id}/memory`, {
    auth: true,
    devAuth: true,
    errorMessage: "failed to load memory",
  });
}

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

export interface AgentEventsPage {
  events: AgentEvent[];
  runner: { connected: boolean; state: "idle" | "running"; status?: AgentStatus };
}

// Fetch a page of an sdk agent's activity transcript. Page backwards with `before` = smallest id held.
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

export function interruptAgent(id: string): Promise<{ ok: boolean; error?: string }> {
  return request(`/api/agents/${id}/interrupt`, {
    method: "POST",
    auth: true,
    devAuth: true,
    errorMessage: "failed to stop agent",
  });
}

// --- Channels ---

export function listChannels(participantId: string): Promise<Channel[]> {
  return request<Channel[]>(`/api/channels?participantId=${participantId}`, {
    auth: true,
    errorMessage: "failed to load channels",
  });
}

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

export function getThread(channelId: string, rootId: string): Promise<Message[]> {
  return request<Message[]>(`/api/channels/${channelId}/threads/${rootId}`, {
    auth: true,
    devAuth: true,
    errorMessage: "failed to load thread",
  });
}

export function markThreadRead(rootId: string, seq?: number): Promise<{ ok: boolean; lastReadSeq: number }> {
  return request(`/api/threads/${rootId}/read`, {
    method: "POST",
    json: seq != null ? { seq } : {},
    auth: true,
    devAuth: true,
    errorMessage: "failed to mark thread read",
  });
}

export function listUnreadThreads(): Promise<UnreadThread[]> {
  return request<UnreadThread[]>(`/api/threads/unread`, {
    auth: true,
    devAuth: true,
    errorMessage: "failed to load threads",
  });
}

export function createDm(participantId: string, otherId: string): Promise<{ id: string; kind: string }> {
  return request(`/api/dms`, {
    json: { participantId, otherId },
    auth: true,
    devAuth: true,
    errorMessage: "failed to open DM",
  });
}

// --- Approvals (tool confirmations) ---

export function confirmToolCall(confirmId: string, decision: "allow" | "deny"): Promise<{ ok: boolean }> {
  return request(`/api/agents/confirm`, {
    json: { confirmId, decision },
    auth: true,
    devAuth: true,
    errorMessage: "failed to submit decision",
  });
}

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

export function listPendingConfirms(): Promise<PendingConfirmation[]> {
  return request<{ confirmations: PendingConfirmation[] }>(`/api/confirmations`, {
    auth: true,
    devAuth: true,
    errorMessage: "failed to load approvals",
  }).then((r) => r.confirmations);
}

// --- Work feed / search ---

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

export function searchMessages(q: string, limit = 20): Promise<SearchResult[]> {
  const qs = new URLSearchParams({ q, limit: String(limit) });
  return request<{ results: SearchResult[] }>(`/api/search?${qs.toString()}`, {
    auth: true,
    devAuth: true,
    errorMessage: "search failed",
  }).then((r) => r.results);
}

// --- Channel members ---

export function listChannelMembers(channelId: string): Promise<Participant[]> {
  return request<Participant[]>(`/api/channels/${channelId}/members`, {
    auth: true,
    devAuth: true,
    errorMessage: "failed to load members",
  });
}

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

// --- Schedules ---

export function listSchedules(): Promise<Schedule[]> {
  return request<{ schedules: Schedule[] }>(`/api/schedules`, {
    auth: true,
    devAuth: true,
    errorMessage: "failed to load schedules",
  }).then((r) => r.schedules);
}

export function updateSchedule(
  id: string,
  patch: { prompt?: string; cron?: string | null; timezone?: string | null; runAt?: string | null; channelId?: string; paused?: boolean },
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

export function listWorkflowTemplates(): Promise<WorkflowTemplate[]> {
  return request<{ templates: WorkflowTemplate[] }>(`/api/workflow-templates`, {
    auth: true,
    devAuth: true,
    errorMessage: "failed to load templates",
  }).then((r) => r.templates);
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

// Open the conversational builder: creates a draft (blank or from a template), ensures the
// Architect agent, and opens your DM with it — the mobile "builder UI" is that DM.
export function openWorkflowBuilder(
  templateId?: string,
): Promise<{ architectId: string; dmChannelId: string; draftId: string }> {
  return request(`/api/workflows/builder`, {
    json: templateId ? { templateId } : {},
    auth: true,
    devAuth: true,
    errorMessage: "failed to open the workflow builder",
  });
}

export function updateWorkflow(
  id: string,
  patch: { playbook?: string; paused?: boolean; name?: string },
): Promise<Workflow> {
  return request<Workflow>(`/api/workflows/${id}`, {
    method: "PATCH",
    json: patch,
    auth: true,
    devAuth: true,
    errorMessage: "failed to update workflow",
  });
}

export function finalizeWorkflow(id: string): Promise<Workflow> {
  return request<Workflow>(`/api/workflows/${id}/finalize`, {
    json: {},
    auth: true,
    devAuth: true,
    errorMessage: "failed to create the workflow",
  });
}

export function runWorkflow(id: string): Promise<WorkflowRun> {
  return request<WorkflowRun>(`/api/workflows/${id}/run`, {
    json: {},
    auth: true,
    devAuth: true,
    errorMessage: "failed to start the run",
  });
}

export function stopWorkflowRun(id: string, runId: string): Promise<WorkflowRun> {
  return request<WorkflowRun>(`/api/workflows/${id}/runs/${runId}/stop`, {
    json: {},
    auth: true,
    devAuth: true,
    errorMessage: "failed to stop the run",
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

// --- Push notifications ---

export function registerPushToken(token: string, platform = "ios"): Promise<{ ok: boolean }> {
  return request(`/api/push/register`, {
    json: { token, platform },
    auth: true,
    devAuth: true,
    errorMessage: "failed to register push token",
  });
}

export function unregisterPushToken(token: string): Promise<{ ok: boolean }> {
  return request(`/api/push/register`, {
    method: "DELETE",
    json: { token },
    auth: true,
    devAuth: true,
    errorMessage: "failed to unregister push token",
  });
}

// --- Identity / workspaces (Firebase auth) ---

export function getMe(): Promise<Me> {
  return request<Me>(`/api/me`, { auth: true, errorMessage: "failed to load profile" });
}

export function checkHandle(
  handle: string,
  scope: { workspaceId?: string; invite?: string } = {},
): Promise<{ available: boolean; valid: boolean }> {
  const qs = new URLSearchParams({ handle });
  if (scope.workspaceId) qs.set("workspaceId", scope.workspaceId);
  if (scope.invite) qs.set("invite", scope.invite);
  return request(`/api/handle-available?${qs.toString()}`, { errorMessage: "failed to check handle" });
}

export function createWorkspace(args: {
  name: string;
  handle: string;
  displayName: string;
}): Promise<{ workspace: Workspace; participant: Participant }> {
  return request(`/api/workspaces`, { json: args, auth: true, errorMessage: "failed to create workspace" });
}

export function getInvite(token: string): Promise<InviteInfo> {
  return request<InviteInfo>(`/api/invites/${token}`, { auth: true, errorMessage: "failed to load invite" });
}

export function acceptInvite(token: string, handle: string, displayName: string): Promise<Participant> {
  return request<Participant>(`/api/invites/${token}/accept`, {
    json: { handle, displayName },
    auth: true,
    errorMessage: "failed to join workspace",
  });
}
