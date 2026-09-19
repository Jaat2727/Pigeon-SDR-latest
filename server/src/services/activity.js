/**
 * Writing history, and raising the things a human has to look at.
 *
 * `activities` is append-only. Nothing in this file updates or deletes a row
 * there, and nothing in the seed writes to it, so the feed on the Queue screen
 * and the timeline on a prospect page are a record of what the system did
 * rather than a description of what it is supposed to do.
 */
import { supabase, unwrapSoft } from '../db/client.js';
import { getAgentName } from '../agents/registry.js';

/**
 * One line in the history. A failed write is logged and swallowed: losing a
 * timeline entry is bad, but failing the pipeline step that was otherwise
 * about to succeed is worse.
 */
export async function logActivity({
  campaignId = null,
  prospectId = null,
  agentRunId = null,
  agentName = null,
  engine = null,
  action,
  detail = null,
  status = 'success',
  metadata = {},
}) {
  try {
    const { error } = await supabase.from('activities').insert({
      campaign_id: campaignId,
      prospect_id: prospectId,
      agent_run_id: agentRunId,
      agent_name: agentName,
      engine,
      action,
      detail,
      status,
      metadata,
    });
    if (error) console.warn(`[activity] not recorded: ${error.message}`);
  } catch (err) {
    console.warn(`[activity] not recorded: ${err.message}`);
  }
}

/**
 * Puts something in front of a person.
 *
 * A partial unique index in the schema allows only one open approval per
 * prospect, campaign and type, so a worker that keeps passing over the same
 * stuck prospect cannot bury the queue in copies of the same question. A
 * duplicate is a no-op, not an error.
 */
export async function raiseApproval({
  campaignId = null,
  prospectId = null,
  campaignProspectId = null,
  messageId = null,
  type,
  sourceAgent = null,
  reason = null,
  proposedAction = null,
  payload = null,
}) {
  const { data, error } = await supabase
    .from('approvals')
    .insert({
      campaign_id: campaignId,
      prospect_id: prospectId,
      campaign_prospect_id: campaignProspectId,
      message_id: messageId,
      type,
      source_agent: sourceAgent,
      reason,
      proposed_action: proposedAction,
      payload,
    })
    .select('id')
    .maybeSingle();

  // 23505 is the unique index doing its job.
  if (error && error.code !== '23505') {
    console.warn(`[approval] not raised: ${error.message}`);
    return null;
  }

  return data?.id ?? null;
}

export async function resolveApproval(id, { status, actor = 'operator', note = null }) {
  const { data, error } = await supabase
    .from('approvals')
    .update({
      status,
      resolved_by: actor,
      resolved_at: new Date().toISOString(),
      resolution_note: note,
    })
    .eq('id', id)
    .eq('status', 'open')
    .select('*')
    .maybeSingle();

  if (error) throw new Error(`approval update: ${error.message}`);
  return data;
}

/**
 * The same person being worked by two live campaigns at once.
 *
 * Membership alone is not a conflict. A prospect can sit in three lists at
 * `discovered` without anyone noticing or caring. It becomes a conflict when
 * two campaigns are both actively working them, because that is when they
 * start receiving two unrelated sequences from the same company.
 */
const ACTIVELY_WORKED = [
  'qualified',
  'strategy_planned',
  'contacted',
  'engaged',
  'meeting',
  'opportunity',
];

export async function detectConflict(prospectId, campaignId) {
  const rows = unwrapSoft(
    await supabase
      .from('campaign_prospects')
      .select('id, campaign_id, state, campaigns(id, name, status)')
      .eq('prospect_id', prospectId),
    [],
    'campaign_prospects conflict scan'
  );

  const active = rows.filter(
    (r) => r.campaigns?.status === 'live' && ACTIVELY_WORKED.includes(r.state)
  );

  if (active.length < 2) return null;

  const others = active.filter((r) => r.campaign_id !== campaignId);
  if (others.length === 0) return null;

  return {
    campaigns: active.map((r) => ({
      id: r.campaign_id,
      name: r.campaigns?.name ?? 'Unknown campaign',
      state: r.state,
    })),
    reason:
      'This prospect is being actively worked by ' +
      `${active.length} live campaigns: ${active.map((r) => r.campaigns?.name).join(', ')}. ` +
      'Pick one before either sends.',
  };
}

/** True when an unresolved conflict should hold outbound for this prospect. */
export async function hasBlockingConflict(prospectId) {
  const rows = unwrapSoft(
    await supabase
      .from('approvals')
      .select('id')
      .eq('prospect_id', prospectId)
      .eq('type', 'duplicate_conflict')
      .eq('status', 'open')
      .limit(1),
    [],
    'approvals'
  );
  return rows.length > 0;
}

/** A readable actor for the feed. "System Prompt" is not a person. */
export const actorFor = (agentName) =>
  !agentName || agentName === 'system' ? 'System' : getAgentName(agentName);
