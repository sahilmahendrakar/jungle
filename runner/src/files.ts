// Attachment transfer between the runner and the backend, over plain HTTP (Node 22 fetch).
// Downloads: enqueue items carry signed origin-relative URLs; we save the bytes into the
// workspace so the agent's tools can use them. Uploads: the send_message tool passes
// workspace file paths; we POST the bytes with the runner token and get attachment ids back.
import { promises as fs } from "node:fs";
import path from "node:path";
import { log } from "./log.js";
import type { EnqueueAttachment } from "./protocol.js";

export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;
export const MAX_FILES_PER_MESSAGE = 10;

// Backend HTTP origin derived from the runner's WS URL (ws://host/api/runner -> http://host).
export function httpBaseFromWsUrl(wsUrl: string): string {
  const u = new URL(wsUrl);
  u.protocol = u.protocol === "wss:" ? "https:" : "http:";
  return u.origin;
}

export interface SavedAttachment {
  filename: string;
  mime: string;
  localPath: string;
  ok: boolean;
  error?: string;
  bytes?: Buffer; // kept only for images small enough to inline as a content block
}

// Raw image bytes above this aren't inlined as content blocks (API limit is ~5MB post-base64);
// the agent still gets the saved file path either way.
const MAX_INLINE_IMAGE_BYTES = 3_500_000;
const IMAGE_MIMES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
export function isImageMime(mime: string): boolean {
  return IMAGE_MIMES.has(mime);
}
export function inlineableImage(a: SavedAttachment): boolean {
  return a.ok && isImageMime(a.mime) && !!a.bytes && a.bytes.length <= MAX_INLINE_IMAGE_BYTES;
}

// Download one inbox item's attachments into <workspace>/attachments/<inboxId-prefix>/.
// Failures never fail the turn — the agent is told what didn't arrive instead.
export async function downloadAttachments(
  httpBase: string,
  workspace: string,
  inboxId: string,
  attachments: EnqueueAttachment[],
): Promise<SavedAttachment[]> {
  const dir = path.join(workspace, "attachments", inboxId.slice(0, 8));
  const out: SavedAttachment[] = [];
  for (const a of attachments) {
    const safeName = path.basename(a.filename) || "file";
    const localPath = path.join(dir, safeName);
    try {
      const res = await fetch(`${httpBase}${a.url}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const bytes = Buffer.from(await res.arrayBuffer());
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(localPath, bytes);
      out.push({
        filename: safeName,
        mime: a.mime,
        localPath,
        ok: true,
        bytes: isImageMime(a.mime) && bytes.length <= MAX_INLINE_IMAGE_BYTES ? bytes : undefined,
      });
    } catch (err) {
      log.warn("attachment download failed", { filename: a.filename, err: String(err) });
      out.push({ filename: safeName, mime: a.mime, localPath, ok: false, error: String(err) });
    }
  }
  return out;
}

// Minimal extension->mime map for uploads (the backend treats anything unknown as a generic
// download, so this only affects whether an image renders inline in the chat).
const EXT_MIME: Record<string, string> = {
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif",
  webp: "image/webp", svg: "image/svg+xml", pdf: "application/pdf", txt: "text/plain",
  md: "text/markdown", json: "application/json", csv: "text/csv", html: "text/html",
  zip: "application/zip", mp4: "video/mp4", mp3: "audio/mpeg", log: "text/plain",
};
export function guessMime(filename: string): string {
  const ext = path.extname(filename).slice(1).toLowerCase();
  return EXT_MIME[ext] ?? "application/octet-stream";
}

export interface UploadedAttachment {
  id: string;
  filename: string;
}

// Upload one workspace file; returns the backend's attachment id. Throws on any problem —
// the tool handler reports the error text back to the agent.
export async function uploadFile(
  httpBase: string,
  runnerToken: string,
  workspace: string,
  filePath: string,
): Promise<UploadedAttachment> {
  const resolved = path.isAbsolute(filePath) ? filePath : path.join(workspace, filePath);
  const stat = await fs.stat(resolved);
  if (!stat.isFile()) throw new Error(`not a file: ${filePath}`);
  if (stat.size > MAX_UPLOAD_BYTES) {
    throw new Error(`${filePath} is ${Math.round(stat.size / 1024 / 1024)}MB — the limit is 25MB`);
  }
  const bytes = await fs.readFile(resolved);
  const filename = path.basename(resolved);
  const qs = new URLSearchParams({ filename, mime: guessMime(filename) });
  const res = await fetch(`${httpBase}/api/attachments?${qs}`, {
    method: "POST",
    headers: {
      "content-type": "application/octet-stream",
      "x-runner-token": runnerToken,
    },
    body: bytes,
  });
  const json = (await res.json().catch(() => ({}))) as { id?: string; error?: string };
  if (!res.ok || !json.id) throw new Error(json.error ?? `upload failed (HTTP ${res.status})`);
  return { id: json.id, filename };
}
