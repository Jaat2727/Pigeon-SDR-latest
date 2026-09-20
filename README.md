# Pigeon · Autonomous SDR

Outbound prospecting run by agents, with a person in the loop and four ways to stop it.

Five agents — running on Groq, then Gemini — research a prospect, score them against a written ICP, plan a sequence, write each message and read replies. A sixth decides timing deterministically. Everything a human has to look at lands in one queue.

Built for the Inter Guild Buildathon 2026 (IIT Madras × DronaHQ). DronaHQ was the original plan for the intelligence layer, per the brief: it was wired, all five agents configured and tested, and dropped once every one of them answered in Background mode (a run acknowledgement, never the model's actual output) — a platform-side setting, not something fixable from this side. Rather than ship an integration that silently produces nothing, the intelligence layer runs on Groq and Gemini directly. See [§6](#6-the-llm-engine) for what that decision cost and what it bought.

---

## Contents

1. [What it does](#1-what-it-does)
2. [Architecture](#2-architecture)
3. [The six decisions that shape it](#3-the-six-decisions-that-shape-it)
4. [What works, what is partial, what is not built](#4-what-works-what-is-partial-what-is-not-built)
5. [Deploying it](#5-deploying-it)
6. [The LLM engine](#6-the-llm-engine)
7. [Running it locally](#7-running-it-locally)
8. [Environment variables](#8-environment-variables)
9. [Folder structure](#9-folder-structure)
10. [Tests](#10-tests)
11. [Driving the demo](#11-driving-the-demo)
12. [How the numbers are counted](#12-how-the-numbers-are-counted)
13. [Security](#13-security)
14. [Known limitations](#14-known-limitations)

---

## 1. What it does

Give it a list of prospects and a campaign written in plain sentences. It then, per prospect:

1. **Researches** them into a structured profile, returning null for anything it cannot source and naming those fields.
2. **Scores** them against the ICP and returns `qualify`, `reject` or `needs_review`. Exclusions are checked before scoring, so a match is a reject whatever the score would have been.
3. **Plans** a sequence across the channels the campaign allows, or decides not to contact them at all.
4. **Writes** each message grounded in the research and the knowledge base, or refuses and hands it to a person.
5. **Reads** the reply, classifies the intent, and moves the prospect according to what they actually said.

A person approves anything that goes out. Four independent switches stop it.

---

## 2. Architecture

```
  Browser                     API                          Data
  ─────────────────────       ──────────────────────       ────────────────────
  React 19 + Vite             Express 4                    Supabase Postgres
  Vercel                      Railway                      12 tables
       │                           │                             │
       │  every screen ───────────►│  service role key ─────────►│
       │  reads the API only       │                             │
       │                           │                             │
       │                           ▼
       │                      LLM engine — Groq, then Gemini
       │                      ┌─────────────────────────────┐
       │                      │ research                    │
       │                      │ icp_fitment                 │
       │                      │ outreach_strategy           │
       │                      │ personalisation             │
       │                      │ conversation                │
       │                      └─────────────────────────────┘
       │                           │ not configured, or every
       │                           │ configured provider fails
       │                           ▼
       │                      Local engine (deterministic)
       │                      every run labelled with the
       │                      engine that produced it
       ▼
  Supabase anon key
  sign-in only, never data
```

### The pipeline

```
discovered ──research──► researched ──icp_fitment──► qualified
                                                  ├► rejected      (terminal)
                                                  └► needs_review  → queue

qualified ──outreach_strategy──► strategy_planned
                               └► stopped        (agent decided not to contact)

strategy_planned ──personalisation──► message drafted
                                    ├► pending approval → queue → sent → contacted
                                    └► needs_human      → queue

contacted ──(reply arrives)──► conversation ──► engaged / meeting / stopped / opted_out
```

Every arrow passes the gate first. The gate is one function, called from one place.

### The seven agents

| Agent | Engine | Built | What it decides |
|---|---|---|---|
| Research & Enrichment | Groq → Gemini | yes | What is known about this person, and what is not |
| ICP Fitment | Groq → Gemini | yes | qualify, reject, or needs_review |
| Outreach Strategy | Groq → Gemini | yes | Whether to contact at all, and the sequence if so |
| Personalisation | Groq → Gemini | yes | The message, or a refusal to write one |
| Conversation | Groq → Gemini | yes | What a reply means and what happens next |
| Follow-up Timing | ours | yes | When the next touch goes out |
| Voice SDR | Groq → Gemini | **no** | Planned and gated, not implemented |

Follow-up timing is deterministic on purpose. Working hours, weekends and the gap since the last touch are arithmetic; a model would only add variance to a calculation that has one right answer.

---

## 3. The six decisions that shape it

**Funnel state lives per campaign, never per person.** `campaign_prospects` holds the state, score and verdict. The same person can be qualified for one campaign and rejected by another on the same day, and both are true. There is deliberately no `state` column on `prospects`.

**Not sure is a first-class answer.** `needs_review` sits beside `qualify` and `reject`. A prospect the system cannot place is different from one who does not fit, and collapsing them either loses good prospects or emails bad ones.

**A fallback that hides itself is worse than no fallback.** When Groq and Gemini both fail, the deterministic local engine answers, and the run is written with `engine = 'local_engine'`. Every screen badges it. The agent performance numbers are counted from those rows.

**Nothing unsourced goes out.** Every claim about a prospect must come from a field in the research; every claim about the product from a chunk in the knowledge base. With nothing specific to say, the agent sets `needs_human` and the message goes to the queue instead.

**Exclusions are SQL, not memory.** The suppression list is matched with a predicate before any outbound action. A model is never asked to remember who is off limits.

**History is append-only and nothing is seeded into it.** `activities`, `agent_runs` and `messages` are written only by real runs. The seed file touches none of them. Every number on screen is counted from rows at the moment it is asked for.

---

## 4. What works, what is partial, what is not built

### Fully working

- All five intelligence agents, running on Groq then Gemini, with coercion, schema validation, one retry carrying the error back to the model, and a deterministic fallback.
- Three-state ICP verdict, with exclusions evaluated before scoring.
- Per-campaign isolation, visible on the prospect page as two verdicts side by side.
- Sequence planning across enabled channels, with a stated touch count respected and weekends handled.
- Message drafting grounded in retrieved knowledge, with a refusal path.
- Reply classification across twelve intents, with opt-out written to the global suppression list.
- Duplicate detection when two live campaigns work the same person, which holds outbound until resolved.
- One approval queue covering all four kinds of human decision.
- Four levels of stopping, all read through the same gate the pipeline uses.
- Prompt editing per campaign per agent, versioned, sent on the next call.
- A test call per agent that fires one real request and shows the raw response.
- A retrieval preview so "grounded in your knowledge base" can be checked rather than believed.

### Partially working

- **Delivery is simulated.** No email or LinkedIn provider is connected. An approved message is recorded as sent and the UI says so on the thread. Wiring a provider is one function.
- **Inbound is typed in.** There is no mailbox. A reply entered on the prospect page goes through the identical path a real one would.
- **Retrieval is lexical**, not embeddings. Term overlap normalised for chunk length, with a boost for the chunk types that matter to the step. Swapping in pgvector means replacing one scoring function.
- **Cost is estimated** at four characters per token when the provider reports none.

### Not built

- **Voice.** Registered, gated through the same stop controls and suppression checks, and it runs nothing. The Agents screen says "not built" rather than showing an idle tile that implies otherwise.
- **CSV import.** Prospects are added one at a time or through the seed file.
- **Multi-tenant.** One workspace.
- **DronaHQ, deliberately.** It was the original plan for the intelligence layer and was fully wired and tested — all five agents, correct webhook shapes, correct payloads. Every one answered in Background mode (a run acknowledgement, never the output), which is a setting on DronaHQ's side and not fixable from this codebase. Rather than ship an integration that silently produces nothing, the intelligence layer runs on Groq and Gemini instead. See [§6](#6-the-llm-engine).

---

## 5. Deploying it

Three services. Do them in this order; each needs the one before it.

### Step 1 · Supabase

1. Create a **new** Supabase project.
2. Open the **SQL Editor**.
3. Paste all of `server/db/01-schema.sql` and press Run. You want `Schema applied. 12 tables created.`
4. Paste all of `server/db/02-seed.sql` and press Run. You want three campaigns, thirteen prospects, and **zero** activities and agent runs. That zero is the point: nothing has happened yet.
5. Go to **Project Settings → API** and copy the project URL and the **service_role** key.

Row level security is left off. The API connects with the service role, which bypasses it either way, and the browser never reads these tables. Do not add a permissive `anon` read policy: `prospects` holds real contact data.

### Step 2 · Railway (the API)

1. Push this repository to GitHub.
2. In Railway, create a project from it.
3. Set the service **root directory** to `server`.
4. Under **Variables**, add:

   ```
   SUPABASE_URL=https://your-project-id.supabase.co
   SUPABASE_SERVICE_ROLE_KEY=your-service-role-key
   CORS_ORIGINS=http://localhost:5173
   NODE_ENV=production
   ```

   You will come back and add the Vercel URL to `CORS_ORIGINS` in step 4.

5. Deploy. Railway reads `server/railway.json` and `server/nixpacks.toml`, which pin **Node 22**.
6. Under **Settings → Networking**, generate a domain and set the target port to **3001**. That is what the server listens on when `PORT` is absent, so it is correct whether or not the platform injects one. **Do not add a `PORT` variable by hand.**
7. Open `https://your-api.up.railway.app/health`. You want `"status": "ok"` and `"database": "connected"`.
8. Open `https://your-api.up.railway.app/health/schema`. You want `"ok": true` and no missing tables.

If either is wrong, the response names the missing variable or the absent table. The server starts either way rather than crash-looping, so it can tell you what is wrong.

### Step 3 · Vercel (the frontend)

1. Import the same repository. Leave the root directory at the repo root.
2. Framework preset: **Vite**. Build command `npm run build`, output `dist`.
3. Under **Environment Variables**, add:

   ```
   VITE_API_BASE_URL=https://your-api.up.railway.app
   ```

   No trailing slash. Vite bakes this in at build time, so changing it later needs a redeploy.

4. Optionally add `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` to require a real sign-in. Leave them out and the app opens with one click and says so on the entry screen.
5. Deploy.

### Step 4 · Close the loop

1. Copy your Vercel URL.
2. Back in Railway, set `CORS_ORIGINS` to include it:

   ```
   CORS_ORIGINS=http://localhost:5173,https://your-app.vercel.app
   ```

   Once one `.vercel.app` origin is listed, preview deploys are allowed automatically.

3. Railway redeploys. Open your Vercel URL. The sidebar should say **API connected**.

### Step 5 · The LLM engine

Required to get a fully working site rather than one running on the deterministic fallback. See the next section — it is two environment variables, not a platform to configure.

---

## 6. The LLM engine

### Why not DronaHQ

DronaHQ was the original plan for the intelligence layer, per the brief. All five agents were wired against real DronaHQ webhooks — correct payload shapes, correct headers, per-campaign `_system_prompt` / `_agent_prompt` carried through. Every one of them answered in Background mode: `{"run_id": ..., "thread_id": ...}` instead of the model's actual output. That is a setting on the DronaHQ side (Webhook trigger → Configure Response → Background vs Standard) and cannot be fixed from outside DronaHQ. Rather than ship an integration that demos as "connected" while silently producing nothing, the intelligence layer calls Groq and Gemini directly instead. The DronaHQ transport code was removed, not disabled — `server/src/agents/dronahq.js` no longer exists, and nothing in the codebase calls out to DronaHQ.

### How it works

`server/src/agents/llmEngine.js` builds one prompt per agent — a role description, the exact JSON shape expected, and the campaign's own `_system_prompt` / `_agent_prompt` from the prompt editor — and calls Groq, then Gemini, in the order named by `LLM_PROVIDER_ORDER`. `GROQ_API_KEY` may hold more than one key, comma separated: a rate-limited or rejected first key falls through to a second one before the pipeline ever tries Gemini. The response is validated through the identical schema and coercion every agent's output goes through, so a malformed answer from either provider is caught exactly the same way a malformed DronaHQ response would have been. Leave both `GROQ_API_KEY` and `GEMINI_API_KEY` blank and the pipeline runs on the deterministic local engine instead — nothing crashes, every run just says which engine produced it.

### Variables

```
GROQ_API_KEY          one or more, comma separated
GROQ_MODEL            default llama-3.3-70b-versatile
GEMINI_API_KEY
GEMINI_MODEL           default gemini-3.6-flash
LLM_PROVIDER_ORDER     default groq,gemini
LLM_TIMEOUT_MS         default 30000
```

Partial is fine. Set only one provider's key and the other is simply never tried.

### Checking it

Open the deployed app, go to **Agents**, click **Send a test call**. It fires one real request with a realistic payload and writes nothing to the database. The result names the problem:

| Result | What to do |
|---|---|
| Responded with valid output | Done. The badge turns from Fallback to `AI (Groq/Gemini)`. |
| Not configured | Neither `GROQ_API_KEY` nor `GEMINI_API_KEY` is set in Railway. |
| Did not match the expected schema | The model answered with the wrong shape. Expand the raw response and compare. Usually one field name or one enum spelling. |
| Every provider failed | Expand the error — it lists each provider's own reason. Almost always an invalid or rate-limited key; check the raw HTTP status in the message. |

`GET /agents/routing` returns which engine each of the five will use right now.

### What happens when an agent misbehaves

1. The response is parsed loosely (a model asked for JSON only can still wrap it in markdown fences or a sentence of preamble).
2. It is reshaped: numbers as strings, arrays as stringified JSON, alternate field names, `"qualified"` for `"qualify"`.
3. It is validated. If every load-bearing field is null, that is treated as a failure rather than written as an empty record.
4. One retry, with the validation error appended to the prompt so the model is told what was wrong.
5. The local engine answers, and the run is recorded as `degraded` with `engine = 'local_engine'`.

---

## 7. Running it locally

```bash
npm install
npm --prefix server install

cp .env.example .env                 # set VITE_API_BASE_URL=http://localhost:3001
cp server/.env.example server/.env   # set your Supabase URL and service role key

npm --prefix server run dev          # API on 3001
npm run dev                          # app on 5173
```

Node 22 or later. Node 20 works because `server/src/db/client.js` supplies a WebSocket transport, but 22 is the supported floor.

---

## 8. Environment variables

### Frontend (`.env`, and Vercel)

| Variable | Required | What it is |
|---|---|---|
| `VITE_API_BASE_URL` | yes | The Railway API URL, no trailing slash |
| `VITE_SUPABASE_URL` | no | Set with the anon key to require sign-in |
| `VITE_SUPABASE_ANON_KEY` | no | The only Supabase key allowed in a browser |

### API (`server/.env`, and Railway)

| Variable | Required | Default | What it is |
|---|---|---|---|
| `SUPABASE_URL` | yes | | Project URL |
| `SUPABASE_SERVICE_ROLE_KEY` | yes | | Service role key. Server only. |
| `CORS_ORIGINS` | yes in production | localhost | Comma separated, no trailing slashes |
| `HOST` | no | `0.0.0.0` | Must not be localhost on Railway |
| `PORT` | no | `3001` | Do not set on Railway |
| `GROQ_API_KEY` | no | | The intelligence layer, tried first. Comma-separate more than one key. |
| `GROQ_MODEL` | no | `llama-3.3-70b-versatile` | |
| `GEMINI_API_KEY` | no | | Tried second, or first if Groq is not set |
| `GEMINI_MODEL` | no | `gemini-3.6-flash` | |
| `LLM_PROVIDER_ORDER` | no | `groq,gemini` | Comma list; only entries with a key set are tried |
| `LLM_TIMEOUT_MS` | no | `30000` | |
| `WORKER_ENABLED` | no | `false` | Advance prospects without anyone watching |
| `WORKER_POLL_MS` | no | `30000` | |
| `WORKER_BATCH_SIZE` | no | `5` | |
| `MAX_AGENT_CALLS_PER_DAY` | no | `250` | |
| `AGENT_TIMEOUT_MS` | no | `45000` | |
| `LOCAL_ENGINE_ENABLED` | no | `true` | False makes a failed call stop the step |
| `COST_PER_1K_TOKENS_USD` | no | `0.015` | Used when the provider reports no usage |

---

## 9. Folder structure

```
├── index.html
├── vercel.json                      SPA rewrites for client-side routing
├── src/
│   ├── main.jsx
│   ├── App.jsx                      shell, sidebar, routing, connection banner
│   ├── styles/app.css               the entire design system, one file
│   ├── api/
│   │   ├── client.js                fetch, errors, no mock mode
│   │   └── index.js                 one function per endpoint
│   ├── lib/auth.js                  Supabase auth only; never reads data
│   ├── context/AppContext.jsx       user, connection, campaigns, queue, polling
│   ├── components/
│   │   ├── ui.jsx                   shared primitives
│   │   └── NewCampaign.jsx          the create-campaign modal
│   └── pages/
│       ├── Login.jsx
│       ├── Dashboard.jsx            every campaign at a glance, real counts only
│       ├── Queue.jsx                home: pipeline, approvals, history
│       ├── Prospects.jsx            list, one row per prospect per campaign
│       ├── ProspectDetail.jsx       verdicts, timeline, thread, profile, runs
│       ├── Campaigns.jsx            targeting, execution, prompt editor, lifecycle
│       ├── Agents.jsx               status, runs, the Groq/Gemini test call
│       ├── Knowledge.jsx            chunks and the retrieval preview
│       └── Controls.jsx             four levels of stopping, suppression
└── server/
    ├── nixpacks.toml                pinned Node 22 build plan
    ├── railway.json                 start command and health check
    ├── db/
    │   ├── 01-schema.sql            12 tables, from empty
    │   ├── 02-seed.sql              starting state, no fake history
    │   └── 03-add-llm-engine.sql    migration for a database created before llm_engine existed
    ├── scripts/verify.js            75 offline checks
    └── src/
        ├── index.js                 express app and boot report
        ├── config.js                every env var, declared once
        ├── worker.js                optional background advance
        ├── db/client.js             supabase client, soft error handling
        ├── lib/http.js              async handler and error shapes
        ├── lib/json.js              loose JSON parsing for model output
        ├── agents/
        │   ├── registry.js          the seven agents
        │   ├── llmEngine.js         Groq/Gemini transport and per-agent prompts
        │   ├── schemas.js           coercion and zod schemas per agent
        │   ├── localEngine.js       the deterministic fallback
        │   └── client.js            callAgent: LLM engine → local engine
        ├── orchestrator/
        │   ├── gate.js              the four stops plus suppression
        │   └── index.js             advance, replies, runCampaign
        ├── services/
        │   ├── activity.js          history, approvals, conflict detection
        │   ├── knowledge.js         lexical retrieval
        │   ├── metrics.js           everything counted from tables
        │   └── mappers.js           rows to API shapes
        └── routes/                  health, queue, campaigns, prospects, reps,
                                     agents, knowledge, controls
```

---

## 10. Tests

```bash
npm --prefix server run check
```

75 offline checks, no network and no database. They cover the registry, loose JSON parsing, coercion of every field type, empty-output detection per agent, and the local engine's scoring, exclusions, sequence planning, message writing and reply classification.

Every assertion is there because the behaviour broke at least once during the build. A few worth naming:

- A geographic exclusion ("outside India") must not reject Indian prospects.
- A full title must match an abbreviated target role. A CIO campaign was scoring actual CIOs as a mismatch.
- A campaign's stated touch count must be respected. Writing "two touches" and getting four teaches an operator that the field is decoration.
- A reply mentioning pricing must route to a human whatever its intent.

The frontend lints clean and builds clean:

```bash
npx eslint .
npm run build
```

---

## 11. Driving the demo

The seed deliberately leaves the history empty. Everything below is created live.

1. **Open the app.** The pipeline shows 15 discovered and nothing else. The queue is empty. That is the truthful starting state.
2. **Press Run campaign** on the US SaaS CTOs campaign. It researches, scores, plans and drafts in one pass.
3. **Watch the history fill.** Every line was written by that run. The engine badge on each says which engine produced it.
4. **Open the queue.** Six messages waiting, two prospects the scorer would not place, one duplicate conflict.
5. **Open Dev Anand.** Exactly the right title at a 4800-person company, against a campaign that states 50 to 2000. The system will not qualify him and will not reject him either. It asks.
6. **Open Vikram Shah.** Two campaigns, two verdicts, one conflict raised before either sends. Approving his message is refused while the conflict is open.
7. **Open Helen Okafor.** Qualified at 78 and suppressed. Research and scoring ran; the gate stopped her the moment anything outbound started.
8. **Approve a message.** It sends, the prospect moves to contacted, and a line lands in the history.
9. **Simulate a reply** on that prospect. Try `Sounds useful, can we talk Tuesday? Also what does pricing look like?` — it classifies as a meeting request and still routes to a human, because it mentions pricing.
10. **Simulate an opt-out** on another. Watch it land on the suppression list on the Controls screen, globally, not just in that campaign.
11. **Hit the kill switch**, press Run again, and watch nothing happen and the reason be stated.

---

## 12. How the numbers are counted

Nothing is stored, incremented or cached. Every figure is counted from rows when it is asked for, so a number on screen cannot drift from the data behind it.

- **The funnel is cumulative.** A prospect who reached `contacted` is counted at discovered, researched and qualified too. Without that, moving forward makes an earlier bar fall, which is the most common way a funnel chart lies. The assumption is printed under the strip.
- **Usable output** counts a clean success and a degraded one together, because both produced output the pipeline could act on. Degraded is reported separately: it means the first attempt failed and either a retry or the built-in engine answered.
- **An agent with no runs shows blanks**, not 100%.
- **Replies from people** excludes auto-replies and bounces, which the conversation agent marks.
- **Cost** is the provider's reported usage where available, otherwise four characters per token at `COST_PER_1K_TOKENS_USD`. It is an estimate and is labelled as one.

---

## 13. Security

- The Supabase **service_role** key lives only in the API environment. It is never sent to the browser, never in a `VITE_` variable, never in the repository. If it leaks, anyone can read and write the whole database.
- The browser sees only the **anon** key, and only for sign-in. No screen reads application data from Supabase directly.
- The API is the only component holding Groq/Gemini credentials.
- `.env` is gitignored. Check your repository has no `.env` anywhere; if it does, delete it and rotate the key.
- Only an allow-list of columns can be written through the campaigns API.
- Exclusions are enforced with SQL predicates, never by asking a model to remember.
- Row level security is off, and the API bypasses it regardless. If you turn it on, write the policies deliberately: `prospects` holds real names, emails and phone numbers.

---

## 14. Known limitations

- **Nothing is actually delivered.** Approving a message records it as sent. There is no provider behind it.
- **Retrieval is lexical.** Term overlap, not meaning. A chunk that says the same thing in different words will not be found.
- **The local engine is rule-based and shallow.** It reasons over fields already in the record and never invents. Without a Groq or Gemini key configured, research adds derivation rather than discovery, and scoring works from firmographics rather than judgement. Every such run is labelled Fallback.
- **Cost is an estimate** until a provider reports real token usage.
- **One workspace.** No tenancy, no roles. Anyone signed in can do anything.
- **The worker is not distributed.** One process polls. Two API instances would both pick up the same due prospects.
- **Conflict resolution is manual.** The system detects that two live campaigns are working the same person and stops, but does not choose.
