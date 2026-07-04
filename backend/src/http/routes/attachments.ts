import { Router, raw } from "express";
import { randomBytes } from "node:crypto";
import { imageSize } from "image-size";
import * as db from "../../db";
import * as att from "../../attachments";
import { storage } from "../../storage";
import { wrap, ApiError } from "../errors";
import { requester } from "../guards";

const router = Router();

// Upload-first (Slack-style): POST raw bytes, get back an attachment id + signed URL; posting a
// message with attachmentIds links them. Auth: a signed-in human (requester) or an agent's runner
// (x-runner-token header). Bytes ride raw in the body with filename/mime in the query, so the
// global JSON body parser never touches an upload.
router.post(
  "/api/attachments",
  raw({ type: "*/*", limit: att.MAX_ATTACHMENT_BYTES + 1024 * 1024 }),
  wrap(async (req, res) => {
    let uploaderId = (await requester(req))?.id ?? null;
    if (!uploaderId) {
      const rt = String(req.headers["x-runner-token"] ?? "");
      if (rt) uploaderId = (await db.agentByRunnerToken(rt))?.id ?? null;
    }
    if (!uploaderId) throw new ApiError(401, "auth required");
    const data = req.body as Buffer;
    if (!Buffer.isBuffer(data) || data.length === 0) throw new ApiError(400, "empty upload");
    if (data.length > att.MAX_ATTACHMENT_BYTES) {
      throw new ApiError(413, `file exceeds the ${Math.floor(att.MAX_ATTACHMENT_BYTES / (1024 * 1024))}MB limit`);
    }
    const filename = att.sanitizeFilename(String(req.query.filename ?? "file"));
    const rawMime = String(req.query.mime ?? "");
    const mime = /^[\w.+-]+\/[\w.+-]+$/.test(rawMime) ? rawMime.toLowerCase() : "application/octet-stream";
    // Image dimensions are a layout hint only; failure to parse just leaves them null.
    let width: number | null = null;
    let height: number | null = null;
    if (att.isInlineImage(mime)) {
      try {
        const dim = imageSize(data);
        width = dim.width ?? null;
        height = dim.height ?? null;
      } catch {
        /* not decodable — fine */
      }
    }
    const storageKey = `attachments/${randomBytes(16).toString("hex")}`;
    await storage.put(storageKey, data);
    const row = await db.createAttachment({
      uploaderId, filename, mime, sizeBytes: data.length, storageKey, width, height,
    });
    res.status(201).json({
      id: row.id,
      filename: row.filename,
      mime: row.mime,
      size_bytes: Number(row.size_bytes),
      width: row.width,
      height: row.height,
      url: att.signedPath(row.id),
    });
  }),
);

// Serve attachment bytes. Auth = a valid, unexpired signature (capability URL) — the only scheme
// that works for both <img> tags and runner downloads. Allowlisted images render inline;
// everything else is forced to download as a generic octet-stream so an uploaded .html/.svg can
// never execute on our origin (stored-XSS defense).
router.get(
  "/api/attachments/:id",
  wrap(async (req, res) => {
    const id = String(req.params.id);
    if (!att.verifySignature(id, String(req.query.e ?? ""), String(req.query.sig ?? ""))) {
      throw new ApiError(403, "invalid or expired link");
    }
    const row = await db.getAttachment(id);
    if (!row) throw new ApiError(404, "attachment not found");
    const inline = att.isInlineImage(row.mime);
    res.setHeader("content-type", inline ? row.mime : "application/octet-stream");
    res.setHeader("content-length", String(row.size_bytes));
    res.setHeader("content-disposition", `${inline ? "inline" : "attachment"}; filename="${row.filename}"`);
    res.setHeader("x-content-type-options", "nosniff");
    res.setHeader("cache-control", "private, max-age=3600");
    (await storage.stream(row.storage_key)).pipe(res);
  }),
);

export default router;
