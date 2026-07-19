import { pool } from "./pool";

// Expo push tokens, keyed by the token string and owned by a Firebase account (uid). See
// migrations/024_push_tokens.sql. Plain data access; the dispatcher lives in services/push.ts.

// Register (or refresh) a device's push token for an account. Re-registering the same token from
// a different account reassigns it (a shared phone that switched Google accounts).
export async function upsertPushToken(uid: string, token: string, platform: string): Promise<void> {
  await pool.query(
    `insert into push_tokens (token, firebase_uid, platform, last_seen_at)
     values ($1, $2, $3, now())
     on conflict (token) do update set firebase_uid = $2, platform = $3, last_seen_at = now()`,
    [token, uid, platform],
  );
}

export async function deletePushToken(token: string): Promise<void> {
  await pool.query(`delete from push_tokens where token = $1`, [token]);
}

// All tokens for a set of accounts (the human recipients of a push). Empty set → no query.
export async function listPushTokensByUids(uids: string[]): Promise<string[]> {
  if (uids.length === 0) return [];
  const { rows } = await pool.query<{ token: string }>(
    `select token from push_tokens where firebase_uid = any($1::text[])`,
    [uids],
  );
  return rows.map((r) => r.token);
}

// Prune tokens Expo reported as no longer registered (uninstalled app / revoked permission).
export async function deletePushTokens(tokens: string[]): Promise<void> {
  if (tokens.length === 0) return;
  await pool.query(`delete from push_tokens where token = any($1::text[])`, [tokens]);
}
