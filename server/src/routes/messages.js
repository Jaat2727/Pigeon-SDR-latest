/**
 * Messages: every outbound send and every inbound reply, across every
 * campaign, in one place.
 *
 * Nothing here is a separate mailbox — it is the same `messages` table every
 * prospect's thread already reads from, just not filtered down to one person
 * first. The point is the view a real SDR actually works from: "what have we
 * sent, what came back, and what needs me" without having to open twenty
 * prospect pages to find out.
 */
import express from 'express';
import { supabase, unwrapSoft } from '../db/client.js';
import { asyncHandler, intParam } from '../lib/http.js';
import { nameOf, companyOf } from '../services/mappers.js';

const router = express.Router();

const SELECT = `
  id, campaign_id, prospect_id, direction, channel, step, subject, body,
  status, sent_at, created_at, intent, sentiment, is_auto_reply,
  campaigns(id, name),
  prospects(id, full_name, first_name, last_name, title, company_name, email, enriched_data)
`;

function mapRow(m) {
  return {
    id: m.id,
    campaign_id: m.campaign_id,
    campaign_name: m.campaigns?.name ?? null,
    prospect_id: m.prospect_id,
    prospect_name: nameOf(m.prospects),
    prospect_company: companyOf(m.prospects),
    direction: m.direction,
    channel: m.channel,
    step: m.step,
    subject: m.subject,
    body: m.body,
    status: m.status,
    sent_at: m.sent_at,
    created_at: m.created_at,
    intent: m.intent,
    sentiment: m.sentiment,
    is_auto_reply: m.is_auto_reply,
  };
}

/**
 * GET /messages?campaignId=&direction=&channel=&status=&needsReply=&limit=
 *
 * `needsReply=true` is the one filter worth calling out: the most recent
 * message per prospect is inbound and nothing has gone out since. That is
 * the actual "needs a reply" definition — a person who spoke last — computed
 * here rather than stored, so it can never drift from the thread itself.
 */
router.get('/', asyncHandler(async (req, res) => {
  let query = supabase
    .from('messages')
    .select(SELECT)
    .order('created_at', { ascending: false })
    .limit(intParam(req.query.limit, 60, { max: 300 }));

  if (req.query.campaignId) query = query.eq('campaign_id', req.query.campaignId);
  if (req.query.direction) query = query.eq('direction', req.query.direction);
  if (req.query.channel) query = query.eq('channel', req.query.channel);
  if (req.query.status) query = query.in('status', String(req.query.status).split(','));

  const rows = unwrapSoft(await query, [], 'messages').map(mapRow);

  if (req.query.needsReply !== 'true') {
    return res.json(rows);
  }

  // Last message per prospect, kept only when that last message is inbound.
  // The messages above are already newest-first, so the first time a
  // prospect_id is seen is their most recent message.
  const seen = new Set();
  const needsReply = [];
  for (const row of rows) {
    if (seen.has(row.prospect_id)) continue;
    seen.add(row.prospect_id);
    if (row.direction === 'inbound' && !row.is_auto_reply) needsReply.push(row);
  }
  res.json(needsReply);
}));

/** GET /messages/stats — counts for the Inbox screen's filter tabs. */
router.get('/stats', asyncHandler(async (req, res) => {
  const rows = unwrapSoft(
    await supabase.from('messages').select('direction, status, is_auto_reply').limit(2000),
    [],
    'messages'
  );

  res.json({
    total: rows.length,
    sent: rows.filter((r) => r.direction === 'outbound' && r.status === 'sent').length,
    received: rows.filter((r) => r.direction === 'inbound').length,
    pending_approval: rows.filter((r) => r.status === 'pending_approval').length,
    auto_replies: rows.filter((r) => r.is_auto_reply).length,
  });
}));

export default router;
