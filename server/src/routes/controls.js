/**
 * Controls: the stop button, at four levels, plus the suppression list.
 *
 * All four are read through the same gate the orchestrator uses, so what this
 * screen says is stopping work is exactly what is stopping work.
 *
 * Two things changed here once runs became jobs. A stop control now also
 * cancels whatever is already in flight, because a pause that only applies to
 * the next step is not a pause — it is a promise to stop in ten minutes. And
 * the screen reports the six checks in the order the gate applies them, with
 * the campaign level included, since a campaign's status is a stop control
 * whether or not it is on this page.
 */
import express from 'express';
import { supabase, unwrapSoft } from '../db/client.js';
import { asyncHandler, badRequest, notFound } from '../lib/http.js';
import { getSystemControl, setSystemControl, explainGate } from '../orchestrator/gate.js';
import { logActivity } from '../services/activity.js';
import { VISIBLE_AGENTS } from '../agents/registry.js';
import { listJobs, cancelAllJobs, cancelJobsForCampaign } from '../orchestrator/jobs.js';
import { verifyMailer, sendEmail, mailerStatus } from '../services/mailer.js';

const router = express.Router();

const CHANNELS = ['email', 'linkedin', 'sms', 'voice'];

/**
 * The gate's checks, in the order it applies them, described in words. The UI
 * prints this rather than hard-coding its own copy, so the explanation and the
 * behaviour cannot drift apart when one of them changes.
 */
const CHECK_ORDER = [
  {
    level: 'system',
    title: 'Kill switch',
    scope: 'Everything, everywhere',
    detail: 'Checked first. Nothing runs, in any campaign, on any channel, until it is off.',
  },
  {
    level: 'channel',
    title: 'Channel pause',
    scope: 'One channel, across every campaign',
    detail: 'Stops anything outbound on that channel. Research and scoring still run.',
  },
  {
    level: 'agent',
    title: 'Agent pause',
    scope: 'One agent, across every campaign',
    detail: 'The pipeline stops at that agent’s step. Prospects wait there rather than skipping it.',
  },
  {
    level: 'campaign',
    title: 'Campaign status',
    scope: 'One campaign',
    detail: 'Only a live campaign runs. A campaign must also have the channel enabled to use it.',
  },
  {
    level: 'prospect',
    title: 'Prospect pause and opt-out',
    scope: 'One person, in one campaign',
    detail: 'A paused prospect is held. Someone who opted out is never contacted again.',
  },
  {
    level: 'suppression',
    title: 'Suppression list',
    scope: 'One person or one whole domain',
    detail: 'Matched with a SQL predicate before any outbound action. A model is never asked to remember who is off limits.',
  },
];

/** GET /controls — current state of every stop, and what is blocking work. */
router.get('/', asyncHandler(async (req, res) => {
  const [control, gate, campaigns, jobs] = await Promise.all([
    getSystemControl(),
    explainGate(),
    supabase.from('campaigns').select('id, name, status, enabled_channels').order('created_at'),
    listJobs({ status: 'queued,running', limit: 20 }),
  ]);

  res.json({
    kill_switch: control.kill_switch,
    channels: CHANNELS.map((c) => ({
      channel: c,
      paused: Boolean(control.channel_pauses?.[c]),
      // Voice has no implementation behind it. Saying so here is more honest
      // than offering a pause control for something that never runs.
      implemented: c !== 'voice',
    })),
    agents: VISIBLE_AGENTS.map((a) => ({
      id: a.id,
      name: a.name,
      paused: Boolean(control.agent_pauses?.[a.id]),
      callable: a.callable,
      stage: a.stage ?? 'pipeline',
    })),
    campaigns: unwrapSoft(campaigns, [], 'campaigns'),
    running_jobs: jobs.map((j) => ({
      id: j.id,
      type: j.type,
      campaign_id: j.campaign_id,
      campaign_name: j.campaigns?.name ?? null,
      status: j.status,
      processed: j.processed ?? 0,
      total: j.total ?? 0,
      started_at: j.started_at,
      created_by: j.created_by,
    })),
    check_order: CHECK_ORDER,
    gate,
    mailer: mailerStatus(),
    updated_by: control.updated_by,
    updated_at: control.updated_at,
  });
}));

/**
 * POST /controls/mailer/test
 *
 * Checks the SMTP credentials, and — when an address is given — actually
 * sends a one-off email to it. Nothing is written to `messages` or any
 * campaign; this exists purely to answer "is this configured right" without
 * needing a real campaign, an approval, and a prospect record to find out.
 */
router.post('/mailer/test', asyncHandler(async (req, res) => {
  const to = req.body?.to?.trim() || null;
  const actor = req.body?.actor || 'operator';

  const verify = await verifyMailer();
  if (!verify.configured) {
    return res.json({ ...verify, sent: null });
  }
  if (!verify.ok) {
    return res.json({ ...verify, sent: null });
  }
  if (!to) {
    return res.json({ ...verify, sent: null, note: 'Credentials check out. Give "to" to send an actual test email.' });
  }

  const result = await sendEmail({
    to,
    subject: 'Pigeon — test send',
    body:
      `This is a test send from Pigeon's SMTP configuration, triggered by ${actor}.\n\n` +
      `If this landed in your inbox, email delivery is live: an approved message will actually ` +
      `send, not just get recorded as sent.`,
    fromName: 'Pigeon',
  });

  await logActivity({
    agentName: 'system',
    action: result.sent ? 'Sent a test email' : 'Test email failed',
    detail: result.sent
      ? `${actor} sent a test email to ${to}.`
      : `${actor} tried a test email to ${to}: ${result.error}`,
    status: result.sent ? 'success' : 'failed',
  });

  res.json({ ...verify, sent: result.sent, to, error: result.error ?? null, message_id: result.message_id ?? null });
}));

/**
 * POST /controls/kill-switch
 *
 * Turning it on cancels every job that is currently running. The flag alone
 * would stop the next step of each prospect, which means the stop lands
 * somewhere between now and thirty seconds from now depending on where each
 * model call happens to be. Cancelling aborts those calls outright.
 */
router.post('/kill-switch', asyncHandler(async (req, res) => {
  const on = req.body?.enabled !== false;
  const actor = req.body?.actor || 'operator';

  const updated = await setSystemControl({ kill_switch: on }, actor);
  const cancelled = on ? await cancelAllJobs(actor) : 0;

  await logActivity({
    agentName: 'system',
    action: on ? 'Stopped everything' : 'Released the kill switch',
    detail: on
      ? `${actor} turned on the global kill switch` +
        (cancelled ? `, stopping ${cancelled} job${cancelled === 1 ? '' : 's'} in progress.` : '. Nothing was running.')
      : `${actor} turned off the global kill switch.`,
    status: on ? 'blocked' : 'success',
  });

  res.json({ ...updated, cancelled_jobs: cancelled });
}));

/** POST /controls/channel */
router.post('/channel', asyncHandler(async (req, res) => {
  const { channel, paused = true, actor = 'operator' } = req.body ?? {};
  if (!CHANNELS.includes(channel)) throw badRequest(`Unknown channel "${channel}"`);

  const control = await getSystemControl();
  const updated = await setSystemControl(
    { channel_pauses: { ...(control.channel_pauses ?? {}), [channel]: paused } },
    actor
  );

  await logActivity({
    agentName: 'system',
    action: paused ? 'Paused a channel' : 'Resumed a channel',
    detail: `${actor} ${paused ? 'paused' : 'resumed'} ${channel} across every campaign.`,
    status: paused ? 'blocked' : 'success',
  });

  res.json(updated);
}));

/**
 * POST /controls/campaign
 *
 * The campaign-level stop, with the same shape as the other three so the
 * Controls screen does not have to special-case it. Pausing cancels that
 * campaign's running job.
 */
router.post('/campaign', asyncHandler(async (req, res) => {
  const { campaignId, paused = true, actor = 'operator' } = req.body ?? {};
  if (!campaignId) throw badRequest('campaignId is required');

  const campaign = unwrapSoft(
    await supabase.from('campaigns').select('id, name, status').eq('id', campaignId).maybeSingle(),
    null,
    'campaigns'
  );
  if (!campaign) throw notFound('No such campaign');

  if (campaign.status === 'archived') {
    throw badRequest(`"${campaign.name}" is archived. Move it back to draft before running it.`);
  }
  if (!paused && campaign.status === 'draft') {
    throw badRequest(
      `"${campaign.name}" is still a draft. Open it and set it live, so its targeting gets checked first.`
    );
  }

  const next = paused ? 'paused' : 'live';
  if (campaign.status === next) {
    return res.json({ id: campaign.id, status: campaign.status, changed: false, cancelled_jobs: 0 });
  }

  const { data, error } = await supabase
    .from('campaigns')
    .update({ status: next })
    .eq('id', campaignId)
    .select('id, name, status')
    .single();
  if (error) throw new Error(`campaign status: ${error.message}`);

  const cancelled = paused ? await cancelJobsForCampaign(campaignId, actor) : 0;

  await logActivity({
    campaignId,
    agentName: 'system',
    action: paused ? 'Paused a campaign' : 'Resumed a campaign',
    detail:
      `${actor} ${paused ? 'paused' : 'resumed'} "${campaign.name}"` +
      (cancelled ? `, stopping ${cancelled} job${cancelled === 1 ? '' : 's'} in progress.` : '.'),
    status: paused ? 'blocked' : 'success',
  });

  res.json({ ...data, changed: true, cancelled_jobs: cancelled });
}));

/** GET /controls/suppression */
router.get('/suppression', asyncHandler(async (req, res) => {
  const rows = unwrapSoft(
    await supabase
      .from('suppression_list')
      .select('*, campaigns(id, name)')
      .order('created_at', { ascending: false }),
    [],
    'suppression_list'
  );

  res.json(
    rows.map((r) => ({
      id: r.id,
      email: r.email,
      domain: r.domain,
      phone: r.phone,
      reason: r.reason,
      scope: r.scope,
      campaign_name: r.campaigns?.name ?? null,
      created_at: r.created_at,
    }))
  );
}));

/** POST /controls/suppression */
router.post('/suppression', asyncHandler(async (req, res) => {
  const { email, domain, phone, reason, scope = 'global', campaignId = null, actor = 'operator' } =
    req.body ?? {};

  if (!email && !domain && !phone) {
    throw badRequest('Give an email, a domain or a phone number. A rule that matches nothing suppresses nobody.');
  }
  if (scope === 'campaign' && !campaignId) {
    throw badRequest('A campaign-scoped rule needs a campaign.');
  }

  const { data, error } = await supabase
    .from('suppression_list')
    .insert({
      email: email?.trim().toLowerCase() || null,
      domain: domain?.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/.*$/, '') || null,
      phone: phone?.trim() || null,
      reason: reason?.trim() || null,
      scope,
      campaign_id: scope === 'campaign' ? campaignId : null,
    })
    .select()
    .single();
  if (error) throw new Error(`suppression insert: ${error.message}`);

  await logActivity({
    campaignId: scope === 'campaign' ? campaignId : null,
    agentName: 'system',
    action: 'Added a suppression rule',
    detail: `${actor} suppressed ${email || domain || phone}${reason ? `: ${reason}` : ''}.`,
    status: 'success',
  });

  res.status(201).json(data);
}));

/** DELETE /controls/suppression/:id */
router.delete('/suppression/:id', asyncHandler(async (req, res) => {
  const { data, error } = await supabase
    .from('suppression_list')
    .delete()
    .eq('id', req.params.id)
    .select('id')
    .maybeSingle();
  if (error) throw new Error(`suppression delete: ${error.message}`);
  if (!data) throw notFound('No such suppression rule');
  res.json({ deleted: data.id });
}));

export default router;
