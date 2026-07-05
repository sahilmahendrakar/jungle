import { pool } from "./pool";

// A participant's connected Google account (see migrations/013_google_identities.sql). Mirrors
// github.ts's GithubIdentity: one per participant, tokens renewed on demand from the refresh token.
export interface GoogleIdentity {
  participant_id: string;
  email: string;
  access_token: string;
  refresh_token: string | null;
  access_expires_at: string | null;
  scopes: string | null;
}

// Store (or replace) the Google account connected to a participant.
export async function upsertGoogleIdentity(i: {
  participantId: string;
  email: string;
  accessToken: string;
  refreshToken: string | null;
  accessExpiresAt: Date | null;
  scopes: string | null;
}): Promise<void> {
  await pool.query(
    `insert into google_identities
       (participant_id, email, access_token, refresh_token, access_expires_at, scopes, updated_at)
     values ($1,$2,$3,$4,$5,$6, now())
     on conflict (participant_id) do update set
       email = excluded.email,
       access_token = excluded.access_token,
       -- Google only returns a refresh_token on first consent; keep the stored one if this
       -- exchange didn't include a new one.
       refresh_token = coalesce(excluded.refresh_token, google_identities.refresh_token),
       access_expires_at = excluded.access_expires_at,
       scopes = excluded.scopes,
       updated_at = now()`,
    [i.participantId, i.email, i.accessToken, i.refreshToken, i.accessExpiresAt, i.scopes],
  );
}

export async function getGoogleIdentity(participantId: string): Promise<GoogleIdentity | null> {
  const { rows } = await pool.query<GoogleIdentity>(
    `select participant_id, email, access_token, refresh_token, access_expires_at, scopes
     from google_identities where participant_id = $1`,
    [participantId],
  );
  return rows[0] ?? null;
}

// Persist a refreshed access token (after a refresh_token grant).
export async function updateGoogleTokens(i: {
  participantId: string;
  accessToken: string;
  refreshToken: string | null;
  accessExpiresAt: Date | null;
}): Promise<void> {
  await pool.query(
    `update google_identities set
       access_token = $2,
       refresh_token = coalesce($3, refresh_token),
       access_expires_at = $4, updated_at = now()
     where participant_id = $1`,
    [i.participantId, i.accessToken, i.refreshToken, i.accessExpiresAt],
  );
}

export async function deleteGoogleIdentity(participantId: string): Promise<void> {
  await pool.query(`delete from google_identities where participant_id = $1`, [participantId]);
}
