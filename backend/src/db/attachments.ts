import type { AttachmentMeta } from "@jungle/shared";
import { pool } from "./pool";

export interface AttachmentRow extends AttachmentMeta {
  uploader_id: string;
  message_id: string | null;
  storage_key: string;
  created_at: string;
}

// Record an upload (message_id starts null; persistMessage links it on post).
export async function createAttachment(a: {
  uploaderId: string;
  filename: string;
  mime: string;
  sizeBytes: number;
  storageKey: string;
  width?: number | null;
  height?: number | null;
}): Promise<AttachmentRow> {
  const { rows } = await pool.query<AttachmentRow>(
    `insert into attachments (uploader_id, filename, mime, size_bytes, storage_key, width, height)
     values ($1, $2, $3, $4, $5, $6, $7) returning *`,
    [a.uploaderId, a.filename, a.mime, a.sizeBytes, a.storageKey, a.width ?? null, a.height ?? null],
  );
  return rows[0];
}

export async function getAttachment(id: string): Promise<AttachmentRow | null> {
  const { rows } = await pool.query<AttachmentRow>(`select * from attachments where id = $1`, [id]);
  return rows[0] ?? null;
}

// Attachment metas for a set of messages, grouped by message id (avoids N+1 in getMessages).
export async function attachmentsForMessages(
  messageIds: string[],
): Promise<Map<string, AttachmentMeta[]>> {
  const out = new Map<string, AttachmentMeta[]>();
  if (!messageIds.length) return out;
  const { rows } = await pool.query(
    `select message_id, id, filename, mime, size_bytes, width, height
     from attachments where message_id = any($1::uuid[]) order by created_at`,
    [messageIds],
  );
  for (const r of rows) {
    const list = out.get(r.message_id) ?? [];
    list.push({
      id: r.id, filename: r.filename, mime: r.mime,
      size_bytes: Number(r.size_bytes), width: r.width, height: r.height,
    });
    out.set(r.message_id, list);
  }
  return out;
}

// Uploads never linked to a message within maxAgeHours (abandoned composer uploads) — GC set.
export async function orphanAttachments(
  maxAgeHours: number,
): Promise<{ id: string; storage_key: string }[]> {
  const { rows } = await pool.query(
    `select id, storage_key from attachments
     where message_id is null and created_at < now() - make_interval(hours => $1)`,
    [maxAgeHours],
  );
  return rows;
}

export async function deleteAttachmentRow(id: string): Promise<void> {
  await pool.query(`delete from attachments where id = $1`, [id]);
}

// Every storage key with a live row (the GC blob sweep keeps only these).
export async function knownStorageKeys(): Promise<Set<string>> {
  const { rows } = await pool.query<{ storage_key: string }>(`select storage_key from attachments`);
  return new Set(rows.map((r) => r.storage_key));
}
