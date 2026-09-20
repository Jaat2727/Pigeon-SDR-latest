-- ===========================================================================
-- Migration: add 'llm_engine' to agent_runs.engine
--
-- Only needed if you ran 01-schema.sql before this value existed. A fresh
-- install from the current 01-schema.sql already includes it and does not
-- need this file. Safe to run more than once.
--
-- Paste this into the Supabase SQL Editor and press Run, the same way you
-- ran 01-schema.sql and 02-seed.sql.
-- ===========================================================================
alter table agent_runs
  drop constraint if exists agent_runs_engine_check;

alter table agent_runs
  add constraint agent_runs_engine_check
  check (engine in ('dronahq', 'llm_engine', 'local_engine', 'our_engine'));
