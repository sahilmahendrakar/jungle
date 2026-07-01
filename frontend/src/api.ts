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
function authHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return authToken ? { authorization: `Bearer ${authToken}`, ...extra } : extra;
}

export interface Channel {
  id: string;
  name: string;
  kind: string;
  dm_with?: string | null; // for dm channels: the other member's handle
}

export interface Message {
  id: string;
  channel_id: string;
  seq: string;
  sender_id: string;
  sender_handle: string;
  body: string;
  created_at: string;
}

export interface Participant {
  id: string;
  kind: "human" | "agent";
  handle: string;
  display_name: string;
  repo?: string | null;
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

export function listChannels(participantId: string): Promise<Channel[]> {
  return fetch(`${BASE}/api/channels?participantId=${participantId}`).then((r) => r.json());
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
