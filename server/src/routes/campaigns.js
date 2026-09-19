/**
 * Campaigns: targeting, policy, prompts, and the Run button.
 */
import express from 'express';
import { supabase, unwrapSoft } from '../db/client.js';
import { asyncHandler, notFound, badRequest, intParam } from '../lib/http.js';
import { mapCampaign } from '../services/mappers.js';
import { computeFunnel } from '../services/metrics.js';
import { runCampaign } from '../orchestrator/index.js';
import { logActivity } from '../services/activity.js';
import { isAgent } from '../agents/registry.js';

const router = express.Router();

/**
 * Only these columns can be written through the API. A campaign is operator
 * input that goes straight into an agent prompt, so an allow-list here is the
 * difference between editing a campaign and editing the system.
 */
const WRITABLE = new Set([
  'name', 'status', 'objective', 'icp_criteria', 'exclusion_criteria',
  'target_roles', 'industry', 'company_size', 'enabled_channels',
  'outreach_policy', 'messaging_policy', 'research_focus', 'working_hours',
  'daily_send_limit', 'require_approval', 'rep_id',
]);

const CHANNELS = ['email', 'linkedin', 'sms', 'voice'];

function cleanPatch(body) {
  const patch = {};
  for (const [key, value] of Object.entries(body ?? {})) {
    if (WRITABLE.has(key)) patch[key] = value;
  }

  if (patch.status && !['draft', 'live', 'paused', 'archived'].includes(patch.status)) {
    throw badRequest(`status must be draft, live, paused or archived`);
  }

  if (patch.enabled_channels) {
    const list = Array.isArray(patch.enabled_channels) ? patch.enabled_channels : [];
    const bad = list.filter((c) => !CHANNELS.includes(c));
    if (bad.length) throw badRequest(`Unknown channel: ${bad.join(', ')}`);
    if (list.length === 0) throw badRequest('A campaign needs at least one channel');
    patch.enabled_channels = list;
  }

  return patch;
}

/** GET /campaigns — the list, each with its own counts. */
router.get('/', asyncHandler(async (req, res) => {
  const campaigns = unwrapSoft(
    await supabase.from('campaigns').select('*, reps(*)').order('created_at', { ascending: true }),
    [],
    'campaigns'
  );

  const members = unwrapSoft(
    await supabase.from('campaign_prospects').select('campaign_id, state'),
    [],
    'campaign_prospects'
  );

  res.json(
    campaigns.map((c) => {
      const mine = members.filter((m) => m.campaign_id === c.id);
      return mapCampaign(c, {
        prospect_count: mine.length,
        qualified_count: mine.filter((m) =>
          ['qualified', 'strategy_planned', 'contacted', 'engaged', 'meeting', 'opportunity'].includes(m.state)
        ).length,
        contacted_count: mine.filter((m) =>
          ['contacted', 'engaged', 'meeting', 'opportunity'].includes(m.state)
        ).length,
        replied_count: mine.filter((m) => ['engaged', 'meeting', 'opportunity'].includes(m.state)).length,
        pending_count: mine.filter((m) => ['discovered', 'researched', 'qualified', 'strategy_planned'].includes(m.state)).length,
      });
    })
  );
}));

/** GET /campaigns/:id */
router.get('/:id', asyncHandler(async (req, res) => {
  const campaign = unwrapSoft(
    await supabase.from('campaigns').select('*, reps(*)').eq('id', req.params.id).maybeSingle(),
    null,
    'campaigns'
  );
  if (!campaign) throw notFound('No such campaign');

  const [funnel, prompts] = await Promise.all([
    computeFunnel(req.params.id),
    supabase
      .from('prompt_versions')
      .select('*')
      .eq('campaign_id', req.params.id)
      .order('agent_name')
      .order('version', { ascending: false }),
  ]);

  res.json(
    mapCampaign(campaign, {
      funnel,
      prompts: unwrapSoft(prompts, [], 'prompt_versions'),
    })
  );
}));

/** POST /campaigns */
router.post('/', asyncHandler(async (req, res) => {
  const patch = cleanPatch(req.body);
  if (!patch.name) throw badRequest('A campaign needs a name');

  const { data, error } = await supabase.from('campaigns').insert(patch).select('*, reps(*)').single();
  if (error) throw new Error(`campaign insert: ${error.message}`);

  await logActivity({
    campaignId: data.id,
    agentName: 'system',
    action: 'Created a campaign',
    detail: data.name,
    status: 'success',
  });

  res.status(201).json(mapCampaign(data));
}));

/** PATCH /campaigns/:id */
router.patch('/:id', asyncHandler(async (req, res) => {
  const patch = cleanPatch(req.body);
  if (Object.keys(patch).length === 0) throw badRequest('Nothing to update');

  const before = unwrapSoft(
    await supabase.from('campaigns').select('status, name').eq('id', req.params.id).maybeSingle(),
    null,
    'campaigns'
  );
  if (!before) throw notFound('No such campaign');

  const { data, error } = await supabase
    .from('campaigns')
    .update(patch)
    .eq('id', req.params.id)
    .select('*, reps(*)')
    .single();
  if (error) throw new Error(`campaign update: ${error.message}`);

  if (patch.status && patch.status !== before.status) {
    await logActivity({
      campaignId: data.id,
      agentName: 'system',
      action: patch.status === 'live' ? 'Set a campaign live' : `Set a campaign to ${patch.status}`,
      detail: `${data.name}: ${before.status} to ${patch.status}`,
      status: 'success',
    });
  }

  res.json(mapCampaign(data));
}));

/**
 * POST /campaigns/:id/run
 *
 * Picks up prospects with something to do and advances each of them. This is
 * the button that makes history: every step it takes writes real rows.
 */
router.post('/:id/run', asyncHandler(async (req, res) => {
  const limit = intParam(req.body?.limit, 5, { max: 25 });
  const force = req.body?.force === true;

  const campaign = unwrapSoft(
    await supabase.from('campaigns').select('id, name, status').eq('id', req.params.id).maybeSingle(),
    null,
    'campaigns'
  );
  if (!campaign) throw notFound('No such campaign');

  if (campaign.status !== 'live') {
    return res.status(409).json({
      error: 'campaign_not_live',
      message: `"${campaign.name}" is ${campaign.status}. Set it live before running it.`,
    });
  }

  const result = await runCampaign(req.params.id, { limit, force });
  res.json(result);
}));

/** GET /campaigns/:id/prompts — active prompt per agent. */
router.get('/:id/prompts', asyncHandler(async (req, res) => {
  const rows = unwrapSoft(
    await supabase
      .from('prompt_versions')
      .select('*')
      .eq('campaign_id', req.params.id)
      .order('version', { ascending: false }),
    [],
    'prompt_versions'
  );

  const byAgent = {};
  for (const row of rows) {
    byAgent[row.agent_name] ??= { agent_name: row.agent_name, versions: [] };
    byAgent[row.agent_name].versions.push(row);
    if (row.is_active) byAgent[row.agent_name].active = row;
  }

  res.json(Object.values(byAgent));
}));

/**
 * PUT /campaigns/:id/prompts/:agent
 * Writes a new version and makes it active. Editing never overwrites, so a
 * change that made things worse can be pointed at afterwards.
 */
router.put('/:id/prompts/:agent', asyncHandler(async (req, res) => {
  const { id, agent } = req.params;
  const content = (req.body?.content ?? '').trim();
  const author = req.body?.author || 'operator';

  if (!content) throw badRequest('A prompt cannot be empty');
  if (agent !== 'system' && !isAgent(agent)) throw badRequest(`Unknown agent "${agent}"`);

  const latest = unwrapSoft(
    await supabase
      .from('prompt_versions')
      .select('version')
      .eq('campaign_id', id)
      .eq('agent_name', agent)
      .order('version', { ascending: false })
      .limit(1),
    [],
    'prompt_versions'
  );

  const version = (latest[0]?.version ?? 0) + 1;

  await supabase
    .from('prompt_versions')
    .update({ is_active: false })
    .eq('campaign_id', id)
    .eq('agent_name', agent);

  const { data, error } = await supabase
    .from('prompt_versions')
    .insert({ campaign_id: id, agent_name: agent, version, is_active: true, author, content })
    .select()
    .single();
  if (error) throw new Error(`prompt insert: ${error.message}`);

  await logActivity({
    campaignId: id,
    agentName: 'system',
    action: 'Edited a prompt',
    detail: `${agent} prompt is now at version ${version}, edited by ${author}.`,
    status: 'success',
  });

  res.json(data);
}));

export default router;
