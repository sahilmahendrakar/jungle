import { Router } from "express";
import { HANDLE_RE } from "@jungle/shared";
import * as db from "../../db";
import * as auth from "../../auth";
import * as runners from "../../runners";
import { wrap, ApiError } from "../errors";
import { publicParticipant, requireRequester } from "../guards";

const router = Router();

router.get(
  "/api/participants",
  wrap(async (req, res) => {
    await requireRequester(req);
    res.json(
      (await db.listParticipants()).map((p) => ({
        ...publicParticipant(p),
        ...(p.kind === "agent" ? { status: runners.agentStatus(p.id) } : {}),
      })),
    );
  }),
);

// Dev-only participant creation (the dev sign-in screen). In production humans are created via
// onboarding/workspace flows; agents via POST /api/agents. 404 when not under dev bypass.
router.post(
  "/api/participants",
  wrap(async (req, res) => {
    if (!auth.DEV_BYPASS) throw new ApiError(404, "not found");
    const { kind, handle, displayName } = req.body ?? {};
    if (!kind || !handle || !displayName) {
      throw new ApiError(400, "kind, handle, displayName required");
    }
    if (!HANDLE_RE.test(String(handle))) {
      throw new ApiError(400, "handle must be 2–30 chars: lowercase letters, digits, - or _");
    }
    res.status(201).json(await db.createParticipant({ kind, handle, displayName }));
  }),
);

// Connection status for a participant (used by the UI to show connected/not).
router.get(
  "/api/participants/:id/github",
  wrap(async (req, res) => {
    const id = await db.getGithubIdentity(String(req.params.id));
    res.json(id ? { connected: true, login: id.github_login } : { connected: false });
  }),
);

export default router;
