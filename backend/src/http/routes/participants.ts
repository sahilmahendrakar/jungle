import { Router } from "express";
import * as db from "../../db";
import * as runners from "../../runners";
import { wrap, ApiError } from "../errors";
import { publicParticipant } from "../guards";

const router = Router();

router.get(
  "/api/participants",
  wrap(async (_req, res) => {
    res.json(
      (await db.listParticipants()).map((p) => ({
        ...publicParticipant(p),
        ...(p.kind === "agent" ? { status: runners.agentStatus(p.id) } : {}),
      })),
    );
  }),
);

router.post(
  "/api/participants",
  wrap(async (req, res) => {
    const { kind, handle, displayName } = req.body ?? {};
    if (!kind || !handle || !displayName) {
      throw new ApiError(400, "kind, handle, displayName required");
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
