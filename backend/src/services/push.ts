import { getMessaging } from "firebase-admin/messaging";
import * as db from "../db";
import { firebaseApp } from "../auth";

// Mobile push via FCM (firebase-admin is already the auth dependency; its messaging API sends
// to APNs through the Firebase project the iOS app registers with). No-op when Firebase isn't
// configured (dev bypass) or the recipients have no registered tokens.

export interface PushPayload {
  title: string;
  body: string;
  // Deep-link/context data (all values must be strings for FCM).
  data?: Record<string, string>;
  // iOS notification category (e.g. "CONFIRM" carries Allow/Deny actions).
  category?: string;
  // Collapse/group key: channel id, so a conversation's pushes thread together.
  threadId?: string;
}

// Send to every registered device of the given accounts. Fire-and-forget from call sites —
// never lets a push failure break the message path.
export async function sendPush(uids: string[], payload: PushPayload): Promise<void> {
  const app = firebaseApp();
  if (!app || !uids.length) return;
  const tokens = await db.pushTokensForUids([...new Set(uids)]);
  if (!tokens.length) return;

  const response = await getMessaging(app).sendEachForMulticast({
    tokens: tokens.map((t) => t.token),
    notification: { title: payload.title, body: payload.body },
    data: payload.data,
    apns: {
      payload: {
        aps: {
          ...(payload.category ? { category: payload.category } : {}),
          ...(payload.threadId ? { threadId: payload.threadId } : {}),
          sound: "default",
        },
      },
    },
  });

  // Prune tokens FCM says are gone so we stop paying for dead sends.
  const dead: string[] = [];
  response.responses.forEach((r, i) => {
    const code = r.error?.code;
    if (code === "messaging/registration-token-not-registered" || code === "messaging/invalid-argument") {
      dead.push(tokens[i].token);
    }
  });
  if (dead.length) await db.removePushTokens(dead);
}

// One-line body preview for a message push.
export function preview(body: string, max = 140): string {
  const line = body.replace(/\s+/g, " ").trim();
  return line.length > max ? `${line.slice(0, max)}…` : line;
}
