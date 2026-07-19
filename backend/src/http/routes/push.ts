import { Router } from "express";
import * as db from "../../db";
import * as auth from "../../auth";
import { wrap, ApiError } from "../errors";

const router = Router();

// Register (or refresh) a device's FCM token for the signed-in account. Account-scoped like
// devices: one phone gets pushes from every workspace the account belongs to.
router.post(
  "/api/push/register",
  auth.requireAuth,
  wrap(async (req, res) => {
    const u = auth.authedUser(req)!;
    const token = String(req.body?.token ?? "").trim();
    const platform = String(req.body?.platform ?? "ios");
    if (!token) throw new ApiError(400, "token required");
    await db.registerPushToken(token, u.uid, platform);
    res.json({ ok: true });
  }),
);

// Sign-out: stop pushing to this device.
router.delete(
  "/api/push/register",
  auth.requireAuth,
  wrap(async (req, res) => {
    const token = String(req.body?.token ?? "").trim();
    if (token) await db.removePushToken(token);
    res.json({ ok: true });
  }),
);

export default router;
