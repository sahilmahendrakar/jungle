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

export function listChannels(participantId: string): Promise<Channel[]> {
  return fetch(`${BASE}/api/channels?participantId=${participantId}`).then((r) => r.json());
}

export function getMessages(channelId: string): Promise<Message[]> {
  return fetch(`${BASE}/api/channels/${channelId}/messages`).then((r) => r.json());
}

export interface DevBootstrap {
  participantId: string;
  handle: string;
  channelId: string;
}

export function fetchDevBootstrap(): Promise<DevBootstrap> {
  return fetch(`${BASE}/api/dev/bootstrap`).then((r) => {
    if (!r.ok) throw new Error(`bootstrap failed (${r.status})`);
    return r.json();
  });
}
