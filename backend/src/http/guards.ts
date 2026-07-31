import type express from "express";
import * as db from "../db";
import * as auth from "../auth";
import { ApiError } from "./errors";

// Strip server-only secrets before a participant row leaves the backend. runner_token
// authenticates an agent's runner socket — it must NEVER reach clients. claude_oauth_token is a
// long-lived Claude subscription credential (migrations/040) and likewise must never leave the
// server — not even to the operator who set it (the settings endpoint reports only whether one is
// configured). Participant reads are `select *`, so both would otherwise ride along in every
// participant list. memory/memory_updated_at aren't secret (GET /api/agents/:id/memory serves
// them) but the MEMORY.md mirror can be ~12KB per agent — too fat for every list, so they go too.
// status_expires_at is dropped too: it's a server-side bookkeeping detail, and expiry is applied
// HERE (see below) so no client ever has to reason about it.
export function publicParticipant<T extends { runner_token?: unknown }>(
  p: T,
): Omit<
  T,
  "runner_token" | "claude_oauth_token" | "memory" | "memory_updated_at" | "status_expires_at"
> {
  const {
    runner_token: _secret,
    claude_oauth_token: _sub,
    memory: _mem,
    memory_updated_at: _memAt,
    status_expires_at: expiresAt,
    ...pub
  } = p as T & {
    claude_oauth_token?: unknown;
    memory?: unknown;
    memory_updated_at?: unknown;
    status_expires_at?: Date | string | null;
  };
  // Self-set status expiry is enforced on the way out rather than by a background sweeper: the
  // row can sit expired in the table indefinitely and still never be shown. This is the ONE place
  // it's applied, which is why every participant payload — HTTP list, profile, WS broadcast —
  // must go through this function. The overlay is spread rather than assigned because `pub`'s
  // property types are generic in T, so TS won't narrow them to accept a plain null.
  if (db.selfStatusExpired(expiresAt)) {
    return { ...pub, status_text: null, status_emoji: null, status_updated_at: null } as typeof pub;
  }
  return pub;
}

// The stable account identity behind a participant, used to scope self-hosted devices (which
// belong to an ACCOUNT, not a workspace — one person's device is usable across all their
// workspaces). Real auth: the Firebase uid. Dev bypass (no Firebase uid): a per-participant
// sentinel so devices stay isolated to the dev participant that registered them. Every device
// path — approve, list, assign — must derive ownership through this one helper so they agree.
export function accountUid(p: db.Participant): string {
  return p.firebase_uid ?? `dev:${p.id}`;
}

// Resolve the requester's participant within the active workspace: from a verified Firebase token
// scoped by the X-Workspace-Id header, or (only under dev bypass) a ?participantId= / body
// participantId (which already names a specific workspace's participant). Returns null when we
// can't identify one.
//
// Rollout fallback: a token without X-Workspace-Id resolves to the account's first membership, so
// clients that predate the header keep working while there's effectively one workspace per user.
// Phase 4 makes the header mandatory.
export async function requester(req: express.Request): Promise<db.Participant | null> {
  // API tokens ("jgl_…", db/apiTokens.ts) resolve straight to their bound participant — the token
  // acts AS that participant, whose row already fixes the workspace, so X-Workspace-Id is ignored.
  const raw = auth.bearer(req);
  if (raw && raw.startsWith(db.API_TOKEN_PREFIX)) {
    return db.getParticipantByApiToken(raw);
  }
  const u = auth.authedUser(req);
  if (u) {
    const wsId = req.header("x-workspace-id");
    if (wsId) return db.getParticipantByUidAndWorkspace(u.uid, wsId);
    return (await db.listParticipantsByUid(u.uid))[0] ?? null;
  }
  if (auth.DEV_BYPASS) {
    const pid = (req.query.participantId as string) || (req.body?.participantId as string);
    if (pid) return db.getParticipant(pid);
  }
  return null;
}

// Like requester, but throws 401 when no participant can be identified.
export async function requireRequester(req: express.Request): Promise<db.Participant> {
  const me = await requester(req);
  if (!me) throw new ApiError(401, "auth required");
  return me;
}

// Guard: the requester must be a member of the channel named by :id. Returns { me, channel }.
// Defence in depth: the channel must also be in the requester's workspace (membership already
// implies this, but the explicit check keeps a cross-workspace id from ever slipping through).
export async function requireChannelMember(
  req: express.Request,
): Promise<{
  me: db.Participant;
  channel: { id: string; name: string; kind: string; workspace_id: string };
}> {
  const me = await requireRequester(req);
  const channel = await db.getChannel(String(req.params.id));
  if (!channel || channel.workspace_id !== me.workspace_id) throw new ApiError(404, "channel not found");
  if (!(await db.isMember(channel.id, me.id))) {
    throw new ApiError(403, "not a member of this channel");
  }
  return { me, channel };
}

// Guard: the requester is signed in and :id names an agent IN THE REQUESTER'S WORKSPACE. Returns
// { me, agent }. Collapses the requester-check + getParticipant + kind/workspace-check preamble
// that was repeated across agent routes.
export async function requireAgent(
  req: express.Request,
): Promise<{ me: db.Participant; agent: db.Participant }> {
  const me = await requireRequester(req);
  const agent = await db.getParticipant(String(req.params.id));
  if (!agent || agent.kind !== "agent" || agent.workspace_id !== me.workspace_id) {
    throw new ApiError(404, "agent not found");
  }
  return { me, agent };
}
