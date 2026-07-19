import { getMessaging } from "firebase-admin/messaging";
import * as db from "../db";
import { firebaseApp } from "../auth";

// Mobile push, two providers split by token shape: the native SwiftUI app registers FCM
// registration tokens (sent via firebase-admin, already the auth dependency); the Expo
// (React Native) app registers Expo push tokens ("ExponentPushToken[...]") which go through
// Expo's push HTTP API. No-op when nothing applies (dev bypass / no registered tokens).

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
  if (!uids.length) return;
  const tokens = await db.pushTokensForUids([...new Set(uids)]);
  if (!tokens.length) return;

  const isExpo = (t: string) => t.startsWith("ExponentPushToken[");
  const expo = tokens.map((t) => t.token).filter(isExpo);
  const fcm = tokens.map((t) => t.token).filter((t) => !isExpo(t));

  await Promise.all([sendFcm(fcm, payload), sendExpo(expo, payload)]);
}

async function sendFcm(tokens: string[], payload: PushPayload): Promise<void> {
  const app = firebaseApp();
  if (!app || !tokens.length) return;

  const response = await getMessaging(app).sendEachForMulticast({
    tokens,
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
      dead.push(tokens[i]);
    }
  });
  if (dead.length) await db.removePushTokens(dead);
}

// Expo push API: one POST with up to 100 messages; per-message tickets come back in order.
// (Expo's gateway holds the APNs credentials minted at EAS build time, so no key handling here.)
async function sendExpo(tokens: string[], payload: PushPayload): Promise<void> {
  if (!tokens.length) return;
  try {
    const res = await fetch("https://exp.host/--/api/v2/push/send", {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify(
        tokens.map((to) => ({
          to,
          title: payload.title,
          body: payload.body,
          sound: "default",
          ...(payload.data ? { data: payload.data } : {}),
          ...(payload.category ? { categoryId: payload.category } : {}),
        })),
      ),
    });
    const out = (await res.json().catch(() => null)) as {
      data?: { status: string; details?: { error?: string } }[];
    } | null;
    // Prune tokens Expo says are gone (app uninstalled / permission revoked).
    const dead: string[] = [];
    out?.data?.forEach((ticket, i) => {
      if (ticket.status === "error" && ticket.details?.error === "DeviceNotRegistered") {
        dead.push(tokens[i]);
      }
    });
    if (dead.length) await db.removePushTokens(dead);
  } catch (err) {
    console.warn("[push] expo send failed:", err);
  }
}

// One-line body preview for a message push.
export function preview(body: string, max = 140): string {
  const line = body.replace(/\s+/g, " ").trim();
  return line.length > max ? `${line.slice(0, max)}…` : line;
}
