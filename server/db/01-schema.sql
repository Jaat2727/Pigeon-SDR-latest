-- ===========================================================================
-- Pigeon SDR · database schema
--
-- Built for an empty Supabase project. Run this once, top to bottom, in the
-- SQL Editor. It is safe to run again: every object is created only if it is
-- absent, so a partial run can be repeated without dropping anything.
--
-- Twelve tables. The shape of them carries three decisions worth naming,
-- because the rest of the system depends on them:
--
--   1. A prospect is a person, once. Everything that happens to that person
--      inside a campaign lives on `campaign_prospects`, never on `prospects`.
--      The same person can be qualified for one campaign and rejected by
--      another on the same day, and both are true at the same time.
--
--   2. `activities` and `agent_runs` are append-only. Nothing in the seed
--      writes to them. Every row in those tables was produced by something
--      the system actually did, which is why the counters on screen can be
--      counted from tables rather than stored and hoped over.
--
--   3. Everything a human has to look at lands in one table, `approvals`,
--      separated by `type`. One queue, one screen, one place to look.
-- ===========================================================================

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------------
-- Shared trigger: keeps updated_at honest without the API having to remember.
-- ---------------------------------------------------------------------------
create or replace function set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;


-- ===========================================================================
-- 1 · reps — the human the outreach is sent as
-- ===========================================================================
create table if not exists reps (
  id          uuid primary key default gen_random_uuid(),
  full_name   text not null,
  title       text,
  email       text,
  signature   text,
  timezone    text default 'UTC',
  created_at  timestamptz not null default now()
);


-- ===========================================================================
-- 2 · campaigns — who to target, what not to touch, how to speak
--
-- The policy fields are text on purpose. They are written by an operator in
-- the app and passed to the agents verbatim, so they have to hold sentences
-- rather than a structure someone has to learn.
-- ===========================================================================
create table if not exists campaigns (
  id                  uuid primary key default gen_random_uuid(),
  name                text not null,
  status              text not null default 'draft'
                        check (status in ('draft', 'live', 'paused', 'archived')),
  objective           text,

  -- targeting
  icp_criteria        text,
  exclusion_criteria  text,
  target_roles        jsonb not null default '[]'::jsonb,
  industry            text,
  company_size        text,
  sample_profiles     jsonb not null default '[]'::jsonb,

  -- execution policy
  enabled_channels    jsonb not null default '["email"]'::jsonb,
  outreach_policy     text,
  messaging_policy    text,
  research_focus      text,
  working_hours       jsonb not null default
                        '{"start":"09:00","end":"17:00","timezone":"UTC","days":[1,2,3,4,5]}'::jsonb,
  daily_send_limit    integer not null default 50 check (daily_send_limit >= 0),
  require_approval    boolean not null default true,

  rep_id              uuid references reps(id) on delete set null,

  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

drop trigger if exists campaigns_updated_at on campaigns;
create trigger campaigns_updated_at before update on campaigns
  for each row execute function set_updated_at();

create index if not exists campaigns_status_idx on campaigns (status);


-- ===========================================================================
-- 3 · prospects — the person, held once across every campaign
--
-- `enriched_data` holds the research agent's output as returned. Nothing in
-- the app reads a field out of it that the schema does not already name, so a
-- change to the research output cannot silently reshape the UI.
--
-- `field_provenance` records where each field came from: manual, csv, crm or
-- ai_enriched. The prospect page shows it, because a human-entered phone
-- number and a model-guessed one should not look the same on screen.
-- ===========================================================================
create table if not exists prospects (
  id                      uuid primary key default gen_random_uuid(),

  first_name              text,
  last_name               text,
  full_name               text,
  title                   text,
  email                   text,
  phone                   text,
  linkedin_url            text,

  company_name            text,
  company_domain          text,

  -- Firmographics that a CSV export or a CRM sync genuinely carries. They are
  -- columns rather than something the research agent has to go and find,
  -- because pretending you do not know a company's industry when the import
  -- told you is not honesty, it is throwing away the input. The research
  -- agent's job is the part a CRM does not have: funding, hiring, news.
  company_industry        text,
  company_employee_count  integer check (company_employee_count >= 0),
  company_hq              text,

  -- Whatever the import carried: a line from the CRM, a note a rep typed, a
  -- field a data provider filled in. Carried into research as a signal and
  -- attributed to the import, never presented as something an agent found.
  notes                   text,

  source                  text not null default 'manual'
                            check (source in ('manual', 'csv', 'crm', 'ai_enriched')),

  enriched_data           jsonb,
  enriched_at             timestamptz,
  enrichment_stale_after  timestamptz,
  research_confidence     text,
  fields_not_found        jsonb not null default '[]'::jsonb,
  field_provenance        jsonb not null default '{}'::jsonb,

  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now()
);

drop trigger if exists prospects_updated_at on prospects;
create trigger prospects_updated_at before update on prospects
  for each row execute function set_updated_at();

-- One person, one row. Case-insensitive, and only where an email exists, so
-- prospects imported without one are still allowed in.
create unique index if not exists prospects_email_key
  on prospects (lower(email)) where email is not null;

create index if not exists prospects_company_domain_idx on prospects (lower(company_domain));
create index if not exists prospects_created_at_idx on prospects (created_at desc);


-- ===========================================================================
-- 4 · campaign_prospects — the funnel, per campaign
--
-- This is the table that makes per-campaign isolation real. A prospect's
-- state, score, verdict and sequence all live here, keyed by campaign. There
-- is deliberately no `state` column on `prospects`.
-- ===========================================================================
create table if not exists campaign_prospects (
  id                  uuid primary key default gen_random_uuid(),
  campaign_id         uuid not null references campaigns(id) on delete cascade,
  prospect_id         uuid not null references prospects(id) on delete cascade,

  state               text not null default 'discovered' check (state in (
                        'discovered',      -- added, nothing done yet
                        'researched',      -- enrichment complete
                        'qualified',       -- ICP said qualify
                        'rejected',        -- ICP said reject
                        'needs_review',    -- ICP could not decide, a human must
                        'strategy_planned',-- sequence built, first touch scheduled
                        'contacted',       -- at least one touch sent
                        'engaged',          -- they replied
                        'meeting',          -- meeting booked
                        'opportunity',      -- converted
                        'stopped',          -- sequence finished, or do-not-contact
                        'suppressed',       -- matched the suppression list
                        'opted_out'         -- they asked us to stop
                      )),

  -- ICP outcome
  fit_score           integer check (fit_score between 0 and 100),
  icp_verdict         text check (icp_verdict in ('qualify', 'reject', 'needs_review')),
  icp_confidence      text check (icp_confidence in ('high', 'medium', 'low')),
  icp_result          jsonb,

  -- strategy outcome
  should_contact      boolean,
  no_contact_reason   text,
  priority            text check (priority in ('high', 'medium', 'low')),
  sequence            jsonb not null default '[]'::jsonb,
  current_step        integer not null default 0,

  -- scheduling
  next_action_at      timestamptz,
  last_contacted_at   timestamptz,
  replied_at          timestamptz,

  paused              boolean not null default false,
  stopped_reason      text,

  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),

  unique (campaign_id, prospect_id)
);

drop trigger if exists campaign_prospects_updated_at on campaign_prospects;
create trigger campaign_prospects_updated_at before update on campaign_prospects
  for each row execute function set_updated_at();

create index if not exists cp_campaign_state_idx on campaign_prospects (campaign_id, state);
create index if not exists cp_prospect_idx on campaign_prospects (prospect_id);
-- The worker's only question: what is due? Partial, so it stays small.
create index if not exists cp_due_idx on campaign_prospects (next_action_at)
  where next_action_at is not null and paused = false;


-- ===========================================================================
-- 5 · agent_runs — one row per agent call, whatever the outcome
--
-- `engine` is the column that keeps the product honest. Every number the app
-- shows about agent performance is counted from here, and the UI badges each
-- result with the engine that produced it, so a fallback never passes itself
-- off as a model call.
-- ===========================================================================
create table if not exists agent_runs (
  id                  uuid primary key default gen_random_uuid(),
  campaign_id         uuid references campaigns(id) on delete set null,
  prospect_id         uuid references prospects(id) on delete set null,

  agent_name          text not null,
  engine              text not null check (engine in ('dronahq', 'llm_engine', 'local_engine', 'our_engine')),
  status              text not null check (status in ('success', 'degraded', 'failed')),

  input               jsonb,
  output              jsonb,
  raw_response        jsonb,

  error               text,
  error_code          text,

  retrieved_chunk_ids jsonb not null default '[]'::jsonb,

  tokens              integer not null default 0,
  cost_usd            numeric(12, 6) not null default 0,
  latency_ms          integer,

  created_at          timestamptz not null default now()
);

create index if not exists agent_runs_agent_idx on agent_runs (agent_name, created_at desc);
create index if not exists agent_runs_prospect_idx on agent_runs (prospect_id, created_at desc);
create index if not exists agent_runs_campaign_idx on agent_runs (campaign_id, created_at desc);
create index if not exists agent_runs_created_idx on agent_runs (created_at desc);


-- ===========================================================================
-- 6 · messages — everything sent and everything received
--
-- Outbound and inbound share a table because the prospect page reads them as
-- one thread, in order. The classification columns are only ever filled on
-- inbound rows, by the conversation agent.
-- ===========================================================================
create table if not exists messages (
  id                    uuid primary key default gen_random_uuid(),
  campaign_id           uuid references campaigns(id) on delete cascade,
  prospect_id           uuid not null references prospects(id) on delete cascade,

  direction             text not null check (direction in ('outbound', 'inbound')),
  channel               text not null check (channel in ('email', 'linkedin', 'sms', 'voice')),
  step                  integer,

  subject               text,
  body                  text not null,

  status                text not null default 'draft' check (status in (
                          'draft', 'pending_approval', 'approved',
                          'scheduled', 'sent', 'failed', 'received'
                        )),
  scheduled_at          timestamptz,
  sent_at               timestamptz,

  agent_run_id          uuid references agent_runs(id) on delete set null,
  personalisation_used  jsonb not null default '[]'::jsonb,
  knowledge_used        jsonb not null default '[]'::jsonb,

  -- inbound classification, written by the conversation agent
  intent                text,
  intent_confidence     numeric(4, 3),
  sentiment             text check (sentiment in ('positive', 'neutral', 'negative')),
  extracted_facts       jsonb not null default '[]'::jsonb,
  questions_asked       jsonb not null default '[]'::jsonb,
  objections_raised     jsonb not null default '[]'::jsonb,
  referral              jsonb,
  is_auto_reply         boolean not null default false,

  created_at            timestamptz not null default now()
);

create index if not exists messages_prospect_idx on messages (prospect_id, created_at);
create index if not exists messages_campaign_idx on messages (campaign_id, created_at desc);
create index if not exists messages_status_idx on messages (status) where status in ('pending_approval', 'scheduled');


-- ===========================================================================
-- 7 · activities — the append-only record of what happened
--
-- The feed on the Queue screen and the timeline on a prospect page are both
-- this table, filtered. Nothing updates a row here and nothing deletes one.
-- ===========================================================================
create table if not exists activities (
  id            uuid primary key default gen_random_uuid(),
  campaign_id   uuid references campaigns(id) on delete cascade,
  prospect_id   uuid references prospects(id) on delete cascade,
  agent_run_id  uuid references agent_runs(id) on delete set null,

  agent_name    text,
  engine        text,

  action        text not null,
  detail        text,
  status        text not null default 'success'
                  check (status in ('success', 'degraded', 'failed', 'escalated', 'blocked')),

  metadata      jsonb not null default '{}'::jsonb,
  created_at    timestamptz not null default now()
);

create index if not exists activities_created_idx on activities (created_at desc);
create index if not exists activities_prospect_idx on activities (prospect_id, created_at desc);
create index if not exists activities_campaign_idx on activities (campaign_id, created_at desc);


-- ===========================================================================
-- 8 · approvals — the single human queue
--
-- Four different situations, one table, because to the person working the
-- queue they are the same job: look at it, decide, move on.
--
--   icp_review         the scoring agent could not decide
--   message_approval   a drafted message is waiting to go out
--   reply_escalation   an inbound reply needs a person
--   duplicate_conflict the same prospect is live in two campaigns
-- ===========================================================================
create table if not exists approvals (
  id                    uuid primary key default gen_random_uuid(),
  campaign_id           uuid references campaigns(id) on delete cascade,
  prospect_id           uuid references prospects(id) on delete cascade,
  campaign_prospect_id  uuid references campaign_prospects(id) on delete cascade,
  message_id            uuid references messages(id) on delete cascade,

  type                  text not null check (type in (
                          'icp_review', 'message_approval',
                          'reply_escalation', 'duplicate_conflict'
                        )),
  source_agent          text,
  reason                text,
  proposed_action       text,
  payload               jsonb,

  status                text not null default 'open'
                          check (status in ('open', 'approved', 'rejected', 'resolved')),
  resolved_by           text,
  resolved_at           timestamptz,
  resolution_note       text,

  created_at            timestamptz not null default now()
);

create index if not exists approvals_open_idx on approvals (status, created_at desc);
create index if not exists approvals_prospect_idx on approvals (prospect_id);
-- One open approval of a given type per prospect per campaign. Stops the same
-- escalation being raised on every pass of the worker.
create unique index if not exists approvals_unique_open_idx
  on approvals (campaign_id, prospect_id, type) where status = 'open';


-- ===========================================================================
-- 9 · knowledge_chunks — what personalisation is allowed to claim
--
-- A null campaign_id means the chunk is global and available to every
-- campaign. Retrieval is lexical over this table.
-- ===========================================================================
create table if not exists knowledge_chunks (
  id          uuid primary key default gen_random_uuid(),
  campaign_id uuid references campaigns(id) on delete cascade,
  type        text not null default 'note',
  title       text,
  content     text not null,
  created_at  timestamptz not null default now()
);

create index if not exists knowledge_campaign_idx on knowledge_chunks (campaign_id);


-- ===========================================================================
-- 10 · suppression_list — do not contact, enforced in SQL
--
-- A model is never asked to remember who is off limits. The gate queries this
-- table before any outbound action, and a match stops the action.
-- ===========================================================================
create table if not exists suppression_list (
  id          uuid primary key default gen_random_uuid(),
  email       text,
  domain      text,
  phone       text,
  reason      text,
  scope       text not null default 'global' check (scope in ('global', 'campaign')),
  campaign_id uuid references campaigns(id) on delete cascade,
  created_at  timestamptz not null default now(),

  -- A row that matches nothing would silently suppress nobody.
  constraint suppression_has_a_target check (
    email is not null or domain is not null or phone is not null
  )
);

create index if not exists suppression_email_idx on suppression_list (lower(email));
create index if not exists suppression_domain_idx on suppression_list (lower(domain));


-- ===========================================================================
-- 11 · prompt_versions — the operator's words, versioned
--
-- The active row for a campaign and agent is sent to that agent on every call
-- as _system_prompt and _agent_prompt. Editing a prompt in the app writes a
-- new version rather than overwriting, so a change that makes things worse
-- can be pointed at afterwards.
-- ===========================================================================
create table if not exists prompt_versions (
  id          uuid primary key default gen_random_uuid(),
  campaign_id uuid references campaigns(id) on delete cascade,
  agent_name  text not null,
  version     integer not null default 1,
  is_active   boolean not null default false,
  author      text,
  content     text not null,
  created_at  timestamptz not null default now(),

  unique (campaign_id, agent_name, version)
);

create index if not exists prompt_active_idx on prompt_versions (campaign_id, agent_name)
  where is_active = true;


-- ===========================================================================
-- 12 · system_control — the stop button, one row forever
--
-- Four levels of stopping, all read through one gate:
--   kill_switch      everything, everywhere
--   channel_pauses   one channel across every campaign
--   agent_pauses     one agent across every campaign
--   campaigns.status a single campaign
-- ===========================================================================
create table if not exists system_control (
  id              integer primary key default 1 check (id = 1),
  kill_switch     boolean not null default false,
  channel_pauses  jsonb not null default
                    '{"email":false,"linkedin":false,"sms":false,"voice":false}'::jsonb,
  agent_pauses    jsonb not null default '{}'::jsonb,
  updated_by      text,
  updated_at      timestamptz not null default now()
);

insert into system_control (id) values (1) on conflict (id) do nothing;


-- ===========================================================================
-- Row level security
--
-- Left off. The API is the only client and it connects with the service role
-- key, which bypasses RLS regardless. The browser never reads these tables,
-- it only calls the API, so the anon role needs no access at all.
--
-- If you turn RLS on later, write the policies deliberately and do not give
-- anon a blanket select: `prospects` holds real names, emails and phone
-- numbers.
-- ===========================================================================

select 'Schema applied. 12 tables created.' as result;
