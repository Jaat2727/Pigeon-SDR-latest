/**
 * Database rows to API shapes.
 *
 * One place where a column name becomes a field name, so a schema change
 * shows up here instead of in six components.
 */
import { actorFor } from './activity.js';

const nameOf = (p) => {
  if (!p) return 'Unknown prospect';
  const enriched = p.enriched_data?.person?.full_name;
  const joined = [p.first_name, p.last_name].filter(Boolean).join(' ');
  return enriched || p.full_name || joined || p.email || 'Unknown prospect';
};

const companyOf = (p) => p?.enriched_data?.company?.name || p?.company_name || null;
const titleOf = (p) => p?.enriched_data?.person?.title || p?.title || null;

export function mapCampaign(row, extra = {}) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    status: row.status,
    objective: row.objective,
    icp_criteria: row.icp_criteria,
    exclusion_criteria: row.exclusion_criteria,
    target_roles: row.target_roles ?? [],
    industry: row.industry,
    company_size: row.company_size,
    enabled_channels: Array.isArray(row.enabled_channels) ? row.enabled_channels : ['email'],
    outreach_policy: row.outreach_policy,
    messaging_policy: row.messaging_policy,
    research_focus: row.research_focus,
    working_hours: row.working_hours,
    daily_send_limit: row.daily_send_limit,
    require_approval: row.require_approval,
    rep: row.reps ? { id: row.reps.id, name: row.reps.full_name, title: row.reps.title } : null,
    created_at: row.created_at,
    updated_at: row.updated_at,
    ...extra,
  };
}

/** A row in the prospects table on screen. */
export function mapProspectRow(cp) {
  const p = cp.prospects ?? {};
  return {
    id: p.id,
    campaign_prospect_id: cp.id,
    campaign_id: cp.campaign_id,
    campaign_name: cp.campaigns?.name ?? null,
    name: nameOf(p),
    title: titleOf(p),
    company: companyOf(p),
    email: p.email,
    state: cp.state,
    fit_score: cp.fit_score,
    icp_verdict: cp.icp_verdict,
    icp_confidence: cp.icp_confidence,
    priority: cp.priority,
    current_step: cp.current_step,
    total_steps: Array.isArray(cp.sequence) ? cp.sequence.length : 0,
    next_action_at: cp.next_action_at,
    last_contacted_at: cp.last_contacted_at,
    replied_at: cp.replied_at,
    paused: cp.paused,
    enriched: Boolean(p.enriched_data),
    source: p.source,
  };
}

/**
 * Everything known about one prospect, including which campaign said what.
 * The `campaigns` array is the per-campaign isolation made visible: the same
 * person can carry a different verdict in each one.
 */
export function mapProspectDetail(prospect, memberships, messages, runs, activities) {
  const e = prospect.enriched_data ?? {};

  return {
    id: prospect.id,
    name: nameOf(prospect),
    title: titleOf(prospect),
    company: companyOf(prospect),
    email: prospect.email,
    phone: prospect.phone,
    linkedin_url: e.person?.linkedin_url || prospect.linkedin_url,
    company_domain: e.company?.domain || prospect.company_domain,
    source: prospect.source,

    enrichment: prospect.enriched_data
      ? {
          confidence: prospect.research_confidence,
          enriched_at: prospect.enriched_at,
          stale_after: prospect.enrichment_stale_after,
          fields_not_found: prospect.fields_not_found ?? [],
          person: e.person ?? {},
          company: e.company ?? {},
          signals: e.signals ?? {},
          sources: e.sources ?? [],
          notes: e.research_notes ?? null,
        }
      : null,

    provenance: prospect.field_provenance ?? {},

    campaigns: (memberships ?? []).map((cp) => ({
      campaign_id: cp.campaign_id,
      campaign_name: cp.campaigns?.name ?? 'Unknown campaign',
      campaign_status: cp.campaigns?.status ?? null,
      state: cp.state,
      fit_score: cp.fit_score,
      icp_verdict: cp.icp_verdict,
      icp_confidence: cp.icp_confidence,
      icp_reasoning: cp.icp_result?.reasoning ?? null,
      disqualifiers: cp.icp_result?.disqualifiers ?? [],
      missing_data: cp.icp_result?.missing_data ?? [],
      priority: cp.priority,
      should_contact: cp.should_contact,
      no_contact_reason: cp.no_contact_reason,
      sequence: Array.isArray(cp.sequence) ? cp.sequence : [],
      current_step: cp.current_step,
      next_action_at: cp.next_action_at,
      paused: cp.paused,
      stopped_reason: cp.stopped_reason,
    })),

    thread: (messages ?? []).map(mapMessage),
    runs: (runs ?? []).map(mapRun),
    timeline: (activities ?? []).map(mapActivity),
  };
}

export function mapMessage(m) {
  return {
    id: m.id,
    campaign_id: m.campaign_id,
    direction: m.direction,
    channel: m.channel,
    step: m.step,
    subject: m.subject,
    body: m.body,
    status: m.status,
    scheduled_at: m.scheduled_at,
    sent_at: m.sent_at,
    created_at: m.created_at,
    personalisation_used: m.personalisation_used ?? [],
    knowledge_used: m.knowledge_used ?? [],
    intent: m.intent,
    intent_confidence: m.intent_confidence,
    sentiment: m.sentiment,
    extracted_facts: m.extracted_facts ?? [],
    questions_asked: m.questions_asked ?? [],
    objections_raised: m.objections_raised ?? [],
    referral: m.referral,
    is_auto_reply: m.is_auto_reply,
  };
}

export function mapRun(r) {
  return {
    id: r.id,
    agent: r.agent_name,
    agent_name: actorFor(r.agent_name),
    engine: r.engine,
    status: r.status,
    error: r.error,
    error_code: r.error_code,
    tokens: r.tokens,
    cost_usd: Number(r.cost_usd ?? 0),
    latency_ms: r.latency_ms,
    knowledge_used: (r.retrieved_chunk_ids ?? []).length,
    created_at: r.created_at,
    output: r.output ?? null,
  };
}

export function mapActivity(a) {
  return {
    id: a.id,
    campaign_id: a.campaign_id,
    prospect_id: a.prospect_id,
    actor: actorFor(a.agent_name),
    agent: a.agent_name,
    engine: a.engine,
    action: a.action,
    detail: a.detail,
    status: a.status,
    metadata: a.metadata ?? {},
    prospect_name: a.prospects ? nameOf(a.prospects) : null,
    campaign_name: a.campaigns?.name ?? null,
    created_at: a.created_at,
  };
}

export function mapApproval(a) {
  return {
    id: a.id,
    type: a.type,
    campaign_id: a.campaign_id,
    campaign_name: a.campaigns?.name ?? null,
    prospect_id: a.prospect_id,
    prospect_name: a.prospects ? nameOf(a.prospects) : null,
    prospect_title: titleOf(a.prospects),
    prospect_company: companyOf(a.prospects),
    message_id: a.message_id,
    message: a.messages ? mapMessage(a.messages) : null,
    source_agent: a.source_agent,
    source_agent_name: actorFor(a.source_agent),
    reason: a.reason,
    proposed_action: a.proposed_action,
    payload: a.payload,
    status: a.status,
    created_at: a.created_at,
  };
}

export { nameOf, companyOf, titleOf };
