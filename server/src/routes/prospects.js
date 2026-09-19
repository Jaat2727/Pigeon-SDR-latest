/**
 * Prospects: the list, one prospect's whole story, and the actions that move
 * them.
 */
import express from 'express';
import { supabase, unwrapSoft } from '../db/client.js';
import { asyncHandler, notFound, badRequest, intParam } from '../lib/http.js';
import { mapProspectRow, mapProspectDetail } from '../services/mappers.js';
import { advance, advanceUntilBlocked, handleReply } from '../orchestrator/index.js';
import { logActivity } from '../services/activity.js';

const router = express.Router();

const LIST_SELECT = `
  id, campaign_id, prospect_id, state, fit_score, icp_verdict, icp_confidence,
  priority, current_step, sequence, next_action_at, last_contacted_at,
  replied_at, paused,
  campaigns(id, name),
  prospects(id, full_name, first_name, last_name, title, email, company_name,
            enriched_data, source)
`;

/** GET /prospects?campaignId=&state=&q=&limit= */
router.get('/', asyncHandler(async (req, res) => {
  let query = supabase
    .from('campaign_prospects')
    .select(LIST_SELECT)
    .order('created_at', { ascending: true })
    .limit(intParam(req.query.limit, 200, { max: 500 }));

  if (req.query.campaignId) query = query.eq('campaign_id', req.query.campaignId);
  if (req.query.state) query = query.in('state', String(req.query.state).split(','));

  const rows = unwrapSoft(await query, [], 'campaign_prospects').map(mapProspectRow);

  // Search is done here rather than in the query because it spans the raw
  // columns and the enriched profile, and a prospect found by their enriched
  // title should appear alongside one found by their imported one.
  const q = (req.query.q ?? '').trim().toLowerCase();
  const filtered = q
    ? rows.filter((r) =>
        [r.name, r.company, r.title, r.email].filter(Boolean).some((v) => v.toLowerCase().includes(q))
      )
    : rows;

  res.json(filtered);
}));

/** GET /prospects/:id — everything known, including per-campaign verdicts. */
router.get('/:id', asyncHandler(async (req, res) => {
  const prospect = unwrapSoft(
    await supabase.from('prospects').select('*').eq('id', req.params.id).maybeSingle(),
    null,
    'prospects'
  );
  if (!prospect) throw notFound('No such prospect');

  const [memberships, messages, runs, activities] = await Promise.all([
    supabase
      .from('campaign_prospects')
      .select('*, campaigns(id, name, status)')
      .eq('prospect_id', req.params.id),
    supabase
      .from('messages')
      .select('*')
      .eq('prospect_id', req.params.id)
      .order('created_at', { ascending: true }),
    supabase
      .from('agent_runs')
      .select('*')
      .eq('prospect_id', req.params.id)
      .order('created_at', { ascending: false })
      .limit(50),
    supabase
      .from('activities')
      .select('*, campaigns(id, name)')
      .eq('prospect_id', req.params.id)
      .order('created_at', { ascending: false })
      .limit(80),
  ]);

  res.json(
    mapProspectDetail(
      prospect,
      unwrapSoft(memberships, [], 'campaign_prospects'),
      unwrapSoft(messages, [], 'messages'),
      unwrapSoft(runs, [], 'agent_runs'),
      unwrapSoft(activities, [], 'activities')
    )
  );
}));

/** POST /prospects/:id/advance — one step, or as far as it will go. */
router.post('/:id/advance', asyncHandler(async (req, res) => {
  const campaignId = req.body?.campaignId;
  if (!campaignId) throw badRequest('campaignId is required: a prospect advances inside one campaign');

  const result =
    req.body?.all === true
      ? await advanceUntilBlocked(campaignId, req.params.id, { force: req.body?.force === true })
      : [await advance(campaignId, req.params.id, { force: req.body?.force === true })];

  res.json({ steps: result, final: result[result.length - 1] });
}));

/**
 * POST /prospects/:id/reply
 *
 * There is no inbox connected, so a reply is typed in here. It then goes
 * through exactly the same path a real one would: recorded as an inbound
 * message, classified by the conversation agent, and acted on. The UI labels
 * this as a simulated inbound rather than implying a mailbox.
 */
router.post('/:id/reply', asyncHandler(async (req, res) => {
  const { campaignId, body, channel = 'email' } = req.body ?? {};
  if (!campaignId) throw badRequest('campaignId is required');
  if (!body?.trim()) throw badRequest('A reply needs a body');

  const result = await handleReply(campaignId, req.params.id, { body: body.trim(), channel });
  if (result.status === 'error') throw badRequest(result.reason);

  res.json(result);
}));

/** POST /prospects/:id/pause — hold one prospect in one campaign. */
router.post('/:id/pause', asyncHandler(async (req, res) => {
  const { campaignId, paused = true, actor = 'operator' } = req.body ?? {};
  if (!campaignId) throw badRequest('campaignId is required');

  const { data, error } = await supabase
    .from('campaign_prospects')
    .update({ paused, next_action_at: paused ? null : new Date().toISOString() })
    .eq('campaign_id', campaignId)
    .eq('prospect_id', req.params.id)
    .select()
    .maybeSingle();
  if (error) throw new Error(`pause: ${error.message}`);
  if (!data) throw notFound('That prospect is not in that campaign');

  await logActivity({
    campaignId,
    prospectId: req.params.id,
    agentName: 'system',
    action: paused ? 'Paused a prospect' : 'Resumed a prospect',
    detail: `${actor} ${paused ? 'paused' : 'resumed'} this prospect in this campaign.`,
    status: 'success',
  });

  res.json(data);
}));

/** POST /prospects — add one by hand. */
router.post('/', asyncHandler(async (req, res) => {
  const { campaignId, first_name, last_name, title, email, company_name, company_domain, linkedin_url, phone } =
    req.body ?? {};

  if (!email?.trim() && !linkedin_url?.trim()) {
    throw badRequest('A prospect needs an email address or a LinkedIn URL');
  }

  const full_name = [first_name, last_name].filter(Boolean).join(' ') || null;
  const provenance = {};
  for (const [k, v] of Object.entries({ email, title, company_name, phone, linkedin_url })) {
    if (v) provenance[k] = 'manual';
  }

  const { data, error } = await supabase
    .from('prospects')
    .insert({
      first_name: first_name ?? null,
      last_name: last_name ?? null,
      full_name,
      title: title ?? null,
      email: email?.trim() || null,
      phone: phone ?? null,
      linkedin_url: linkedin_url ?? null,
      company_name: company_name ?? null,
      company_domain: company_domain ?? null,
      source: 'manual',
      field_provenance: provenance,
    })
    .select()
    .single();

  if (error) {
    // 23505 is the unique index on email: this person is already here.
    if (error.code === '23505') throw badRequest('A prospect with that email already exists');
    throw new Error(`prospect insert: ${error.message}`);
  }

  if (campaignId) {
    await supabase
      .from('campaign_prospects')
      .insert({ campaign_id: campaignId, prospect_id: data.id, state: 'discovered' });

    await logActivity({
      campaignId,
      prospectId: data.id,
      agentName: 'system',
      action: 'Added a prospect',
      detail: `${full_name || email} was added by hand.`,
      status: 'success',
    });
  }

  res.status(201).json(data);
}));

export default router;
