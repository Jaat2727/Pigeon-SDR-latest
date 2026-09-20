# Pigeon · Autonomous SDR

An outbound sales system with two halves. A control plane, where a person
creates campaigns, watches what is happening and stops it when they want to.
An intelligence layer, where agents find people, research them, score them,
plan a sequence, write the messages and read the replies.

Built for the Inter Guild Buildathon 2026 (IIT Madras × DronaHQ).

React 19 and Vite on the front, Node and Express on the API, Supabase Postgres
underneath, Groq and Gemini for the reasoning, Apollo for finding real people.

---

## Contents

1. [Read this first: the three ideas](#1-read-this-first-the-three-ideas)
2. [How a prospect moves through the system](#2-how-a-prospect-moves-through-the-system)
3. [The agents, one at a time](#3-the-agents-one-at-a-time)
4. [How the model keys work](#4-how-the-model-keys-work)
5. [How finding people works](#5-how-finding-people-works)
6. [How running a campaign works](#6-how-running-a-campaign-works)
7. [How the stop controls work](#7-how-the-stop-controls-work)
8. [Walking through the screens](#8-walking-through-the-screens)
9. [Setting it up](#9-setting-it-up)
10. [Environment variables](#10-environment-variables)
11. [Checking that it works](#11-checking-that-it-works)
12. [How the numbers are counted](#12-how-the-numbers-are-counted)
13. [Folder structure](#13-folder-structure)
14. [What is not built, and why](#14-what-is-not-built-and-why)
15. [When something goes wrong](#15-when-something-goes-wrong)
16. [About DronaHQ](#16-about-dronahq)

---

## 1. Read this first: the three ideas

Everything else in this README follows from three decisions. If you read only
one section, read this one.

**Every result says which engine produced it.** An agent call can be answered
by a real model (Groq or Gemini), by a retry, or by a built-in rule engine when
no model is available. Those are three different things and the app never blurs
them. Each run writes a row in `agent_runs` naming the engine, the provider, the
model and which key served it, and the screens badge every result accordingly.
A fallback that quietly impersonates a model call is worse than no fallback,
because it makes a broken system look like a working one.

**State lives per campaign, not per person.** A prospect's funnel position,
score, verdict and sequence live in `campaign_prospects`, keyed by campaign. The
same person can be qualified in one campaign and rejected in another, and both
are true at once. The `prospects` table has no state column, by design.

**Long work is a row you watch, not a request you wait for.** Running a campaign
is four model calls per prospect, which is minutes. That used to happen inside
the HTTP request that asked for it, so the browser gave up long before the work
did. Now `POST /campaigns/:id/run` writes a job, returns its id and returns. The
UI polls the job, shows the counts moving and offers a Stop button that aborts
the model call in flight rather than waiting for it to finish.

---

## 2. How a prospect moves through the system

Read left to right. Each arrow is one pass of the orchestrator, and each pass
does one thing and stops, so you can always read a prospect's state off the
database and explain it.

```
                 ┌──────────────────────────────────────────────┐
                 │ Discovery (Apollo, or model suggestions,      │
                 │ or a CSV you paste in)                        │
                 └──────────────────────┬───────────────────────┘
                                        ▼
  discovered ──► research ──► researched ──► icp_fitment ──┬─► qualified
                                                            ├─► rejected
                                                            └─► needs_review  (a person decides)

  qualified ──► outreach_strategy ──┬─► strategy_planned
                                     └─► stopped   (the agent decided not to contact)

  strategy_planned ──► personalisation ──► pending_approval ──► (a person approves) ──► sent ──► contacted

  contacted ──► (a reply arrives) ──► conversation ──┬─► engaged
                                                      ├─► meeting
                                                      ├─► stopped
                                                      └─► opted_out
```

Every one of those arrows passes through one gate function first, in
`server/src/orchestrator/gate.js`. There is exactly one of these and it is
called from exactly one place. A second code path that skips a check is how a
system ends up emailing someone who asked not to be emailed.

The gate checks six things, in this order:

1. the global kill switch
2. a channel pause
3. an agent pause
4. campaign status, and whether the campaign has that channel enabled
5. the prospect's own pause and opt-out state
6. the suppression list, matched in SQL

The order changes the explanation, not the outcome. When the kill switch and
the suppression list would both stop something, "the kill switch is on" is the
more useful answer, so the broadest reason is checked first.

---

## 3. The agents, one at a time

Open the Agents screen in the app and you get this same list with live
statistics, a working input you can edit, and the full trace of what came back.
This table is the short version.

| Agent | Takes | Gives | Engine |
|---|---|---|---|
| **Prospect Discovery** | The campaign ICP, exclusions, target roles, industry, headcount band | Candidate companies and the job title worth approaching at each | Apollo, or a model |
| **Research & Enrichment** | A thin prospect record | A filled profile, plus a list of fields it could not source | Model |
| **ICP Fitment** | The profile and the campaign ICP and exclusions | A score out of 100 and one of qualify, reject, needs_review | Model |
| **Outreach Strategy** | The profile, the verdict, the enabled channels, the outreach policy | A touch sequence with a channel and day offset per step, or a decision not to contact | Model |
| **Personalisation** | One step of the sequence, the profile, the thread, the retrieved knowledge | One message: subject, body, and what it drew on | Model |
| **Conversation** | An inbound reply | Intent, sentiment, extracted facts, and what should happen next | Model |
| **Follow-up Timing** | The planned sequence and the working hours | A real timestamp per touch, rolled off weekends | Rule based, on purpose |
| **Voice SDR** | Nothing yet | Nothing yet | Registered, gated, not built |

Three behaviours are worth calling out because they are the ones that make the
difference between a demo and a system.

**Research returns null rather than guessing.** Anything it could not source
comes back null and is named in `fields_not_found`, which the prospect page
prints. A model asked to fill in a headcount will produce a plausible number;
this one is told not to, and the empty field is the honest answer.

**ICP checks exclusions before it scores.** A match on an exclusion is a reject
whatever the fit score would have been. A perfect-fit CTO at an agency you told
it to avoid is rejected at zero, not qualified at 85.

**Personalisation is allowed to refuse.** When there is nothing specific enough
to say, it sets `needs_human`, explains why, and still returns a best-effort
draft for a person to fix. A message agent that always produces something
produces filler, and filler is what gets a domain blocked.

**Follow-up timing has no model behind it, on purpose.** Working hours,
weekends and the gap since the last touch are arithmetic. A model would only
add variance to a question that has a correct answer.

### Trying an agent yourself

On the Agents screen, press "Try it" on any agent. You get:

- a set of example inputs to start from, including deliberately awkward ones
  (an ICP too vague to score, a prospect with nothing to say about them, a
  reply that mentions pricing)
- the input as editable JSON, so you can change one field and rerun
- the full trace of what happened: the prompt that was sent, which provider,
  model and key answered, how long it took, the raw text the model returned,
  the reshaped version, and whether it validated

Nothing is written to the database, so run it as often as you like. Changing
the input and watching the verdict change is the fastest way to understand what
an agent actually reacts to.

### What happens when an agent misbehaves

Model output is not trusted. Two passes run over every response.

First, coercion. A model returns numbers as strings, arrays as stringified
JSON, and alternate field names. All of that is normal and recoverable, so
`server/src/agents/schemas.js` reshapes it rather than treating it as failure.
"qualified" becomes "qualify". `"82"` becomes `82`. A sequence step on a channel
that does not exist is dropped.

Second, validation with zod. This only fails when a field the pipeline genuinely
cannot proceed without is missing. When it fails, the agent gets one retry with
its own validation error handed back to it. If that fails too, the local rule
engine answers instead and the run is marked degraded.

---

## 4. How the model keys work

Each provider holds a pool of up to **six keys**. This is not redundancy
theatre. A free-tier key runs out of requests part way through a campaign run,
and with one key that stops the run.

### Giving it the keys

Three spellings, all read and merged, so it works whichever way you paste them:

```bash
GROQ_API_KEY=key1,key2,key3        # one variable, comma separated
GROQ_API_KEYS=key1,key2            # the plural spelling, same thing
GROQ_API_KEY_1 … GROQ_API_KEY_6    # one variable per key
```

Same for `GEMINI_API_KEY`. Duplicates are dropped. Anything past six is ignored.

### What the pool does

Every key carries its own state:

- **healthy** — usable now
- **cooling** — failed recently, off the rota until a cooldown expires
- **disabled** — the provider rejected the key itself (401 or 403), off until
  you fix it or press "Retry this key" on the Agents screen

Selection is least recently used among the healthy keys, so load spreads evenly
instead of hammering key #1 until it dies.

### What happens on a failure

The important part is deciding whose fault the failure was. Getting this wrong
in either direction is expensive: benching a good key wastes capacity, and not
benching a rate-limited one wastes every call after it.

| What came back | What it means | What happens |
|---|---|---|
| 401, 403 | The key is bad | Key disabled |
| 429 | This key is rate limited | Key benched, cooldown grows with repeated failures: 20s, 60s, 3m, 10m |
| 404, or a 400 naming the model | The model name is wrong or retired | Key untouched, retry on the next model in the ladder |
| 400 otherwise | Our request was malformed | Key untouched, stop trying (it will be malformed on every key) |
| 5xx, network, timeout | The provider is having a bad day | Short cooldown |
| Cancelled | Someone pressed Stop | Key untouched |

### The full escalation, for one agent call

```
1. a healthy key for Groq            most calls stop here
2. a different healthy Groq key      the first one was rate limited
3. a different model on Groq         the named model was rejected
4. Gemini, same walk                 Groq has nothing usable left
5. the local rule engine             every provider is out
```

Step 3 is worth its own section.

### Models are discovered, not declared

This used to be a hand-written ladder of model names in `.env`. It broke
twice. Providers retire models on their own schedule: `llama3-70b-8192`
worked, then did not, then its replacement was renamed too. Every time, the
whole pipeline failed with `Every provider failed`, which reads like a key
problem and sends you to check your keys. It was one stale string.

So on first use the engine asks each provider `GET /models` with a real key,
and builds the ladder from the answer:

1. the model you set in `GROQ_MODEL` / `GEMINI_MODEL`, **if it genuinely
   exists on your account**
2. any `*_MODEL_FALLBACKS` you named that also exist
3. everything else the account can reach, best first

Ranking drops models that answer a chat call but cannot do this job: safety
classifiers, speech, embeddings, image models. A safety classifier returns a
verdict rather than the JSON an agent asked for, so falling back to one would
fail on every call and look like the model was broken.

Three rules keep it honest:

- **Your choice wins.** A configured model that exists is always tried first.
  Discovery only supplies what comes after it.
- **Failure is visible.** If the catalogue cannot be read, the static list from
  `.env` is used and both the log and `/health` say so.
- **Nothing is fatal.** A provider that will not answer `/models` still gets
  tried with your configured model.

When your configured model is missing, the log names the replacement and tells
you what to set:

```
[models] GROQ_MODEL is set to "llama3-70b-8192", which this account cannot
reach. Using "llama-3.3-70b-versatile" instead. Set GROQ_MODEL to one of:
llama-3.3-70b-versatile, openai/gpt-oss-120b, llama-3.1-8b-instant
```

To see what your keys can reach right now, open `GET /agents/models`, or press
**Recheck models** on the Agents screen. The list is cached for thirty
minutes; that button forces a fresh read without a redeploy.

Set `MODEL_AUTO_DISCOVER=false` to pin the models exactly and never ask. Only
worth it if you need reproducibility more than you need the app to survive a
model being retired.

### Seeing it

The Agents screen has a Model keys panel. Every key appears as a chip showing
its state, how many calls it has served, its average latency, its last error,
and how many seconds until a cooling key comes back. Keys are shown redacted
(`#2 gsk_ab…f3d9`), which is enough to tell six apart and useless to anyone who
sees a screenshot.

Key state lives in the API process, not the database. It describes what this
instance has seen in the last few minutes, and a stored row claiming a key was
dead after a restart would be worse than none.

---

## 5. How finding people works

There are three ways prospects get into a campaign, and the app never pretends
they are the same kind of thing.

### Apollo (real people)

Set `APOLLO_API_KEY` and discovery runs a real search against Apollo's contact
database. Real names, real titles, real LinkedIn URLs.

The search filters are built from the campaign: target roles become person
titles, the headcount band becomes an employee range, the industry becomes a
keyword. The discover dialog lets you override any of them, and **Preview**
runs the search and shows what it found without writing anything, so you find
out your headcount band was wrong before a hundred wrong people land in the
campaign.

One thing to know about Apollo emails. Apollo returns the literal string
`email_not_unlocked@domain.com` for anyone whose email you have not paid to
reveal. Stored naively that becomes a deliverable-looking address on a prospect
record, the personalisation agent writes to it, and you believe you have a
contactable lead. So it is thrown away and the field stays null, and the UI
shows the gap. Set `APOLLO_REVEAL_EMAILS=true` to unlock them during discovery,
which spends one Apollo credit per person. It is off by default because a demo
should not quietly drain an account.

### Model suggestions (leads to verify)

With no Apollo key, discovery asks the model for companies that fit the ICP and
the job title worth approaching at each one. These are stored with
`source = 'ai_suggested'` and labelled as unverified everywhere they appear.

Two rules are enforced in code, not just asked for in the prompt:

- **No email address is ever invented.** Not by this agent, not by research.
- **A person is only named when the name looks like a name.** A model asked to
  find people will happily answer "the CTO of Globex", or produce a plausible
  individual for a company it knows nothing about. The coercion layer accepts a
  name only if it is two to five words, each capitalised or a recognised
  particle (van, de, bin), and none of them a job title. Anything else becomes
  null and the candidate carries only its title, which is the honest version of
  what the model actually knows.

Discovery has no local rule-engine fallback, deliberately. Every other agent
transforms something it was handed, so a rule-based version degrades
gracefully. Discovery invents the input itself, and a deterministic version of
that would be a fabricated list of companies presented as sourced leads.

### Import (a list you already have)

Paste CSV with a header row. Recognised columns: name (or first name and last
name), title, email, phone, linkedin, company, domain, industry, employees,
location, notes. Anything else is ignored rather than guessed at. You see a
preview of the parsed rows before anything is written.

A row needs an email, a LinkedIn URL, or both a name and a company. Anything
with less is rejected rather than imported as an unreachable record that still
gets researched and scored, spending model calls on nothing.

### Deduplication

However a prospect arrives, the same check runs: email first (it is unique in
the schema), then LinkedIn URL, then name plus company domain. A person already
in the database is linked into the new campaign rather than duplicated. A
duplicate person means two sequences from the same company landing in one
inbox, which is exactly what the duplicate-conflict check further down the
pipeline exists to prevent.

Discovery works while a campaign is still a draft. Filling a campaign with
prospects contacts nobody, and making someone set it live before they can see
who they would be approaching gets the review step backwards.

---

## 6. How running a campaign works

Press Run. The API writes a row in `job_runs`, hands back its id, and returns
202. The work happens after the response.

```
POST /campaigns/:id/run
      │
      ├─► writes job_runs row, status 'queued'
      ├─► returns { job_id } immediately
      │
      └─► (after the response) execute(job)
            │
            ├─ picks up prospects with a step waiting, up to the limit
            ├─ works JOB_CONCURRENCY of them at once (2 by default)
            ├─ claims each one with a database lock before touching it
            ├─ writes progress and an event line after every prospect
            └─ releases the lock, whatever happened
```

The UI polls `GET /jobs/:id` every 1.5 seconds and shows a progress bar, a
running count, the prospect currently being worked on, and a line per prospect
as it is finished with.

Three things make this safe rather than merely asynchronous.

**Cancellation is real.** Every job owns an AbortController, and that signal
rides along on every model call. Pressing Stop aborts the HTTP request to Groq
or Gemini rather than just breaking the loop around it. Stop means stop, not
"stop after this thirty seconds".

**Prospects are locked.** The background worker and a manual run can reach the
same prospect in the same second. Without a claim in the database they both
advance it, it takes two steps at once, and the timeline stops explaining
itself. A lock older than `JOB_LOCK_TTL_MS` is assumed abandoned, so a process
that dies mid-step does not leave a prospect stuck forever.

**A restart closes out its orphans.** A job that was running when the API died
cannot be resumed, so at the next boot it is marked failed with a reason
instead of sitting at "running" for the rest of time and blocking its campaign
from starting a new one.

Only one job runs per campaign at a time. Two concurrent runs would fight over
the same prospects, and the locks would turn the second one into a long list of
"skipped", which looks like a bug.

---

## 7. How the stop controls work

Four levels, plus the suppression list. All of them are read through the same
gate the pipeline calls, so what the Controls screen says is stopping work is
what is stopping work.

| Control | Covers | What it does |
|---|---|---|
| **Kill switch** | Everything, everywhere | Nothing runs in any campaign. Also cancels every job in flight. |
| **Channel pause** | One channel, all campaigns | Stops anything outbound on that channel. Research and scoring carry on. |
| **Agent pause** | One agent, all campaigns | The pipeline stops at that agent's step. Prospects wait there rather than skipping it. |
| **Campaign status** | One campaign | Only a live campaign runs. Pausing also cancels that campaign's running job. |
| **Prospect pause / opt-out** | One person in one campaign | Held, or never contacted again. |
| **Suppression list** | One person, or a whole domain | Matched in SQL before any outbound action. |

The cancellation behaviour is the part that changed. Before, a pause only
applied to the next step, which meant the stop landed somewhere between now and
thirty seconds from now depending on where each model call happened to be. Now
the flag and the cancellation happen together.

Research and scoring still run for a suppressed prospect, because knowing that
someone on the list would have qualified is useful and costs them nothing. The
stop happens the moment anything outbound begins.

An opt-out reply writes a global suppression rule, not just a state change, so
it holds across every campaign rather than only the one they replied to.

---

## 8. Walking through the screens

| Screen | What it is for |
|---|---|
| **Dashboard** | Every campaign at a glance. Real counts only. |
| **Campaigns** | Create, edit, duplicate, find people, import, run, pause. Click a campaign's name for its Activity tab: the funnel, the live history, and the Run button. Also has Targeting, Execution and a per-campaign per-agent prompt editor. |
| **Prospects** | Every prospect, across all campaigns by default. One row per campaign membership, since state is per campaign. |
| **Prospect detail** | The full profile, the per-campaign verdicts side by side, the message thread, the agent run history. |
| **Queue** | The home screen. Approvals waiting on a person, the pipeline funnel, the activity feed. |
| **Agents** | How the agents fit together, per-agent statistics, the key health panel, and the playground. |
| **Knowledge** | The source material personalisation is allowed to cite, with a retrieval preview. Lexical search over term overlap, not embeddings, and labelled as such. |
| **Controls** | What is running, what is stopping it, and the switches. |

### Creating a campaign

Four steps, in the order the decisions actually happen.

1. **Basics** — name, a template to start from, what a win looks like
2. **Who to target** — the ICP, the exclusions, job titles, industry, headcount
3. **How to reach them** — channels, sequence policy, messaging policy, the rep
   it is signed as, whether a person approves each message
4. **Review** — a summary, plus what is missing and what that will cost you

The templates are starting points, not presets. Every word stays editable.
They exist so the first campaign you build has real sentences in it rather than
placeholders, and so the shape of a good ICP is visible from an example.

The review step distinguishes blockers from warnings. No ICP is a blocker,
because without one the scoring agent has nothing to score against and every
prospect comes back as needs_review. No target roles is a warning, because it
only means discovery has no job title to search for and you would have to
import by hand. The server enforces the same rules when you try to set a
campaign live.

---

## 9. Setting it up

### Step 1 · Supabase

1. Create a project.
2. SQL Editor, paste `server/db/01-schema.sql`, run it. Twelve tables.
3. SQL Editor, paste `server/db/04-runtime.sql`, run it. This adds `job_runs`,
   the prospect lock columns, the run attribution columns and the new discovery
   source values. It is safe to run more than once.
4. Optionally run `server/db/02-seed.sql` for three demo campaigns.
5. Project Settings → API, copy the URL and the **service role** key.

Without step 3 the app still starts, and says so specifically: `/health/schema`
names `job_runs` as the missing table, and locking degrades to no locking with
a warning in the log rather than refusing to run.

### Step 2 · Railway (the API)

1. New project from your repo, root directory `server`.
2. Variables: everything in section 10 below.
3. Settings → Networking → Generate Domain, pointed at port 3001.
4. Open `https://your-api.up.railway.app/health`. It should say
   `"status": "ok"`.

The API boots whether or not it is correctly configured. A server that crashes
on a missing variable leaves you with a container in a restart loop and nothing
to ask. This one starts, prints what it found, and answers `/health` with the
specific names of anything absent.

### Step 3 · Vercel (the frontend)

1. Import the repo, framework Vite, root directory left blank.
2. Environment variable `VITE_API_BASE_URL` = your Railway URL, no trailing
   slash.
3. Deploy.

Vite reads that value at build time, so changing it needs a redeploy.

### Step 4 · Close the loop

Add your Vercel URL to `CORS_ORIGINS` on Railway and redeploy the API. Once one
`*.vercel.app` origin is listed, preview deploys are allowed too.

### Running it locally

```bash
npm run setup                 # installs both package.json files

cp .env.example .env          # VITE_API_BASE_URL=http://localhost:3001
cp server/.env.example server/.env   # Supabase + your keys

npm --prefix server run dev   # API on 3001
npm run dev                   # app on 5173
```

Both need to be running. They do not persist between sessions.

---

## 10. Environment variables

### Frontend (`.env`, and Vercel)

| Variable | What it is |
|---|---|
| `VITE_API_BASE_URL` | Your Railway URL, no trailing slash. Read at build time. |

Nothing secret goes in a `VITE_` variable. Anything prefixed that way is
compiled into the JavaScript the browser downloads.

### API (`server/.env`, and Railway)

**Required**

| Variable | What it is |
|---|---|
| `SUPABASE_URL` | Project URL |
| `SUPABASE_SERVICE_ROLE_KEY` | Service role key. Server side only, never in a `VITE_` variable. |
| `CORS_ORIGINS` | Comma separated browser origins, no trailing slashes |

**The intelligence layer**

| Variable | Default | What it is |
|---|---|---|
| `GROQ_API_KEY` | | Up to six keys, comma separated. Or `GROQ_API_KEY_1` … `_6`. |
| `GROQ_MODEL` | `llama-3.3-70b-versatile` | A preference. Used if your account has it, otherwise the best available one is. |
| `GROQ_MODEL_FALLBACKS` | `openai/gpt-oss-120b,…` | Only used when discovery is off or the provider will not answer |
| `GEMINI_API_KEY` | | Up to six keys, same rules |
| `GEMINI_MODEL` | `gemini-2.5-flash` | Same: a preference, not a requirement |
| `GEMINI_MODEL_FALLBACKS` | `gemini-2.0-flash,…` | |
| `MODEL_AUTO_DISCOVER` | `true` | Ask each provider what it has. False pins the models above exactly. |
| `MODEL_CATALOG_TTL_MS` | `1800000` | How long a model list is trusted |
| `MODEL_LADDER_MAX` | `5` | How far down the list one call will walk |
| `LLM_PROVIDER_ORDER` | `groq,gemini` | |
| `LLM_TIMEOUT_MS` | `30000` | |
| `LOCAL_ENGINE_ENABLED` | `true` | Set false to make a failed model call stop the step instead of falling back |

**Finding prospects**

| Variable | Default | What it is |
|---|---|---|
| `DISCOVERY_SOURCE` | `auto` | `auto`, `apollo`, `llm` or `none` |
| `DISCOVERY_MAX_PER_RUN` | `25` | |
| `APOLLO_API_KEY` | | Apollo → Settings → Integrations → API |
| `APOLLO_REVEAL_EMAILS` | `false` | Spends one credit per person when true |
| `APOLLO_TIMEOUT_MS` | `20000` | |

**Running**

| Variable | Default | What it is |
|---|---|---|
| `JOB_CONCURRENCY` | `2` | Prospects worked on at once during a run |
| `JOB_LOCK_TTL_MS` | `300000` | After this, a lock is assumed abandoned |
| `WORKER_ENABLED` | `false` | Background worker. Off so it does not move prospects during a demo. |
| `WORKER_POLL_MS` | `30000` | |
| `WORKER_BATCH_SIZE` | `5` | |
| `PORT` | `3001` | Do not set this on Railway |
| `SHUTDOWN_GRACE_MS` | `1500` | How long an in-flight request gets before its socket is ended |
| `SHUTDOWN_TIMEOUT_MS` | `8000` | Hard stop, so a wedged process cannot hold the port |
| `COST_PER_1K_TOKENS_USD` | `0.015` | Used when the provider reports no usage |

---

## 11. Checking that it works

### The offline suite

```bash
npm --prefix server run check
```

Three files, 190 checks, no network and no database. Every assertion is about
logic that has broken at least once.

`scripts/verify.js` (139 checks) covers the agent registry, loose JSON parsing,
every coercion path, empty-output detection, the local rule engine's scoring and
intent classification, the key pool, provider error classification, the Apollo
mapping, discovery coercion, job event trimming and campaign readiness.

`scripts/verify-failover.js` (19 checks) replaces `fetch` with a script and
exercises the real provider walk against providers that misbehave on cue. Six
stories:

1. a rate-limited key falls through to the next key on the same provider
2. every Groq key out means Gemini takes over, and Gemini is untouched
3. a retired model name climbs the model ladder without blaming the key
4. the next call goes straight to the model that worked
5. a malformed request gives up after one key instead of burning all six
6. cancelling aborts the in-flight call, quickly, without benching the key

Story 3 is there because it was a real bug. A 404 naming the model benched the
key it was tried on. With one key configured that took the only key out of
service, the retry on the fallback model then found an empty pool, and the call
failed with "every key is cooling down", which sends you looking at your keys
for a problem that was one wrong model string.

No model name appears in an assertion in that file. They are declared once at
the top and every check reads them back out of `process.env`, because an
earlier version pasted the literal strings into the assertions and changing a
default in `.env` broke the suite for a reason unrelated to what it was
testing.

`scripts/verify-models.js` (29 checks) covers discovery itself: ranking that
excludes safety, speech and embedding models; a configured model that exists
being tried first; a configured model that has been retired not breaking the
call; named fallbacks honoured only when real; a provider that will not answer
falling back to the environment with the reason recorded; a rejected key
reported as a key problem rather than a model problem; Gemini's differently
shaped response; and the cache not re-fetching on every call.

### Live checks

| Endpoint | What it tells you |
|---|---|
| `GET /health` | Database reachable, what is configured, every key's state |
| `GET /health/schema` | Which tables exist. Names `job_runs` specifically if `04-runtime.sql` has not been run. |
| `GET /health/providers` | Key states plus a one-record Apollo search that spends no credits |
| `GET /agents/keys` | The key panel's data: every key, redacted, with its state and history |
| `GET /agents/models` | Every model your keys can actually reach, ranked. Where to look when a model name is rejected. |
| `POST /agents/models/refresh` | Ask the providers again now, without waiting for the cache or redeploying |
| `GET /agents/routing` | Which engine each agent would use on its next call, and which discovery source is active |

And from the app itself: the Agents screen playground fires one real call and
shows every stage of it.

---

## 12. How the numbers are counted

Everything is counted from rows at the moment it is asked for. Nothing is
stored, incremented or cached, so a number on screen cannot drift away from the
data behind it.

The funnel is cumulative. Anyone who reached `contacted` was necessarily
researched and qualified first, so they count at every earlier stage too.
Without that, a prospect moving forward makes an earlier bar go down, which is
the most common way a funnel chart lies. The assumption is printed under the
chart.

"Usable output" counts clean successes and degraded runs together, because both
produced output the pipeline could act on. Degraded is reported separately: it
means the first attempt failed and either a retry or the built-in engine
answered instead.

An agent with no runs shows blank rates, not 100%.

A local run finishes in under a millisecond and reports 0ms. That is a
measurement, not a missing value, so it is not turned into a dash.

---

## 13. Folder structure

```
server/
  db/
    01-schema.sql            twelve tables, the original schema
    02-seed.sql              optional demo data
    03-add-llm-engine.sql    earlier migration
    04-runtime.sql           jobs, locks, run attribution, discovery sources
  scripts/
    verify.js                139 offline checks
    verify-failover.js       19 checks against scripted providers
  src/
    agents/
      keyPool.js             up to six keys per provider, health and rotation
      llmEngine.js           the provider walk: keys, then models, then providers
      client.js              the one way anything calls an agent
      schemas.js             coercion and validation per agent
      localEngine.js         the deterministic fallback
      registry.js            one id per agent, used as the key everywhere
    orchestrator/
      index.js               advance: one prospect, one step
      gate.js                the six checks, in one place
      jobs.js                the job runner, locking and cancellation
    services/
      discovery/
        index.js             source selection, dedupe, writing
        apollo.js            the real search
      knowledge.js           lexical retrieval
      activity.js            the timeline and approvals
      metrics.js             every number, counted from rows
      mappers.js             database row to API shape
    routes/                  one file per resource
    config.js                every environment variable, declared once
    worker.js                the optional background loop

src/
  api/                       one function per endpoint
  components/
    JobWatcher.jsx           polling a job, and the progress panel
    NewCampaign.jsx          the four-step builder
    ui.jsx                   shared primitives
  pages/                     one file per screen
  styles/app.css             one stylesheet, no component library
```

---

## 14. What is not built, and why

These are real gaps. They are listed here rather than hidden because a system
that overstates what it does is harder to trust about the parts it gets right.

**No email or LinkedIn provider is connected.** A message marked "sent" is
recorded, not delivered. Everything up to that point is real: the message is
written by a model, grounded in real research, approved by a person, and
recorded against the prospect.

**No inbox.** Replies are typed in by hand on the prospect page. They then go
through the identical classify-and-route logic a real inbox would feed, so the
conversation agent and every state change it triggers are genuinely exercised.

**Retrieval is lexical, not vector based.** Term overlap, not embeddings. The
Knowledge screen says so, and shows you what a given query would retrieve.

**One workspace, no multi-tenancy.** There is no organisation boundary.

**Cost is estimated** at four characters per token unless the provider reports
real usage.

**Voice is registered and gated but not implemented.** It is wired through the
same stop controls and suppression checks as every other channel, and it places
no calls. The UI says so rather than showing an idle tile that implies
otherwise.

---

## 15. When something goes wrong

Three failures that cost real time, what caused them, and what now happens
instead.

### `EADDRINUSE: address already in use 0.0.0.0:3001`

**What you saw.** Edit a file, `node --watch` restarts, the new server crashes
on the port. Worse, the old process kept running, so the app carried on
working while serving the environment variables you had just changed.

**The cause.** `server.close()` stops accepting new connections but waits for
open ones to end by themselves. The app polls a running job every 1.5 seconds
over a keep-alive connection, which never ends. So `close()` never completed,
the old process never exited, and it held the port.

**What happens now.** The server tracks every open socket and ends them itself
during shutdown, so the port is genuinely released. `SIGINT`, `SIGTERM`,
`SIGUSR2` and `SIGBREAK` are all handled, in-flight jobs are cancelled first,
and a crash releases the port too. Measured: 111ms to exit with a keep-alive
socket held open, and the next instance binds on its first try.

If it still happens, the port is held by something that is not this server,
and the error message now tells you how to find it:

```
netstat -ano | findstr :3001
taskkill /PID <the number in the last column> /F
```

Or run this one elsewhere: `PORT=3002 npm run dev`

### `The model X has been decommissioned`

**What you saw.** Everything worked, then one morning every agent call failed
with `Every provider failed`. Checking keys found nothing wrong, because
nothing was wrong with the keys.

**The cause.** A hand-written ladder of model names in `.env` and `config.js`.
The provider retired the model; the config did not know.

**What happens now.** The ladder is asked for, not written down. See
[section 4](#models-are-discovered-not-declared). Your configured model is
still tried first when it exists; when it does not, the best available one is
used and the log names it. To see the current list: `GET /agents/models`, or
**Recheck models** on the Agents screen.

### A test failing because a model name changed

**What you saw.** `FAIL it goes straight to the working model`, right after
editing `.env`.

**The cause.** `verify-failover.js` had model names pasted into its
assertions, so the tests were checking the contents of a config file rather
than the behaviour of the engine.

**What happens now.** The models are declared once at the top of that file and
every assertion reads them back from `process.env`. Change the names and the
tests still pass, because what they are testing did not change.

### Anything else

Every request carries an `x-request-id`, echoed in the response header and
printed in the API log with the status and duration. Copy it out of the
browser network tab and grep the Railway log for it.

Then, in order: `/health` for configuration, `/health/schema` for the
database, `/health/providers` for keys and models, and the Agents screen
playground for the full trace of any failing agent call.

---

## 16. About DronaHQ

The brief wanted DronaHQ as the agent engine. It was fully wired: all five
agents, correct webhook payloads, correct auth headers. Every single one
answered in Background mode, returning `{"run_id": …, "thread_id": …}` instead
of the agent's actual output. That is a setting on DronaHQ's side (Webhook
trigger → Configure Response → Background versus Standard) and it cannot be
changed from the client.

The choice was to ship something that looks connected and produces nothing, or
to run the intelligence layer on real models. All DronaHQ transport code was
deleted and replaced with direct Groq and Gemini calls.

This is a known trade-off, stated plainly rather than papered over. The
"DronaHQ mandatory" judging category will score low. Everything else, the
intelligence, the personalisation, the control plane and the engineering, is
intact and arguably better for it: the fallback chain, the key pool and the
model ladder all exist because they had to replace something that was supposed
to be handled for us.
