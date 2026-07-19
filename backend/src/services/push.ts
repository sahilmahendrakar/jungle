// Push-notification dispatcher (Expo Push Service). Called fire-and-forget from the single
// fan-out site in ws/appSocket.ts (messages) and services/confirmations.ts (approval requests),
// so every place a message or confirmation reaches a user's other devices also reaches their
// phone. Notification rules mirror the web notify logic: a message notifies non-sender HUMAN
// members when it's a DM or an @mention; a confirmation request notifies all human members.
// Recipients already looking at the app on a live socket are NOT suppressed here (the client
// suppresses the banner for the channel it's actively viewing) — keeping this stateless.
import { Expo, type ExpoPushMessage, type ExpoPushTicket } from "expo-server-sdk";
import * as db from "../db";
import type { PersistedMessage } from "../db";

const expo = new Expo();

const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + "…" : s);

// Send a batch, then prune any tokens Expo immediately rejected as unregistered.
async function send(messages: ExpoPushMessage[]): Promise<void> {
  if (messages.length === 0) return;
  const chunks = expo.chunkPushNotifications(messages);
  const dead: string[] = [];
  for (const chunk of chunks) {
    let tickets: ExpoPushTicket[] = [];
    try {
      tickets = await expo.sendPushNotificationsAsync(chunk);
    } catch (err) {
      console.error("[push] send failed:", err);
      continue;
    }
    tickets.forEach((t, i) => {
      if (t.status === "error" && t.details?.error === "DeviceNotRegistered") {
        const to = chunk[i].to;
        if (typeof to === "string") dead.push(to);
      }
    });
  }
  if (dead.length) await db.deletePushTokens(dead).catch(() => {});
}

// Collect the Expo tokens for a set of human participants (by their accounts), excluding the
// sender. Returns [] when nobody's eligible.
async function tokensForHumans(members: db.Participant[], excludeId: string): Promise<string[]> {
  const uids = members
    .filter((m) => m.kind === "human" && m.id !== excludeId && m.firebase_uid)
    .map((m) => m.firebase_uid as string);
  return db.listPushTokensByUids([...new Set(uids)]);
}

// A newly-posted message. Notify non-sender human members when it's a DM or mentions them.
export async function pushMessage(message: PersistedMessage): Promise<void> {
  try {
    const channel = await db.getChannel(message.channel_id);
    if (!channel) return;
    const members = await db.channelMembers(message.channel_id);
    const isDm = channel.kind === "dm";
    const mentionedIds = new Set((message.mentions ?? []).map((m) => m.id));

    // Eligible human recipients: not the sender, and either a DM or mentioned.
    const recipients = members.filter(
      (m) => m.kind === "human" && m.id !== message.sender_id && (isDm || mentionedIds.has(m.id)),
    );
    const uids = [...new Set(recipients.map((r) => r.firebase_uid).filter(Boolean) as string[])];
    const tokens = await db.listPushTokensByUids(uids);
    if (tokens.length === 0) return;

    const sender = members.find((m) => m.id === message.sender_id);
    const who = sender ? `@${sender.handle}` : "New message";
    const title = isDm ? who : `${who} in #${channel.name}`;
    const body = message.body?.trim() ? clip(message.body, 180) : "Sent an attachment";

    await send(
      tokens.map((to) => ({
        to,
        title,
        body,
        sound: "default",
        data: {
          url: `jungle:///channel/${channel.id}`,
          channelId: channel.id,
          threadRootId: message.thread_root_id ?? undefined,
          workspaceId: channel.workspace_id,
        },
      })),
    );
  } catch (err) {
    console.error("[push] pushMessage error:", err);
  }
}

// A tool-call approval request. Notify all human members (minus the agent, which isn't human).
export async function pushApproval(opts: {
  channelId: string;
  agentName: string;
  tool: string;
}): Promise<void> {
  try {
    const channel = await db.getChannel(opts.channelId);
    if (!channel) return;
    const members = await db.channelMembers(opts.channelId);
    const tokens = await tokensForHumans(members, "");
    if (tokens.length === 0) return;
    await send(
      tokens.map((to) => ({
        to,
        title: "Approval needed",
        body: clip(`${opts.agentName} wants to run ${opts.tool}`, 180),
        sound: "default",
        data: { url: "jungle:///activity", channelId: channel.id, workspaceId: channel.workspace_id },
      })),
    );
  } catch (err) {
    console.error("[push] pushApproval error:", err);
  }
}
