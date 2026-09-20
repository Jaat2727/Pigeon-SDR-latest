-- ===========================================================================
-- 04 · runtime
--
-- Run this in the Supabase SQL editor after 01-schema.sql. It is safe to run
-- more than once: every statement checks first, so re-running it changes
-- nothing rather than failing halfway through.
--
-- What it adds, and why each one exists:
--
--   job_runs            A campaign run is four agent calls per prospect, which
--                       is minutes of work. It used to happen inside the HTTP
--                       request that asked for it, so the browser timed out
--                       while the server carried on invisibly. A run is now a
--                       row you can watch, cancel, and read afterwards.
--
--   prospect locks      The background worker and a manual run can reach the
--                       same prospect in the same second. Without a claim in
--                       the database they both advance it, it takes two steps
--                       at once, and the timeline stops explaining itself.
--
--   run attribution     Which provider, model and key produced each agent run.
--                       Turns "everything failed" into "Groq key #3 was rate
--                       limited and Gemini answered instead".
--
--   discovery sources   `prospects.source` only allowed four values, none of
--                       which described a person found by Apollo or suggested
--                       by a model.
-- ===========================================================================


-- ---------------------------------------------------------------------------
-- 1 · job_runs — one row per long-running action
-- ---------------------------------------------------------------------------
create table if not exists job_runs (
  id                   uuid primary key default gen_random_uuid(),
  campaign_id          uuid references campaigns(id) on delete cascade,

  type                 text not null check (type in (
                         'campaign_run',     -- advance every prospect that has a step waiting
                         'discovery',        -- find new people and add them
                         'prospect_advance'  -- take one prospect as far as it will go
                       )),

  status               text not null default 'queued' check (status in (
                         'queued', 'running', 'succeeded', 'failed', 'cancelled'
                       )),

  -- What was asked for, kept so a finished run can be read months later
  -- without guessing which limit or filters produced it.
  params               jsonb not null default '{}'::jsonb,

  total                integer not null default 0,
  processed            integer not null default 0,
  succeeded            integer not null default 0,
  failed               integer not null default 0,
  current_label        text,

  -- A bounded log, newest last. The server trims it; the cap is here in a
  -- comment rather than a constraint because a hard limit would fail a write
  -- mid-run, and losing the run to protect the log is the wrong trade.
  events               jsonb not null default '[]'::jsonb,

  result               jsonb,
  error                text,

  -- Which API process owns this job. A job whose owner is not the process
  -- reading it, and which is still 'running', was abandoned by a restart and
  -- is closed out at the next boot.
  owner_instance       uuid,
  created_by           text,
  cancel_requested_by  text,

  started_at           timestamptz,
  finished_at          timestamptz,
  duration_ms          integer,

  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);

drop trigger if exists job_runs_updated_at on job_runs;
create trigger job_runs_updated_at before update on job_runs
  for each row execute function set_updated_at();

create index if not exists job_runs_campaign_idx on job_runs (campaign_id, created_at desc);
create index if not exists job_runs_created_idx on job_runs (created_at desc);

-- The question the UI asks most often: is anything running right now? Partial,
-- so the index stays small as finished runs pile up behind it.
create index if not exists job_runs_active_idx on job_runs (campaign_id)
  where status in ('queued', 'running');


-- ---------------------------------------------------------------------------
-- 2 · prospect locks
--
-- `locked_at` is not decoration. A process that dies mid-step leaves its lock
-- behind, and without a timestamp to age it out that prospect is stuck for
-- good with no way to release it from the UI.
-- ---------------------------------------------------------------------------
alter table campaign_prospects add column if not exists locked_by text;
alter table campaign_prospects add column if not exists locked_at timestamptz;

create index if not exists cp_locked_idx on campaign_prospects (locked_at)
  where locked_by is not null;


-- ---------------------------------------------------------------------------
-- 3 · run attribution
-- ---------------------------------------------------------------------------
alter table agent_runs add column if not exists llm_provider text;
alter table agent_runs add column if not exists llm_model    text;
-- The key's redacted label, never the key. `#2 gsk_ab…f3d9` is enough to tell
-- six keys apart and useless to anyone who sees a screenshot of this table.
alter table agent_runs add column if not exists llm_key      text;

create index if not exists agent_runs_provider_idx on agent_runs (llm_provider, created_at desc);


-- ---------------------------------------------------------------------------
-- 4 · discovery sources
--
-- `apollo` is a real record from a real contact database. `ai_suggested` is a
-- company the model proposed. They are not the same kind of thing and the
-- prospect page shows the difference, so they get different values rather than
-- both being flattened into 'ai_enriched'.
-- ---------------------------------------------------------------------------
do $$
begin
  alter table prospects drop constraint if exists prospects_source_check;
  alter table prospects add constraint prospects_source_check
    check (source in ('manual', 'csv', 'crm', 'ai_enriched', 'apollo', 'ai_suggested'));
end $$;


-- ---------------------------------------------------------------------------
-- 5 · a place to record where a discovered prospect came from
--
-- `discovery_meta` holds the search filters that found this person, or the
-- model's reason for proposing the company. Being able to answer "why is this
-- person in my campaign" six weeks later is worth one jsonb column.
-- ---------------------------------------------------------------------------
alter table prospects add column if not exists discovery_meta jsonb not null default '{}'::jsonb;


select 'Runtime migration applied: job_runs, prospect locks, run attribution, discovery sources.' as result;
