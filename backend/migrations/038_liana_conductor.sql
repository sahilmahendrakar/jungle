-- Mark an agent as a Liana "conductor" (the persistent per-user conversational agent). Lets the
-- runner subsystem treat these specially without a reverse liana_settings lookup on every sweep:
-- compact at a lower threshold (40%) and SUSPEND on idle (fast resume) instead of a cold stop.
alter table participants
  add column if not exists liana_conductor boolean not null default false;
