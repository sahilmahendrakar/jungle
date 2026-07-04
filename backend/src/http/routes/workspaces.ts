import { Router } from "express";
import { HANDLE_RE } from "@jungle/shared";
import type { InviteInfo } from "@jungle/shared";
import * as db from "../../db";
import * as auth from "../../auth";
import { wrap, ApiError } from "../errors";
import { publicParticipant, requireRequester } from "../guards";

const router = Router();

function validName(name: unknown): string {
  const n = String(name ?? "").trim();
  if (n.length < 2 || n.length > 60) throw new ApiError(400, "workspace name must be 2–60 characters");
  return n;
}
function validHandle(handle: unknown): string {
  const h = String(handle ?? "").trim();
  if (!HANDLE_RE.test(h)) {
    throw new ApiError(400, "handle must be 2–30 chars: lowercase letters, digits, - or _");
  }
  return h;
}

// The requester must be an admin of the workspace named by :id (their active workspace, per
// X-Workspace-Id / dev participantId, must be :id and their role must be admin). Returns the
// admin participant.
async function requireWorkspaceAdmin(req: import("express").Request, workspaceId: string): Promise<db.Participant> {
  const me = await requireRequester(req);
  if (me.workspace_id !== workspaceId) throw new ApiError(403, "not a member of this workspace");
  if (me.role !== "admin") throw new ApiError(403, "admin only");
  return me;
}

// Create a workspace and its first participant (an admin). Replaces onboarding for new users: a
// signed-in Google account with no workspace lands here. The handle is unique within the new
// (empty) workspace, so no availability check is needed.
router.post(
  "/api/workspaces",
  auth.requireAuth,
  wrap(async (req, res) => {
    const u = auth.authedUser(req)!;
    const name = validName(req.body?.name);
    const handle = validHandle(req.body?.handle);
    const displayName = String(req.body?.displayName ?? "").trim() || u.name || handle;
    const { workspace, participant } = await db.createWorkspaceWithCreator({
      name, handle, displayName, firebaseUid: u.uid, email: u.email, avatarUrl: u.picture,
    });
    res.status(201).json({ workspace, participant: publicParticipant(participant) });
  }),
);

// --- Invites ---

// Create a shareable invite link for a workspace (admin only). Optional expiry in days.
router.post(
  "/api/workspaces/:id/invites",
  wrap(async (req, res) => {
    const workspaceId = String(req.params.id);
    const me = await requireWorkspaceAdmin(req, workspaceId);
    const days = Number(req.body?.expiresInDays);
    const expiresAt = Number.isFinite(days) && days > 0 ? new Date(Date.now() + days * 86400_000) : null;
    const invite = await db.createInvite({ workspaceId, createdBy: me.id, expiresAt });
    res.status(201).json({ token: invite.token, expires_at: invite.expires_at, created_at: invite.created_at });
  }),
);

// List a workspace's active invites (admin only).
router.get(
  "/api/workspaces/:id/invites",
  wrap(async (req, res) => {
    const workspaceId = String(req.params.id);
    await requireWorkspaceAdmin(req, workspaceId);
    const invites = await db.listInvites(workspaceId);
    res.json(
      invites.map((i) => ({ token: i.token, expires_at: i.expires_at, created_at: i.created_at })),
    );
  }),
);

// Revoke an invite by token (admin of the invite's workspace).
router.post(
  "/api/invites/:token/revoke",
  wrap(async (req, res) => {
    const token = String(req.params.token);
    const invite = await db.getInviteByToken(token);
    if (!invite) throw new ApiError(404, "invite not found");
    await requireWorkspaceAdmin(req, invite.workspace_id);
    await db.revokeInvite(invite.workspace_id, token);
    res.json({ ok: true });
  }),
);

// Public preview of an invite (drives the /join page). Reveals only the workspace name + validity;
// if the caller is signed in, whether they're already a member.
router.get(
  "/api/invites/:token",
  wrap(async (req, res) => {
    const invite = await db.getInviteByToken(String(req.params.token));
    if (!invite || !db.inviteIsLive(invite)) {
      return res.json({ valid: false } satisfies InviteInfo);
    }
    let alreadyMember = false;
    const u = auth.authedUser(req);
    if (u) {
      alreadyMember = !!(await db.getParticipantByUidAndWorkspace(u.uid, invite.workspace_id));
    }
    res.json({ valid: true, workspaceName: invite.workspace_name, alreadyMember } satisfies InviteInfo);
  }),
);

// Accept an invite: create the signed-in account's participant in the workspace (idempotent — if
// already a member, return the existing participant). Requires a live invite + a free handle.
router.post(
  "/api/invites/:token/accept",
  auth.requireAuth,
  wrap(async (req, res) => {
    const u = auth.authedUser(req)!;
    const invite = await db.getInviteByToken(String(req.params.token));
    if (!invite || !db.inviteIsLive(invite)) throw new ApiError(404, "invite is invalid or expired");
    const existing = await db.getParticipantByUidAndWorkspace(u.uid, invite.workspace_id);
    if (existing) return res.status(200).json(publicParticipant(existing));
    const handle = validHandle(req.body?.handle);
    const displayName = String(req.body?.displayName ?? "").trim() || u.name || handle;
    if (!(await db.handleAvailable(invite.workspace_id, handle))) {
      throw new ApiError(409, "that handle is taken in this workspace");
    }
    const participant = await db.createParticipant({
      kind: "human", workspaceId: invite.workspace_id, handle, displayName,
      firebaseUid: u.uid, email: u.email, avatarUrl: u.picture,
    });
    res.status(201).json(publicParticipant(participant));
  }),
);

// Dev/test only: create a workspace + a human participant in it, returning both ids. Lets the
// tenancy test spin up isolated workspaces without Firebase. 404 in production.
router.post(
  "/api/_dev/workspaces",
  wrap(async (req, res) => {
    if (!auth.DEV_BYPASS) return res.status(404).end();
    const name = validName(req.body?.name);
    const handle = validHandle(req.body?.handle ?? "owner");
    const displayName = String(req.body?.displayName ?? "").trim() || handle;
    const { workspace, participant } = await db.createWorkspaceWithCreator({ name, handle, displayName });
    res.status(201).json({ workspace, participant: publicParticipant(participant) });
  }),
);

export default router;
