/**
 * Campaigns: targeting, policy, prompts, lifecycle, and the two buttons that
 * make something happen — Discover and Run.
 *
 * Both of those return a job id rather than a result. Neither one finishes
 * inside an HTTP request: discovery is a provider search plus a write per
 * person, and a run is four agent calls per prospect. The response says "this
 * started, here is how to watch it", and the UI polls /jobs/:id.
 */
import express from 'express';
import { supabase, unwrapSoft } from '../db/client.js';
import { asyncHandler, notFound, badRequest, intParam } from '../lib/http.js';
import { mapCampaign } from '../services/mappers.js';
import { computeFunnel } from '../services/metrics.js';
import { startJob, cancelJobsForCampaign, listJobs } from '../orchestrator/jobs.js';
import { logActivity } from '../services/activity.js';
import { isAgent } from '../agents/registry.js';
import { chooseSource } from '../services/discovery/index.js';
import { searchPeople, buildSearchFilters, isApolloConfigured } from '../services/discovery/apollo.js';
import { discoveryRouting, env } from '../config.js';

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
  'daily_send_limit', 'require_approval', 'rep_id', 'sample_profiles',
]);

const CHANNELS = ['email', 'linkedin', 'sms', 'voice'];
const STATUSES = ['draft', 'live', 'paused', 'archived'];

/**
 * Which status changes are allowed, and from where. Without this an archived
 * campaign can be set live again by a stale browser tab, and a draft can jump
 * straight to paused, which means nothing.
 */
const TRANSITIONS = {
  draft: ['live', 'archived'],
  live: ['paused', 'archived'],
  paused: ['live', 'archived'],
  archived: ['draft'],
};

function cleanPatch(body) {
  const patch = {};
  for (const [key, value] of Object.entries(body ?? {})) {
    if (WRITABLE.has(key)) patch[key] = value;
  }

  if (patch.status && !STATUSES.includes(patch.status)) {
    throw badRequest('status must be draft, live, paused or archived');
  }

  if (patch.enabled_channels) {
    const list = Array.isArray(patch.enabled_channels) ? patch.enabled_channels : [];
    const bad = list.filter((c) => !CHANNELS.includes(c));
    if (bad.length) throw badRequest(`Unknown channel: ${bad.join(', ')}`);
    if (list.length === 0) throw badRequest('A campaign needs at least one channel');
    patch.enabled_channels = list;
  }

  if (patch.target_roles && !Array.isArray(patch.target_roles)) {
    patch.target_roles = String(patch.target_roles).split(',').map((s) => s.trim()).filter(Boolean);
  }

  return patch;
}

/**
 * What is missing before this campaign can do anything useful. Returned with
 * every campaign so the UI can show it rather than letting someone set a
 * campaign live with no ICP and then wonder why every prospect comes back
 * "needs review".
 */
export function readiness(campaign) {
  const blockers = [];
  const warnings = [];

  if (!campaign.icp_criteria?.trim()) {
    blockers.push({
      field: 'icp_criteria',
      message: 'No ICP. The scoring agent has nothing to score against, so everything comes back needs_review.',
    });
  }
  if (!Array.isArray(campaign.enabled_channels) || campaign.enabled_channels.length === 0) {
    blockers.push({ field: 'enabled_channels', message: 'No channel is enabled, so no message can be planned.' });
  }

  if (!campaign.objective?.trim()) {
    warnings.push({ field: 'objective', message: 'No objective. Messages will be generic.' });
  }
  if (!Array.isArray(campaign.target_roles) || campaign.target_roles.length === 0) {
    warnings.push({ field: 'target_roles', message: 'No target roles, so discovery has no job title to search for.' });
  }
  if (!campaign.exclusion_criteria?.trim()) {
    warnings.push({ field: 'exclusion_criteria', message: 'No exclusions. Nothing will be rejected on principle.' });
  }
  if (!campaign.messaging_policy?.trim()) {
    warnings.push({ field: 'messaging_policy', message: 'No messaging policy, so length and tone are the model’s choice.' });
  }
  if (!campaign.rep_id) {
    warnings.push({ field: 'rep_id', message: 'No rep assigned, so messages are signed "Sales team".' });
  }

  return { ready: blockers.length === 0, blockers, warnings };
}

/** GET /campaigns — the list, each with its own counts. */
router.get('/', asyncHandler(async (req, res) => {
  const campaigns = unwrapSoft(
    await supabase.from('campaigns').select('*, reps(*)').order('created_at', { ascending: true }),
    [],
    'campaigns'
  );

  const [members, running] = await Promise.all([
    supabase.from('campaign_prospects').select('campaign_id, state'),
    listJobs({ status: 'queued,running', limit: 50 }),
  ]);

  const rows = unwrapSoft(members, [], 'campaign_prospects');
  const busy = new Map(running.map((j) => [j.campaign_id, { id: j.id, type: j.type, status: j.status }]));

  res.json(
    campaigns.map((c) => {
      const mine = rows.filter((m) => m.campaign_id === c.id);
      return mapCampaign(c, {
        prospect_count: mine.length,
        qualified_count: mine.filter((m) =>
          ['qualified', 'strategy_planned', 'contacted', 'engaged', 'meeting', 'opportunity'].includes(m.state)
        ).length,
        contacted_count: mine.filter((m) =>
          ['contacted', 'engaged', 'meeting', 'opportunity'].includes(m.state)
        ).length,
        replied_count: mine.filter((m) => ['engaged', 'meeting', 'opportunity'].includes(m.state)).length,
        meetings_count: mine.filter((m) => ['meeting', 'opportunity'].includes(m.state)).length,
        pending_count: mine.filter((m) => ['discovered', 'researched', 'qualified', 'strategy_planned'].includes(m.state)).length,
        readiness: readiness(c),
        running_job: busy.get(c.id) ?? null,
        allowed_transitions: TRANSITIONS[c.status] ?? [],
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

  const [funnel, prompts, jobs] = await Promise.all([
    computeFunnel(req.params.id),
    supabase
      .from('prompt_versions')
      .select('*')
      .eq('campaign_id', req.params.id)
      .order('agent_name')
      .order('version', { ascending: false }),
    listJobs({ campaignId: req.params.id, limit: 8 }),
  ]);

  res.json(
    mapCampaign(campaign, {
      funnel,
      prompts: unwrapSoft(prompts, [], 'prompt_versions'),
      readiness: readiness(campaign),
      allowed_transitions: TRANSITIONS[campaign.status] ?? [],
      running_job: jobs.find((j) => ['queued', 'running'].includes(j.status)) ?? null,
      recent_jobs: jobs.map((j) => ({
        id: j.id, type: j.type, status: j.status, processed: j.processed,
        total: j.total, created_at: j.created_at,
      })),
      discovery: discoveryRouting(),
    })
  );
}));

/** POST /campaigns */
router.post('/', asyncHandler(async (req, res) => {
  const patch = cleanPatch(req.body);
  if (!patch.name?.trim()) throw badRequest('A campaign needs a name');

  // A campaign always begins in draft. Letting the create call set it live
  // would skip the one review step the lifecycle exists to enforce.
  patch.status = 'draft';

  const { data, error } = await supabase.from('campaigns').insert(patch).select('*, reps(*)').single();
  if (error) throw new Error(`campaign insert: ${error.message}`);

  await logActivity({
    campaignId: data.id,
    agentName: 'system',
    action: 'Created a campaign',
    detail: data.name,
    status: 'success',
  });

  res.status(201).json(mapCampaign(data, { readiness: readiness(data) }));
}));

/** PATCH /campaigns/:id */
router.patch('/:id', asyncHandler(async (req, res) => {
  const patch = cleanPatch(req.body);
  if (Object.keys(patch).length === 0) throw badRequest('Nothing to update');

  const before = unwrapSoft(
    await supabase.from('campaigns').select('*').eq('id', req.params.id).maybeSingle(),
    null,
    'campaigns'
  );
  if (!before) throw notFound('No such campaign');

  if (patch.status && patch.status !== before.status) {
    const allowed = TRANSITIONS[before.status] ?? [];
    if (!allowed.includes(patch.status)) {
      throw badRequest(
        `A ${before.status} campaign cannot go straight to ${patch.status}. ` +
          `From ${before.status} you can go to: ${allowed.join(', ') || 'nowhere'}.`
      );
    }

    if (patch.status === 'live') {
      const check = readiness({ ...before, ...patch });
      if (!check.ready) {
        throw badRequest(
          `Not ready to go live. ${check.blockers.map((b) => b.message).join(' ')}`,
          { details: check.blockers }
        );
      }
    }
  }

  const { data, error } = await supabase
    .from('campaigns')
    .update(patch)
    .eq('id', req.params.id)
    .select('*, reps(*)')
    .single();
  if (error) throw new Error(`campaign update: ${error.message}`);

  let cancelled = 0;
  if (patch.status && patch.status !== before.status) {
    // Pausing a campaign whose run is mid-flight has to stop that run too.
    // Otherwise "paused" means "paused after it finishes the next ten
    // minutes of work", which is not what anyone pressing pause means.
    if (['paused', 'archived', 'draft'].includes(patch.status)) {
      cancelled = await cancelJobsForCampaign(req.params.id, req.body?.actor || 'operator');
    }

    await logActivity({
      campaignId: data.id,
      agentName: 'system',
      action: patch.status === 'live' ? 'Set a campaign live' : `Set a campaign to ${patch.status}`,
      detail:
        `${data.name}: ${before.status} to ${patch.status}` +
        (cancelled ? `, stopping ${cancelled} job${cancelled === 1 ? '' : 's'} in progress` : ''),
      status: 'success',
    });
  }

  res.json(
    mapCampaign(data, {
      readiness: readiness(data),
      allowed_transitions: TRANSITIONS[data.status] ?? [],
      cancelled_jobs: cancelled,
    })
  );
}));

/**
 * POST /campaigns/:id/run
 *
 * Starts a job and returns its id. 202, because the work has been accepted
 * and has not happened yet, and saying 200 would be claiming otherwise.
 */
router.post('/:id/run', asyncHandler(async (req, res) => {
  const limit = intParam(req.body?.limit, 5, { max: 25 });

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

  const job = await startJob({
    type: 'campaign_run',
    campaignId: req.params.id,
    params: {
      limit,
      force: req.body?.force === true,
      prospect_ids: Array.isArray(req.body?.prospect_ids) ? req.body.prospect_ids : null,
    },
    actor: req.body?.actor || 'operator',
  });

  res.status(202).json({ job_id: job.id, status: job.status, watch: `/jobs/${job.id}` });
}));

/**
 * POST /campaigns/:id/discover
 *
 * Finds people and puts them in the campaign. Allowed while a campaign is in
 * draft: filling a campaign with prospects sends nothing, and making someone
 * set it live before they can even see who they would be contacting gets the
 * review step backwards.
 */
router.post('/:id/discover', asyncHandler(async (req, res) => {
  const campaign = unwrapSoft(
    await supabase.from('campaigns').select('*').eq('id', req.params.id).maybeSingle(),
    null,
    'campaigns'
  );
  if (!campaign) throw notFound('No such campaign');
  if (campaign.status === 'archived') throw badRequest('That campaign is archived.');

  const source = chooseSource(req.body?.source ?? null);
  if (source === 'none') {
    throw badRequest(
      'No discovery source is configured. Set APOLLO_API_KEY for a real search, or a Groq or ' +
        'Gemini key for model suggestions, or import a CSV instead.'
    );
  }

  const job = await startJob({
    type: 'discovery',
    campaignId: req.params.id,
    params: {
      count: intParam(req.body?.count, 10, { max: env.DISCOVERY_MAX_PER_RUN }),
      source,
      filters: req.body?.filters ?? {},
    },
    actor: req.body?.actor || 'operator',
  });

  res.status(202).json({ job_id: job.id, source, status: job.status, watch: `/jobs/${job.id}` });
}));

/**
 * POST /campaigns/:id/discover/preview
 *
 * Runs the Apollo search and shows what it found without writing anything.
 * Worth its own endpoint: seeing the list before it lands in the campaign is
 * how an operator finds out their headcount band was wrong, and undoing an
 * import is much more annoying than not doing it.
 */
router.post('/:id/discover/preview', asyncHandler(async (req, res) => {
  const campaign = unwrapSoft(
    await supabase.from('campaigns').select('*').eq('id', req.params.id).maybeSingle(),
    null,
    'campaigns'
  );
  if (!campaign) throw notFound('No such campaign');

  if (!isApolloConfigured()) {
    return res.json({
      previewable: false,
      reason:
        'Preview needs Apollo. Model suggestions cannot be previewed without generating them, ' +
        'which costs the same call as running discovery, so run it and review the prospects after.',
      filters: buildSearchFilters(campaign, req.body?.filters ?? {}),
    });
  }

  const search = await searchPeople(campaign, {
    ...(req.body?.filters ?? {}),
    per_page: intParam(req.body?.count, 10, { max: 25 }),
  });

  res.json({
    previewable: true,
    filters: search.filters,
    total_matches: search.pagination.total_entries,
    showing: search.candidates.length,
    candidates: search.candidates,
    emails_locked: search.candidates.filter((c) => !c.email).length,
  });
}));

/**
 * POST /campaigns/:id/duplicate
 *
 * Clones the campaign's own configuration — targeting, policy, prompts — into
 * a new draft. Nothing about prospects, activity or history comes along: a
 * variant is a fresh start built on the same instructions, not a copy of the
 * original's progress. This is what lets a team run "Campaign A" against
 * "Campaign A: Personalisation Variant B" and compare response rates.
 */
router.post('/:id/duplicate', asyncHandler(async (req, res) => {
  const source = unwrapSoft(
    await supabase.from('campaigns').select('*').eq('id', req.params.id).maybeSingle(),
    null,
    'campaigns'
  );
  if (!source) throw notFound('No such campaign');

  const name = (req.body?.name ?? `${source.name} (copy)`).trim();

  const clone = {
    name,
    status: 'draft',
    objective: source.objective,
    icp_criteria: source.icp_criteria,
    exclusion_criteria: source.exclusion_criteria,
    target_roles: source.target_roles,
    industry: source.industry,
    company_size: source.company_size,
    sample_profiles: source.sample_profiles,
    enabled_channels: source.enabled_channels,
    outreach_policy: source.outreach_policy,
    messaging_policy: source.messaging_policy,
    research_focus: source.research_focus,
    working_hours: source.working_hours,
    daily_send_limit: source.daily_send_limit,
    require_approval: source.require_approval,
    rep_id: source.rep_id,
  };

  const { data, error } = await supabase.from('campaigns').insert(clone).select('*, reps(*)').single();
  if (error) throw new Error(`campaign duplicate: ${error.message}`);

  const prompts = unwrapSoft(
    await supabase
      .from('prompt_versions')
      .select('agent_name, content, author')
      .eq('campaign_id', req.params.id)
      .eq('is_active', true),
    [],
    'prompt_versions'
  );

  if (prompts.length > 0) {
    await supabase.from('prompt_versions').insert(
      prompts.map((p) => ({
        campaign_id: data.id,
        agent_name: p.agent_name,
        version: 1,
        is_active: true,
        author: p.author,
        content: p.content,
      }))
    );
  }

  await logActivity({
    campaignId: data.id,
    agentName: 'system',
    action: 'Duplicated a campaign',
    detail: `Created from "${source.name}", starting in draft with ${prompts.length} active prompt(s) carried over.`,
    status: 'success',
  });

  res.status(201).json(
    mapCampaign(data, {
      prospect_count: 0, qualified_count: 0, contacted_count: 0,
      replied_count: 0, meetings_count: 0, pending_count: 0,
      readiness: readiness(data),
    })
  );
}));

/**
 * DELETE /campaigns/:id?keepProspects=true|false
 *
 * Deleting the campaign row cascades: its memberships, messages, prompt
 * versions, knowledge chunks, approvals and jobs all go with it (that is the
 * point — a deleted campaign should not leave orphaned rows a report has to
 * explain), and its agent_runs are kept with campaign_id set to null rather
 * than deleted, so the numbers on the Agents screen do not quietly drop.
 *
 * The one real choice is what happens to the *people*. Default is to keep
 * them: a prospect this campaign found is still a real person, and the next
 * campaign that searches for someone at the same company should find them
 * again rather than re-adding a duplicate. `keepProspects=false` instead
 * deletes every prospect that was *only* in this campaign — someone also
 * being worked by a second live campaign is never touched, whichever way
 * this is set, because deleting them out from under a campaign that still
 * has them mid-sequence would be a much worse surprise than an extra row.
 */
router.delete('/:id', asyncHandler(async (req, res) => {
  const campaign = unwrapSoft(
    await supabase.from('campaigns').select('id, name').eq('id', req.params.id).maybeSingle(),
    null,
    'campaigns'
  );
  if (!campaign) throw notFound('No such campaign');

  const keepProspects = req.query.keepProspects !== 'false';

  const memberships = unwrapSoft(
    await supabase.from('campaign_prospects').select('prospect_id').eq('campaign_id', req.params.id),
    [],
    'campaign_prospects'
  );
  const prospectIds = [...new Set(memberships.map((m) => m.prospect_id))];

  const { error } = await supabase.from('campaigns').delete().eq('id', req.params.id);
  if (error) throw new Error(`campaign delete: ${error.message}`);

  let deletedProspects = 0;
  if (!keepProspects && prospectIds.length > 0) {
    // The campaign's own memberships are already gone (cascaded with it), so
    // "still has other memberships" now means "is in some other campaign".
    const stillLinked = unwrapSoft(
      await supabase.from('campaign_prospects').select('prospect_id').in('prospect_id', prospectIds),
      [],
      'campaign_prospects'
    );
    const linkedElsewhere = new Set(stillLinked.map((r) => r.prospect_id));
    const onlyHere = prospectIds.filter((id) => !linkedElsewhere.has(id));

    if (onlyHere.length > 0) {
      const { error: delErr, count } = await supabase
        .from('prospects')
        .delete({ count: 'exact' })
        .in('id', onlyHere);
      if (delErr) throw new Error(`prospect delete: ${delErr.message}`);
      deletedProspects = count ?? onlyHere.length;
    }
  }

  await logActivity({
    agentName: 'system',
    action: 'Deleted a campaign',
    detail: keepProspects
      ? `Deleted "${campaign.name}". ${prospectIds.length} prospect(s) kept — they stay findable for future campaigns.`
      : `Deleted "${campaign.name}" and ${deletedProspects} prospect(s) who were only in it. ` +
        `${prospectIds.length - deletedProspects} were also in another campaign and were left alone.`,
    status: 'success',
  });

  res.json({
    deleted: true,
    campaign_id: req.params.id,
    prospects_kept: keepProspects ? prospectIds.length : prospectIds.length - deletedProspects,
    prospects_deleted: deletedProspects,
  });
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
