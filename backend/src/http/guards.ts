import type express from "express";
import * as db from "../db";
import * as auth from "../auth";
import { ApiError } from "./errors";

// Strip server-only secrets before a participant row leaves the backend. runner_token
// authenticates an agent's runner socket — it must NEVER reach clients. memory/memory_updated_at
// aren't secret (GET /api/agents/:id/memory serves them) but the MEMORY.md mirror can be ~12KB
// per agent — too fat to ride along in every participant list, so they're stripped here too.
export function publicParticipant<T extends { runner_token?: unknown }>(
  p: T,
): Omit<T, "runner_token" | "memory" | "memory_updated_at"> {
  const { runner_token: _secret, memory: _mem, memory_updated_at: _memAt, ...pub } =
    p as T & { memory?: unknown; memory_updated_at?: unknown };
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
