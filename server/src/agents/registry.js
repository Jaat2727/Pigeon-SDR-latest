/**
 * The agent registry. One id per agent, used as the primary key everywhere:
 * in agent_runs.agent_name, in activities.agent_name, in prompt_versions,
 * and in the pause map. Display names are for screens only and are never
 * stored.
 *
 * `engine` is what an agent is meant to run on: `llm` for the ones that
 * reason over a prospect (Groq, then Gemini — see llmEngine.js), `our_engine`
 * for the one that is deliberately deterministic. `callable` marks the agents
 * that exist. Follow-up timing has no model behind it by design; voice is
 * planned and gated but not implemented, and the UI says so rather than
 * showing an idle tile that implies otherwise.
 *
 * `takes` and `gives` exist for the Agents screen. An agent list that only
 * gives each one a name and a paragraph leaves a reader with no idea what
 * actually flows between them, and the handoffs are the interesting part.
 */

export const AGENT_REGISTRY = [
  {
    id: 'discovery',
    name: 'Prospect Discovery',
    engine: 'llm',
    callable: true,
    order: 0,
    stage: 'sourcing',
    takes: 'The campaign ICP, exclusions, target roles, industry and headcount band',
    gives: 'Candidate companies, and the job title worth approaching at each one',
    description:
      'Finds people to put into a campaign. With an Apollo key it searches their database and returns real records; without one it asks the model for candidate companies and roles, labelled as unverified leads. It never invents an email address either way.',
  },
  {
    id: 'research',
    name: 'Research & Enrichment',
    engine: 'llm',
    callable: true,
    order: 1,
    stage: 'pipeline',
    takes: 'A thin prospect record: a name, a title, a company, maybe an email',
    gives: 'A filled profile, plus the list of fields it could not source',
    description:
      'Turns a thin prospect record into a profile. Returns null for anything it cannot source and names those fields, rather than filling gaps with plausible guesses.',
  },
  {
    id: 'icp_fitment',
    name: 'ICP Fitment',
    engine: 'llm',
    callable: true,
    order: 2,
    stage: 'pipeline',
    takes: 'The enriched profile and the campaign ICP and exclusion criteria',
    gives: 'A score out of 100 and one of qualify, reject or needs_review',
    description:
      'Scores a prospect against the campaign ICP and returns qualify, reject or needs_review. Exclusions are checked before scoring, so a match is a reject whatever the score would have been.',
  },
  {
    id: 'outreach_strategy',
    name: 'Outreach Strategy',
    engine: 'llm',
    callable: true,
    order: 3,
    stage: 'pipeline',
    takes: 'The profile, the ICP verdict, the enabled channels and the outreach policy',
    gives: 'A touch sequence with a channel and a day offset per step, or a decision not to contact',
    description:
      'Plans the touch sequence across the channels the campaign allows. Allowed to decide not to contact someone at all, and that decision is respected rather than overridden.',
  },
  {
    id: 'personalisation',
    name: 'Personalisation',
    engine: 'llm',
    callable: true,
    order: 4,
    stage: 'pipeline',
    takes: 'One step of the sequence, the profile, the thread so far and the retrieved knowledge',
    gives: 'One message: subject, body, and what it drew on to write it',
    description:
      'Writes one message for one step, grounded in the research and the knowledge base. Hands the message to a human instead of sending when it has nothing specific to say.',
  },
  {
    id: 'conversation',
    name: 'Conversation',
    engine: 'llm',
    callable: true,
    order: 5,
    stage: 'inbound',
    takes: 'An inbound reply and the prospect it came from',
    gives: 'An intent, a sentiment, extracted facts and what should happen next',
    description:
      'Reads an inbound reply, classifies the intent, extracts facts, and decides what happens next. Opt-outs and anything touching pricing or procurement go to a person.',
  },
  {
    id: 'followup_timing',
    name: 'Follow-up Timing',
    engine: 'our_engine',
    callable: true,
    order: 6,
    stage: 'pipeline',
    takes: 'The planned sequence and the campaign working hours',
    gives: 'A real timestamp per touch, rolled off weekends and out of hours',
    description:
      'Decides when the next touch goes out. Deterministic on purpose: working hours, weekends and the gap since the last touch are arithmetic, and a model would only add variance.',
  },
  {
    id: 'voice_sdr',
    name: 'Voice SDR',
    engine: 'llm',
    callable: false,
    order: 7,
    stage: 'pipeline',
    takes: 'Nothing yet',
    gives: 'Nothing yet',
    description:
      'Planned. The voice channel is wired through the same stop controls and the same suppression checks as every other channel, but no calls are placed. Nothing in the app pretends otherwise.',
  },
  {
    id: 'system',
    name: 'System',
    engine: 'our_engine',
    callable: false,
    order: 99,
    stage: 'system',
    description: 'Actions taken by the platform itself rather than by an agent.',
  },
];

const BY_ID = new Map(AGENT_REGISTRY.map((a) => [a.id, a]));

export const CALLABLE_AGENTS = AGENT_REGISTRY.filter((a) => a.callable).map((a) => a.id);

/** Agents that appear on the Agents screen. */
export const VISIBLE_AGENTS = AGENT_REGISTRY.filter((a) => a.id !== 'system').sort(
  (a, b) => a.order - b.order
);

/**
 * The per-prospect pipeline, in the order the orchestrator runs it. Discovery
 * is not in here: it creates prospects rather than advancing one, so it runs
 * as its own job against a campaign.
 */
export const PIPELINE = ['research', 'icp_fitment', 'outreach_strategy', 'personalisation'];

export const getAgent = (id) => BY_ID.get(id) ?? null;

export const getAgentName = (id) => BY_ID.get(id)?.name ?? id;

export const getAgentEngine = (id) => BY_ID.get(id)?.engine ?? 'our_engine';

export const isAgent = (id) => BY_ID.has(id);

export default AGENT_REGISTRY;
