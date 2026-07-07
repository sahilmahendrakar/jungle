-- Link an agent's message to the runner turn that produced it (the runner's currentTurnId at
-- send_message time). Lets the UI offer "view the work behind this message" — jumping straight
-- to that turn in the agent's Activity transcript. Null for human messages and for agent
-- messages sent outside a tracked turn.
alter table messages add column if not exists turn_id text;
