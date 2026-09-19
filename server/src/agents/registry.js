/**
 * The agent registry. One id per agent, used as the primary key everywhere:
 * in agent_runs.agent_name, in activities.agent_name, in prompt_versions,
 * in the pause map, and in the DronaHQ config. Display names are for screens
 * only and are never stored.
 *
 * `engine` is what an agent is meant to run on. `callable` marks the agents
 * that exist. Follow-up timing is deterministic by design and has no model
 * behind it; voice is planned and gated but not implemented, and the UI says
 * so rather than showing an idle tile that implies otherwise.
 */

export const AGENT_REGISTRY = [
  {
    id: 'research',
    name: 'Research & Enrichment',
    engine: 'dronahq',
    callable: true,
    order: 1,
    description:
      'Turns a thin prospect record into a profile. Returns null for anything it cannot source and names those fields, rather than filling gaps with plausible guesses.',
  },
  {
    id: 'icp_fitment',
    name: 'ICP Fitment',
    engine: 'dronahq',
    callable: true,
    order: 2,
    description:
      'Scores a prospect against the campaign ICP and returns qualify, reject or needs_review. Exclusions are checked before scoring, so a match is a reject whatever the score would have been.',
  },
  {
    id: 'outreach_strategy',
    name: 'Outreach Strategy',
    engine: 'dronahq',
    callable: true,
    order: 3,
    description:
      'Plans the touch sequence across the channels the campaign allows. Allowed to decide not to contact someone at all, and that decision is respected rather than overridden.',
  },
  {
    id: 'personalisation',
    name: 'Personalisation',
    engine: 'dronahq',
    callable: true,
    order: 4,
    description:
      'Writes one message for one step, grounded in the research and the knowledge base. Hands the message to a human instead of sending when it has nothing specific to say.',
  },
  {
    id: 'conversation',
    name: 'Conversation',
    engine: 'dronahq',
    callable: true,
    order: 5,
    description:
      'Reads an inbound reply, classifies the intent, extracts facts, and decides what happens next. Opt-outs and anything touching pricing or procurement go to a person.',
  },
  {
    id: 'followup_timing',
    name: 'Follow-up Timing',
    engine: 'our_engine',
    callable: true,
    order: 6,
    description:
      'Decides when the next touch goes out. Deterministic on purpose: working hours, weekends and the gap since the last touch are arithmetic, and a model would only add variance.',
  },
  {
    id: 'voice_sdr',
    name: 'Voice SDR',
    engine: 'dronahq',
    callable: false,
    order: 7,
    description:
      'Planned. The voice channel is wired through the same stop controls and the same suppression checks as every other channel, but no calls are placed. Nothing in the app pretends otherwise.',
  },
  {
    id: 'system',
    name: 'System',
    engine: 'our_engine',
    callable: false,
    order: 99,
    description: 'Actions taken by the platform itself rather than by an agent.',
  },
];

const BY_ID = new Map(AGENT_REGISTRY.map((a) => [a.id, a]));

export const CALLABLE_AGENTS = AGENT_REGISTRY.filter((a) => a.callable).map((a) => a.id);

/** Agents that appear on the Agents screen. */
export const VISIBLE_AGENTS = AGENT_REGISTRY.filter((a) => a.id !== 'system').sort(
  (a, b) => a.order - b.order
);

/** The pipeline, in the order the orchestrator runs it. */
export const PIPELINE = ['research', 'icp_fitment', 'outreach_strategy', 'personalisation'];

export const getAgent = (id) => BY_ID.get(id) ?? null;

export const getAgentName = (id) => BY_ID.get(id)?.name ?? id;

export const getAgentEngine = (id) => BY_ID.get(id)?.engine ?? 'our_engine';

export const isAgent = (id) => BY_ID.has(id);

export default AGENT_REGISTRY;
