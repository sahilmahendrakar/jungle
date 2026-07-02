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
function authHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return authToken ? { authorization: `Bearer ${authToken}`, ...extra } : extra;
}
// Append the dev participantId to a URL's query when running without a token, so GET
// endpoints gated by requester() resolve an identity under DEV_BYPASS. No-op in prod.
function withDevAuth(url: string): string {
  if (authToken || !devParticipantId) return url;
  return url + (url.includes("?") ? "&" : "?") + `participantId=${encodeURIComponent(devParticipantId)}`;
}

export interface Channel {
  id: string;
  name: string;
  kind: string;
  dm_with?: string | null; // for dm channels: the other member's handle
  unread_count?: number; // messages after my last_read_seq, excluding my own
  has_mention?: boolean; // any unread message @mentions me
}

export interface Attachment {
  id: string;
  filename: string;
  mime: string;
  size_bytes: number;
  width?: number | null;
  height?: number | null;
  url: string; // origin-relative signed path — prefix with the API BASE (see attachmentUrl)
}

export interface Message {
  id: string;
  channel_id: string;
  seq: string;
  sender_id: string;
  sender_handle: string;
  body: string;
  created_at: string;
  mentions?: { id: string; handle: string }[]; // present on WS message frames
  attachments?: Attachment[]; // may be absent on older cached shapes — treat as empty
}

// Upload a file (upload-first, Slack-style): returns the stored Attachment whose id is
// then referenced by the WS `post` frame's attachmentIds. Max 25MB per file.
export function uploadAttachment(file: File): Promise<Attachment> {
  const mime = file.type || "application/octet-stream";
  const qs = `filename=${encodeURIComponent(file.name)}&mime=${encodeURIComponent(mime)}`;
  return fetch(withDevAuth(`${BASE}/api/attachments?${qs}`), {
    method: "POST",
    headers: authHeaders({ "content-type": "application/octet-stream" }),
    body: file,
  }).then((r) => json<Attachment>(r, "upload failed"));
}

// Attachment urls come back origin-relative (signed path); resolve against the API BASE.
export function attachmentUrl(a: Attachment): string {
  return `${BASE}${a.url}`;
}

export interface Participant {
  id: string;
  kind: "human" | "agent";
  handle: string;
  display_name: string;
  repo?: string | null;
  model?: string | null; // agent model (null = agent-config default)
  mode?: string; // SDK permission mode: 'default'|'acceptEdits'|'plan'|'bypassPermissions'|'dontAsk'
  runtime?: string; // 'sdk' (per-agent runner)
}

export function listParticipants(): Promise<Participant[]> {
  return fetch(`${BASE}/api/participants`).then(async (r) => {
    const j = await r.json();
    if (!r.ok) throw new Error(j.error ?? "failed to load participants");
    return j;
  });
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
  const body =
    p.kind === "agent"
      ? {
          handle: p.handle,
          displayName: p.displayName,
          ...(p.repo ? { repo: p.repo } : {}),
          ...(p.model ? { model: p.model } : {}),
          ...(p.mode ? { mode: p.mode } : {}),
        }
      : { kind: "human", handle: p.handle, displayName: p.displayName };
  return fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }).then(async (r) => {
    const j = await r.json();
    if (!r.ok) throw new Error(j.error ?? "create failed");
    return j;
  });
}

// Update an agent's editable config from its profile page. `mode` is applied live; for sdk
// agents `model` is applied at the agent's next turn boundary (read-only for ma agents).
export function updateAgent(
  id: string,
  patch: { displayName?: string; mode?: string; model?: string },
): Promise<Participant> {
  return fetch(`${BASE}/api/agents/${id}`, {
    method: "PATCH",
    headers: authHeaders({ "content-type": "application/json" }),
    body: JSON.stringify(patch),
  }).then((r) => json<Participant>(r, "failed to update agent"));
}

// Permanently delete an agent: tears down its runner/container and removes all of its data
// (its DMs and the messages it sent). Irreversible.
export function deleteAgent(id: string): Promise<{ ok: boolean; error?: string }> {
  return fetch(withDevAuth(`${BASE}/api/agents/${id}`), {
    method: "DELETE",
    headers: authHeaders(),
  }).then((r) => json<{ ok: boolean; error?: string }>(r, "failed to delete agent"));
}

// A single Claude Agent SDK stream message persisted for an sdk agent. `event` is the raw
// SDK message JSON (system/assistant/user/result); render defensively (shapes may vary).
export interface AgentEvent {
  id: number;
  turn_id: string;
  event: unknown;
  created_at: string;
}

export interface AgentEventsPage {
  events: AgentEvent[]; // oldest-first within the page
  runner: { connected: boolean; state: "idle" | "running" };
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
  return fetch(withDevAuth(`${BASE}/api/agents/${id}/events${q ? `?${q}` : ""}`), {
    headers: authHeaders(),
  }).then((r) => json<AgentEventsPage>(r, "failed to load activity"));
}

// Stop an sdk agent's currently-running turn.
export function interruptAgent(id: string): Promise<{ ok: boolean; error?: string }> {
  return fetch(withDevAuth(`${BASE}/api/agents/${id}/interrupt`), {
    method: "POST",
    headers: authHeaders(),
  }).then((r) => json<{ ok: boolean; error?: string }>(r, "failed to stop agent"));
}

export function listChannels(participantId: string): Promise<Channel[]> {
  return fetch(`${BASE}/api/channels?participantId=${participantId}`).then((r) => r.json());
}

// Mark a channel read for the current user: advances my last_read_seq to the channel's max
// message seq (or the supplied `seq`). Requester-gated; uses withDevAuth so the ?participantId=
// dev path resolves an identity when there's no Firebase token.
export function markChannelRead(
  channelId: string,
  seq?: number,
): Promise<{ ok: boolean; lastReadSeq: number }> {
  return fetch(withDevAuth(`${BASE}/api/channels/${channelId}/read`), {
    method: "POST",
    headers: authHeaders({ "content-type": "application/json" }),
    body: JSON.stringify(seq != null ? { seq } : {}),
  }).then((r) => json<{ ok: boolean; lastReadSeq: number }>(r, "failed to mark read"));
}

// Create a channel (kind "channel") or DM (kind "dm") with the given member handles.
export function createChannel(c: {
  name: string;
  kind: "channel" | "dm";
  memberHandles: string[];
}): Promise<Channel> {
  return fetch(`${BASE}/api/channels`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(c),
  }).then(async (r) => {
    const j = await r.json();
    if (!r.ok) throw new Error(j.error ?? "failed to create channel");
    return j;
  });
}

export function getMessages(channelId: string): Promise<Message[]> {
  return fetch(`${BASE}/api/channels/${channelId}/messages`).then((r) => r.json());
}

// Find-or-create a 1:1 DM with another participant.
export function createDm(participantId: string, otherId: string): Promise<{ id: string; kind: string }> {
  return fetch(`${BASE}/api/dms`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ participantId, otherId }),
  }).then(async (r) => {
    const j = await r.json();
    if (!r.ok) throw new Error(j.error ?? "failed to open DM");
    return j;
  });
}

// Approve or deny a pending tool confirmation from an always_ask agent.
export function confirmToolCall(confirmId: string, decision: "allow" | "deny"): Promise<{ ok: boolean }> {
  return fetch(`${BASE}/api/agents/confirm`, {
    method: "POST",
    headers: authHeaders({ "content-type": "application/json" }),
    body: JSON.stringify({ confirmId, decision }),
  }).then((r) => json<{ ok: boolean }>(r, "failed to submit decision"));
}

// --- Channel members + delete ---

export function listChannelMembers(channelId: string): Promise<Participant[]> {
  return fetch(`${BASE}/api/channels/${channelId}/members`, { headers: authHeaders() }).then((r) =>
    json<Participant[]>(r, "failed to load members"),
  );
}

// Add a participant (by handle) to a channel. Returns the added participant.
export function addChannelMember(channelId: string, handle: string): Promise<Participant> {
  return fetch(`${BASE}/api/channels/${channelId}/members`, {
    method: "POST",
    headers: authHeaders({ "content-type": "application/json" }),
    body: JSON.stringify({ handle }),
  }).then((r) => json<Participant>(r, "failed to add member"));
}

export function removeChannelMember(channelId: string, participantId: string): Promise<{ ok: boolean }> {
  return fetch(`${BASE}/api/channels/${channelId}/members/${participantId}`, {
    method: "DELETE",
    headers: authHeaders(),
  }).then((r) => json<{ ok: boolean }>(r, "failed to remove member"));
}

export function deleteChannel(channelId: string): Promise<{ ok: boolean }> {
  return fetch(`${BASE}/api/channels/${channelId}`, {
    method: "DELETE",
    headers: authHeaders(),
  }).then((r) => json<{ ok: boolean }>(r, "failed to delete channel"));
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

async function json<T>(r: Response, fallbackErr: string): Promise<T> {
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error((j as { error?: string }).error ?? fallbackErr);
  return j as T;
}

export function getMe(): Promise<Me> {
  return fetch(`${BASE}/api/me`, { headers: authHeaders() }).then((r) => json<Me>(r, "failed to load profile"));
}

export function checkHandle(handle: string): Promise<{ available: boolean; valid: boolean }> {
  return fetch(`${BASE}/api/handle-available?handle=${encodeURIComponent(handle)}`).then((r) =>
    json(r, "failed to check handle"),
  );
}

export function completeOnboarding(handle: string, displayName: string): Promise<Participant> {
  return fetch(`${BASE}/api/onboarding`, {
    method: "POST",
    headers: authHeaders({ "content-type": "application/json" }),
    body: JSON.stringify({ handle, displayName }),
  }).then((r) => json<Participant>(r, "onboarding failed"));
}

export function githubConnectUrl(): Promise<{ url: string }> {
  return fetch(`${BASE}/api/github/connect-url`, {
    method: "POST",
    headers: authHeaders(),
  }).then((r) => json<{ url: string }>(r, "failed to start GitHub connect"));
}

// Disconnect the current user's GitHub account (removes stored tokens).
export function disconnectGithub(): Promise<{ ok: boolean }> {
  return fetch(`${BASE}/api/github/connection`, {
    method: "DELETE",
    headers: authHeaders(),
  }).then((r) => json<{ ok: boolean }>(r, "failed to disconnect GitHub"));
}

export interface GithubStatus {
  connected: boolean;
  login?: string;
  installUrl: string | null;
  installationCount: number;
  repoCount: number;
}

export function getGithubStatus(): Promise<GithubStatus> {
  return fetch(`${BASE}/api/github/status`, { headers: authHeaders() }).then((r) =>
    json<GithubStatus>(r, "failed to load GitHub status"),
  );
}

export interface Repo {
  full_name: string;
  private: boolean;
  pushed_at: string | null;
}

// List the user's GitHub repos for the picker. A 409 (GitHub not connected) is returned as
// { connected: false } rather than thrown, so the UI can fall back to manual entry.
export function listGithubRepos(): Promise<{ connected: boolean; repos?: Repo[]; error?: string }> {
  return fetch(`${BASE}/api/github/repos`, { headers: authHeaders() }).then(async (r) => {
    const j = await r.json().catch(() => ({}));
    if (r.status === 409) return { connected: false, error: (j as { error?: string }).error };
    if (!r.ok) throw new Error((j as { error?: string }).error ?? "failed to list repos");
    return j as { connected: boolean; repos: Repo[] };
  });
}
