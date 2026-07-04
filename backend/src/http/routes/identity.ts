import { Router } from "express";
import { HANDLE_RE } from "@jungle/shared";
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

// Who am I? Returns the linked participant, or onboarding hints if this Google user is new.
router.get(
  "/api/me",
  auth.requireAuth,
  wrap(async (req, res) => {
    const u = auth.authedUser(req)!;
    const p = await db.getParticipantByFirebaseUid(u.uid);
    if (p) {
      const gid = await db.getGithubIdentity(p.id);
      return res.json({
        onboarded: true,
        participant: publicParticipant(p),
        github: gid ? { connected: true, login: gid.github_login } : { connected: false },
      });
    }
    let suggested = suggestHandle(u);
    if (!(await db.handleAvailable(db.DEFAULT_WORKSPACE_ID, suggested))) {
      suggested = `${suggested}-${Math.random().toString(36).slice(2, 5)}`;
    }
    res.json({ onboarded: false, profile: u, suggestedHandle: suggested });
  }),
);

// Is a handle valid + free? (drives the onboarding handle field)
router.get(
  "/api/handle-available",
  wrap(async (req, res) => {
    const handle = String(req.query.handle ?? "").trim();
    if (!HANDLE_RE.test(handle)) return res.json({ available: false, valid: false });
    res.json({ available: await db.handleAvailable(db.DEFAULT_WORKSPACE_ID, handle), valid: true });
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
