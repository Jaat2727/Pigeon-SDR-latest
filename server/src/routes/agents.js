/**
 * Agents: what each one is doing, which engine and which key is actually
 * serving it, and a test call you can edit and re-run.
 *
 * The test call exists because the most common failure in an agent layer like
 * this is a silent one — a bad key, a rate limit, a retired model name, a
 * model answering with prose instead of JSON — and that is far easier to fix
 * when the deployed app names it than when the only evidence is a null column.
 */
import express from 'express';
import { supabase, unwrapSoft } from '../db/client.js';
import { asyncHandler, notFound, badRequest, intParam } from '../lib/http.js';
import { VISIBLE_AGENTS, getAgent } from '../agents/registry.js';
import { getSystemControl, setSystemControl } from '../orchestrator/gate.js';
import { computeAgentPerformance } from '../services/metrics.js';
import { probeAgent } from '../agents/client.js';
import { configuredLlmProviders, activeModels } from '../agents/llmEngine.js';
import { keyHealth, reviveKey, reviveAll } from '../agents/keyPool.js';
import { env, isLlmEngineConfigured, configReport, discoveryRouting } from '../config.js';
import { logActivity } from '../services/activity.js';
import { mapRun } from '../services/mappers.js';

const router = express.Router();

/**
 * Realistic-shaped input per agent, so a test call exercises the real path.
 * Each one carries a short label, because the point of the playground is to
 * let someone change the input and watch the output change, and that only
 * works if they can see what they are changing.
 */
const SCENARIOS = {
  discovery: [
    {
      id: 'saas_cto',
      label: 'B2B SaaS CTOs',
      description: 'A normal ICP with a clear role and headcount band.',
      payload: {
        campaign: {
          name: 'US SaaS CTO outreach',
          objective: 'Book qualified discovery calls',
          icp_criteria: 'B2B SaaS companies in the US, 50 to 2000 employees, post Series A.',
          exclusion_criteria: 'Agencies, consultancies and competitors.',
          target_roles: ['CTO', 'VP Engineering'],
          industry: 'B2B SaaS',
          company_size: '50-2000',
        },
        how_many: 5,
      },
    },
    {
      id: 'vague',
      label: 'A deliberately vague ICP',
      description: 'Checks the agent flags what it cannot pin down instead of inventing companies.',
      payload: { campaign: { name: 'Untitled', icp_criteria: 'good companies' }, how_many: 3 },
    },
  ],
  research: [
    {
      id: 'thin',
      label: 'A thin record',
      description: 'A name, a title and a domain. Watch which fields come back null.',
      payload: {
        prospect: {
          stub: {
            first_name: 'Test',
            last_name: 'Prospect',
            title: 'CTO',
            email: 'test@example.com',
            company_name: 'Example Inc',
            company_domain: 'example.com',
          },
        },
        campaign: { research_focus: 'funding and hiring signals', name: 'Test' },
      },
    },
    {
      id: 'nameless',
      label: 'Almost nothing',
      description: 'A company and nothing else. A good agent says so rather than filling it in.',
      payload: { prospect: { stub: { company_domain: 'example.com' } }, campaign: { name: 'Test' } },
    },
  ],
  icp_fitment: [
    {
      id: 'clean_fit',
      label: 'A clean fit',
      description: 'Matches the ICP on every dimension. Should qualify with high confidence.',
      payload: {
        prospect: {
          enriched_profile: {
            person: { full_name: 'Test Prospect', title: 'CTO', seniority: 'C-Level' },
            company: { name: 'Example Inc', industry: 'B2B SaaS', employee_count: 300 },
            signals: { recent_news: 'Raised a Series B' },
          },
        },
        campaign: {
          icp_criteria: 'B2B SaaS companies with 50 to 2000 employees. Target the CTO.',
          exclusion_criteria: 'Agencies and consulting firms.',
          target_roles: ['CTO'],
          industry: 'B2B SaaS',
          company_size: '50-2000',
        },
        retrieved_knowledge: [],
      },
    },
    {
      id: 'excluded',
      label: 'Hits an exclusion',
      description: 'A perfect fit that is also an agency. Must reject, whatever the score would be.',
      payload: {
        prospect: {
          enriched_profile: {
            person: { full_name: 'Test Prospect', title: 'CTO', seniority: 'C-Level' },
            company: { name: 'Bright Digital Agency', industry: 'Marketing agency', employee_count: 300 },
          },
        },
        campaign: {
          icp_criteria: 'Companies with 50 to 2000 employees. Target the CTO.',
          exclusion_criteria: 'Agencies and consulting firms.',
          target_roles: ['CTO'],
        },
        retrieved_knowledge: [],
      },
    },
    {
      id: 'too_thin',
      label: 'Too thin to judge',
      description: 'Should answer needs_review and name what is missing, not guess.',
      payload: {
        prospect: { enriched_profile: { person: { title: null }, company: { name: 'Unknown' } } },
        campaign: { icp_criteria: 'B2B SaaS, 50 to 2000 employees, target the CTO.' },
        retrieved_knowledge: [],
      },
    },
  ],
  outreach_strategy: [
    {
      id: 'three_touch',
      label: 'Three touches, two channels',
      description: 'A normal plan. Check it only uses the channels the campaign enabled.',
      payload: {
        prospect: {
          enriched_profile: {
            person: { full_name: 'Test Prospect', title: 'CTO' },
            company: { name: 'Example Inc' },
            signals: { recent_news: 'Raised a Series B', hiring_roles: ['Platform Engineer'] },
          },
          icp_result: { verdict: 'qualify', fit_score: 82, confidence: 'high' },
          contact_history: [],
        },
        campaign: {
          outreach_policy: 'Three touches over nine days.',
          enabled_channels: ['email', 'linkedin'],
          working_hours: { start: '09:00', end: '17:00' },
        },
        retrieved_knowledge: [],
      },
    },
    {
      id: 'should_not_contact',
      label: 'Someone we should leave alone',
      description: 'Already said no last quarter. A good agent declines to sequence them.',
      payload: {
        prospect: {
          enriched_profile: { person: { full_name: 'Test Prospect', title: 'CTO' }, company: { name: 'Example Inc' } },
          icp_result: { verdict: 'qualify', fit_score: 70 },
          contact_history: [
            { direction: 'outbound', channel: 'email', body: 'Worth a chat?' },
            { direction: 'inbound', channel: 'email', body: 'Not interested, please stop.' },
          ],
        },
        campaign: { outreach_policy: 'Three touches over nine days.', enabled_channels: ['email'] },
        retrieved_knowledge: [],
      },
    },
  ],
  personalisation: [
    {
      id: 'with_signal',
      label: 'A real signal to open on',
      description: 'Funding news in the research. The message should use it and say that it did.',
      payload: {
        prospect: {
          enriched_profile: {
            person: { full_name: 'Test Prospect', title: 'CTO' },
            company: { name: 'Example Inc' },
            signals: { recent_news: 'Raised a Series B in March' },
          },
          thread_history: [],
        },
        outreach: {
          current_step: { step: 1, channel: 'email', angle: 'open on the funding round', goal: 'earn a reply' },
        },
        campaign: { messaging_policy: 'Under 90 words, peer to peer.' },
        retrieved_knowledge: [],
        rep: { identity: 'Connectivity Test', title: 'AE' },
      },
    },
    {
      id: 'nothing_to_say',
      label: 'Nothing specific to say',
      description: 'Empty research and no knowledge. Should set needs_human rather than write filler.',
      payload: {
        prospect: { enriched_profile: { person: {}, company: {}, signals: {} }, thread_history: [] },
        outreach: { current_step: { step: 1, channel: 'email' } },
        campaign: { messaging_policy: 'Under 90 words, no fluff, nothing generic.' },
        retrieved_knowledge: [],
        rep: { identity: 'Connectivity Test' },
      },
    },
  ],
  conversation: [
    {
      id: 'meeting',
      label: 'A meeting request',
      description: 'Should classify as meeting_request and move the prospect to meeting.',
      payload: {
        inbound: { message: 'Sounds interesting, can we talk next week?', channel: 'email' },
        prospect: { enriched_profile: {}, thread_history: [] },
        campaign: { objective_and_policy: 'Book meetings.' },
        retrieved_knowledge: [],
      },
    },
    {
      id: 'opt_out',
      label: 'An opt-out',
      description: 'Must classify as opt_out. That writes a global suppression rule.',
      payload: {
        inbound: { message: 'Take me off your list and do not contact me again.', channel: 'email' },
        prospect: { enriched_profile: {}, thread_history: [] },
        campaign: { objective_and_policy: 'Book meetings.' },
        retrieved_knowledge: [],
      },
    },
    {
      id: 'pricing',
      label: 'A pricing question',
      description: 'Anything about pricing must set requires_human, whatever the intent.',
      payload: {
        inbound: { message: 'Interesting. What does this cost for 200 seats?', channel: 'email' },
        prospect: { enriched_profile: {}, thread_history: [] },
        campaign: { objective_and_policy: 'Book meetings.' },
        retrieved_knowledge: [],
      },
    },
  ],
};

const defaultPayload = (agentId) => SCENARIOS[agentId]?.[0]?.payload ?? {};

/** GET /agents — the Agents screen. */
router.get('/', asyncHandler(async (req, res) => {
  const [control, performance] = await Promise.all([getSystemControl(), computeAgentPerformance()]);
  const byId = new Map(performance.map((p) => [p.id, p]));
  const llmConfigured = isLlmEngineConfigured();
  const models = activeModels();

  res.json(
    VISIBLE_AGENTS.map((agent) => {
      const perf = byId.get(agent.id);
      const paused = Boolean(control.agent_pauses?.[agent.id]);

      // What is actually serving this agent right now. An agent that has run
      // reports the engine of its last run. One that has not reports what it
      // would use. An agent that is not built reports its configured engine
      // rather than a fallback, because it has not fallen back to anything.
      const wouldUse = agent.engine === 'llm' ? (llmConfigured ? 'llm_engine' : 'local_engine') : agent.engine;
      const activeEngine = !agent.callable ? agent.engine : perf?.last_engine ?? wouldUse;

      return {
        id: agent.id,
        name: agent.name,
        description: agent.description,
        takes: agent.takes ?? null,
        gives: agent.gives ?? null,
        stage: agent.stage ?? 'pipeline',
        order: agent.order,
        callable: agent.callable,
        configured_engine: agent.engine,
        engine: activeEngine,
        llm_configured: llmConfigured,
        models: agent.engine === 'llm' ? models : null,
        testable: agent.callable && agent.engine === 'llm',
        scenarios: (SCENARIOS[agent.id] ?? []).map(({ id, label, description }) => ({ id, label, description })),
        paused,
        status: !agent.callable
          ? 'not_built'
          : paused
            ? 'paused'
            : (perf?.runs_today ?? 0) > 0
              ? 'active'
              : 'idle',
        runs: perf?.runs ?? 0,
        runs_today: perf?.runs_today ?? 0,
        degraded: perf?.degraded ?? 0,
        failed: perf?.failed ?? 0,
        success_rate: perf?.success_rate ?? null,
        clean_rate: perf?.clean_rate ?? null,
        avg_latency_ms: perf?.avg_latency_ms ?? null,
        cost_usd: perf?.cost_usd ?? 0,
        last_run_at: perf?.last_run_at ?? null,
      };
    })
  );
}));

/** GET /agents/routing — which engine each agent would use right now. */
router.get('/routing', asyncHandler(async (req, res) => {
  res.json({ ...configReport(), models: activeModels(), discovery: discoveryRouting() });
}));

/**
 * GET /agents/keys — every key, redacted, with its current state.
 *
 * This is the screen that turns "everything failed" into "key #3 is rate
 * limited for another forty seconds and key #5 is rejected". State is held in
 * this process rather than the database on purpose: it describes what this
 * instance has seen in the last few minutes, and a row surviving a restart to
 * claim a key is dead would be worse than no row.
 */
router.get('/keys', asyncHandler(async (req, res) => {
  res.json({
    providers: keyHealth(),
    provider_order: env.LLM_PROVIDER_ORDER,
    configured_order: configuredLlmProviders(),
    models: activeModels(),
    model_ladders: {
      groq: [env.GROQ_MODEL, ...env.GROQ_MODEL_FALLBACKS],
      gemini: [env.GEMINI_MODEL, ...env.GEMINI_MODEL_FALLBACKS],
    },
    local_engine_enabled: env.LOCAL_ENGINE_ENABLED,
  });
}));

/** POST /agents/keys/revive — put cooled or rejected keys back on the rota. */
router.post('/keys/revive', asyncHandler(async (req, res) => {
  const { provider, index } = req.body ?? {};

  if (provider && Number.isFinite(index)) {
    const revived = reviveKey(provider, index);
    if (!revived) throw notFound(`No key #${index} for ${provider}`);
    return res.json({ revived: 1, key: revived });
  }

  res.json({ revived: reviveAll(), providers: keyHealth() });
}));

/** GET /agents/:id/runs — recent runs for one agent. */
router.get('/:id/runs', asyncHandler(async (req, res) => {
  const agent = getAgent(req.params.id);
  if (!agent) throw notFound(`Unknown agent "${req.params.id}"`);

  const runs = unwrapSoft(
    await supabase
      .from('agent_runs')
      .select('*')
      .eq('agent_name', agent.id)
      .order('created_at', { ascending: false })
      .limit(intParam(req.query.limit, 25, { max: 100 })),
    [],
    'agent_runs'
  );

  res.json(runs.map(mapRun));
}));

/** GET /agents/:id/scenarios — the presets, with their full payloads. */
router.get('/:id/scenarios', asyncHandler(async (req, res) => {
  const agent = getAgent(req.params.id);
  if (!agent) throw notFound(`Unknown agent "${req.params.id}"`);
  res.json(SCENARIOS[agent.id] ?? []);
}));

/** POST /agents/:id/pause */
router.post('/:id/pause', asyncHandler(async (req, res) => {
  const agent = getAgent(req.params.id);
  if (!agent) throw notFound(`Unknown agent "${req.params.id}"`);

  const paused = req.body?.paused !== false;
  const actor = req.body?.actor || 'operator';

  const control = await getSystemControl();
  const updated = await setSystemControl(
    { agent_pauses: { ...(control.agent_pauses ?? {}), [agent.id]: paused } },
    actor
  );

  await logActivity({
    agentName: 'system',
    action: paused ? 'Paused an agent' : 'Resumed an agent',
    detail: `${actor} ${paused ? 'paused' : 'resumed'} ${agent.name}.`,
    status: 'success',
  });

  res.json(updated);
}));

/**
 * POST /agents/:id/test
 *
 * One real call, nothing written to the database, and every stage returned:
 * the prompt that was sent, which key and model answered, the raw text, the
 * reshaped object and the validated result. `payload` may be anything —
 * editing it and re-running is how the playground teaches what each agent
 * reacts to.
 */
router.post('/:id/test', asyncHandler(async (req, res) => {
  const agent = getAgent(req.params.id);
  if (!agent) throw notFound(`Unknown agent "${req.params.id}"`);
  if (!agent.callable) throw badRequest(`${agent.name} is not built yet, so there is nothing to test.`);

  if (agent.engine !== 'llm') {
    return res.json({
      reachable: true,
      valid: true,
      engine: agent.engine,
      agent_id: agent.id,
      agent_name: agent.name,
      guidance: `${agent.name} runs on our own deterministic engine. There is no model call to make.`,
    });
  }

  let payload = req.body?.payload;

  if (req.body?.scenario) {
    const scenario = (SCENARIOS[agent.id] ?? []).find((s) => s.id === req.body.scenario);
    if (!scenario) throw badRequest(`Unknown scenario "${req.body.scenario}" for ${agent.name}`);
    payload = scenario.payload;
  }

  if (typeof payload === 'string') {
    try {
      payload = JSON.parse(payload);
    } catch (err) {
      throw badRequest(`That payload is not valid JSON: ${err.message}`);
    }
  }

  payload = payload ?? defaultPayload(agent.id);

  const result = await probeAgent(agent.id, payload);

  const guidance = {
    not_configured: 'Set GROQ_API_KEY and/or GEMINI_API_KEY in the API environment, then redeploy.',
    schema_mismatch:
      'The model answered, but the output did not match the expected schema. Compare the raw ' +
      'response below against the reshaped one. It is almost always one field name or one enum spelling.',
    all_providers_failed:
      `Every configured provider failed (tried: ${configuredLlmProviders().join(', ') || 'none'}, ` +
      `timeout ${env.LLM_TIMEOUT_MS}ms). The attempts below name each key and model that was tried ` +
      'and why it did not work. Check the key panel on this screen first.',
    unsupported_agent: 'That agent has no LLM prompt defined, so it cannot be tested this way.',
  }[result.error_code] ?? null;

  res.json({ ...result, agent_id: agent.id, agent_name: agent.name, sent_payload: payload, guidance });
}));

export default router;
