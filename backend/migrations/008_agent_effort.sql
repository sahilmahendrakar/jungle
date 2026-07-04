-- Per-agent reasoning effort (Agent SDK `effort` option): low|medium|high|xhigh.
-- Guides thinking depth + tool-call iteration count per turn; lower = fewer round-trips =
-- less context re-read = cheaper. Default 'medium' brings existing agents down from the CLI
-- default (high); bump repo/coding agents to high/xhigh in the profile. Runner passes it to
-- query(); models without effort support (Haiku 4.5) silently ignore it.
alter table participants add column if not exists effort text not null default 'medium';
