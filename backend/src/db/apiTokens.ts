import { createHash, randomBytes } from "node:crypto";
import { pool } from "./pool";
import type { Participant } from "./participants";

// Participant-scoped API tokens (see migrations/039_api_tokens.sql): a bearer token that acts AS
// its participant against the HTTP API and the /mcp server. Only the sha256 of the plaintext is
// stored; mint returns the plaintext exactly once. This module is plain data access — who may
// mint/list/revoke lives in http/routes/tokens.ts, and resolution into a requester lives in
// http/guards.ts.

export const API_TOKEN_PREFIX = "jgl_";

export interface ApiTokenRow {
  id: string;
  participant_id: string;
  name: string;
  created_by: string | null;
  created_at: string;
  last_used_at: string | null;
}

const ROW_COLUMNS = "id, participant_id, name, created_by, created_at, last_used_at";

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

// Mint a token for a participant. Returns the row plus the plaintext — the only time it exists.
export async function createApiToken(args: {
  participantId: string;
  name: string;
  createdBy?: string | null;
}): Promise<{ row: ApiTokenRow; token: string }> {
  const token = API_TOKEN_PREFIX + randomBytes(24).toString("hex");
  const { rows } = await pool.query<ApiTokenRow>(
    `insert into api_tokens (participant_id, name, token_hash, created_by)
     values ($1, $2, $3, $4)
     returning ${ROW_COLUMNS}`,
    [args.participantId, args.name, hashToken(token), args.createdBy ?? null],
  );
  return { row: rows[0], token };
}

// Resolve a plaintext bearer token to its participant (or null). Touches last_used_at
// fire-and-forget — it's informational, not worth a round-trip on the request path.
export async function getParticipantByApiToken(token: string): Promise<Participant | null> {
  if (!token.startsWith(API_TOKEN_PREFIX)) return null;
  const { rows } = await pool.query<Participant & { token_id: string }>(
    `select p.*, t.id as token_id
       from api_tokens t
       join participants p on p.id = t.participant_id
      where t.token_hash = $1`,
    [hashToken(token)],
  );
  const row = rows[0];
  if (!row) return null;
  void pool
    .query(`update api_tokens set last_used_at = now() where id = $1`, [row.token_id])
    .catch(() => {});
  const { token_id: _tid, ...participant } = row;
  return participant as Participant;
}

// Every token bound to a participant of this workspace (the settings list). Never the hash.
export async function listWorkspaceApiTokens(
  workspaceId: string,
): Promise<Array<ApiTokenRow & { participant_handle: string; participant_kind: string }>> {
  const { rows } = await pool.query<ApiTokenRow & { participant_handle: string; participant_kind: string }>(
    `select ${ROW_COLUMNS.split(", ").map((c) => "t." + c).join(", ")},
            p.handle as participant_handle, p.kind as participant_kind
       from api_tokens t
       join participants p on p.id = t.participant_id
      where p.workspace_id = $1
      order by t.created_at desc`,
    [workspaceId],
  );
  return rows;
}

// Revoke (delete) one token, scoped to a workspace so nobody can revoke across tenants.
export async function deleteApiToken(id: string, workspaceId: string): Promise<boolean> {
  const { rowCount } = await pool.query(
    `delete from api_tokens t
      using participants p
      where t.id = $1 and p.id = t.participant_id and p.workspace_id = $2`,
    [id, workspaceId],
  );
  return (rowCount ?? 0) > 0;
}

// Delete every token of a given name on a participant — the jungle integration adapter rotates
// its agent-bound token by name (delete + recreate) on each configure, and drops it on detach.
export async function deleteApiTokensByName(participantId: string, name: string): Promise<void> {
  await pool.query(`delete from api_tokens where participant_id = $1 and name = $2`, [
    participantId,
    name,
  ]);
}
