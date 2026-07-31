-- Message deletion (soft delete).
--
-- Deleting a message does NOT remove the row. The messages table is load-bearing in ways a hard
-- DELETE would quietly corrupt:
--   * thread_root_id is ON DELETE CASCADE, so deleting a thread root would take everyone else's
--     replies with it;
--   * reply_count/last_reply_at are denormed on the root and only ever incremented (see
--     db/messages.ts persistMessage);
--   * channel_reads/thread_reads track progress by `seq`, and a hole in the stream is fine but a
--     row that still counts toward "unread" while being invisible is not.
-- So a deleted message keeps its row and its seq, gets deleted_at stamped, and is filtered out of
-- every read path (history, thread transcripts, search, activity, unread aggregates, and the
-- context fed to agents). The one exception: a deleted thread ROOT that still has live replies is
-- served as a tombstone, so the thread keeps its head.
--
-- The body is blanked here, not retained — "delete" should actually destroy the content. The
-- message's attachments, mentions and extracted deliverables are removed by the delete path in
-- db/messages.ts (blobs get swept by the attachment GC).

alter table messages add column if not exists deleted_at timestamptz;
alter table messages add column if not exists deleted_by uuid references participants(id) on delete set null;

-- The hot path (channel history, ordered by seq) only ever wants live rows.
create index if not exists messages_channel_seq_live_idx
  on messages (channel_id, seq) where deleted_at is null;
