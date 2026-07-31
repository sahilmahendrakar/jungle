import type pg from "pg";
import type { ParticipantBase, Kind, AgentServiceInfo, AgentSelfStatus } from "@jungle/shared";
import { pool } from "./pool";

// A participant row as stored: the public shape (in @jungle/shared) plus the server-only runner
// secret. Strip runner_token (see index.ts publicParticipant) before sending to any client.
export interface Participant extends ParticipantBase {
  runner_token: string | null; // per-agent runner secret — never reaches clients
  // Operator-supplied Claude subscription OAuth token (migrations/040). Present on the row because
  // participant reads are `select *`; stripped by publicParticipant so it never reaches clients.
  claude_oauth_token: string | null;
  // When the self-set status auto-clears (migrations/046), or null for "stands until changed".
  // Server-only: publicParticipant applies it and drops the column, so clients only ever see a
  // status that is still current.
  status_expires_at: string | null;
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
  lianaConductor?: boolean; // true = a persistent per-user Liana conductor (compact@40% + suspend)
  jungleDefault?: boolean; // true = the workspace's one @jungle default agent (services/jungleAgent.ts)
  createdBy?: string | null; // the human participant creating this agent (usage attribution)
}, client?: pg.PoolClient): Promise<Participant> {
  const { rows } = await (client ?? pool).query<Participant>(
    `insert into participants
       (kind, workspace_id, handle, display_name, role, repo, firebase_uid, email, avatar_url,
        model, mode, runtime, runner_token, runner_provider, persona, liana_conductor,
        jungle_default, created_by)
     values ($1, $2, $3, $4, coalesce($5, 'member'), $6, $7, $8, $9, $10, coalesce($11, 'default'),
             coalesce($12, 'sdk'), $13, coalesce($14, 'docker'), $15, coalesce($16, false),
             coalesce($17, false), $18)
     returning *`,
    [
      p.kind, p.workspaceId, p.handle, p.displayName, p.role ?? null, p.repo ?? null,
      p.firebaseUid ?? null, p.email ?? null, p.avatarUrl ?? null,
      p.model ?? null, p.mode ?? null, p.runtime ?? null, p.runnerToken ?? null,
      p.runnerProvider ?? null, p.persona ?? null, p.lianaConductor ?? null,
      p.jungleDefault ?? null, p.createdBy ?? null,
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

// True when a self-set status's auto-clear time has passed. The single definition of "expired",
// shared by the two places that need it: the client serializer (http/guards.ts publicParticipant)
// and the runner-facing view (selfStatusOf). Absent expiry = stands until changed.
export function selfStatusExpired(expiresAt: Date | string | null | undefined): boolean {
  return !!expiresAt && new Date(expiresAt).getTime() <= Date.now();
}

// A participant row's self-set status in wire form, or null when there is none (or it expired).
// This is what the runner is handed on `configure` so the agent can be shown what it last told
// everyone it was doing.
export function selfStatusOf(p: {
  status_text?: string | null;
  status_emoji?: string | null;
  status_updated_at?: string | Date | null;
  status_expires_at?: string | Date | null;
}): AgentSelfStatus | null {
  if (!p.status_text || selfStatusExpired(p.status_expires_at)) return null;
  return {
    text: p.status_text,
    emoji: p.status_emoji ?? null,
    updatedAt: new Date(p.status_updated_at ?? Date.now()).toISOString(),
  };
}

// Write an agent's self-set status (the set_status tool, or a human clearing it from the profile).
// `text: null` clears — and clears the emoji and both timestamps with it, so a cleared status can
// never leave a stray emoji or a misleading "set 3h ago" behind. Returns the updated row (null if
// the id isn't an agent) so callers can broadcast the participant without a re-read.
//
// status_updated_at is set from now() on EVERY write, including one that repeats the same text:
// re-asserting a status is the agent saying "still on it", and the age shown in the UI should
// reflect that.
export async function setAgentStatus(
  id: string,
  status: { text: string | null; emoji?: string | null; expiresAt?: Date | null },
): Promise<Participant | null> {
  const cleared = status.text === null;
  const { rows } = await pool.query<Participant>(
    `update participants
        set status_text       = $1,
            status_emoji      = $2,
            status_updated_at = case when $1::text is null then null else now() end,
            status_expires_at = $3
      where id = $4 and kind = 'agent'
      returning *`,
    [status.text, cleared ? null : (status.emoji ?? null), cleared ? null : (status.expiresAt ?? null), id],
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

// Persist the managed-services snapshot an agent's runner reported (`services` frame).
// Empty list -> null, so "never had services" and "all gone" look the same.
export async function updateAgentServices(
  id: string,
  services: AgentServiceInfo[],
): Promise<void> {
  await pool.query(
    `update participants set runner_services = $1, runner_services_updated_at = now()
      where id = $2 and kind = 'agent'`,
    [services.length ? JSON.stringify(services) : null, id],
  );
}

// The agent's stored services snapshot, for GET /api/agents/:id/services (on-demand like
// memory — kept out of participant list payloads).
export async function getAgentServices(
  id: string,
): Promise<{ services: AgentServiceInfo[]; updatedAt: string | null }> {
  const { rows } = await pool.query<{
    runner_services: AgentServiceInfo[] | null;
    runner_services_updated_at: string | null;
  }>(
    `select runner_services, runner_services_updated_at
       from participants where id = $1 and kind = 'agent'`,
    [id],
  );
  return {
    services: rows[0]?.runner_services ?? [],
    updatedAt: rows[0]?.runner_services_updated_at ?? null,
  };
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

// Handles nobody may claim, so the well-known @mentions always reach what people expect. "jungle"
// belongs to the workspace's default agent (services/jungleAgent.ts) — reserved even before that
// agent exists, since it's created a moment after the workspace's first human. Only new claims are
// checked: a participant who already holds a reserved handle keeps it.
const RESERVED_HANDLES = new Set(["jungle"]);

// Is a handle free within a workspace? (case-insensitive; handles are unique per workspace).
export async function handleAvailable(workspaceId: string, handle: string): Promise<boolean> {
  if (RESERVED_HANDLES.has(handle.trim().toLowerCase())) return false;
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

// Adopt a pre-accounts shadow participant into a signed-in account: stamp the Firebase uid
// (and freshen email/avatar) so their existing workflows and links carry over.
export async function claimParticipant(
  id: string,
  args: { firebaseUid: string; email?: string | null; avatarUrl?: string | null },
): Promise<Participant> {
  const { rows } = await pool.query<Participant>(
    `update participants set
       firebase_uid = $2,
       email = coalesce($3, email),
       avatar_url = coalesce($4, avatar_url)
     where id = $1
     returning *`,
    [id, args.firebaseUid, args.email ?? null, args.avatarUrl ?? null],
  );
  return rows[0];
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

// --- @jungle, the default agent (migrations/044) -------------------------------------------------
// Found by the marker column, never by handle: the handle is only a preference (it can be taken by
// someone else in an old workspace), while the marker is what makes an agent THE default one.

export async function getJungleAgent(workspaceId: string): Promise<Participant | null> {
  const { rows } = await pool.query<Participant>(
    `select * from participants where workspace_id = $1 and jungle_default limit 1`,
    [workspaceId],
  );
  return rows[0] ?? null;
}

// Every workspace, for the boot sweep (services/jungleAgent.ts). Returns workspaces that already
// have an agent too: ensureJungleAgent is a find-or-create that also heals integrations and member
// DMs, so the sweep is how an existing @jungle picks up anything it's missing.
//
// There is deliberately no exclusion here. Two earlier attempts to leave Liana's workspaces alone
// both skipped REAL ones instead: excluding workspaces with a liana_conductor missed that Liana
// reuses a user's existing Jungle workspace and puts its conductor inside it, and excluding
// workspaces with an active Liana Slack install missed that a Jungle workspace people work in every
// day can also have Liana's Slack app installed — that filter skipped the seed workspace itself.
// A workspace having anything to do with Liana says nothing about whether its members want to type
// @jungle. Every workspace gets one.
export async function listWorkspaceIdsForJungleAgent(): Promise<string[]> {
  const { rows } = await pool.query<{ id: string }>(`select id from workspaces`);
  return rows.map((r) => r.id);
}

// --- Claude subscription token (migrations/040) -------------------------------------------------
// Set/cleared by an allowlisted operator on their OWN human participant row (see
// backend/src/subscription.ts for the gate). Because a participant row is per (account, workspace),
// storing it here scopes the subscription to exactly the workspace it was set in.

export async function setClaudeOauthToken(participantId: string, token: string | null): Promise<void> {
  await pool.query(`update participants set claude_oauth_token = $2 where id = $1`, [participantId, token]);
}

// Whether THIS participant has a token stored (drives the settings UI's configured/not state).
// Returns the boolean only — the token itself never leaves the server.
export async function hasClaudeOauthToken(participantId: string): Promise<boolean> {
  const { rows } = await pool.query<{ present: boolean }>(
    `select claude_oauth_token is not null as present from participants where id = $1`,
    [participantId],
  );
  return rows[0]?.present ?? false;
}

// The subscription token that applies to an agent: the one stored by the operator who CREATED it
// (participants.created_by). Scoping to the creator rather than the workspace keeps a personal,
// per-seat credential from being spent by a workspace co-member's agents. Read by buildConfigure;
// null means bill turns to the org API key as usual.
export async function getClaudeOauthTokenForAgent(agentId: string): Promise<string | null> {
  const { rows } = await pool.query<{ claude_oauth_token: string }>(
    `select owner.claude_oauth_token
       from participants agent
       join participants owner on owner.id = agent.created_by
      where agent.id = $1 and owner.claude_oauth_token is not null`,
    [agentId],
  );
  return rows[0]?.claude_oauth_token ?? null;
}

// Agents created by this operator, for re-pushing `configure` after the token changes.
export async function listAgentIdsCreatedBy(ownerId: string): Promise<string[]> {
  const { rows } = await pool.query<{ id: string }>(
    `select id from participants where kind = 'agent' and created_by = $1`,
    [ownerId],
  );
  return rows.map((r) => r.id);
}

// The human whose Claude subscription backs this workspace's @jungle (services/jungleAgent.ts).
// The default agent has no natural creator, so it's adopted by a subscriber: that person's token
// pays for its turns (getClaudeOauthTokenForAgent walks created_by) and their connected accounts
// back its integrations (integrations/backing.ts rule 4). Admins first, then oldest, so the choice
// is stable across boots rather than flipping as people join.
export async function findSubscriptionOwner(workspaceId: string): Promise<Participant | null> {
  const { rows } = await pool.query<Participant>(
    `select * from participants
      where workspace_id = $1 and kind = 'human' and claude_oauth_token is not null
      order by (role = 'admin') desc, created_at
      limit 1`,
    [workspaceId],
  );
  return rows[0] ?? null;
}

// Re-point an agent at its owner (participants.created_by) — used to adopt an @jungle that was
// created before it had one, or whose owner cleared their subscription.
export async function setAgentCreatedBy(agentId: string, createdBy: string | null): Promise<void> {
  await pool.query(`update participants set created_by = $2 where id = $1 and kind = 'agent'`, [agentId, createdBy]);
}
