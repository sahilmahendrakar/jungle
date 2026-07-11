import { pool } from "./pool";

// Mobile push tokens (FCM). Account-scoped: keyed by firebase_uid, so one phone receives
// pushes from every workspace the account belongs to.

export async function registerPushToken(token: string, firebaseUid: string, platform: string): Promise<void> {
  await pool.query(
    `insert into push_tokens (token, firebase_uid, platform)
     values ($1, $2, $3)
     on conflict (token) do update set firebase_uid = $2, platform = $3, last_seen_at = now()`,
    [token, firebaseUid, platform],
  );
}

export async function removePushToken(token: string): Promise<void> {
  await pool.query(`delete from push_tokens where token = $1`, [token]);
}

export async function pushTokensForUids(uids: string[]): Promise<{ token: string; firebase_uid: string }[]> {
  if (!uids.length) return [];
  const { rows } = await pool.query<{ token: string; firebase_uid: string }>(
    `select token, firebase_uid from push_tokens where firebase_uid = any($1)`,
    [uids],
  );
  return rows;
}

// Prune tokens FCM reported as dead (unregistered / invalid).
export async function removePushTokens(tokens: string[]): Promise<void> {
  if (!tokens.length) return;
  await pool.query(`delete from push_tokens where token = any($1)`, [tokens]);
}
