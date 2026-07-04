// Wire types are the single source of truth in @jungle/shared (also consumed by the backend).
// The frontend re-exports the ones it uses so components can keep importing from "./api".
import type {
  Participant,
  Attachment,
  UnreadThread,
  AgentEvent,
  AgentStatus,
  WireMessage,
} from "@jungle/shared";

export type { Participant, Attachment, UnreadThread, AgentEvent, AgentStatus };
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

// Current Firebase ID token, set by the auth provider; attached to authed requests.
let authToken: string | null = null;
export function setAuthToken(t: string | null) {
  authToken = t;
}
// Dev/test identity (?as=<id>): when Firebase isn't configured there's no token, so
// requester-gated endpoints authenticate via a participantId the backend trusts under
// DEV_BYPASS. In production authToken is set and this stays null.
let devParticipantId: string | null = null;
export function setDevParticipantId(id: string | null) {
  devParticipantId = id;
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
  if (opts.auth && authToken) headers.authorization = `Bearer ${authToken}`;
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
  return request<Participant[]>(`/api/participants`, { errorMessage: "failed to load participants" });
}

// Create a human participant, or (kind "agent", optional repo/model/mode) a cloud agent.
export function createParticipant(p: {
  kind: "human" | "agent";
  handle: string;
  displayName: string;
  repo?: string;
  model?: string;
  mode?: string;
}): Promise<Participant> {
  const path = p.kind === "agent" ? "/api/agents" : "/api/participants";
  const json =
    p.kind === "agent"
      ? {
          handle: p.handle,
          displayName: p.displayName,
          ...(p.repo ? { repo: p.repo } : {}),
          ...(p.model ? { model: p.model } : {}),
          ...(p.mode ? { mode: p.mode } : {}),
        }
      : { kind: "human", handle: p.handle, displayName: p.displayName };
  return request<Participant>(path, { json, errorMessage: "create failed" });
}

// Update an agent's editable config from its profile page. `mode` is applied live; for sdk
// agents `model` is applied at the agent's next turn boundary.
export function updateAgent(
  id: string,
  patch: { displayName?: string; mode?: string; model?: string; effort?: string },
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

export function listChannels(participantId: string): Promise<Channel[]> {
  return request<Channel[]>(`/api/channels?participantId=${participantId}`, {
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
  return request<Channel>(`/api/channels`, { json: c, errorMessage: "failed to create channel" });
}

export function getMessages(channelId: string): Promise<Message[]> {
  return request<Message[]>(`/api/channels/${channelId}/messages`, {
    errorMessage: "failed to load messages",
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
  return request(`/api/dms`, { json: { participantId, otherId }, errorMessage: "failed to open DM" });
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

// --- Identity / onboarding (Firebase auth) ---

export interface GoogleProfile {
  uid: string;
  email: string | null;
  name: string | null;
  picture: string | null;
}

export interface Me {
  onboarded: boolean;
  participant?: Participant;
  profile?: GoogleProfile;
  suggestedHandle?: string;
  github?: { connected: boolean; login?: string };
}

export function getMe(): Promise<Me> {
  return request<Me>(`/api/me`, { auth: true, errorMessage: "failed to load profile" });
}

export function checkHandle(handle: string): Promise<{ available: boolean; valid: boolean }> {
  return request(`/api/handle-available?handle=${encodeURIComponent(handle)}`, {
    errorMessage: "failed to check handle",
  });
}

export function completeOnboarding(handle: string, displayName: string): Promise<Participant> {
  return request<Participant>(`/api/onboarding`, {
    json: { handle, displayName },
    auth: true,
    errorMessage: "onboarding failed",
  });
}

export function githubConnectUrl(): Promise<{ url: string }> {
  return request(`/api/github/connect-url`, {
    method: "POST",
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

export interface Repo {
  full_name: string;
  private: boolean;
  pushed_at: string | null;
}

// List the user's GitHub repos for the picker. A 409 (GitHub not connected) is returned as
// { connected: false } rather than thrown, so the UI can fall back to manual entry.
export function listGithubRepos(): Promise<{ connected: boolean; repos?: Repo[]; error?: string }> {
  return fetch(`${BASE}/api/github/repos`, {
    headers: authToken ? { authorization: `Bearer ${authToken}` } : {},
  }).then(async (r) => {
    const j = await r.json().catch(() => ({}));
    if (r.status === 409) return { connected: false, error: (j as { error?: string }).error };
    if (!r.ok) throw new Error((j as { error?: string }).error ?? "failed to list repos");
    return j as { connected: boolean; repos: Repo[] };
  });
}
