/**
 * Agent output schemas.
 *
 * Two passes run over every agent response:
 *
 *   1. `coerce*` reshapes whatever came back into the shape we expect. DronaHQ
 *      returns strings for numbers, stringified JSON for arrays and objects,
 *      and nulls for fields the model could not fill. All of that is normal and
 *      recoverable, so it is handled here rather than treated as a failure.
 *   2. The zod schema then validates the coerced object. It only fails when a
 *      field the pipeline genuinely cannot proceed without is absent — the
 *      caller falls back to the local engine in that case.
 *
 * `requiredFields` names those load-bearing fields per agent. A response whose
 * required fields are all null is the "agent returned nulls" case, and it is
 * reported as a failure so the fallback engine takes over instead of writing an
 * empty record to the database.
 */
import { z } from 'zod';

/* ── coercion helpers ───────────────────────────────────────────────── */

const NULLISH = new Set(['', 'null', 'NULL', 'None', 'none', 'undefined', 'N/A', 'n/a', '-', '—']);

export function cleanValue(v) {
  if (v === undefined) return null;
  if (v === null) return null;
  if (typeof v === 'string') {
    const t = v.trim();
    return NULLISH.has(t) ? null : t;
  }
  return v;
}

export function toStringOrNull(v) {
  const c = cleanValue(v);
  if (c === null) return null;
  if (typeof c === 'string') return c;
  if (typeof c === 'number' || typeof c === 'boolean') return String(c);
  try {
    return JSON.stringify(c);
  } catch {
    return null;
  }
}

export function toNumberOrNull(v) {
  const c = cleanValue(v);
  if (c === null) return null;
  if (typeof c === 'number') return Number.isFinite(c) ? c : null;
  const n = parseFloat(String(c).replace(/[^0-9.-]/g, ''));
  return Number.isFinite(n) ? n : null;
}

export function toBool(v, fallback = false) {
  const c = cleanValue(v);
  if (c === null) return fallback;
  if (typeof c === 'boolean') return c;
  const s = String(c).toLowerCase();
  if (['true', 'yes', '1', 'y'].includes(s)) return true;
  if (['false', 'no', '0', 'n'].includes(s)) return false;
  return fallback;
}

/** Arrays arrive as real arrays, as JSON strings, or as comma-separated text. */
export function toArray(v) {
  const c = cleanValue(v);
  if (c === null) return [];
  if (Array.isArray(c)) return c.filter((x) => cleanValue(x) !== null);
  if (typeof c === 'object') return [c];
  if (typeof c === 'string') {
    const trimmed = c.trim();
    if (trimmed.startsWith('[')) {
      try {
        const parsed = JSON.parse(trimmed);
        if (Array.isArray(parsed)) return parsed.filter((x) => cleanValue(x) !== null);
      } catch {
        /* fall through to comma split */
      }
    }
    return trimmed.split(/[,;|\n]/).map((s) => s.trim()).filter(Boolean);
  }
  return [];
}

/** Objects arrive as real objects or as JSON strings. */
export function toObject(v, fallback = null) {
  const c = cleanValue(v);
  if (c === null) return fallback;
  if (typeof c === 'object' && !Array.isArray(c)) return c;
  if (typeof c === 'string') {
    try {
      const parsed = JSON.parse(c);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
    } catch {
      /* not JSON */
    }
  }
  return fallback;
}

/** Picks the first key present in the payload, so field renames do not break us. */
export function pick(obj, ...keys) {
  if (!obj || typeof obj !== 'object') return null;
  for (const k of keys) {
    if (k in obj) {
      const val = cleanValue(obj[k]);
      if (val !== null) return val;
    }
  }
  return null;
}

const oneOf = (value, allowed, fallback) => {
  const v = toStringOrNull(value);
  if (!v) return fallback;
  const lower = v.toLowerCase().replace(/[\s-]+/g, '_');
  return allowed.includes(lower) ? lower : fallback;
};

/* ── Agent 1 · ICP fitment ──────────────────────────────────────────── */

export const VERDICTS = ['qualify', 'reject', 'needs_review'];
export const CONFIDENCES = ['high', 'medium', 'low'];

export const icpSchema = z.object({
  fit_score: z.number().min(0).max(100),
  verdict: z.enum(['qualify', 'reject', 'needs_review']),
  confidence: z.enum(['high', 'medium', 'low']),
  dimension_scores: z.record(z.string(), z.any()).nullable().default(null),
  reasoning: z.string(),
  disqualifiers: z.array(z.string()).default([]),
  missing_data: z.array(z.string()).default([]),
});

export function coerceIcp(raw) {
  const o = raw || {};
  const score = toNumberOrNull(pick(o, 'fit_score', 'score', 'fitScore'));
  const verdictRaw = pick(o, 'verdict', 'decision', 'result');
  let verdict = oneOf(verdictRaw, VERDICTS, null);
  // Some prompts answer "qualified" / "rejected" / "review".
  if (!verdict && verdictRaw) {
    const s = String(verdictRaw).toLowerCase();
    if (s.startsWith('qualif')) verdict = 'qualify';
    else if (s.startsWith('reject') || s.startsWith('disqualif')) verdict = 'reject';
    else if (s.includes('review')) verdict = 'needs_review';
  }
  return {
    fit_score: score === null ? null : Math.max(0, Math.min(100, Math.round(score))),
    verdict,
    confidence: oneOf(pick(o, 'confidence', 'confidence_level'), CONFIDENCES, 'low'),
    dimension_scores: toObject(pick(o, 'dimension_scores', 'dimensions'), null),
    reasoning: toStringOrNull(pick(o, 'reasoning', 'reason', 'rationale', 'explanation')) ?? '',
    disqualifiers: toArray(pick(o, 'disqualifiers', 'disqualifiers_found')).map(String),
    missing_data: toArray(pick(o, 'missing_data', 'missing_fields')).map(String),
  };
}

/* ── Agent 2 · Research & enrichment ────────────────────────────────── */

export const researchSchema = z.object({
  person: z.object({
    full_name: z.string().nullable(),
    title: z.string().nullable(),
    seniority: z.string().nullable(),
    department: z.string().nullable(),
    location: z.string().nullable(),
    timezone: z.string().nullable(),
    linkedin_url: z.string().nullable(),
    email: z.string().nullable(),
    email_status: z.string().nullable(),
    phone: z.string().nullable(),
    phone_type: z.string().nullable(),
    tenure_months: z.number().nullable(),
    recent_activity: z.string().nullable(),
    previous_companies: z.array(z.string()).default([]),
  }),
  company: z.object({
    name: z.string().nullable(),
    domain: z.string().nullable(),
    industry: z.string().nullable(),
    sub_industry: z.string().nullable(),
    employee_count: z.number().nullable(),
    hq_location: z.string().nullable(),
    funding_stage: z.string().nullable(),
    last_funding_date: z.string().nullable(),
    description: z.string().nullable(),
  }),
  signals: z.object({
    tech_stack: z.array(z.string()).default([]),
    hiring_roles: z.array(z.string()).default([]),
    recent_news: z.string().nullable(),
    intent_signals: z.array(z.string()).default([]),
  }),
  sources: z.array(z.string()).default([]),
  research_notes: z.string().nullable(),
  confidence: z.string().nullable(),
  fields_not_found: z.array(z.string()).default([]),
});

/**
 * Research output arrives either nested (person/company/signals) or flattened
 * (full_name, company_name, …). Both are accepted and normalised to nested.
 */
export function coerceResearch(raw) {
  const o = raw || {};
  const person = toObject(o.person, {}) || {};
  const company = toObject(o.company, {}) || {};
  const signals = toObject(o.signals, {}) || {};

  const p = (...keys) => pick(person, ...keys) ?? pick(o, ...keys);
  const c = (...keys) => pick(company, ...keys) ?? pick(o, ...keys);
  const s = (...keys) => pick(signals, ...keys) ?? pick(o, ...keys);

  return {
    person: {
      full_name: toStringOrNull(p('full_name', 'name', 'fullName')),
      title: toStringOrNull(p('title', 'job_title', 'role')),
      seniority: toStringOrNull(p('seniority', 'seniority_level')),
      department: toStringOrNull(p('department', 'function')),
      location: toStringOrNull(p('location', 'city')),
      timezone: toStringOrNull(p('timezone', 'time_zone')),
      linkedin_url: toStringOrNull(p('linkedin_url', 'linkedin', 'linkedinUrl')),
      email: toStringOrNull(p('email', 'work_email')),
      email_status: toStringOrNull(p('email_status', 'emailStatus')),
      phone: toStringOrNull(p('phone', 'phone_number')),
      phone_type: toStringOrNull(p('phone_type')),
      tenure_months: toNumberOrNull(p('tenure_months', 'tenure')),
      recent_activity: toStringOrNull(p('recent_activity', 'activity')),
      previous_companies: toArray(p('previous_companies', 'past_companies')).map(String),
    },
    company: {
      name: toStringOrNull(c('name', 'company_name', 'companyName')),
      domain: toStringOrNull(c('domain', 'company_domain', 'website')),
      industry: toStringOrNull(c('industry', 'company_industry')),
      sub_industry: toStringOrNull(c('sub_industry', 'company_sub_industry')),
      employee_count: toNumberOrNull(c('employee_count', 'company_employee_count', 'headcount')),
      hq_location: toStringOrNull(c('hq_location', 'company_hq', 'headquarters')),
      funding_stage: toStringOrNull(c('funding_stage', 'company_funding_stage')),
      last_funding_date: toStringOrNull(c('last_funding_date', 'company_last_funding_date')),
      description: toStringOrNull(c('description', 'company_description')),
    },
    signals: {
      tech_stack: toArray(s('tech_stack', 'technologies')).map(String),
      hiring_roles: toArray(s('hiring_roles', 'open_roles')).map(String),
      recent_news: toStringOrNull(s('recent_news', 'news')),
      intent_signals: toArray(s('intent_signals', 'intent')).map(String),
    },
    sources: toArray(pick(o, 'sources', 'source_urls')).map(String),
    research_notes: toStringOrNull(pick(o, 'research_notes', 'notes', 'summary')),
    confidence: toStringOrNull(pick(o, 'confidence')),
    fields_not_found: toArray(pick(o, 'fields_not_found', 'missing_fields')).map(String),
  };
}

/* ── Agent 3 · Outreach strategy ────────────────────────────────────── */

export const CHANNELS = ['email', 'linkedin', 'sms', 'voice'];

export const strategySchema = z.object({
  should_contact: z.boolean(),
  no_contact_reason: z.string().nullable(),
  priority: z.enum(['high', 'medium', 'low']),
  sequence: z
    .array(
      z.object({
        step: z.number(),
        channel: z.string(),
        day_offset: z.number(),
        send_window: z.string().nullable(),
        angle: z.string().nullable(),
        signal_used: z.string().nullable(),
        goal: z.string().nullable(),
      })
    )
    .min(1),
  stop_conditions: z.array(z.string()).default([]),
  escalate_to_human: z.boolean(),
  escalation_reason: z.string().nullable(),
  reasoning: z.string(),
});

export function coerceStrategy(raw) {
  const o = raw || {};
  const seqSource = pick(o, 'sequence', 'sequence_json', 'touches', 'steps');
  let sequence = [];
  const parsed = Array.isArray(seqSource) ? seqSource : toArray(seqSource);
  sequence = parsed
    .map((item, i) => {
      const step = toObject(item, null) || {};
      const channel = oneOf(pick(step, 'channel', 'medium'), CHANNELS, null);
      if (!channel) return null;
      return {
        step: toNumberOrNull(pick(step, 'step', 'step_number')) ?? i + 1,
        channel,
        day_offset: toNumberOrNull(pick(step, 'day_offset', 'dayOffset', 'day')) ?? i * 3,
        send_window: toStringOrNull(pick(step, 'send_window', 'window')),
        angle: toStringOrNull(pick(step, 'angle', 'approach')),
        signal_used: toStringOrNull(pick(step, 'signal_used', 'signal')),
        goal: toStringOrNull(pick(step, 'goal', 'objective')),
      };
    })
    .filter(Boolean);

  return {
    should_contact: toBool(pick(o, 'should_contact', 'contact'), sequence.length > 0),
    no_contact_reason: toStringOrNull(pick(o, 'no_contact_reason')),
    priority: oneOf(pick(o, 'priority'), ['high', 'medium', 'low'], 'medium'),
    sequence,
    stop_conditions: toArray(pick(o, 'stop_conditions')).map(String),
    escalate_to_human: toBool(pick(o, 'escalate_to_human', 'escalate'), false),
    escalation_reason: toStringOrNull(pick(o, 'escalation_reason')),
    reasoning: toStringOrNull(pick(o, 'reasoning', 'reason')) ?? '',
  };
}

/* ── Agent 4 · Personalisation ──────────────────────────────────────── */

export const personalisationSchema = z.object({
  channel: z.string(),
  subject: z.string().nullable(),
  body: z.string().min(1),
  word_count: z.number(),
  personalisation_used: z.array(z.any()).default([]),
  knowledge_used: z.array(z.any()).default([]),
  cta: z.string().nullable(),
  needs_human: z.boolean(),
  needs_human_reason: z.string().nullable(),
  reasoning: z.string(),
});

export function coercePersonalisation(raw, fallbackChannel = 'email') {
  const o = raw || {};
  const body = toStringOrNull(pick(o, 'body', 'message', 'message_text', 'content'));
  return {
    channel: oneOf(pick(o, 'channel'), CHANNELS, fallbackChannel),
    subject: toStringOrNull(pick(o, 'subject', 'subject_line')),
    body,
    word_count:
      toNumberOrNull(pick(o, 'word_count')) ?? (body ? body.split(/\s+/).filter(Boolean).length : 0),
    personalisation_used: toArray(pick(o, 'personalisation_used', 'personalisation_used_json')),
    knowledge_used: toArray(pick(o, 'knowledge_used', 'knowledge_used_json')),
    cta: toStringOrNull(pick(o, 'cta', 'call_to_action')),
    needs_human: toBool(pick(o, 'needs_human'), false),
    needs_human_reason: toStringOrNull(pick(o, 'needs_human_reason')),
    reasoning: toStringOrNull(pick(o, 'reasoning', 'reason')) ?? '',
  };
}

/* ── Agent 5 · Conversation ─────────────────────────────────────────── */

export const INTENTS = [
  'interested', 'meeting_request', 'question', 'objection', 'not_now',
  'not_interested', 'opt_out', 'referral', 'wrong_person', 'auto_reply',
  'bounce', 'unclear',
];

export const conversationSchema = z.object({
  is_human_reply: z.boolean(),
  intent: z.enum([
    'interested', 'meeting_request', 'question', 'objection', 'not_now',
    'not_interested', 'opt_out', 'referral', 'wrong_person', 'auto_reply',
    'bounce', 'unclear',
  ]),
  intent_confidence: z.number().min(0).max(1),
  sentiment: z.enum(['positive', 'neutral', 'negative']),
  extracted_facts: z.array(z.any()).default([]),
  questions_asked: z.array(z.string()).default([]),
  objections_raised: z.array(z.string()).default([]),
  referral: z.record(z.string(), z.any()).nullable().default(null),
  recommended_action: z.string(),
  followup_delay_days: z.number().nullable(),
  requires_human: z.boolean(),
  escalation_reason: z.string().nullable(),
  reasoning: z.string(),
});

export function coerceConversation(raw) {
  const o = raw || {};
  let confidence = toNumberOrNull(pick(o, 'intent_confidence', 'confidence'));
  // Models report confidence as 0-1 or as 0-100. Normalise to 0-1.
  if (confidence !== null && confidence > 1) confidence = confidence / 100;

  const referralName = toStringOrNull(pick(o, 'referral_name'));
  const referralContact = toStringOrNull(pick(o, 'referral_contact'));
  let referral = toObject(pick(o, 'referral'), null);
  if (!referral && (referralName || referralContact)) {
    referral = { name: referralName, contact: referralContact };
  }

  return {
    is_human_reply: toBool(pick(o, 'is_human_reply'), true),
    intent: oneOf(pick(o, 'intent', 'classification'), INTENTS, null),
    intent_confidence: confidence === null ? 0.5 : Math.max(0, Math.min(1, confidence)),
    sentiment: oneOf(pick(o, 'sentiment'), ['positive', 'neutral', 'negative'], 'neutral'),
    extracted_facts: toArray(pick(o, 'extracted_facts', 'extracted_facts_json', 'facts')),
    questions_asked: toArray(pick(o, 'questions_asked', 'questions')).map(String),
    objections_raised: toArray(pick(o, 'objections_raised', 'objections')).map(String),
    referral,
    recommended_action: toStringOrNull(pick(o, 'recommended_action', 'next_action')) ?? 'review',
    followup_delay_days: toNumberOrNull(pick(o, 'followup_delay_days', 'followup_days')),
    requires_human: toBool(pick(o, 'requires_human', 'needs_human'), false),
    escalation_reason: toStringOrNull(pick(o, 'escalation_reason')),
    reasoning: toStringOrNull(pick(o, 'reasoning', 'reason')) ?? '',
  };
}

/* ── registry ───────────────────────────────────────────────────────── */

export const AGENT_SCHEMAS = {
  icp_fitment: {
    schema: icpSchema,
    coerce: coerceIcp,
    // A response where all of these are null is the "returned nulls" case.
    requiredFields: ['verdict', 'fit_score'],
  },
  research: {
    schema: researchSchema,
    coerce: coerceResearch,
    requiredFields: ['person.full_name', 'person.title', 'company.name'],
  },
  outreach_strategy: {
    schema: strategySchema,
    coerce: coerceStrategy,
    requiredFields: ['sequence'],
  },
  personalisation: {
    schema: personalisationSchema,
    coerce: coercePersonalisation,
    requiredFields: ['body'],
  },
  conversation: {
    schema: conversationSchema,
    coerce: coerceConversation,
    requiredFields: ['intent'],
  },
};

/** Reads a dotted path off an object. */
function readPath(obj, path) {
  return path.split('.').reduce((acc, key) => (acc == null ? acc : acc[key]), obj);
}

/**
 * True when every load-bearing field is null/empty — the exact symptom of a
 * DronaHQ agent whose webhook response is not configured or whose model
 * returned an empty object.
 */
export function isEmptyOutput(agentName, coerced) {
  const spec = AGENT_SCHEMAS[agentName];
  if (!spec || !coerced) return true;
  return spec.requiredFields.every((field) => {
    const value = readPath(coerced, field);
    if (value === null || value === undefined) return true;
    if (Array.isArray(value)) return value.length === 0;
    if (typeof value === 'string') return value.trim() === '';
    return false;
  });
}
