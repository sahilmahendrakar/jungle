import { Router } from "express";
import { HANDLE_RE } from "@jungle/shared";
import type { Me, Membership } from "@jungle/shared";
import * as db from "../../db";
import * as auth from "../../auth";
import { wrap, ApiError } from "../errors";
import { publicParticipant } from "../guards";

const router = Router();

// Derive a starter handle from the Google profile (email local-part or name).
function suggestHandle(u: auth.AuthUser): string {
  const base = (u.email?.split("@")[0] || u.name || "user")
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 30);
  return base.length >= 2 ? base : "user";
}

// Who am I? The signed-in Google account plus every workspace it belongs to. An account with no
// memberships gets an empty list (the client routes it to "create a workspace" / an invite link).
router.get(
  "/api/me",
  auth.requireAuth,
  wrap(async (req, res) => {
    const u = auth.authedUser(req)!;
    const participants = await db.listParticipantsByUid(u.uid);
    const memberships: Membership[] = [];
    for (const p of participants) {
      const ws = await db.getWorkspace(p.workspace_id);
      if (!ws) continue; // defensive: a membership should always have its workspace
      const gid = await db.getGithubIdentity(p.id);
      memberships.push({
        workspace: { id: ws.id, name: ws.name },
        participant: publicParticipant(p),
        github: gid ? { connected: true, login: gid.github_login } : { connected: false },
      });
    }
    const me: Me = {
      profile: { uid: u.uid, email: u.email, name: u.name, picture: u.picture },
      memberships,
      suggestedHandle: suggestHandle(u),
    };
    res.json(me);
  }),
);

// Is a handle valid + free within a workspace? Scope comes from ?workspaceId= or an invite token
// (?invite=<token>); with neither, falls back to the default workspace (legacy onboarding). Drives
// the handle field on create-workspace and join-workspace.
router.get(
  "/api/handle-available",
  wrap(async (req, res) => {
    const handle = String(req.query.handle ?? "").trim();
    if (!HANDLE_RE.test(handle)) return res.json({ available: false, valid: false });
    let workspaceId = String(req.query.workspaceId ?? "") || null;
    const inviteToken = String(req.query.invite ?? "");
    if (!workspaceId && inviteToken) {
      const invite = await db.getInviteByToken(inviteToken);
      workspaceId = invite?.workspace_id ?? null;
    }
    res.json({ available: await db.handleAvailable(workspaceId ?? db.DEFAULT_WORKSPACE_ID, handle), valid: true });
  }),
);

// Complete onboarding: create the human participant linked to this Firebase user. Idempotent.
router.post(
  "/api/onboarding",
  auth.requireAuth,
  wrap(async (req, res) => {
    const u = auth.authedUser(req)!;
    const existing = await db.getParticipantByFirebaseUid(u.uid);
    if (existing) return res.status(200).json(existing);
    const handle = String(req.body?.handle ?? "").trim();
    const displayName = String(req.body?.displayName ?? "").trim() || u.name || handle;
    if (!HANDLE_RE.test(handle)) {
      throw new ApiError(400, "handle must be 2–30 chars: lowercase letters, digits, - or _");
    }
    if (!(await db.handleAvailable(db.DEFAULT_WORKSPACE_ID, handle))) {
      throw new ApiError(409, "that handle is taken");
    }
    // Legacy onboarding lands humans in the default workspace (Phase 2 replaces this with the
    // workspace-create / invite-accept flows).
    const p = await db.createParticipant({
      kind: "human", workspaceId: db.DEFAULT_WORKSPACE_ID, handle, displayName,
      firebaseUid: u.uid, email: u.email, avatarUrl: u.picture,
    });
    res.status(201).json(p);
  }),
);

export default router;
