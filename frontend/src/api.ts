// In dev, use same-origin requests proxied by Vite. In prod, point at the backend host.
const BASE = import.meta.env.DEV ? "" : "http://localhost:3001";
const wsProto = location.protocol === "https:" ? "wss:" : "ws:";
export const WS_BASE = import.meta.env.DEV ? `${wsProto}//${location.host}/ws` : "ws://localhost:3001";

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
  return fetch(`${BASE}/api/dev/bootstrap`).then(async (r) => {
    if (!r.ok) {
      const body = await r.json().catch(() => ({}));
      throw new Error(body.error || `bootstrap failed (${r.status})`);
    }
    return r.json();
  });
}
