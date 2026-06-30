// Backend runs on :3001 on the same host the frontend is served from. Deriving from
// location (rather than hardcoding localhost) means access via an IP/hostname works too.
const host = typeof location !== "undefined" && location.hostname ? location.hostname : "localhost";
const secure = typeof location !== "undefined" && location.protocol === "https:";
const BASE = `${secure ? "https" : "http"}://${host}:3001`;
export const WS_BASE = `${secure ? "wss" : "ws"}://${host}:3001`;

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
