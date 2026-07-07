-- Full-text search over message bodies (GET /api/search). The expression index matches the
-- to_tsvector('english', body) predicate in db/messages.ts searchMessages exactly — keep them
-- in sync or the planner falls back to a seq scan.
create index if not exists messages_body_fts_idx
  on messages using gin (to_tsvector('english', body));
