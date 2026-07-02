import "./env";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import * as db from "./db";
import { storage } from "./storage";

// Attachment policy + signed-URL plumbing. Uploads and downloads are handled by routes in
// index.ts; this module owns the rules (size cap, what renders inline) and the HMAC
// capability URLs that let <img> tags and runners fetch bytes without an auth header.

export const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;
export const MAX_ATTACHMENTS_PER_MESSAGE = 10;

// Mimes served inline (rendered by <img> in the chat). Everything else downloads as an
// octet-stream attachment — never executed/rendered by the browser — so a malicious upload
// (e.g. an .html or .svg full of script) can't become stored XSS on our origin.
const INLINE_IMAGE_MIMES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
export function isInlineImage(mime: string): boolean {
  return INLINE_IMAGE_MIMES.has(mime);
}

// Keep just a safe basename: strip any path, control chars and quotes, cap the length.
export function sanitizeFilename(raw: string): string {
  const base = raw.replace(/\\/g, "/").split("/").pop() ?? "file";
  const clean = [...base]
    .filter((ch) => {
      const c = ch.charCodeAt(0);
      return c >= 32 && c !== 127 && ch !== '"';
    })
    .join("")
    .trim();
  return (clean || "file").slice(0, 200);
}

// --- Signed capability URLs ---
// path = /api/attachments/<id>?e=<unix-expiry>&sig=<hmac(id.e)>. The signature IS the auth:
// browsers can't attach headers to <img> requests, and runners get URLs inside `enqueue`.
// Paths are origin-relative; each client prefixes its own backend origin.

const SECRET =
  process.env.ATTACHMENT_URL_SECRET ??
  (() => {
    console.warn("ATTACHMENT_URL_SECRET not set — using a per-boot secret (URLs die on restart)");
    return randomBytes(32).toString("hex");
  })();

export const URL_TTL_SECONDS = 6 * 60 * 60; // plenty for an open tab / a long agent turn

function sig(id: string, expiry: number): string {
  return createHmac("sha256", SECRET).update(`${id}.${expiry}`).digest("hex");
}

export function signedPath(id: string, ttlSeconds = URL_TTL_SECONDS): string {
  const e = Math.floor(Date.now() / 1000) + ttlSeconds;
  return `/api/attachments/${id}?e=${e}&sig=${sig(id, e)}`;
}

export function verifySignature(id: string, e: string, s: string): boolean {
  const expiry = Number(e);
  if (!Number.isFinite(expiry) || expiry < Date.now() / 1000) return false;
  const expected = Buffer.from(sig(id, expiry));
  const given = Buffer.from(s);
  return expected.length === given.length && timingSafeEqual(expected, given);
}

// Add a fresh signed url to each attachment on a message before it leaves the backend
// (REST history + WS fan-out both go through this).
export function withUrls(msg: db.PersistedMessage): db.PersistedMessage & {
  attachments: (db.AttachmentMeta & { url: string })[];
} {
  return {
    ...msg,
    attachments: (msg.attachments ?? []).map((a) => ({ ...a, url: signedPath(a.id) })),
  };
}

// --- GC ---
// Two sweeps: (1) rows uploaded but never linked to a message within 24h (abandoned
// composer uploads) — delete blob + row; (2) blobs on disk with no row at all (rows removed
// by FK cascades when a message/channel/agent was deleted) — delete the blob.

const ORPHAN_MAX_AGE_HOURS = 24;

export async function gcOrphans(): Promise<void> {
  const orphans = await db.orphanAttachments(ORPHAN_MAX_AGE_HOURS);
  for (const o of orphans) {
    await storage.delete(o.storage_key);
    await db.deleteAttachmentRow(o.id);
  }
  const keys = await storage.listKeys("attachments");
  const live = await db.knownStorageKeys();
  for (const key of keys) {
    if (!live.has(key)) await storage.delete(key);
  }
  if (orphans.length) console.log(`attachment gc: removed ${orphans.length} orphaned uploads`);
}
