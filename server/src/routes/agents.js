/**
 * Agents: what each one is doing, which engine is actually serving it, and a
 * test call against the LLM engine (Groq, then Gemini).
 *
 * The test call exists because the most common failure in an agent layer
 * like this is a silent one — a bad key, a rate limit, a model answering with
 * prose instead of JSON — and that is far easier to fix when the deployed
 * app names it than when the only evidence is a null column.
 */
import express from 'express';
import { supabase, unwrapSoft } from '../db/client.js';
import { asyncHandler, notFound, badRequest } from '../lib/http.js';
import { VISIBLE_AGENTS, getAgent } from '../agents/registry.js';
import { getSystemControl, setSystemControl } from '../orchestrator/gate.js';
import { computeAgentPerformance } from '../services/metrics.js';
import { probeAgent } from '../agents/client.js';
import { configuredLlmProviders } from '../agents/llmEngine.js';
import { env, isLlmEngineConfigured, configReport } from '../config.js';
import { logActivity } from '../services/activity.js';
import { mapRun } from '../services/mappers.js';

const router = express.Router();

/** Realistic-shaped input per agent, so a test call exercises the real path. */
const SAMPLE_PAYLOAD = {
  research: {
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
    campaign: { research_focus: 'connectivity test', name: 'Test' },
  },
  icp_fitment: {
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
  outreach_strategy: {
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
  personalisation: {
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
  conversation: {
    inbound: { message: 'Sounds interesting, can we talk next week?', channel: 'email' },
    prospect: { enriched_profile: {}, thread_history: [] },
    campaign: { objective_and_policy: 'Book meetings.' },
    retrieved_knowledge: [],
  },
};

/** GET /agents — the Agents screen. */
router.get('/', asyncHandler(async (req, res) => {
  const [control, performance] = await Promise.all([getSystemControl(), computeAgentPerformance()]);
  const byId = new Map(performance.map((p) => [p.id, p]));
  const llmConfigured = isLlmEngineConfigured();

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
        order: agent.order,
        callable: agent.callable,
        configured_engine: agent.engine,
        engine: activeEngine,
        llm_configured: llmConfigured,
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
  res.json(configReport());
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
      .limit(25),
    [],
    'agent_runs'
  );

  res.json(runs.map(mapRun));
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
 * One real call to the LLM engine, nothing written to the database, and the
 * raw body returned so a mismatch can be read rather than guessed at.
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
      guidance: `${agent.name} runs on our own deterministic engine. There is nothing to call.`,
    });
  }

  const payload = req.body?.payload ?? SAMPLE_PAYLOAD[agent.id] ?? {};
  const result = await probeAgent(agent.id, payload);

  const guidance = {
    not_configured: 'Set GROQ_API_KEY and/or GEMINI_API_KEY in the API environment, then redeploy.',
    schema_mismatch:
      'The model answered, but the output did not match the expected schema. Compare the raw ' +
      'response below against the schema. It is almost always one field name or one enum spelling.',
    all_providers_failed:
      `Every configured provider failed (tried: ${configuredLlmProviders().join(', ') || 'none'}, ` +
      `timeout ${env.LLM_TIMEOUT_MS}ms). The error above lists each attempt's own reason — usually ` +
      'an invalid or rate-limited key.',
  }[result.error_code] ?? null;

  res.json({ ...result, agent_id: agent.id, agent_name: agent.name, sent_payload: payload, guidance });
}));

export default router;
