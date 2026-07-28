import { Router } from "express";
import * as db from "../../db";
import { wrap, ApiError } from "../errors";
import { requireRequester } from "../guards";

// API-token management (see db/apiTokens.ts): mint/list/revoke bearer tokens that act as a
// participant against the HTTP API and /mcp. Humans only — a token-authed caller (or an agent)
// must not be able to mint itself fresh credentials, or revocation would mean nothing.

const router = Router();

async function requireHuman(req: Parameters<typeof requireRequester>[0]): Promise<db.Participant> {
  const me = await requireRequester(req);
  if (me.kind !== "human") throw new ApiError(403, "only humans can manage API tokens");
  return me;
}

// Mint a token. Default: bound to the requester themselves (the caller acts as you). Pass
// `participantId` naming an AGENT in your workspace to mint an agent-bound token instead (e.g.
// for an external tool that should act as that agent). The plaintext is returned exactly once.
router.post(
  "/api/tokens",
  wrap(async (req, res) => {
    const me = await requireHuman(req);
    const name = String(req.body?.name ?? "").trim();
    if (!name) throw new ApiError(400, "name required");
    let participantId = me.id;
    if (req.body?.participantId && String(req.body.participantId) !== me.id) {
      const target = await db.getParticipant(String(req.body.participantId));
      if (!target || target.workspace_id !== me.workspace_id || target.kind !== "agent") {
        throw new ApiError(404, "participantId must name an agent in your workspace");
      }
      participantId = target.id;
    }
    const { row, token } = await db.createApiToken({ participantId, name, createdBy: me.id });
    res.status(201).json({ ...row, token });
  }),
);

router.get(
  "/api/tokens",
  wrap(async (req, res) => {
    const me = await requireHuman(req);
    res.json({ tokens: await db.listWorkspaceApiTokens(me.workspace_id) });
  }),
);

router.delete(
  "/api/tokens/:id",
  wrap(async (req, res) => {
    const me = await requireHuman(req);
    if (!(await db.deleteApiToken(String(req.params.id), me.workspace_id))) {
      throw new ApiError(404, "token not found");
    }
    res.json({ ok: true });
  }),
);

export default router;
