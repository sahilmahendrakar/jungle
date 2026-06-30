// Backend runs on :3001 on the same host the frontend is served from. Deriving from
// location (rather than hardcoding localhost) means access via an IP/hostname works too.
const host = typeof location !== "undefined" && location.hostname ? location.hostname : "localhost";
const secure = typeof location !== "undefined" && location.protocol === "https:";
const BASE = `${secure ? "https" : "http"}://${host}:3001`;
export const WS_BASE = `${secure ? "wss" : "ws"}://${host}:3001`;

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

// Create a human participant, or (kind "agent", optional repo) a cloud agent.
export function createParticipant(p: {
  kind: "human" | "agent";
  handle: string;
  displayName: string;
  repo?: string;
}): Promise<Participant> {
  const path = p.kind === "agent" ? "/api/agents" : "/api/participants";
  const body =
    p.kind === "agent"
      ? { handle: p.handle, displayName: p.displayName, ...(p.repo ? { repo: p.repo } : {}) }
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
