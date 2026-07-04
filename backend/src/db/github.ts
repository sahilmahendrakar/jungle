import { pool } from "./pool";

export interface GithubIdentity {
  participant_id: string;
  github_login: string;
  github_user_id: string; // bigint serialized as string
  access_token: string;
  refresh_token: string | null;
  access_expires_at: string | null;
  refresh_expires_at: string | null;
  scopes: string | null;
}

// Store (or replace) the GitHub account connected to a participant.
export async function upsertGithubIdentity(i: {
  participantId: string;
  githubLogin: string;
  githubUserId: number;
  accessToken: string;
  refreshToken: string | null;
  accessExpiresAt: Date | null;
  refreshExpiresAt: Date | null;
  scopes: string | null;
}): Promise<void> {
  await pool.query(
    `insert into github_identities
       (participant_id, github_login, github_user_id, access_token, refresh_token,
        access_expires_at, refresh_expires_at, scopes, updated_at)
     values ($1,$2,$3,$4,$5,$6,$7,$8, now())
     on conflict (participant_id) do update set
       github_login = excluded.github_login,
       github_user_id = excluded.github_user_id,
       access_token = excluded.access_token,
       refresh_token = excluded.refresh_token,
       access_expires_at = excluded.access_expires_at,
       refresh_expires_at = excluded.refresh_expires_at,
       scopes = excluded.scopes,
       updated_at = now()`,
    [
      i.participantId, i.githubLogin, i.githubUserId, i.accessToken, i.refreshToken,
      i.accessExpiresAt, i.refreshExpiresAt, i.scopes,
    ],
  );
}

export async function getGithubIdentity(participantId: string): Promise<GithubIdentity | null> {
  const { rows } = await pool.query<GithubIdentity>(
    `select participant_id, github_login, github_user_id::text as github_user_id,
            access_token, refresh_token, access_expires_at, refresh_expires_at, scopes
     from github_identities where participant_id = $1`,
    [participantId],
  );
  return rows[0] ?? null;
}

// Persist refreshed tokens (after a refresh_token grant).
export async function updateGithubTokens(i: {
  participantId: string;
  accessToken: string;
  refreshToken: string | null;
  accessExpiresAt: Date | null;
  refreshExpiresAt: Date | null;
}): Promise<void> {
  await pool.query(
    `update github_identities set
       access_token = $2, refresh_token = $3,
       access_expires_at = $4, refresh_expires_at = $5, updated_at = now()
     where participant_id = $1`,
    [i.participantId, i.accessToken, i.refreshToken, i.accessExpiresAt, i.refreshExpiresAt],
  );
}

export async function deleteGithubIdentity(participantId: string): Promise<void> {
  await pool.query(`delete from github_identities where participant_id = $1`, [participantId]);
}
