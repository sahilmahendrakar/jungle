import type { ParticipantBase, Kind } from "@jungle/shared";
import { pool } from "./pool";

// A participant row as stored: the public shape (in @jungle/shared) plus the server-only runner
// secret. Strip runner_token (see index.ts publicParticipant) before sending to any client.
export interface Participant extends ParticipantBase {
  runner_token: string | null; // per-agent runner secret — never reaches clients
}

export async function createParticipant(p: {
  kind: Kind;
  handle: string;
  displayName: string;
  repo?: string | null;
  firebaseUid?: string | null;
  email?: string | null;
  avatarUrl?: string | null;
  model?: string | null;
  mode?: string | null;
  runtime?: string | null;
  runnerToken?: string | null;
  runnerProvider?: string | null;
}): Promise<Participant> {
  const { rows } = await pool.query<Participant>(
    `insert into participants
       (kind, handle, display_name, repo, firebase_uid, email, avatar_url,
        model, mode, runtime, runner_token, runner_provider)
     values ($1, $2, $3, $4, $5, $6, $7, $8, coalesce($9, 'default'),
             coalesce($10, 'sdk'), $11, coalesce($12, 'docker'))
     returning *`,
    [
      p.kind, p.handle, p.displayName, p.repo ?? null,
      p.firebaseUid ?? null, p.email ?? null, p.avatarUrl ?? null,
      p.model ?? null, p.mode ?? null, p.runtime ?? null, p.runnerToken ?? null,
      p.runnerProvider ?? null,
    ],
  );
  return rows[0];
}

// Patch an agent's editable config (display name / permission mode). Agents only; returns the
// updated row (null if the id isn't an agent). No-op patches just return the current row.
export async function updateAgentConfig(
  id: string,
  patch: { displayName?: string; mode?: string; model?: string; effort?: string },
): Promise<Participant | null> {
  const sets: string[] = [];
  const vals: unknown[] = [];
  if (patch.displayName !== undefined) {
    vals.push(patch.displayName);
    sets.push(`display_name = $${vals.length}`);
  }
  if (patch.mode !== undefined) {
    vals.push(patch.mode);
    sets.push(`mode = $${vals.length}`);
  }
  if (patch.model !== undefined) {
    vals.push(patch.model);
    sets.push(`model = $${vals.length}`);
  }
  if (patch.effort !== undefined) {
    vals.push(patch.effort);
    sets.push(`effort = $${vals.length}`);
  }
  if (!sets.length) {
    const p = await getParticipant(id);
    return p && p.kind === "agent" ? p : null;
  }
  vals.push(id);
  const { rows } = await pool.query<Participant>(
    `update participants set ${sets.join(", ")} where id = $${vals.length} and kind = 'agent' returning *`,
    vals,
  );
  return rows[0] ?? null;
}

// Record the context-window occupancy an agent's runner reported after a turn.
export async function updateAgentContextUsage(
  id: string,
  tokens: number,
  maxTokens: number,
): Promise<void> {
  await pool.query(
    `update participants
        set context_tokens = $1, context_max_tokens = $2, context_updated_at = now()
      where id = $3 and kind = 'agent'`,
    [tokens, maxTokens, id],
  );
}

// Look up the human participant linked to a Firebase Auth uid (null if not onboarded yet).
export async function getParticipantByFirebaseUid(uid: string): Promise<Participant | null> {
  const { rows } = await pool.query<Participant>(
    `select * from participants where firebase_uid = $1`,
    [uid],
  );
  return rows[0] ?? null;
}

// Is a handle free? (case-insensitive; handles are unique). Used to validate onboarding.
export async function handleAvailable(handle: string): Promise<boolean> {
  const { rows } = await pool.query(`select 1 from participants where lower(handle) = lower($1)`, [handle]);
  return rows.length === 0;
}

// Resolve the @handles mentioned in a message body to participant ids.
export async function resolveMentions(body: string): Promise<{ id: string; handle: string }[]> {
  // Handles may contain hyphens (e.g. "sahils-agent"), so include "-" in the mention charset.
  const handles = [...new Set([...body.matchAll(/@([a-zA-Z0-9_-]+)/g)].map((m) => m[1]))];
  if (!handles.length) return [];
  const { rows } = await pool.query<{ id: string; handle: string }>(
    `select id, handle from participants where handle = any($1)`,
    [handles],
  );
  return rows;
}

// All participants, for the dev sign-in screen (newest last).
export async function listParticipants(): Promise<Participant[]> {
  const { rows } = await pool.query<Participant>(
    `select * from participants order by created_at`,
  );
  return rows;
}

export async function getParticipant(id: string): Promise<Participant | null> {
  const { rows } = await pool.query<Participant>(`select * from participants where id = $1`, [id]);
  return rows[0] ?? null;
}

export async function getParticipantByHandle(handle: string): Promise<Participant | null> {
  const { rows } = await pool.query<Participant>(`select * from participants where handle = $1`, [handle]);
  return rows[0] ?? null;
}
