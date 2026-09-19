/**
 * The gate. Every action that could reach a prospect passes through here, and
 * there is exactly one of these functions, called from exactly one place in
 * the orchestrator. A second code path that skips a check is how a system
 * ends up emailing someone who asked not to be emailed.
 *
 * Six things can stop an action, in this order:
 *
 *   1. kill switch            everything, everywhere, one flag
 *   2. channel pause          one channel across every campaign
 *   3. agent pause            one agent across every campaign
 *   4. campaign status        a single campaign, or a single prospect paused
 *   5. suppression list       matched in SQL, never by asking a model
 *   6. opted out              they told us to stop
 *
 * The order matters for the explanation, not the outcome: whichever reason is
 * found first is the one shown, and the broadest reason is the most useful
 * one to show. "The kill switch is on" is a better answer than "this prospect
 * is on the suppression list" when both are true.
 */
import { supabase, unwrapSoft } from '../db/client.js';
import { getAgentName } from '../agents/registry.js';

const DEFAULT_CONTROL = {
  id: 1,
  kill_switch: false,
  channel_pauses: { email: false, linkedin: false, sms: false, voice: false },
  agent_pauses: {},
};

export async function getSystemControl() {
  const row = unwrapSoft(
    await supabase.from('system_control').select('*').eq('id', 1).maybeSingle(),
    null,
    'system_control'
  );
  return { ...DEFAULT_CONTROL, ...(row ?? {}) };
}

export async function setSystemControl(patch, actor = 'operator') {
  const { data, error } = await supabase
    .from('system_control')
    .update({ ...patch, updated_by: actor, updated_at: new Date().toISOString() })
    .eq('id', 1)
    .select()
    .single();
  if (error) throw new Error(`system_control update: ${error.message}`);
  return data;
}

/**
 * Is this prospect on the suppression list?
 *
 * The filter is built from the identifiers that actually exist. Including a
 * null here produces `email.eq.null`, which PostgREST rejects outright, and
 * the whole check would throw rather than return a clean answer.
 */
async function suppressionMatch(prospect, campaignId) {
  const filters = [];
  if (prospect.email) filters.push(`email.eq.${prospect.email}`);
  if (prospect.phone) filters.push(`phone.eq.${prospect.phone}`);
  if (prospect.company_domain) filters.push(`domain.eq.${prospect.company_domain}`);
  if (filters.length === 0) return null;

  const rows = unwrapSoft(
    await supabase
      .from('suppression_list')
      .select('id, email, domain, phone, reason, scope, campaign_id')
      .or(filters.join(',')),
    [],
    'suppression_list'
  );

  // A campaign-scoped rule only applies to its own campaign.
  return rows.find((r) => r.scope === 'global' || r.campaign_id === campaignId) ?? null;
}

/**
 * @returns {Promise<{allowed: boolean, reason?: string, level?: string, detail?: object}>}
 */
export async function isActionAllowed({
  campaignId,
  prospectId,
  channel = null,
  agentName = null,
  isOutbound = false,
}) {
  const control = await getSystemControl();

  if (control.kill_switch) {
    return {
      allowed: false,
      level: 'system',
      reason: 'The global kill switch is on. Nothing runs until it is turned off.',
    };
  }

  if (channel && control.channel_pauses?.[channel]) {
    return {
      allowed: false,
      level: 'channel',
      reason: `The ${channel} channel is paused.`,
    };
  }

  if (agentName && control.agent_pauses?.[agentName]) {
    return {
      allowed: false,
      level: 'agent',
      reason: `${getAgentName(agentName)} is paused.`,
    };
  }

  if (campaignId) {
    const campaign = unwrapSoft(
      await supabase.from('campaigns').select('id, name, status, enabled_channels').eq('id', campaignId).maybeSingle(),
      null,
      'campaigns'
    );

    if (!campaign) {
      return { allowed: false, level: 'campaign', reason: 'That campaign no longer exists.' };
    }

    if (campaign.status !== 'live') {
      return {
        allowed: false,
        level: 'campaign',
        reason: `"${campaign.name}" is ${campaign.status}, so nothing in it runs.`,
      };
    }

    if (channel) {
      const enabled = Array.isArray(campaign.enabled_channels) ? campaign.enabled_channels : [];
      if (!enabled.includes(channel)) {
        return {
          allowed: false,
          level: 'campaign',
          reason: `"${campaign.name}" does not have ${channel} enabled.`,
        };
      }
    }
  }

  if (prospectId) {
    const prospect = unwrapSoft(
      await supabase
        .from('prospects')
        .select('id, full_name, email, phone, company_domain')
        .eq('id', prospectId)
        .maybeSingle(),
      null,
      'prospects'
    );

    if (!prospect) {
      return { allowed: false, level: 'prospect', reason: 'That prospect no longer exists.' };
    }

    if (campaignId) {
      const cp = unwrapSoft(
        await supabase
          .from('campaign_prospects')
          .select('id, state, paused')
          .eq('campaign_id', campaignId)
          .eq('prospect_id', prospectId)
          .maybeSingle(),
        null,
        'campaign_prospects'
      );

      if (cp?.paused) {
        return { allowed: false, level: 'prospect', reason: 'This prospect is paused in this campaign.' };
      }

      if (cp?.state === 'opted_out') {
        return {
          allowed: false,
          level: 'prospect',
          reason: 'This prospect opted out. Nothing further is sent to them.',
        };
      }
    }

    // Only outbound actions are stopped by suppression. Research and scoring
    // still run, because knowing that a suppressed prospect would have
    // qualified is useful and costs them nothing.
    if (isOutbound) {
      const match = await suppressionMatch(prospect, campaignId);
      if (match) {
        return {
          allowed: false,
          level: 'suppression',
          reason: match.reason
            ? `On the suppression list: ${match.reason}`
            : 'On the suppression list.',
          detail: { suppression_id: match.id, matched_on: match.email ? 'email' : match.domain ? 'domain' : 'phone' },
        };
      }
    }
  }

  return { allowed: true };
}

/**
 * The same six checks, reported rather than enforced. The Controls screen uses
 * this to show what is currently stopping work, so an operator can see the
 * state of the system without having to trigger something to find out.
 */
export async function explainGate(campaignId = null) {
  const control = await getSystemControl();

  const campaigns = unwrapSoft(
    await supabase.from('campaigns').select('id, name, status, enabled_channels'),
    [],
    'campaigns'
  );

  const pausedChannels = Object.entries(control.channel_pauses ?? {})
    .filter(([, paused]) => paused)
    .map(([c]) => c);

  const pausedAgents = Object.entries(control.agent_pauses ?? {})
    .filter(([, paused]) => paused)
    .map(([a]) => a);

  const blockers = [];
  if (control.kill_switch) blockers.push({ level: 'system', detail: 'Kill switch is on' });
  for (const c of pausedChannels) blockers.push({ level: 'channel', detail: `${c} is paused` });
  for (const a of pausedAgents) blockers.push({ level: 'agent', detail: `${getAgentName(a)} is paused` });

  const target = campaignId ? campaigns.find((c) => c.id === campaignId) : null;
  if (target && target.status !== 'live') {
    blockers.push({ level: 'campaign', detail: `${target.name} is ${target.status}` });
  }

  return {
    kill_switch: control.kill_switch,
    channel_pauses: control.channel_pauses,
    agent_pauses: control.agent_pauses,
    paused_channels: pausedChannels,
    paused_agents: pausedAgents,
    live_campaigns: campaigns.filter((c) => c.status === 'live').length,
    total_campaigns: campaigns.length,
    blockers,
    running: blockers.length === 0,
  };
}
