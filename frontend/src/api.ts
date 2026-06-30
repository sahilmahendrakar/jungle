// MVP: backend is hardcoded to localhost. Swap to an env-configured URL when deployed.
const BASE = "http://localhost:3001";
export const WS_BASE = "ws://localhost:3001";

export interface Channel {
  id: string;
  name: string;
  kind: string;
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
  return fetch(`${BASE}/api/participants`).then((r) => r.json());
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

export function getMessages(channelId: string): Promise<Message[]> {
  return fetch(`${BASE}/api/channels/${channelId}/messages`).then((r) => r.json());
}
