/**
 * Controls: the stop button, at four levels, plus the suppression list.
 *
 * All four are read through the same gate the orchestrator uses, so what this
 * screen says is stopping work is exactly what is stopping work.
 */
import express from 'express';
import { supabase, unwrapSoft } from '../db/client.js';
import { asyncHandler, badRequest, notFound } from '../lib/http.js';
import { getSystemControl, setSystemControl, explainGate } from '../orchestrator/gate.js';
import { logActivity } from '../services/activity.js';
import { VISIBLE_AGENTS } from '../agents/registry.js';

const router = express.Router();

const CHANNELS = ['email', 'linkedin', 'sms', 'voice'];

/** GET /controls — current state of every stop, and what is blocking work. */
router.get('/', asyncHandler(async (req, res) => {
  const [control, gate, campaigns] = await Promise.all([
    getSystemControl(),
    explainGate(),
    supabase.from('campaigns').select('id, name, status, enabled_channels').order('created_at'),
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
    })),
    campaigns: unwrapSoft(campaigns, [], 'campaigns'),
    gate,
    updated_by: control.updated_by,
    updated_at: control.updated_at,
  });
}));

/** POST /controls/kill-switch */
router.post('/kill-switch', asyncHandler(async (req, res) => {
  const on = req.body?.enabled !== false;
  const actor = req.body?.actor || 'operator';

  const updated = await setSystemControl({ kill_switch: on }, actor);

  await logActivity({
    agentName: 'system',
    action: on ? 'Stopped everything' : 'Released the kill switch',
    detail: on
      ? `${actor} turned on the global kill switch. Nothing runs until it is off.`
      : `${actor} turned off the global kill switch.`,
    status: on ? 'blocked' : 'success',
  });

  res.json(updated);
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

  const { data, error } = await supabase
    .from('suppression_list')
    .insert({
      email: email?.trim() || null,
      domain: domain?.trim().replace(/^https?:\/\//, '').replace(/\/.*$/, '') || null,
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
