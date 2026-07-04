import type express from "express";
import * as db from "../db";
import * as auth from "../auth";
import { ApiError } from "./errors";

// Strip server-only secrets before a participant row leaves the backend. runner_token
// authenticates an agent's runner socket — it must NEVER reach clients.
export function publicParticipant<T extends { runner_token?: unknown }>(p: T): Omit<T, "runner_token"> {
  const { runner_token: _secret, ...pub } = p;
  return pub;
}

// Resolve the requester's participant: from a verified Firebase token, or (only under dev
// bypass) a ?participantId= / body participantId. Returns null when we can't identify one.
export async function requester(req: express.Request): Promise<db.Participant | null> {
  const u = auth.authedUser(req);
  if (u) return db.getParticipantByFirebaseUid(u.uid);
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
export async function requireChannelMember(
  req: express.Request,
): Promise<{ me: db.Participant; channel: { id: string; name: string; kind: string } }> {
  const me = await requireRequester(req);
  const channel = await db.getChannel(String(req.params.id));
  if (!channel) throw new ApiError(404, "channel not found");
  if (!(await db.isMember(channel.id, me.id))) {
    throw new ApiError(403, "not a member of this channel");
  }
  return { me, channel };
}

// Guard: the requester is signed in and :id names an agent. Returns the agent row. Collapses the
// requester-check + getParticipant + kind-check preamble that was repeated across agent routes.
export async function requireAgent(req: express.Request): Promise<db.Participant> {
  await requireRequester(req);
  const agent = await db.getParticipant(String(req.params.id));
  if (!agent || agent.kind !== "agent") throw new ApiError(404, "agent not found");
  return agent;
}
