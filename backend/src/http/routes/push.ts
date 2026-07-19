import { Router } from "express";
import * as db from "../../db";
import { wrap, ApiError } from "../errors";
import { reqString, optString } from "../validate";
import { requireRequester, accountUid } from "../guards";

// Expo push-token registration for the mobile app. Account-scoped (accountUid): a token belongs to
// the signed-in Google account and receives that account's notifications across all its
// workspaces. Distinct from devices.ts (the self-hosted-runner subsystem) — do not conflate.
const router = Router();

router.post(
  "/api/push/register",
  wrap(async (req, res) => {
    const me = await requireRequester(req);
    const token = reqString(req.body?.token, "token");
    if (!token.startsWith("ExponentPushToken") && !token.startsWith("ExpoPushToken")) {
      throw new ApiError(400, "not a valid Expo push token");
    }
    const platform = optString(req.body?.platform) ?? "ios";
    await db.upsertPushToken(accountUid(me), token, platform);
    res.json({ ok: true });
  }),
);

router.post(
  "/api/push/unregister",
  wrap(async (req, res) => {
    await requireRequester(req); // must be authed, but the token alone identifies the row
    const token = reqString(req.body?.token, "token");
    await db.deletePushToken(token);
    res.json({ ok: true });
  }),
);

export default router;
