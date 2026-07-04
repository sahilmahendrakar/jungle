import { randomBytes } from "node:crypto";
import type { Workspace } from "@jungle/shared";
import { pool } from "./pool";
import { withTransaction } from "./tx";
import type { Participant } from "./participants";

// Per-workspace agent cap when the workspace has no explicit override (workspaces.max_agents).
const DEFAULT_MAX_AGENTS = Number(process.env.MAX_AGENTS_PER_WORKSPACE ?? 10);

export interface WorkspaceRow extends Workspace {
  max_agents: number | null;
}

export async function getWorkspace(id: string): Promise<WorkspaceRow | null> {
  const { rows } = await pool.query<WorkspaceRow>(
    `select id, name, max_agents from workspaces where id = $1`,
    [id],
  );
  return rows[0] ?? null;
}

// Create a workspace and its first participant (the creator, an admin) atomically. The handle is
// trivially free (brand-new workspace), so no availability check is needed here.
export async function createWorkspaceWithCreator(args: {
  name: string;
  handle: string;
  displayName: string;
  firebaseUid?: string | null;
  email?: string | null;
  avatarUrl?: string | null;
}): Promise<{ workspace: WorkspaceRow; participant: Participant }> {
  return withTransaction(async (client) => {
    const { rows: wsRows } = await client.query<WorkspaceRow>(
      `insert into workspaces (name) values ($1) returning id, name, max_agents`,
      [args.name],
    );
    const workspace = wsRows[0];
    const { rows: pRows } = await client.query<Participant>(
      `insert into participants (kind, workspace_id, handle, display_name, role, firebase_uid, email, avatar_url)
       values ('human', $1, $2, $3, 'admin', $4, $5, $6)
       returning *`,
      [workspace.id, args.handle, args.displayName, args.firebaseUid ?? null, args.email ?? null, args.avatarUrl ?? null],
    );
    return { workspace, participant: pRows[0] };
  });
}

// The number of agents in a workspace and the effective cap (explicit override, else env default).
// Uses SELECT ... FOR UPDATE on the workspace row so a concurrent create can't race past the cap.
export async function agentCountAndCap(
  client: import("pg").PoolClient,
  workspaceId: string,
): Promise<{ count: number; cap: number }> {
  const { rows: wsRows } = await client.query<{ max_agents: number | null }>(
    `select max_agents from workspaces where id = $1 for update`,
    [workspaceId],
  );
  const cap = wsRows[0]?.max_agents ?? DEFAULT_MAX_AGENTS;
  const { rows: cRows } = await client.query<{ n: string }>(
    `select count(*)::text as n from participants where workspace_id = $1 and kind = 'agent'`,
    [workspaceId],
  );
  return { count: Number(cRows[0]?.n ?? 0), cap };
}

// --- Invites ---

export interface InviteRow {
  id: string;
  workspace_id: string;
  token: string;
  created_by: string | null;
  created_at: string;
  expires_at: string | null;
  revoked_at: string | null;
}

export async function createInvite(args: {
  workspaceId: string;
  createdBy: string;
  expiresAt?: Date | null;
}): Promise<InviteRow> {
  const token = randomBytes(32).toString("hex");
  const { rows } = await pool.query<InviteRow>(
    `insert into workspace_invites (workspace_id, token, created_by, expires_at)
     values ($1, $2, $3, $4) returning *`,
    [args.workspaceId, token, args.createdBy, args.expiresAt ?? null],
  );
  return rows[0];
}

// An invite by token, joined with its workspace name. Null if the token is unknown.
export async function getInviteByToken(
  token: string,
): Promise<(InviteRow & { workspace_name: string }) | null> {
  const { rows } = await pool.query<InviteRow & { workspace_name: string }>(
    `select i.*, w.name as workspace_name
     from workspace_invites i join workspaces w on w.id = i.workspace_id
     where i.token = $1`,
    [token],
  );
  return rows[0] ?? null;
}

// Whether an invite row is currently usable (not revoked, not expired).
export function inviteIsLive(invite: InviteRow): boolean {
  if (invite.revoked_at) return false;
  if (invite.expires_at && new Date(invite.expires_at).getTime() <= Date.now()) return false;
  return true;
}

// Active (non-revoked) invites for a workspace, newest first, for the invite-management UI.
export async function listInvites(workspaceId: string): Promise<InviteRow[]> {
  const { rows } = await pool.query<InviteRow>(
    `select * from workspace_invites
     where workspace_id = $1 and revoked_at is null
     order by created_at desc`,
    [workspaceId],
  );
  return rows;
}

// Revoke an invite by token within a workspace (admin action). Returns true if one was revoked.
export async function revokeInvite(workspaceId: string, token: string): Promise<boolean> {
  const { rowCount } = await pool.query(
    `update workspace_invites set revoked_at = now()
     where workspace_id = $1 and token = $2 and revoked_at is null`,
    [workspaceId, token],
  );
  return (rowCount ?? 0) > 0;
}
