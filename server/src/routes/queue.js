/**
 * The Queue screen: one request, everything it needs.
 *
 * The home screen of an outbound tool should answer "what needs me?" before
 * it answers anything else, so the approvals come first and the pipeline sits
 * above them as context rather than as the point.
 */
import express from 'express';
import { supabase, unwrapSoft } from '../db/client.js';
import { asyncHandler, notFound, badRequest, intParam } from '../lib/http.js';
import { computeFunnel, computeQueueStats } from '../services/metrics.js';
import { mapApproval, mapActivity } from '../services/mappers.js';
import { resolveApproval, logActivity } from '../services/activity.js';
import { sendApprovedMessage, advance } from '../orchestrator/index.js';

const router = express.Router();

const APPROVAL_SELECT = `
  *,
  campaigns(id, name),
  prospects(id, full_name, first_name, last_name, title, company_name, email, enriched_data),
  messages(*)
`;

const ACTIVITY_SELECT = `
  *,
  campaigns(id, name),
  prospects(id, full_name, first_name, last_name, company_name, enriched_data)
`;

/** GET /queue — pipeline, open approvals, recent history, counters. */
router.get('/', asyncHandler(async (req, res) => {
  const campaignId = req.query.campaignId || null;
  const feedLimit = intParam(req.query.limit, 30, { max: 100 });

  let approvalsQuery = supabase
    .from('approvals')
    .select(APPROVAL_SELECT)
    .eq('status', 'open')
    .order('created_at', { ascending: false })
    .limit(50);

  let activityQuery = supabase
    .from('activities')
    .select(ACTIVITY_SELECT)
    .order('created_at', { ascending: false })
    .limit(feedLimit);

  if (campaignId) {
    approvalsQuery = approvalsQuery.eq('campaign_id', campaignId);
    activityQuery = activityQuery.eq('campaign_id', campaignId);
  }

  const [funnel, stats, approvals, activity] = await Promise.all([
    computeFunnel(campaignId),
    computeQueueStats(),
    approvalsQuery,
    activityQuery,
  ]);

  res.json({
    funnel,
    stats,
    approvals: unwrapSoft(approvals, [], 'approvals').map(mapApproval),
    activity: unwrapSoft(activity, [], 'activities').map(mapActivity),
  });
}));

/** GET /queue/activity — the feed on its own, for polling. */
router.get('/activity', asyncHandler(async (req, res) => {
  let query = supabase
    .from('activities')
    .select(ACTIVITY_SELECT)
    .order('created_at', { ascending: false })
    .limit(intParam(req.query.limit, 40, { max: 200 }));

  if (req.query.campaignId) query = query.eq('campaign_id', req.query.campaignId);
  if (req.query.since) query = query.gt('created_at', req.query.since);

  res.json(unwrapSoft(await query, [], 'activities').map(mapActivity));
}));

/**
 * POST /queue/approvals/:id/approve
 *
 * What approving means depends on what was asked. A drafted message gets
 * sent; a prospect the scorer could not place gets qualified and re-enters
 * the pipeline; a duplicate gets resolved in favour of this campaign.
 */
router.post('/approvals/:id/approve', asyncHandler(async (req, res) => {
  const actor = req.body?.actor || 'operator';
  const note = req.body?.note ?? null;

  const approval = unwrapSoft(
    await supabase.from('approvals').select('*').eq('id', req.params.id).maybeSingle(),
    null,
    'approvals'
  );

  if (!approval) throw notFound('No such approval');
  if (approval.status !== 'open') throw badRequest('That approval has already been handled');

  let outcome = { action: 'resolved' };

  switch (approval.type) {
    case 'message_approval': {
      if (approval.message_id) {
        const sent = await sendApprovedMessage(approval.message_id, actor);
        outcome = sent.sent
          ? { action: 'message_sent' }
          : { action: 'blocked', reason: sent.reason };
      }
      break;
    }

    case 'icp_review': {
      await supabase
        .from('campaign_prospects')
        .update({
          state: 'qualified',
          icp_verdict: 'qualify',
          next_action_at: new Date().toISOString(),
        })
        .eq('campaign_id', approval.campaign_id)
        .eq('prospect_id', approval.prospect_id);

      await logActivity({
        campaignId: approval.campaign_id,
        prospectId: approval.prospect_id,
        agentName: 'system',
        action: 'Qualified by a human',
        detail: `${actor} qualified this prospect after the scorer could not decide.`,
        status: 'success',
      });

      outcome = { action: 'qualified' };
      break;
    }

    case 'duplicate_conflict': {
      // This campaign keeps the prospect. The others stop working them.
      const others = unwrapSoft(
        await supabase
          .from('campaign_prospects')
          .select('id, campaign_id')
          .eq('prospect_id', approval.prospect_id)
          .neq('campaign_id', approval.campaign_id),
        [],
        'campaign_prospects'
      );

      for (const row of others) {
        await supabase
          .from('campaign_prospects')
          .update({
            state: 'stopped',
            next_action_at: null,
            stopped_reason: 'Another campaign took this prospect',
          })
          .eq('id', row.id);
      }

      await logActivity({
        campaignId: approval.campaign_id,
        prospectId: approval.prospect_id,
        agentName: 'system',
        action: 'Resolved a duplicate',
        detail: `${actor} kept this prospect here and stopped ${others.length} other campaign${others.length === 1 ? '' : 's'}.`,
        status: 'success',
      });

      outcome = { action: 'conflict_resolved', stopped_elsewhere: others.length };
      break;
    }

    case 'reply_escalation':
    default:
      await logActivity({
        campaignId: approval.campaign_id,
        prospectId: approval.prospect_id,
        agentName: 'system',
        action: 'Handled an escalation',
        detail: note || `${actor} marked this as handled.`,
        status: 'success',
      });
      break;
  }

  // A blocked send (no email on record, a gate check, a live duplicate) is not
  // a decision — the person still needs to act on it. Closing the approval
  // here would drop it out of the queue with nothing left to retry once the
  // underlying problem (e.g. SMTP not configured) is fixed.
  if (outcome.action === 'blocked') {
    res.json({ approval, outcome });
    return;
  }

  const resolved = await resolveApproval(req.params.id, { status: 'approved', actor, note });
  res.json({ approval: resolved, outcome });
}));

/** POST /queue/approvals/:id/reject */
router.post('/approvals/:id/reject', asyncHandler(async (req, res) => {
  const actor = req.body?.actor || 'operator';
  const note = req.body?.note ?? null;

  const approval = unwrapSoft(
    await supabase.from('approvals').select('*').eq('id', req.params.id).maybeSingle(),
    null,
    'approvals'
  );

  if (!approval) throw notFound('No such approval');
  if (approval.status !== 'open') throw badRequest('That approval has already been handled');

  if (approval.type === 'message_approval' && approval.message_id) {
    await supabase.from('messages').update({ status: 'failed' }).eq('id', approval.message_id);
  }

  if (approval.type === 'icp_review') {
    await supabase
      .from('campaign_prospects')
      .update({ state: 'rejected', icp_verdict: 'reject', next_action_at: null })
      .eq('campaign_id', approval.campaign_id)
      .eq('prospect_id', approval.prospect_id);
  }

  await logActivity({
    campaignId: approval.campaign_id,
    prospectId: approval.prospect_id,
    agentName: 'system',
    action: 'Rejected',
    detail: note || `${actor} rejected this.`,
    status: 'success',
  });

  const resolved = await resolveApproval(req.params.id, { status: 'rejected', actor, note });
  res.json({ approval: resolved });
}));

/**
 * POST /queue/approvals/:id/approve-and-continue
 * Approves, then immediately advances the prospect, so the next draft appears
 * without a second click.
 */
router.post('/approvals/:id/approve-and-continue', asyncHandler(async (req, res) => {
  const actor = req.body?.actor || 'operator';

  const approval = unwrapSoft(
    await supabase.from('approvals').select('*').eq('id', req.params.id).maybeSingle(),
    null,
    'approvals'
  );
  if (!approval) throw notFound('No such approval');

  if (approval.type === 'message_approval' && approval.message_id) {
    await sendApprovedMessage(approval.message_id, actor);
  }
  await resolveApproval(req.params.id, { status: 'approved', actor });

  const next = await advance(approval.campaign_id, approval.prospect_id, { force: true });
  res.json({ approved: true, next });
}));

export default router;
