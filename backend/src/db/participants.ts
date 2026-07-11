import type pg from "pg";
import type { ParticipantBase, Kind } from "@jungle/shared";
import { pool } from "./pool";

// A participant row as stored: the public shape (in @jungle/shared) plus the server-only runner
// secret. Strip runner_token (see index.ts publicParticipant) before sending to any client.
export interface Participant extends ParticipantBase {
  runner_token: string | null; // per-agent runner secret — never reaches clients
}

// The default workspace (migrations/009_workspaces.sql) — holds all pre-multi-tenancy rows and is
// where dev-bypass participants and the current onboarding flow land. Kept in sync with schema.sql.
export const DEFAULT_WORKSPACE_ID = "00000000-0000-0000-0000-000000000001";

export async function createParticipant(p: {
  kind: Kind;
  workspaceId: string;
  handle: string;
  displayName: string;
  role?: string | null; // 'admin' | 'member' (default 'member')
  repo?: string | null;
  firebaseUid?: string | null;
  email?: string | null;
  avatarUrl?: string | null;
  model?: string | null;
  mode?: string | null;
  runtime?: string | null;
  runnerToken?: string | null;
  runnerProvider?: string | null;
  persona?: string | null; // creator-written role/personality, injected into the system prompt
}, client?: pg.PoolClient): Promise<Participant> {
  const { rows } = await (client ?? pool).query<Participant>(
    `insert into participants
       (kind, workspace_id, handle, display_name, role, repo, firebase_uid, email, avatar_url,
        model, mode, runtime, runner_token, runner_provider, persona)
     values ($1, $2, $3, $4, coalesce($5, 'member'), $6, $7, $8, $9, $10, coalesce($11, 'default'),
             coalesce($12, 'sdk'), $13, coalesce($14, 'docker'), $15)
     returning *`,
    [
      p.kind, p.workspaceId, p.handle, p.displayName, p.role ?? null, p.repo ?? null,
      p.firebaseUid ?? null, p.email ?? null, p.avatarUrl ?? null,
      p.model ?? null, p.mode ?? null, p.runtime ?? null, p.runnerToken ?? null,
      p.runnerProvider ?? null, p.persona ?? null,
    ],
  );
  return rows[0];
}

// Patch an agent's editable config (display name / permission mode). Agents only; returns the
// updated row (null if the id isn't an agent). No-op patches just return the current row.
export async function updateAgentConfig(
  id: string,
  patch: { displayName?: string; mode?: string; model?: string; effort?: string; persona?: string | null },
): Promise<Participant | null> {
  const sets: string[] = [];
  const vals: unknown[] = [];
  if (patch.displayName !== undefined) {
    vals.push(patch.displayName);
    sets.push(`display_name = $${vals.length}`);
  }
  if (patch.persona !== undefined) {
    vals.push(patch.persona); // null clears the persona
    sets.push(`persona = $${vals.length}`);
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

// Persist the MEMORY.md mirror an agent's runner reported (`memory` frame). Empty content means
// the file is absent/empty — store null so "no memory yet" and "cleared" look the same.
export async function updateAgentMemory(id: string, content: string): Promise<void> {
  await pool.query(
    `update participants set memory = $1, memory_updated_at = now()
      where id = $2 and kind = 'agent'`,
    [content || null, id],
  );
}

// The agent's stored MEMORY.md mirror, for GET /api/agents/:id/memory (stripped from participant
// list payloads by publicParticipant).
export async function getAgentMemory(
  id: string,
): Promise<{ memory: string | null; memory_updated_at: string | null } | null> {
  const { rows } = await pool.query<{ memory: string | null; memory_updated_at: string | null }>(
    `select memory, memory_updated_at from participants where id = $1 and kind = 'agent'`,
    [id],
  );
  return rows[0] ?? null;
}

// Every workspace membership for a Firebase Auth uid (one participant row per workspace joined),
// oldest first. A Google account maps to at most one participant per workspace.
export async function listParticipantsByUid(uid: string): Promise<Participant[]> {
  const { rows } = await pool.query<Participant>(
    `select * from participants where firebase_uid = $1 order by created_at`,
    [uid],
  );
  return rows;
}

// The participant a Firebase uid maps to within a specific workspace (null if not a member).
export async function getParticipantByUidAndWorkspace(
  uid: string,
  workspaceId: string,
): Promise<Participant | null> {
  const { rows } = await pool.query<Participant>(
    `select * from participants where firebase_uid = $1 and workspace_id = $2`,
    [uid, workspaceId],
  );
  return rows[0] ?? null;
}

// Back-compat single-membership lookup: the first workspace a uid belongs to. Used by GitHub
// routes (GitHub is per-participant) and as the pre-multi-workspace fallback. With one workspace
// this is exactly the row it always returned.
export async function getParticipantByFirebaseUid(uid: string): Promise<Participant | null> {
  return (await listParticipantsByUid(uid))[0] ?? null;
}

// Is a handle free within a workspace? (case-insensitive; handles are unique per workspace).
export async function handleAvailable(workspaceId: string, handle: string): Promise<boolean> {
  const { rows } = await pool.query(
    `select 1 from participants where workspace_id = $1 and lower(handle) = lower($2)`,
    [workspaceId, handle],
  );
  return rows.length === 0;
}

// Resolve the @handles mentioned in a message body to participant ids — scoped to the channel's
// workspace, so a mention can never reach (or summon) a participant in another workspace.
export async function resolveMentions(
  channelId: string,
  body: string,
): Promise<{ id: string; handle: string }[]> {
  // Handles may contain hyphens (e.g. "sahils-agent"), so include "-" in the mention charset.
  const handles = [...new Set([...body.matchAll(/@([a-zA-Z0-9_-]+)/g)].map((m) => m[1]))];
  if (!handles.length) return [];
  const { rows } = await pool.query<{ id: string; handle: string }>(
    `select id, handle from participants
     where handle = any($1)
       and workspace_id = (select workspace_id from channels where id = $2)`,
    [handles, channelId],
  );
  return rows;
}

// All participants in a workspace (People list + dev sign-in screen), newest last.
export async function listParticipants(workspaceId: string): Promise<Participant[]> {
  const { rows } = await pool.query<Participant>(
    `select * from participants where workspace_id = $1 order by created_at`,
    [workspaceId],
  );
  return rows;
}

export async function getParticipant(id: string): Promise<Participant | null> {
  const { rows } = await pool.query<Participant>(`select * from participants where id = $1`, [id]);
  return rows[0] ?? null;
}

// A human in a workspace matching an email (case-insensitive). Used by the Slack bridge to
// attribute a Slack user's messages to their real Jungle account instead of a shadow. Agents
// don't have meaningful emails, so restrict to humans. Prefer a real (signed-in) account over a
// prior shadow if an email somehow collides — real accounts have a firebase_uid.
export async function getParticipantByEmail(
  workspaceId: string,
  email: string,
): Promise<Participant | null> {
  const { rows } = await pool.query<Participant>(
    `select * from participants
     where workspace_id = $1 and kind = 'human' and lower(email) = lower($2)
     order by (firebase_uid is null), created_at
     limit 1`,
    [workspaceId, email],
  );
  return rows[0] ?? null;
}

export async function getParticipantByHandle(
  workspaceId: string,
  handle: string,
): Promise<Participant | null> {
  const { rows } = await pool.query<Participant>(
    `select * from participants where workspace_id = $1 and handle = $2`,
    [workspaceId, handle],
  );
  return rows[0] ?? null;
}
