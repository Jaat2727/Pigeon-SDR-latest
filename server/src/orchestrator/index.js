/**
 * The orchestrator.
 *
 * `advance` moves one prospect one step, based on the state that prospect is
 * in for that campaign. It is the only thing in the system that changes a
 * prospect's state, and every path through it goes past the gate first.
 *
 * Steps are small on purpose. A pass that does one thing and returns leaves a
 * prospect in a state you can read off the database and explain, which is what
 * makes the timeline honest. `advanceUntilBlocked` just calls it in a loop.
 */
import { supabase, unwrapSoft } from '../db/client.js';
import { callAgent } from '../agents/client.js';
import { isActionAllowed } from './gate.js';
import { retrieveForStep } from '../services/knowledge.js';
import { sendEmail } from '../services/mailer.js';
import { isMailerConfigured } from '../config.js';
import {
  logActivity,
  raiseApproval,
  detectConflict,
  hasBlockingConflict,
} from '../services/activity.js';

const ENRICHMENT_TTL_DAYS = 14;

/** The step each state is waiting on. A state absent here is terminal. */
export const STEP_BY_STATE = {
  discovered: 'research',
  researched: 'icp_fitment',
  qualified: 'outreach_strategy',
  strategy_planned: 'personalisation',
  contacted: 'personalisation',
  engaged: null,
  meeting: null,
  opportunity: null,
  rejected: null,
  needs_review: null,
  stopped: null,
  suppressed: null,
  opted_out: null,
};

const TERMINAL = new Set(['rejected', 'needs_review', 'stopped', 'suppressed', 'opted_out', 'meeting', 'opportunity']);

/* ── helpers ──────────────────────────────────────────────────────────── */

async function loadContext(campaignId, prospectId) {
  const [campaign, prospect, cp] = await Promise.all([
    supabase.from('campaigns').select('*, reps(*)').eq('id', campaignId).maybeSingle(),
    supabase.from('prospects').select('*').eq('id', prospectId).maybeSingle(),
    supabase
      .from('campaign_prospects')
      .select('*')
      .eq('campaign_id', campaignId)
      .eq('prospect_id', prospectId)
      .maybeSingle(),
  ]);

  return {
    campaign: unwrapSoft(campaign, null, 'campaigns'),
    prospect: unwrapSoft(prospect, null, 'prospects'),
    cp: unwrapSoft(cp, null, 'campaign_prospects'),
  };
}

async function updateCp(campaignId, prospectId, patch) {
  const { error } = await supabase
    .from('campaign_prospects')
    .update(patch)
    .eq('campaign_id', campaignId)
    .eq('prospect_id', prospectId);
  if (error) throw new Error(`campaign_prospects update: ${error.message}`);
}

/** The campaign's written policy, in the shape the agents expect. */
function policyOf(campaign) {
  return {
    icp_criteria: campaign.icp_criteria,
    exclusion_criteria: campaign.exclusion_criteria,
    target_roles: campaign.target_roles ?? [],
    industry: campaign.industry,
    company_size: campaign.company_size,
    outreach_policy: campaign.outreach_policy,
    messaging_policy: campaign.messaging_policy,
    research_focus: campaign.research_focus,
    working_hours: campaign.working_hours,
  };
}

/** Name and company for the feed, from whichever source has them. */
function displayOf(prospect) {
  const e = prospect.enriched_data ?? {};
  return {
    name: e.person?.full_name || prospect.full_name ||
      [prospect.first_name, prospect.last_name].filter(Boolean).join(' ') || 'Unknown prospect',
    company: e.company?.name || prospect.company_name || null,
  };
}

async function activePrompts(campaignId) {
  const rows = unwrapSoft(
    await supabase
      .from('prompt_versions')
      .select('agent_name, content')
      .eq('campaign_id', campaignId)
      .eq('is_active', true),
    [],
    'prompt_versions'
  );
  return Object.fromEntries(rows.map((r) => [r.agent_name, r.content]));
}

const isEnrichmentFresh = (prospect) =>
  Boolean(
    prospect.enriched_data &&
      prospect.enrichment_stale_after &&
      new Date(prospect.enrichment_stale_after) > new Date()
  );

/**
 * Turns day offsets into timestamps.
 *
 * The first touch is never rolled off a weekend. A campaign set live on a
 * Saturday that then sits idle until Monday looks broken, and to the operator
 * who just pressed the button it is broken. Later touches do roll, because by
 * then the sequence is running and a Tuesday email beats a Sunday one.
 */
export function scheduleSequence(sequence, workingHours = {}) {
  const startHour = parseInt((workingHours.start ?? '09:00').split(':')[0], 10) || 9;
  const now = new Date();

  return (sequence ?? []).map((step, i) => {
    const at = new Date(now.getTime() + (step.day_offset ?? i * 3) * 86400000);

    if (step.day_offset > 0) {
      // 0 is Sunday, 6 is Saturday.
      if (at.getUTCDay() === 6) at.setUTCDate(at.getUTCDate() + 2);
      else if (at.getUTCDay() === 0) at.setUTCDate(at.getUTCDate() + 1);
      at.setUTCHours(startHour, 0, 0, 0);
    }

    return { ...step, scheduled_at: at.toISOString() };
  });
}

/* ── the one step ─────────────────────────────────────────────────────── */

/**
 * Moves one prospect one step forward in one campaign.
 *
 * @returns {Promise<{status, state, reason?, engine?, degraded?}>}
 *   status is one of: advanced, blocked, done, error
 */
export async function advance(campaignId, prospectId, { force = false, signal = null } = {}) {
  if (signal?.aborted) return { status: 'cancelled', reason: 'Cancelled before this step started' };

  const { campaign, prospect, cp } = await loadContext(campaignId, prospectId);

  if (!campaign) return { status: 'error', reason: 'Campaign not found' };
  if (!prospect) return { status: 'error', reason: 'Prospect not found' };
  if (!cp) return { status: 'error', reason: 'This prospect is not in this campaign' };

  const state = cp.state;
  const step = STEP_BY_STATE[state];

  if (!step) {
    return { status: 'done', state, reason: `Nothing to do from "${state}"` };
  }

  const isOutbound = step === 'personalisation';

  // ── the gate, once, for every path ─────────────────────────────────────
  const gate = await isActionAllowed({
    campaignId,
    prospectId,
    agentName: step,
    channel: isOutbound ? (cp.sequence?.[cp.current_step]?.channel ?? 'email') : null,
    isOutbound,
  });

  if (!gate.allowed) {
    // Suppression is not a temporary block, it is an answer. Record it as the
    // prospect's state so the system stops asking.
    if (gate.level === 'suppression') {
      await updateCp(campaignId, prospectId, {
        state: 'suppressed',
        next_action_at: null,
        stopped_reason: gate.reason,
      });
      await logActivity({
        campaignId,
        prospectId,
        agentName: 'system',
        action: 'Stopped before contact',
        detail: gate.reason,
        status: 'blocked',
        metadata: gate.detail ?? {},
      });
      return { status: 'blocked', state: 'suppressed', reason: gate.reason };
    }

    await logActivity({
      campaignId,
      prospectId,
      agentName: 'system',
      action: 'Held',
      detail: gate.reason,
      status: 'blocked',
      metadata: { level: gate.level },
    });
    return { status: 'blocked', state, reason: gate.reason, level: gate.level };
  }

  const policy = policyOf(campaign);
  const prompts = await activePrompts(campaignId);
  const display = displayOf(prospect);

  const harness = (payload) => ({
    ...payload,
    _system_prompt: prompts.system ?? null,
    _agent_prompt: prompts[step] ?? null,
  });

  // `signal` rides along on every agent call, so cancelling a job aborts the
  // HTTP request to Groq or Gemini rather than waiting for it to come back.
  const baseMeta = { campaignId, prospectId, signal };

  /** A cancelled call is not a failed step. It is a step that did not happen. */
  const cancelled = (result) => result.cancelled === true;

  try {
    switch (step) {
      /* ── research ─────────────────────────────────────────────────── */
      case 'research': {
        if (isEnrichmentFresh(prospect) && !force) {
          await updateCp(campaignId, prospectId, { state: 'researched' });
          return { status: 'advanced', state: 'researched', reason: 'Used cached enrichment' };
        }

        const result = await callAgent(
          'research',
          harness({
            prospect: { stub: prospect },
            campaign: { research_focus: policy.research_focus, name: campaign.name },
          }),
          { ...baseMeta, localPayload: { stub: prospect } }
        );

        if (cancelled(result)) return { status: 'cancelled', state, reason: 'Cancelled mid-step' };
        if (!result.success) return { status: 'error', state, reason: result.error };

        await supabase
          .from('prospects')
          .update({
            enriched_data: result.output,
            enriched_at: new Date().toISOString(),
            enrichment_stale_after: new Date(Date.now() + ENRICHMENT_TTL_DAYS * 86400000).toISOString(),
            research_confidence: result.output.confidence ?? null,
            fields_not_found: result.output.fields_not_found ?? [],
          })
          .eq('id', prospectId);

        await updateCp(campaignId, prospectId, { state: 'researched' });

        const notFound = result.output.fields_not_found?.length ?? 0;
        await logActivity({
          ...baseMeta,
          agentRunId: result.agentRunId,
          agentName: 'research',
          engine: result.engine,
          action: 'Researched prospect',
          detail:
            `Built a profile for ${display.name}` +
            (notFound ? `, ${notFound} field${notFound === 1 ? '' : 's'} left null` : ''),
          status: result.degraded ? 'degraded' : 'success',
          metadata: { fields_not_found: notFound, confidence: result.output.confidence },
        });

        return { status: 'advanced', state: 'researched', engine: result.engine, degraded: result.degraded };
      }

      /* ── ICP fitment ──────────────────────────────────────────────── */
      case 'icp_fitment': {
        const enriched = prospect.enriched_data ?? prospect;
        const chunks = await retrieveForStep({
          campaignId,
          agentName: 'icp_fitment',
          context: `${policy.icp_criteria ?? ''} ${JSON.stringify(enriched).slice(0, 1200)}`,
        });

        const result = await callAgent(
          'icp_fitment',
          harness({
            prospect: { enriched_profile: enriched },
            campaign: {
              icp_criteria: policy.icp_criteria,
              exclusion_criteria: policy.exclusion_criteria,
              target_roles: policy.target_roles,
              industry: policy.industry,
              company_size: policy.company_size,
              sample_profiles: campaign.sample_profiles ?? [],
            },
            retrieved_knowledge: chunks,
          }),
          {
            ...baseMeta,
            retrievedChunks: chunks,
            localPayload: { enriched_profile: enriched, campaign: policy },
          }
        );

        if (cancelled(result)) return { status: 'cancelled', state, reason: 'Cancelled mid-step' };
        if (!result.success) return { status: 'error', state, reason: result.error };

        const out = result.output;
        const nextState =
          out.verdict === 'qualify' ? 'qualified' : out.verdict === 'reject' ? 'rejected' : 'needs_review';

        await updateCp(campaignId, prospectId, {
          state: nextState,
          fit_score: out.fit_score,
          icp_verdict: out.verdict,
          icp_confidence: out.confidence,
          icp_result: out,
          next_action_at: nextState === 'qualified' ? new Date().toISOString() : null,
        });

        if (nextState === 'needs_review') {
          await raiseApproval({
            ...baseMeta,
            campaignProspectId: cp.id,
            type: 'icp_review',
            sourceAgent: 'icp_fitment',
            reason:
              out.missing_data?.length
                ? `Not enough information to score. Missing: ${out.missing_data.join(', ')}.`
                : out.reasoning || 'The scoring agent could not reach a decision.',
            proposedAction: 'Qualify or reject this prospect by hand',
            payload: out,
          });
        }

        await logActivity({
          ...baseMeta,
          agentRunId: result.agentRunId,
          agentName: 'icp_fitment',
          engine: result.engine,
          action:
            out.verdict === 'qualify' ? 'Qualified' : out.verdict === 'reject' ? 'Rejected' : 'Sent for review',
          detail: `${display.name} scored ${out.fit_score}/100. ${out.reasoning ?? ''}`.trim(),
          status: nextState === 'needs_review' ? 'escalated' : result.degraded ? 'degraded' : 'success',
          metadata: {
            fit_score: out.fit_score,
            verdict: out.verdict,
            disqualifiers: out.disqualifiers ?? [],
          },
        });

        // A prospect two live campaigns are both working is worth flagging
        // before either of them sends anything.
        if (nextState === 'qualified') {
          const conflict = await detectConflict(prospectId, campaignId);
          if (conflict) {
            await raiseApproval({
              ...baseMeta,
              campaignProspectId: cp.id,
              type: 'duplicate_conflict',
              sourceAgent: 'system',
              reason: conflict.reason,
              proposedAction: 'Choose which campaign keeps this prospect',
              payload: conflict,
            });
            await logActivity({
              ...baseMeta,
              agentName: 'system',
              action: 'Flagged a duplicate',
              detail: conflict.reason,
              status: 'escalated',
            });
          }
        }

        return { status: 'advanced', state: nextState, engine: result.engine, degraded: result.degraded };
      }

      /* ── outreach strategy ────────────────────────────────────────── */
      case 'outreach_strategy': {
        if (await hasBlockingConflict(prospectId)) {
          return {
            status: 'blocked',
            state,
            reason: 'Held: this prospect is claimed by two live campaigns and the conflict is open.',
          };
        }

        const enriched = prospect.enriched_data ?? prospect;
        const history = unwrapSoft(
          await supabase
            .from('messages')
            .select('direction, channel, subject, body, sent_at, created_at')
            .eq('prospect_id', prospectId)
            .order('created_at', { ascending: true })
            .limit(20),
          [],
          'messages'
        );

        const chunks = await retrieveForStep({
          campaignId,
          agentName: 'outreach_strategy',
          context: `${policy.outreach_policy ?? ''} ${enriched?.person?.title ?? ''}`,
        });

        const enabledChannels = Array.isArray(campaign.enabled_channels)
          ? campaign.enabled_channels
          : ['email'];

        const result = await callAgent(
          'outreach_strategy',
          harness({
            prospect: {
              enriched_profile: enriched,
              icp_result: cp.icp_result,
              contact_history: history,
            },
            campaign: {
              outreach_policy: policy.outreach_policy,
              enabled_channels: enabledChannels,
              working_hours: policy.working_hours,
            },
            retrieved_knowledge: chunks,
          }),
          {
            ...baseMeta,
            retrievedChunks: chunks,
            localPayload: {
              enriched_profile: enriched,
              icp_result: cp.icp_result,
              campaign: { ...policy, enabled_channels: enabledChannels },
              contact_history: history,
            },
          }
        );

        if (cancelled(result)) return { status: 'cancelled', state, reason: 'Cancelled mid-step' };
        if (!result.success) return { status: 'error', state, reason: result.error };

        const out = result.output;
        // Only channels this campaign has enabled. The agent is told, but the
        // system does not depend on the agent having listened.
        const allowed = (out.sequence ?? []).filter((s) => enabledChannels.includes(s.channel));
        const plan = scheduleSequence(allowed, policy.working_hours);

        if (!out.should_contact || plan.length === 0) {
          const reason = out.no_contact_reason || 'The strategy agent decided not to contact this prospect.';
          await updateCp(campaignId, prospectId, {
            state: 'stopped',
            should_contact: false,
            no_contact_reason: reason,
            stopped_reason: reason,
            next_action_at: null,
          });
          await logActivity({
            ...baseMeta,
            agentRunId: result.agentRunId,
            agentName: 'outreach_strategy',
            engine: result.engine,
            action: 'Decided not to contact',
            detail: reason,
            status: 'success',
          });
          return { status: 'advanced', state: 'stopped', engine: result.engine };
        }

        await updateCp(campaignId, prospectId, {
          state: 'strategy_planned',
          sequence: plan,
          current_step: 0,
          priority: out.priority,
          should_contact: true,
          no_contact_reason: null,
          next_action_at: plan[0].scheduled_at,
        });

        await logActivity({
          ...baseMeta,
          agentRunId: result.agentRunId,
          agentName: 'outreach_strategy',
          engine: result.engine,
          action: 'Planned a sequence',
          detail:
            `${plan.length} touch${plan.length === 1 ? '' : 'es'} over ` +
            `${plan[plan.length - 1].day_offset ?? 0} days on ` +
            `${[...new Set(plan.map((s) => s.channel))].join(' and ')}`,
          status: result.degraded ? 'degraded' : 'success',
          metadata: { steps: plan.length, priority: out.priority },
        });

        return { status: 'advanced', state: 'strategy_planned', engine: result.engine, degraded: result.degraded };
      }

      /* ── personalisation ──────────────────────────────────────────── */
      case 'personalisation': {
        if (await hasBlockingConflict(prospectId)) {
          return { status: 'blocked', state, reason: 'Held: an open duplicate conflict.' };
        }

        const sequence = Array.isArray(cp.sequence) ? cp.sequence : [];
        const index = cp.current_step ?? 0;
        const current = sequence[index];

        if (!current) {
          await updateCp(campaignId, prospectId, {
            state: 'stopped',
            next_action_at: null,
            stopped_reason: 'Sequence finished with no reply.',
          });
          await logActivity({
            ...baseMeta,
            agentName: 'system',
            action: 'Sequence finished',
            detail: `All ${sequence.length} touches sent, no reply.`,
            status: 'success',
          });
          return { status: 'advanced', state: 'stopped' };
        }

        // A draft already waiting on a person is not a reason to write another
        // one. The prospect stays at `strategy_planned` while a message sits
        // in the queue, so without this check every press of Run produced a
        // fresh copy of the same touch and buried the queue in duplicates.
        const pending = unwrapSoft(
          await supabase
            .from('messages')
            .select('id, step')
            .eq('campaign_id', campaignId)
            .eq('prospect_id', prospectId)
            .eq('direction', 'outbound')
            .eq('status', 'pending_approval')
            .limit(1),
          [],
          'messages'
        );

        if (pending.length > 0) {
          return {
            status: 'blocked',
            state,
            reason: `Touch ${pending[0].step ?? index + 1} is already drafted and waiting for approval.`,
          };
        }

        if (!force && current.scheduled_at && new Date(current.scheduled_at) > new Date()) {
          return {
            status: 'blocked',
            state,
            reason: `Step ${index + 1} is scheduled for ${new Date(current.scheduled_at).toUTCString()}.`,
          };
        }

        const enriched = prospect.enriched_data ?? prospect;
        const thread = unwrapSoft(
          await supabase
            .from('messages')
            .select('direction, channel, subject, body, created_at')
            .eq('prospect_id', prospectId)
            .eq('campaign_id', campaignId)
            .order('created_at', { ascending: true }),
          [],
          'messages'
        );

        const chunks = await retrieveForStep({
          campaignId,
          agentName: 'personalisation',
          context: `${current.angle ?? ''} ${current.signal_used ?? ''} ${JSON.stringify(enriched?.signals ?? {})}`,
        });

        const rep = campaign.reps ?? null;

        const result = await callAgent(
          'personalisation',
          harness({
            prospect: { enriched_profile: enriched, thread_history: thread },
            outreach: { current_step: current },
            campaign: { messaging_policy: policy.messaging_policy },
            retrieved_knowledge: chunks,
            rep: { identity: rep?.full_name ?? 'Sales team', title: rep?.title ?? null },
          }),
          {
            ...baseMeta,
            retrievedChunks: chunks,
            coerceContext: current.channel,
            localPayload: {
              enriched_profile: enriched,
              current_step: current,
              retrieved_knowledge: chunks,
              rep: { identity: rep?.full_name ?? 'Sales team' },
            },
          }
        );

        if (cancelled(result)) return { status: 'cancelled', state, reason: 'Cancelled mid-step' };
        if (!result.success) return { status: 'error', state, reason: result.error };

        const out = result.output;

        // The agent refusing to send is a good outcome, not a failure.
        if (out.needs_human) {
          const message = unwrapSoft(
            await supabase
              .from('messages')
              .insert({
                campaign_id: campaignId,
                prospect_id: prospectId,
                direction: 'outbound',
                channel: out.channel ?? current.channel,
                step: index + 1,
                subject: out.subject,
                body: out.body ?? '(the agent declined to draft this message)',
                status: 'pending_approval',
                agent_run_id: result.agentRunId,
                personalisation_used: out.personalisation_used ?? [],
                knowledge_used: chunks.map((c) => ({ id: c.id, title: c.title })),
              })
              .select('id')
              .maybeSingle(),
            null,
            'messages insert'
          );

          await raiseApproval({
            ...baseMeta,
            campaignProspectId: cp.id,
            messageId: message?.id ?? null,
            type: 'message_approval',
            sourceAgent: 'personalisation',
            reason: out.needs_human_reason || 'The agent had nothing specific enough to say.',
            proposedAction: 'Review this draft before it goes out',
            payload: out,
          });

          await updateCp(campaignId, prospectId, { next_action_at: null });

          await logActivity({
            ...baseMeta,
            agentRunId: result.agentRunId,
            agentName: 'personalisation',
            engine: result.engine,
            action: 'Held a message for review',
            detail: out.needs_human_reason || 'Nothing specific enough to send.',
            status: 'escalated',
          });

          return { status: 'blocked', state, reason: 'Waiting on a human' };
        }

        const needsApproval = campaign.require_approval !== false;

        const message = unwrapSoft(
          await supabase
            .from('messages')
            .insert({
              campaign_id: campaignId,
              prospect_id: prospectId,
              direction: 'outbound',
              channel: out.channel ?? current.channel,
              step: index + 1,
              subject: out.subject,
              body: out.body,
              status: needsApproval ? 'pending_approval' : 'sent',
              scheduled_at: current.scheduled_at ?? null,
              sent_at: needsApproval ? null : new Date().toISOString(),
              agent_run_id: result.agentRunId,
              personalisation_used: out.personalisation_used ?? [],
              knowledge_used: chunks.map((c) => ({ id: c.id, title: c.title })),
            })
            .select('id')
            .maybeSingle(),
          null,
          'messages insert'
        );

        if (needsApproval) {
          await raiseApproval({
            ...baseMeta,
            campaignProspectId: cp.id,
            messageId: message?.id ?? null,
            type: 'message_approval',
            sourceAgent: 'personalisation',
            reason: `Touch ${index + 1} of ${sequence.length} on ${out.channel ?? current.channel}.`,
            proposedAction: 'Approve to send',
            payload: out,
          });
          await updateCp(campaignId, prospectId, { next_action_at: null });
        } else {
          await updateCp(campaignId, prospectId, {
            state: 'contacted',
            current_step: index + 1,
            last_contacted_at: new Date().toISOString(),
            next_action_at: sequence[index + 1]?.scheduled_at ?? null,
          });
        }

        await logActivity({
          ...baseMeta,
          agentRunId: result.agentRunId,
          agentName: 'personalisation',
          engine: result.engine,
          action: needsApproval ? 'Drafted a message' : 'Sent a message',
          detail:
            `Touch ${index + 1} on ${out.channel ?? current.channel}, ${out.word_count ?? '?'} words` +
            (chunks.length ? `, grounded in ${chunks.length} source${chunks.length === 1 ? '' : 's'}` : ''),
          status: result.degraded ? 'degraded' : 'success',
          metadata: {
            step: index + 1,
            channel: out.channel ?? current.channel,
            knowledge_used: chunks.length,
          },
        });

        return {
          status: 'advanced',
          state: needsApproval ? state : 'contacted',
          engine: result.engine,
          degraded: result.degraded,
        };
      }

      default:
        return { status: 'done', state, reason: `No handler for step "${step}"` };
    }
  } catch (err) {
    await logActivity({
      ...baseMeta,
      agentName: step,
      action: 'Step failed',
      detail: err.message,
      status: 'failed',
    });
    return { status: 'error', state, reason: err.message };
  }
}

/** Keeps calling `advance` until it stops making progress. */
export async function advanceUntilBlocked(
  campaignId,
  prospectId,
  { maxSteps = 6, force = false, signal = null } = {}
) {
  const steps = [];
  for (let i = 0; i < maxSteps; i += 1) {
    if (signal?.aborted) {
      steps.push({ status: 'cancelled', reason: 'Cancelled' });
      break;
    }
    const result = await advance(campaignId, prospectId, { force, signal });
    steps.push(result);
    if (result.status !== 'advanced') break;
    if (TERMINAL.has(result.state)) break;
  }
  return steps;
}

/**
 * Approving a message is what sends it. Delivery is simulated: there is no
 * email provider wired in, and the UI says so rather than implying a send.
 */
export async function sendApprovedMessage(messageId, actor = 'operator') {
  const message = unwrapSoft(
    await supabase.from('messages').select('*').eq('id', messageId).maybeSingle(),
    null,
    'messages'
  );
  if (!message) throw new Error('Message not found');

  const gate = await isActionAllowed({
    campaignId: message.campaign_id,
    prospectId: message.prospect_id,
    channel: message.channel,
    agentName: 'personalisation',
    isOutbound: true,
  });

  if (!gate.allowed) return { sent: false, reason: gate.reason };

  // Checked here as well as before drafting, because a conflict can appear in
  // between: a draft written while only one campaign was working this person
  // can be sitting in the queue when a second campaign qualifies them. The
  // approval click is the last moment anything can stop it.
  if (await hasBlockingConflict(message.prospect_id)) {
    return {
      sent: false,
      reason:
        'Held: another live campaign is also working this prospect. Resolve the duplicate first, ' +
        'or this person gets two unrelated sequences from the same company.',
    };
  }

  // Real delivery, email only. LinkedIn, SMS and voice have no provider wired
  // and stay simulated — the thread says which one it was either way.
  let delivery = { simulated: true };
  if (message.channel === 'email' && isMailerConfigured()) {
    const { campaign, prospect } = await loadContext(message.campaign_id, message.prospect_id);
    const display = prospect ? displayOf(prospect) : { name: null };
    const rep = campaign?.reps ?? null;

    delivery = await sendEmail({
      to: prospect?.email ?? null,
      subject: message.subject,
      body: message.body,
      fromName: rep?.full_name ?? campaign?.name ?? 'Pigeon',
      replyTo: rep?.email ?? undefined,
    });
    delivery.simulated = false;

    if (!delivery.sent) {
      await supabase
        .from('messages')
        .update({ status: 'failed' })
        .eq('id', messageId);

      await logActivity({
        campaignId: message.campaign_id,
        prospectId: message.prospect_id,
        agentName: 'system',
        action: 'Send failed',
        detail: `${actor} approved this for ${display.name ?? 'this prospect'}, but sending it failed: ${delivery.error}`,
        status: 'failed',
        metadata: { message_id: messageId, channel: message.channel },
      });

      return { sent: false, reason: `Approved, but the send itself failed: ${delivery.error}` };
    }
  }

  await supabase
    .from('messages')
    .update({ status: 'sent', sent_at: new Date().toISOString() })
    .eq('id', messageId);

  const cp = unwrapSoft(
    await supabase
      .from('campaign_prospects')
      .select('*')
      .eq('campaign_id', message.campaign_id)
      .eq('prospect_id', message.prospect_id)
      .maybeSingle(),
    null,
    'campaign_prospects'
  );

  if (cp) {
    const sequence = Array.isArray(cp.sequence) ? cp.sequence : [];
    const next = (cp.current_step ?? 0) + 1;
    await updateCp(message.campaign_id, message.prospect_id, {
      state: 'contacted',
      current_step: next,
      last_contacted_at: new Date().toISOString(),
      next_action_at: sequence[next]?.scheduled_at ?? null,
    });
  }

  await logActivity({
    campaignId: message.campaign_id,
    prospectId: message.prospect_id,
    agentName: 'system',
    action: 'Sent a message',
    detail: delivery.simulated
      ? `Approved by ${actor} and sent on ${message.channel}.`
      : delivery.sandboxed
        ? `Approved by ${actor} and delivered by email — sandboxed to ${delivery.actually_sent_to} ` +
          `(would have gone to ${delivery.intended_for}).`
        : `Approved by ${actor} and delivered by email.`,
    status: 'success',
    metadata: {
      message_id: messageId,
      channel: message.channel,
      simulated_delivery: delivery.simulated,
      ...(delivery.message_id ? { smtp_message_id: delivery.message_id } : {}),
      ...(delivery.sandboxed ? { sandboxed: true, intended_for: delivery.intended_for } : {}),
    },
  });

  return { sent: true, simulated: delivery.simulated, sandboxed: delivery.sandboxed ?? false };
}

/**
 * An inbound reply. Records it, classifies it with the conversation agent, and
 * moves the prospect according to what they actually said.
 */
const STATE_BY_INTENT = {
  meeting_request: 'meeting',
  interested: 'engaged',
  question: 'engaged',
  objection: 'engaged',
  referral: 'engaged',
  not_now: 'engaged',
  not_interested: 'stopped',
  opt_out: 'opted_out',
  wrong_person: 'stopped',
  bounce: 'stopped',
  auto_reply: null, // not a reply from a person; the sequence carries on
  unclear: 'engaged',
};

export async function handleReply(campaignId, prospectId, { body, channel = 'email', signal = null }) {
  const { campaign, prospect, cp } = await loadContext(campaignId, prospectId);
  if (!campaign || !prospect || !cp) return { status: 'error', reason: 'Unknown prospect or campaign' };

  const inbound = unwrapSoft(
    await supabase
      .from('messages')
      .insert({
        campaign_id: campaignId,
        prospect_id: prospectId,
        direction: 'inbound',
        channel,
        body,
        status: 'received',
      })
      .select('id')
      .maybeSingle(),
    null,
    'messages insert'
  );

  const prompts = await activePrompts(campaignId);
  const chunks = await retrieveForStep({
    campaignId,
    agentName: 'conversation',
    context: body,
  });

  const result = await callAgent(
    'conversation',
    {
      inbound: { message: body, channel },
      prospect: { enriched_profile: prospect.enriched_data ?? prospect, thread_history: [] },
      campaign: { objective_and_policy: campaign.messaging_policy },
      retrieved_knowledge: chunks,
      _system_prompt: prompts.system ?? null,
      _agent_prompt: prompts.conversation ?? null,
    },
    { campaignId, prospectId, retrievedChunks: chunks, localPayload: { message: body }, signal }
  );

  if (!result.success) return { status: 'error', reason: result.error };

  const out = result.output;

  if (inbound?.id) {
    await supabase
      .from('messages')
      .update({
        intent: out.intent,
        intent_confidence: out.intent_confidence,
        sentiment: out.sentiment,
        extracted_facts: out.extracted_facts ?? [],
        questions_asked: out.questions_asked ?? [],
        objections_raised: out.objections_raised ?? [],
        referral: out.referral,
        is_auto_reply: !out.is_human_reply,
        agent_run_id: result.agentRunId,
      })
      .eq('id', inbound.id);
  }

  const nextState = STATE_BY_INTENT[out.intent];
  const display = displayOf(prospect);

  if (nextState) {
    await updateCp(campaignId, prospectId, {
      state: nextState,
      replied_at: new Date().toISOString(),
      next_action_at: null,
      ...(nextState === 'opted_out' ? { stopped_reason: 'Opted out' } : {}),
    });
  }

  // An opt-out is written to the suppression list, not just to a state, so it
  // holds across every campaign rather than only this one.
  if (out.intent === 'opt_out' && prospect.email) {
    await supabase
      .from('suppression_list')
      .insert({ email: prospect.email, reason: 'Opted out by reply', scope: 'global' });
  }

  if (out.requires_human) {
    await raiseApproval({
      campaignId,
      prospectId,
      campaignProspectId: cp.id,
      messageId: inbound?.id ?? null,
      type: 'reply_escalation',
      sourceAgent: 'conversation',
      reason: out.escalation_reason || `A ${out.intent.replace(/_/g, ' ')} reply that needs a person.`,
      proposedAction: out.recommended_action,
      payload: out,
    });
  }

  await logActivity({
    campaignId,
    prospectId,
    agentRunId: result.agentRunId,
    agentName: 'conversation',
    engine: result.engine,
    action: 'Classified a reply',
    detail: `${display.name} replied: ${out.intent.replace(/_/g, ' ')} (${Math.round(out.intent_confidence * 100)}% confident). ${out.recommended_action}`,
    status: out.requires_human ? 'escalated' : result.degraded ? 'degraded' : 'success',
    metadata: { intent: out.intent, sentiment: out.sentiment, requires_human: out.requires_human },
  });

  return { status: 'ok', intent: out.intent, state: nextState, engine: result.engine, output: out };
}

/**
 * Running a whole campaign used to live here, synchronously, inside the HTTP
 * request that asked for it. It now lives in orchestrator/jobs.js as a job
 * with progress and a cancel button, because four agent calls per prospect is
 * minutes of work and no browser waits that long. This file keeps the part
 * that was always correct: one prospect, one step, one honest answer.
 */
