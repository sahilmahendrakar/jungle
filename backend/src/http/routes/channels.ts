import { Router } from "express";
import * as db from "../../db";
import * as att from "../../attachments";
import { fanOut } from "../../ws/appSocket";
import { wrap, ApiError } from "../errors";
import { requireChannelMember, requireRequester } from "../guards";

const router = Router();

// Find-or-create the 1:1 DM channel between the requester and another participant (dedupes,
// unlike POST /channels). The first party is always the authenticated requester.
router.post(
  "/api/dms",
  wrap(async (req, res) => {
    const me = await requireRequester(req);
    const { otherId } = req.body ?? {};
    if (!otherId) throw new ApiError(400, "otherId required");
    const id = await db.findOrCreateDm(me.id, String(otherId));
    res.status(201).json({ id, kind: "dm" });
  }),
);

router.post(
  "/api/channels",
  wrap(async (req, res) => {
    const me = await requireRequester(req);
    const { name, kind, memberHandles } = req.body ?? {};
    if (!name || !kind) throw new ApiError(400, "name, kind required");
    // The creator is always a member (even if their handle wasn't listed in the request).
    const handles = Array.isArray(memberHandles) ? memberHandles.map(String) : [];
    if (!handles.includes(me.handle)) handles.push(me.handle);
    res.status(201).json(await db.createChannel({ name, kind, memberHandles: handles }));
  }),
);

router.get(
  "/api/channels",
  wrap(async (req, res) => {
    const me = await requireRequester(req);
    res.json(await db.listChannels(me.id));
  }),
);

router.get(
  "/api/channels/:id/messages",
  wrap(async (req, res) => {
    const ctx = await requireChannelMember(req);
    const afterSeq = Number(req.query.afterSeq ?? 0);
    res.json((await db.getMessages(ctx.channel.id, afterSeq)).map(att.withUrls));
  }),
);

// Mark a channel read for the requester (Slack-style): advance their last_read_seq to the
// channel's max message seq, or a client-supplied `seq`. Requester + membership gated.
router.post(
  "/api/channels/:id/read",
  wrap(async (req, res) => {
    const ctx = await requireChannelMember(req);
    const rawSeq = req.body?.seq;
    const seq = rawSeq != null && Number.isFinite(Number(rawSeq)) ? Number(rawSeq) : undefined;
    const lastReadSeq = await db.markChannelRead(ctx.channel.id, ctx.me.id, seq);
    res.json({ ok: true, lastReadSeq });
  }),
);

router.get(
  "/api/channels/:id/members",
  wrap(async (req, res) => {
    const ctx = await requireChannelMember(req);
    res.json(await db.channelMembers(ctx.channel.id));
  }),
);

router.post(
  "/api/channels/:id/members",
  wrap(async (req, res) => {
    const ctx = await requireChannelMember(req);
    if (ctx.channel.kind === "dm") throw new ApiError(400, "cannot change members of a DM");
    const handle = String(req.body?.handle ?? "").trim().replace(/^@/, "");
    const target = await db.getParticipantByHandle(handle);
    if (!target) throw new ApiError(404, `no participant @${handle}`);
    await db.addChannelMember(ctx.channel.id, target.id);
    await fanOut(ctx.channel.id, { type: "members_changed", channelId: ctx.channel.id });
    res.status(201).json(target);
  }),
);

router.delete(
  "/api/channels/:id/members/:participantId",
  wrap(async (req, res) => {
    const ctx = await requireChannelMember(req);
    if (ctx.channel.kind === "dm") throw new ApiError(400, "cannot change members of a DM");
    // Notify (incl. the person being removed) before the row is gone, then remove.
    await fanOut(ctx.channel.id, { type: "members_changed", channelId: ctx.channel.id });
    await db.removeChannelMember(ctx.channel.id, String(req.params.participantId));
    res.json({ ok: true });
  }),
);

router.delete(
  "/api/channels/:id",
  wrap(async (req, res) => {
    const ctx = await requireChannelMember(req);
    if (ctx.channel.kind === "dm") throw new ApiError(400, "DMs cannot be deleted");
    // Fan out to members before deleting (afterwards there are no members to resolve).
    await fanOut(ctx.channel.id, { type: "channel_deleted", channelId: ctx.channel.id });
    await db.deleteChannel(ctx.channel.id);
    res.json({ ok: true });
  }),
);

export default router;
