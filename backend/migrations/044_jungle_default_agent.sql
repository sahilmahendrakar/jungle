-- @jungle: the workspace's default agent — one per workspace, created automatically and not
-- deletable/renameable by members. Marked with a column rather than matched by handle so a rename
-- attempt (or a member who already owns the handle "jungle") can't produce a second one, mirroring
-- the liana_conductor marker from 038.
alter table participants
  add column if not exists jungle_default boolean not null default false;

-- At most one default agent per workspace. Partial index so the ordinary agents (all false) don't
-- collide with each other.
create unique index if not exists participants_ws_jungle_default_idx
  on participants (workspace_id) where jungle_default;
