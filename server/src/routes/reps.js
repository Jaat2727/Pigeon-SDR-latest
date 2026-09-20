/**
 * Reps: the human identity outreach is sent as.
 *
 * Deliberately thin. A rep is a name, a title and the campaigns they are
 * assigned to; assignment itself lives on `campaigns.rep_id`, one rep per
 * campaign, because that is the field the orchestrator already reads to sign
 * a message. Offboarding a rep means finding every campaign that points at
 * them, which is exactly what GET /reps/:id/campaigns answers.
 */
import express from 'express';
import { supabase, unwrapSoft } from '../db/client.js';
import { asyncHandler, notFound, badRequest } from '../lib/http.js';
import { logActivity } from '../services/activity.js';

const router = express.Router();

/** GET /reps — every rep, with how many campaigns each is assigned to. */
router.get('/', asyncHandler(async (req, res) => {
  const [reps, campaigns] = await Promise.all([
    supabase.from('reps').select('*').order('created_at', { ascending: true }),
    supabase.from('campaigns').select('id, name, status, rep_id'),
  ]);

  const repRows = unwrapSoft(reps, [], 'reps');
  const campaignRows = unwrapSoft(campaigns, [], 'campaigns');

  res.json(
    repRows.map((r) => ({
      id: r.id,
      full_name: r.full_name,
      title: r.title,
      email: r.email,
      timezone: r.timezone,
      created_at: r.created_at,
      campaigns: campaignRows
        .filter((c) => c.rep_id === r.id)
        .map((c) => ({ id: c.id, name: c.name, status: c.status })),
    }))
  );
}));

/** POST /reps */
router.post('/', asyncHandler(async (req, res) => {
  const { full_name, title, email, signature, timezone } = req.body ?? {};
  if (!full_name?.trim()) throw badRequest('A rep needs a name');

  const { data, error } = await supabase
    .from('reps')
    .insert({
      full_name: full_name.trim(),
      title: title?.trim() || null,
      email: email?.trim() || null,
      signature: signature?.trim() || null,
      timezone: timezone?.trim() || 'UTC',
    })
    .select()
    .single();
  if (error) throw new Error(`rep insert: ${error.message}`);

  res.status(201).json(data);
}));

/**
 * DELETE /reps/:id — offboard.
 *
 * `rep_id` on campaigns is ON DELETE SET NULL, so this never leaves a
 * campaign pointing at nothing quietly: every affected campaign is named in
 * the response so an admin can reassign each one, and a line is written to
 * that campaign's history saying whose outreach identity just went away.
 */
router.delete('/:id', asyncHandler(async (req, res) => {
  const rep = unwrapSoft(
    await supabase.from('reps').select('id, full_name').eq('id', req.params.id).maybeSingle(),
    null,
    'reps'
  );
  if (!rep) throw notFound('No such rep');

  const affected = unwrapSoft(
    await supabase.from('campaigns').select('id, name').eq('rep_id', req.params.id),
    [],
    'campaigns'
  );

  const { error } = await supabase.from('reps').delete().eq('id', req.params.id);
  if (error) throw new Error(`rep delete: ${error.message}`);

  for (const c of affected) {
    await logActivity({
      campaignId: c.id,
      agentName: 'system',
      action: 'Rep offboarded',
      detail: `${rep.full_name} was removed. This campaign has no rep assigned until one is chosen.`,
      status: 'escalated',
    });
  }

  res.json({ deleted: rep.id, affected_campaigns: affected });
}));

export default router;
