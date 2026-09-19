-- ===========================================================================
-- Pigeon SDR · seed
--
-- This file sets up a believable starting position and nothing more. It
-- writes reps, campaigns, prospects, knowledge, suppression rules and
-- prompts.
--
-- It deliberately writes nothing to `activities`, `agent_runs` or `messages`,
-- and every prospect starts at `discovered`. Those three tables fill up only
-- when the system actually does something, so the timeline a judge reads and
-- the counters on the Queue screen are a record of real runs rather than a
-- story typed in ahead of time. Press Run on a campaign and watch them fill.
--
-- The thirteen prospects are chosen so that one pass of the pipeline exercises
-- every branch the system has: a clean qualify, two different kinds of
-- exclusion, a profile too thin to score, the same person judged differently
-- by two campaigns, a prospect live in two campaigns at once, and one who is
-- on the suppression list.
--
-- Safe to run more than once. Every insert is guarded.
-- ===========================================================================

-- ── reps ───────────────────────────────────────────────────────────────────
insert into reps (id, full_name, title, email, signature, timezone) values
  ('a0000000-0000-4000-8000-000000000001', 'Nishu Jain', 'Account Executive',
   'nishu@pigeon.example', 'Nishu Jain · Pigeon', 'Asia/Kolkata'),
  ('a0000000-0000-4000-8000-000000000002', 'Aarav Singh', 'Founding AE',
   'aarav@pigeon.example', 'Aarav Singh · Pigeon', 'Asia/Kolkata')
on conflict (id) do nothing;


-- ── campaigns ──────────────────────────────────────────────────────────────
insert into campaigns (
  id, name, status, objective, icp_criteria, exclusion_criteria, target_roles,
  industry, company_size, enabled_channels, outreach_policy, messaging_policy,
  research_focus, daily_send_limit, require_approval, rep_id
) values
  ('c0000000-0000-4000-8000-000000000001',
   'US SaaS CTOs · Platform Modernisation',
   'live',
   'Book 15 minute technical calls with engineering leaders who are already rebuilding their data platform.',
   'B2B SaaS companies headquartered in the United States with 50 to 2000 employees. Target the most senior engineering leader: CTO, VP Engineering, Head of Platform. Companies that have raised a Series A through Series C are the best fit. A recent funding round, a platform rebuild, or open platform engineering roles all count as buying signals.',
   'Consulting firms and agencies. Companies under 50 or over 2000 employees. Anyone at a company that sells a competing data platform.',
   '["CTO", "VP Engineering", "Head of Platform", "Chief Technology Officer"]'::jsonb,
   'B2B SaaS', '50-2000',
   '["email", "linkedin"]'::jsonb,
   'Three touches over nine days. Open on email, second touch on LinkedIn, close on email. Never more than three.',
   'Under 90 words. Peer to peer, not vendor to buyer. One specific observation about their company, then one question. No adjectives about our product.',
   'Current title and seniority, headcount, funding stage and date, engineering blog or open source activity, and open platform engineering roles.',
   40, true, 'a0000000-0000-4000-8000-000000000001'),

  ('c0000000-0000-4000-8000-000000000002',
   'India BFSI Technology Leaders',
   'live',
   'Open conversations with technology leaders at Indian banks, insurers and NBFCs running a modernisation programme.',
   'Scheduled commercial banks, insurers and NBFCs in India with more than 1000 employees. Target the CIO, CTO or Head of Digital. An announced core system modernisation or a regulatory deadline they are working towards is the strongest signal.',
   'Cooperative banks, microfinance institutions and payment aggregators. Any organisation headquartered outside India.',
   '["CIO", "CTO", "Head of Digital", "Chief Information Officer"]'::jsonb,
   'Banking, Insurance, NBFC', '1000+',
   '["email"]'::jsonb,
   'Two touches over seven days. Email only. This audience does not respond well to LinkedIn from strangers.',
   'Formal and specific. Assume a compliance function may read it. Never imply a regulatory obligation you cannot cite. Under 120 words.',
   'Current title, institution type, announced digital transformation programmes, core platform in use, and regulatory deadlines.',
   25, true, 'a0000000-0000-4000-8000-000000000001'),
   -- industry is written the way the prospect records are labelled, not as the
   -- umbrella term. "BFSI" matches nothing; "Banking, Insurance, NBFC" matches
   -- the rows. Scoring compares strings, so the operator writing the target has
   -- to write it in the vocabulary the data uses.

  ('c0000000-0000-4000-8000-000000000003',
   'Voice AI Founders · Seed to Series A',
   'paused',
   'Reach technical founders building voice and speech products before they pick an infrastructure partner.',
   'Companies whose core product is voice, speech or conversational AI. Between seed and Series A. Under 50 employees. Target the founder or CTO. Published technical writing and open source activity matter more than firmographics for this list.',
   'Enterprise AI divisions inside large corporations. Hardware-first companies. Agencies that resell voice platforms. Anyone at Series B or later.',
   '["Founder", "Co-founder", "CTO", "CEO"]'::jsonb,
   'AI Infrastructure', '1-50',
   '["email", "linkedin"]'::jsonb,
   'Two touches over five days. Short. These founders read every cold email and delete almost all of them.',
   'Under 60 words. Be specific about what they built or say nothing. No pleasantries, no framing, no "hope this finds you well".',
   'What the product actually does, funding stage, GitHub and open source activity, accelerator affiliation, published technical writing.',
   15, true, 'a0000000-0000-4000-8000-000000000002')
on conflict (id) do nothing;


-- ── prospects ──────────────────────────────────────────────────────────────
-- What a CSV export or a CRM sync realistically hands you: a name, a title, a
-- company, an industry and a rough headcount. Nothing more. The signals that
-- make a first touch worth reading (funding, hiring, news, technical writing)
-- are absent, because those are the part the research agent goes and finds.
--
-- The comment above each one says which branch it is there to exercise. None
-- of them carry a verdict in the seed: the verdict is produced by a real run.
insert into prospects (id, first_name, last_name, full_name, title, email, phone,
                       linkedin_url, company_name, company_domain,
                       company_industry, company_employee_count, company_hq,
                       source, field_provenance) values

  -- Clean qualify for campaign 1. Role, industry and headcount all in band.
  ('d0000000-0000-4000-8000-000000000001', 'Sarah', 'Chen', 'Sarah Chen',
   'Chief Technology Officer', 'sarah.chen@northwinddata.com', null,
   'https://linkedin.com/in/sarahchen-cto', 'Northwind Data', 'northwinddata.com',
   'B2B SaaS', 300, 'San Francisco, CA',
   'csv', '{"email":"csv","title":"csv","company_name":"csv","company_industry":"csv","company_employee_count":"csv"}'::jsonb),

  -- The same person, two campaigns, two different answers. Qualifies for the
  -- SaaS campaign; rejected by the Voice AI one on role and size. Both true
  -- at once, which is the whole reason funnel state lives per campaign.
  ('d0000000-0000-4000-8000-000000000002', 'Marcus', 'Webb', 'Marcus Webb',
   'VP Engineering', 'marcus.webb@lumenretail.com', '+1-415-555-0142',
   'https://linkedin.com/in/marcuswebb', 'Lumen Retail', 'lumenretail.com',
   'B2B SaaS', 850, 'Austin, TX',
   'crm', '{"email":"crm","phone":"crm","title":"crm","company_industry":"crm"}'::jsonb),

  -- Exclusion reject. Campaign 1 excludes consulting firms, and exclusions are
  -- checked before scoring, so this never gets a fit score at all.
  ('d0000000-0000-4000-8000-000000000003', 'Tomas', 'Lindqvist', 'Tomas Lindqvist',
   'Founder', 'tomas@brightsidepartners.se', null, null,
   'Brightside Partners', 'brightsidepartners.se',
   'Management Consulting', 40, 'Stockholm, Sweden',
   'manual', '{"email":"manual","company_name":"manual","company_industry":"manual"}'::jsonb),

  -- Too thin to judge. Comes back needs_review, not reject: not knowing is a
  -- different answer from knowing they do not fit.
  ('d0000000-0000-4000-8000-000000000004', 'Jordan', 'Pace', 'Jordan Pace',
   null, 'j.pace@gmail.com', null, null, null, null,
   null, null, null,
   'manual', '{"email":"manual"}'::jsonb),

  -- Second clean qualify, smaller company.
  ('d0000000-0000-4000-8000-000000000005', 'Priya', 'Raman', 'Priya Raman',
   'Chief Technology Officer', 'priya@halofintech.com', null,
   'https://linkedin.com/in/priyaraman', 'Halo Fintech', 'halofintech.com',
   'B2B SaaS', 120, 'London, UK',
   'csv', '{"email":"csv","title":"csv","company_name":"csv","company_industry":"csv","company_employee_count":"csv"}'::jsonb),

  -- Exactly the right person at a company well outside the size band. Lands in
  -- review rather than a clean reject, which is the correct answer: a human
  -- decides whether a 4800-person company is worth an exception.
  ('d0000000-0000-4000-8000-000000000006', 'Dev', 'Anand', 'Dev Anand',
   'Head of Platform', 'dev.anand@cirrussystems.com', null, null,
   'Cirrus Systems', 'cirrussystems.com',
   'B2B SaaS', 4800, 'Bengaluru, India',
   'csv', '{"email":"csv","title":"csv","company_industry":"csv","company_employee_count":"csv"}'::jsonb),

  -- Would qualify on the numbers, but is on the suppression list. Research and
  -- scoring still run; the gate stops her the moment anything outbound starts.
  ('d0000000-0000-4000-8000-000000000007', 'Helen', 'Okafor', 'Helen Okafor',
   'VP Engineering', 'helen.okafor@vertexlabs.com', null, null,
   'Vertex Labs', 'vertexlabs.com',
   'B2B SaaS', 500, 'Toronto, Canada',
   'csv', '{"email":"csv","title":"csv","company_industry":"csv","company_employee_count":"csv"}'::jsonb),

  -- Clean qualify for the BFSI campaign.
  ('d0000000-0000-4000-8000-000000000008', 'Rajesh', 'Kumar', 'Rajesh Kumar',
   'Chief Information Officer', 'rajesh.kumar@meridianbank.in', null,
   'https://linkedin.com/in/rajeshkumar-cio', 'Meridian Bank', 'meridianbank.in',
   'Banking', 12000, 'Mumbai, India',
   'crm', '{"email":"crm","title":"crm","company_name":"crm","company_industry":"crm","company_employee_count":"crm"}'::jsonb),

  -- Exclusion reject in the BFSI campaign: cooperative banks are named.
  ('d0000000-0000-4000-8000-000000000009', 'Anita', 'Desai', 'Anita Desai',
   'Chief Technology Officer', 'anita.desai@sahyadricoop.in', null, null,
   'Sahyadri Cooperative Bank', 'sahyadricoop.in',
   'Cooperative Banking', 900, 'Pune, India',
   'manual', '{"email":"manual","company_name":"manual","company_industry":"manual"}'::jsonb),

  -- BFSI qualify.
  ('d0000000-0000-4000-8000-00000000000a', 'Nadia', 'Rahman', 'Nadia Rahman',
   'Chief Information Officer', 'nadia.rahman@arcadiainsure.in', null,
   'https://linkedin.com/in/nadiarahman', 'Arcadia Insurance', 'arcadiainsure.in',
   'Insurance', 4200, 'Mumbai, India',
   'crm', '{"email":"crm","title":"crm","company_name":"crm","company_industry":"crm","company_employee_count":"crm"}'::jsonb),

  -- Clean qualify for the Voice AI campaign, which is paused. Nothing here
  -- moves until someone sets that campaign live.
  ('d0000000-0000-4000-8000-00000000000b', 'Elena', 'Fiorentino', 'Elena Fiorentino',
   'Founder & CEO', 'elena@vocalis.ai', null,
   'https://linkedin.com/in/elenafiorentino', 'Vocalis', 'vocalis.ai',
   'Conversational AI', 18, 'Lisbon, Portugal',
   'manual', '{"email":"manual","title":"manual","company_name":"manual","company_industry":"manual"}'::jsonb),

  -- Voice AI reject: an AI division inside a large manufacturer, which is
  -- neither the role nor the stage that campaign targets.
  ('d0000000-0000-4000-8000-00000000000c', 'Kenji', 'Sato', 'Kenji Sato',
   'Director of AI Platform', 'k.sato@orbitalindustries.com', null, null,
   'Orbital Industries', 'orbitalindustries.com',
   'Industrial Manufacturing', 8000, 'Osaka, Japan',
   'csv', '{"email":"csv","title":"csv","company_industry":"csv","company_employee_count":"csv"}'::jsonb),

  -- Genuinely fits two live campaigns: a CTO at an Indian financial software
  -- company inside both size bands. Both will qualify him, and the second one
  -- to do so raises a duplicate conflict before either sends anything.
  ('d0000000-0000-4000-8000-00000000000d', 'Vikram', 'Shah', 'Vikram Shah',
   'Chief Technology Officer', 'vikram.shah@aurexfinancial.in', null,
   'https://linkedin.com/in/vikramshah-cto', 'Aurex Financial Systems', 'aurexfinancial.in',
   'Insurance Technology, B2B SaaS', 1400, 'Mumbai, India',
   'crm', '{"email":"crm","title":"crm","company_name":"crm","company_industry":"crm","company_employee_count":"crm"}'::jsonb)

on conflict (id) do nothing;


-- ── notes carried in by the import ─────────────────────────────────────────
-- A CRM export or a data provider usually carries one line of context beyond
-- the firmographics. It is the difference between a first touch that opens on
-- something real and one that opens on nothing, so the system keeps it and
-- attributes it to the import rather than letting an agent claim it.
--
-- Four prospects have one and the rest do not, on purpose: that is what a real
-- list looks like, and it is how you see the personalisation agent refuse to
-- write rather than invent a hook.
update prospects set notes = v.note from (values
  ('d0000000-0000-4000-8000-000000000001'::uuid,
   'Announced a $40M Series B in March 2026, led by Redpoint. Hiring four platform engineers.'),
  ('d0000000-0000-4000-8000-000000000002'::uuid,
   'Presented at QCon on cutting their data pipeline cost by 60 percent after a warehouse migration.'),
  ('d0000000-0000-4000-8000-000000000005'::uuid,
   'Rebuilding their reporting stack this quarter. Two open roles for analytics engineers.'),
  ('d0000000-0000-4000-8000-000000000008'::uuid,
   'Meridian announced a three-year core banking modernisation programme in January 2026.'),
  ('d0000000-0000-4000-8000-00000000000a'::uuid,
   'Arcadia published a digital claims transformation roadmap targeting completion by March 2027.'),
  ('d0000000-0000-4000-8000-00000000000d'::uuid,
   'Aurex is migrating its policy administration platform off mainframe, announced at their October investor day.'),
  ('d0000000-0000-4000-8000-00000000000b'::uuid,
   'Open-sourced their turn-taking model in February. Writes regularly about sub-300ms latency.')
) as v(id, note)
where prospects.id = v.id and prospects.notes is null;


-- ── campaign membership ────────────────────────────────────────────────────
-- Everyone at `discovered`. Nothing has happened to anyone yet.
insert into campaign_prospects (campaign_id, prospect_id, state) values
  -- US SaaS CTOs
  ('c0000000-0000-4000-8000-000000000001', 'd0000000-0000-4000-8000-000000000001', 'discovered'),
  ('c0000000-0000-4000-8000-000000000001', 'd0000000-0000-4000-8000-000000000002', 'discovered'),
  ('c0000000-0000-4000-8000-000000000001', 'd0000000-0000-4000-8000-000000000003', 'discovered'),
  ('c0000000-0000-4000-8000-000000000001', 'd0000000-0000-4000-8000-000000000004', 'discovered'),
  ('c0000000-0000-4000-8000-000000000001', 'd0000000-0000-4000-8000-000000000005', 'discovered'),
  ('c0000000-0000-4000-8000-000000000001', 'd0000000-0000-4000-8000-000000000006', 'discovered'),
  ('c0000000-0000-4000-8000-000000000001', 'd0000000-0000-4000-8000-000000000007', 'discovered'),
  ('c0000000-0000-4000-8000-000000000001', 'd0000000-0000-4000-8000-00000000000d', 'discovered'),

  -- India BFSI
  ('c0000000-0000-4000-8000-000000000002', 'd0000000-0000-4000-8000-000000000008', 'discovered'),
  ('c0000000-0000-4000-8000-000000000002', 'd0000000-0000-4000-8000-000000000009', 'discovered'),
  ('c0000000-0000-4000-8000-000000000002', 'd0000000-0000-4000-8000-00000000000a', 'discovered'),
  ('c0000000-0000-4000-8000-000000000002', 'd0000000-0000-4000-8000-00000000000d', 'discovered'),

  -- Voice AI (paused campaign — nothing here should move until it is set live)
  ('c0000000-0000-4000-8000-000000000003', 'd0000000-0000-4000-8000-000000000002', 'discovered'),
  ('c0000000-0000-4000-8000-000000000003', 'd0000000-0000-4000-8000-00000000000b', 'discovered'),
  ('c0000000-0000-4000-8000-000000000003', 'd0000000-0000-4000-8000-00000000000c', 'discovered')
on conflict (campaign_id, prospect_id) do nothing;


-- ── suppression ────────────────────────────────────────────────────────────
-- Enforced by a SQL predicate in the gate, not by asking a model to remember.
insert into suppression_list (id, email, domain, phone, reason, scope) values
  ('e0000000-0000-4000-8000-000000000001', 'helen.okafor@vertexlabs.com', null, null,
   'Asked to be removed after a previous campaign', 'global'),
  ('e0000000-0000-4000-8000-000000000002', null, 'competitorplatform.com', null,
   'Competitor domain', 'global'),
  ('e0000000-0000-4000-8000-000000000003', null, 'gov.in', null,
   'Government domains are out of scope for outbound', 'global')
on conflict (id) do nothing;


-- ── knowledge ──────────────────────────────────────────────────────────────
-- What personalisation is permitted to claim. A campaign_id of null means the
-- chunk is available to every campaign.
insert into knowledge_chunks (id, campaign_id, type, title, content) values
  ('f0000000-0000-4000-8000-000000000001', null, 'product',
   'What Pigeon does',
   'Pigeon runs outbound prospecting end to end: it researches a prospect, scores them against a written ICP, plans a multi-channel sequence, drafts each message grounded in source material, and classifies replies. A human approves anything that goes out and can stop the system at four levels.'),

  ('f0000000-0000-4000-8000-000000000002', null, 'brand_voice',
   'How we write',
   'Short sentences. One specific observation, then one question. We never open with a compliment, never say "I hope this finds you well", and never describe our own product with adjectives. If there is nothing specific to say to this person, we do not send.'),

  ('f0000000-0000-4000-8000-000000000003', null, 'objection_handling',
   'We already have a tool for this',
   'Acknowledge it and ask what it does not do. Most teams running outbound tooling have a research step and a sending step but nothing joining them, so the sequence is personalised at the top and generic by touch three. That gap is the conversation worth having.'),

  ('f0000000-0000-4000-8000-000000000004', null, 'objection_handling',
   'Is this just AI spam',
   'Fair question. The difference is what happens when the system does not know something. Ours stops and asks a person rather than inventing a detail. Every claim in a message traces back to a field in the research or a document in the knowledge base, and the prospect record shows which.'),

  ('f0000000-0000-4000-8000-000000000005', 'c0000000-0000-4000-8000-000000000001', 'case_study',
   'Series B SaaS, 400 people',
   'A data infrastructure company with 400 employees moved outbound research in-house after their SDR team spent roughly nine hours a week on manual enrichment. Reply rate went from 2.1 percent to 6.4 percent over eleven weeks. The change they credit is that every first touch opened on a signal from the last ninety days.'),

  ('f0000000-0000-4000-8000-000000000006', 'c0000000-0000-4000-8000-000000000001', 'icp_definition',
   'Why 50 to 2000',
   'Under 50 people there is usually no dedicated platform team, so the problem we solve has not appeared yet. Over 2000 the buying process runs through procurement and the engineering leader is no longer the decision maker. The band in between is where a CTO can still say yes.'),

  ('f0000000-0000-4000-8000-000000000007', 'c0000000-0000-4000-8000-000000000002', 'faq',
   'Data residency for Indian financial institutions',
   'Deployments for Indian regulated entities run in the Mumbai region with data at rest inside India. We do not make claims about specific RBI circulars in outbound messages; questions about regulatory fit are escalated to a human.'),

  ('f0000000-0000-4000-8000-000000000008', 'c0000000-0000-4000-8000-000000000002', 'playbook',
   'Approaching a CIO at a scheduled commercial bank',
   'Lead with the modernisation programme they have already announced publicly, never with a product capability. Reference the programme by name. Keep the ask to a 20 minute technical conversation with an architect rather than a demo.'),

  ('f0000000-0000-4000-8000-000000000009', 'c0000000-0000-4000-8000-000000000003', 'playbook',
   'Writing to technical founders',
   'Name the specific thing they built and one hard part of building it. If you cannot name a hard part, you have not read enough and should not send. No mention of funding unless it is the reason you are writing.'),

  ('f0000000-0000-4000-8000-00000000000a', 'c0000000-0000-4000-8000-000000000003', 'competitor',
   'How we differ from general speech APIs',
   'A speech API gives you transcription. The gap founders hit is everything after: turn taking, interruption handling, and keeping latency under 300ms end to end. That is the part worth a conversation.')
on conflict (id) do nothing;


-- ── prompts ────────────────────────────────────────────────────────────────
-- The active row for a campaign and agent is sent on every call to that
-- agent, as _system_prompt and _agent_prompt. This is what makes the prompt
-- editor in the app change behaviour rather than just store text.
insert into prompt_versions (campaign_id, agent_name, version, is_active, author, content) values

  -- US SaaS CTOs
  ('c0000000-0000-4000-8000-000000000001', 'system', 1, true, 'Nishu Jain',
   'You are the outbound system for the US SaaS CTO campaign. You write to engineering leaders who get dozens of cold emails a week and delete almost all of them. Every claim about a prospect must come from a field in their researched profile. Every claim about the product must come from a retrieved knowledge chunk. If you cannot ground a statement in one of those, do not make it. Escalate rather than guess.'),
  ('c0000000-0000-4000-8000-000000000001', 'research', 1, true, 'Nishu Jain',
   'Return only what you can source. A null field is a correct answer; an invented value is a failure. Prioritise current title and seniority, headcount, funding stage and date, engineering blog or open source activity, and open platform engineering roles. Name every field you could not find in fields_not_found.'),
  ('c0000000-0000-4000-8000-000000000001', 'icp_fitment', 1, true, 'Nishu Jain',
   'Check exclusions first: agencies and consulting firms are immediate rejects regardless of role. Then weight role seniority most heavily, then headcount inside the 50 to 2000 band, then industry. A missing headcount is needs_review, not reject.'),
  ('c0000000-0000-4000-8000-000000000001', 'outreach_strategy', 1, true, 'Nishu Jain',
   'Three touches over nine days: email at day 0, LinkedIn at day 4, email at day 9. Every touch needs a distinct angle grounded in a different signal. If you only have one signal, plan two touches, not three.'),
  ('c0000000-0000-4000-8000-000000000001', 'personalisation', 1, true, 'Nishu Jain',
   'Under 90 words. Open on the specific signal named in the step angle. One question at the end, never two. If the profile has no signal from the last ninety days, set needs_human to true rather than opening on something generic.'),
  ('c0000000-0000-4000-8000-000000000001', 'conversation', 1, true, 'Nishu Jain',
   'Engineering leaders reply tersely. A two-word reply is still a real reply. Treat "who is this" as a question, not an objection. Anything touching pricing, security review or procurement requires a human.'),

  -- India BFSI
  ('c0000000-0000-4000-8000-000000000002', 'system', 1, true, 'Nishu Jain',
   'You are the outbound system for the India BFSI campaign. Your audience is regulated and every message may be read by a compliance function. Be formal, specific and conservative. Never imply a regulatory obligation you cannot cite. Escalate anything touching compliance, security review or procurement.'),
  ('c0000000-0000-4000-8000-000000000002', 'research', 1, true, 'Nishu Jain',
   'Prioritise current title, institution type (scheduled commercial bank, insurer or NBFC), announced digital transformation programmes, core platform in use, and regulatory deadlines they are working towards. Return null for anything you cannot source.'),
  ('c0000000-0000-4000-8000-000000000002', 'icp_fitment', 1, true, 'Nishu Jain',
   'Exclusions first: cooperative banks, microfinance institutions and payment aggregators are immediate rejects. Then score on role seniority, institution size, and whether a modernisation programme is under way. Institution type matters as much as role: a CIO at an NBFC and a CIO at a scheduled commercial bank are different prospects.'),
  ('c0000000-0000-4000-8000-000000000002', 'outreach_strategy', 1, true, 'Nishu Jain',
   'Email only. Two touches, day 0 and day 7. This audience does not respond to LinkedIn approaches from strangers and a LinkedIn touch here costs you the email.'),
  ('c0000000-0000-4000-8000-000000000002', 'personalisation', 1, true, 'Nishu Jain',
   'Under 120 words, formal register. Lead with the modernisation programme they have announced publicly, by name. The ask is a 20 minute technical conversation with an architect, never a demo. No regulatory claims.'),
  ('c0000000-0000-4000-8000-000000000002', 'conversation', 1, true, 'Nishu Jain',
   'Replies here are often forwarded internally before you see them. If a reply reads as though it came from someone other than the addressee, set intent to referral. Route anything mentioning RBI, IRDAI, audit or procurement to a human.'),

  -- Voice AI
  ('c0000000-0000-4000-8000-000000000003', 'system', 1, true, 'Aarav Singh',
   'You are the outbound system for the Voice AI founder campaign. You write to technical founders who spot a generic email instantly. Be specific about what they built. Short beats complete. If you have nothing technically specific to say, say nothing and escalate.'),
  ('c0000000-0000-4000-8000-000000000003', 'research', 1, true, 'Aarav Singh',
   'Prioritise what the product actually does, funding stage, GitHub and open source activity, accelerator affiliation, and published technical writing. Technical specifics matter more than firmographics for this list.'),
  ('c0000000-0000-4000-8000-000000000003', 'icp_fitment', 1, true, 'Aarav Singh',
   'Exclusions first: enterprise AI divisions inside large corporations, hardware-first companies and reseller agencies are rejects. Then score on whether the person is a founder or CTO, whether the company is genuinely voice or speech focused, and whether they are between seed and Series A. A perfect fit at Series B is still a reject here.'),
  ('c0000000-0000-4000-8000-000000000003', 'outreach_strategy', 1, true, 'Aarav Singh',
   'Two touches, five days apart. Email then LinkedIn. Do not plan a third; this audience reads a third touch as automation.'),
  ('c0000000-0000-4000-8000-000000000003', 'personalisation', 1, true, 'Aarav Singh',
   'Under 60 words. Name the specific thing they built and one hard part of building it. No pleasantries, no framing sentence, no mention of funding unless it is the reason you are writing. If you cannot name a hard part, set needs_human to true.'),
  ('c0000000-0000-4000-8000-000000000003', 'conversation', 1, true, 'Aarav Singh',
   'Founders reply fast and informally. A one-line "sure, when" is a meeting_request. Technical pushback is a question, not an objection, and is a good sign.')

on conflict (campaign_id, agent_name, version) do nothing;


-- ── report ─────────────────────────────────────────────────────────────────
select
  (select count(*) from campaigns)           as campaigns,
  (select count(*) from prospects)           as prospects,
  (select count(*) from campaign_prospects)  as memberships,
  (select count(*) from knowledge_chunks)    as knowledge,
  (select count(*) from prompt_versions)     as prompts,
  (select count(*) from suppression_list)    as suppression,
  (select count(*) from activities)          as activities_should_be_zero,
  (select count(*) from agent_runs)          as agent_runs_should_be_zero,
  'Seed applied. Nothing has run yet. Open the app and press Run on a campaign.' as next_step;
