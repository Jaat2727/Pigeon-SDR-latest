/**
 * The intelligence layer: Groq first, Gemini second, tried in the order
 * named by `LLM_PROVIDER_ORDER`. DronaHQ was the original plan, per the
 * brief; it was wired, tested, and dropped once every one of the five
 * DronaHQ agents we configured answered in Background mode (a run
 * acknowledgement, never the model's actual output) — a setting on
 * DronaHQ's side, not something fixable from here. This is the real
 * intelligence layer now, not a fallback tier.
 *
 * A campaign's own `_system_prompt` / `_agent_prompt` (its wording from the
 * prompt editor) is carried straight into the model call, so a campaign's
 * behaviour still changes per campaign exactly the way the brief asks for.
 *
 * Every provider here is called the same way it will be validated: ask for
 * one JSON object, parse it with the same loose-JSON reader, and hand the
 * raw object back for the caller to run through
 * `AGENT_SCHEMAS[agentName].coerce` + zod, unchanged. This module never
 * decides whether the output is good enough — it only tries to get a real
 * model's best attempt at the shape.
 */
import { parseLooseJson } from '../lib/json.js';
import { env } from '../config.js';

export class LlmError extends Error {
  constructor(message, { code = 'llm_error', raw = null } = {}) {
    super(message);
    this.name = 'LlmError';
    this.code = code;
    this.raw = raw;
  }
}

const IS_CONFIGURED = {
  groq: () => env.GROQ_API_KEYS.length > 0,
  gemini: () => Boolean(env.GEMINI_API_KEY),
};

export function configuredLlmProviders() {
  return env.LLM_PROVIDER_ORDER.filter((name) => IS_CONFIGURED[name]?.());
}

export function isLlmEngineConfigured() {
  return configuredLlmProviders().length > 0;
}

/* ── prompts ────────────────────────────────────────────────────────── */

const JSON_ONLY =
  'Respond with exactly one JSON object and nothing else: no markdown code fences, no ' +
  'commentary before or after it. Use null for anything you do not know rather than guessing ' +
  'or inventing a plausible-sounding value.';

const AGENT_BRIEFS = {
  research: {
    role: 'the Research & Enrichment agent for an outbound sales system',
    shape: `{
  "person": { "full_name": string|null, "title": string|null, "seniority": string|null, "department": string|null, "location": string|null, "timezone": string|null, "linkedin_url": string|null, "email": string|null, "email_status": string|null, "phone": string|null, "phone_type": string|null, "tenure_months": number|null, "recent_activity": string|null, "previous_companies": string[] },
  "company": { "name": string|null, "domain": string|null, "industry": string|null, "sub_industry": string|null, "employee_count": number|null, "hq_location": string|null, "funding_stage": string|null, "last_funding_date": string|null, "description": string|null },
  "signals": { "tech_stack": string[], "hiring_roles": string[], "recent_news": string|null, "intent_signals": string[] },
  "sources": string[],
  "research_notes": string|null,
  "confidence": "high"|"medium"|"low"|null,
  "fields_not_found": string[]
}`,
    instruction:
      'You are given a thin prospect record. Build the fullest honest profile you can from it and ' +
      'from what a well-informed rep would already know about a company at that domain / of that ' +
      'size and industry. Do not invent specific facts (funding rounds, headcount, news) you were ' +
      'not given or cannot reasonably infer — list any field you could not responsibly fill in ' +
      '"fields_not_found" and leave it null instead of guessing.',
  },
  icp_fitment: {
    role: 'the ICP Fitment agent for an outbound sales system',
    shape: `{
  "fit_score": number (0-100),
  "verdict": "qualify"|"reject"|"needs_review",
  "confidence": "high"|"medium"|"low",
  "dimension_scores": object|null,
  "reasoning": string,
  "disqualifiers": string[],
  "missing_data": string[]
}`,
    instruction:
      'Score the prospect against the campaign ICP and exclusion criteria. Check exclusions ' +
      'first: a match on an exclusion is always "reject" whatever the fit score would otherwise ' +
      'be. If the profile is too thin to place confidently, answer "needs_review" rather than ' +
      'guessing either way, and name what is missing in "missing_data".',
  },
  outreach_strategy: {
    role: 'the Outreach Strategy agent for an outbound sales system',
    shape: `{
  "should_contact": boolean,
  "no_contact_reason": string|null,
  "priority": "high"|"medium"|"low",
  "sequence": [ { "step": number, "channel": "email"|"linkedin"|"sms"|"voice", "day_offset": number, "send_window": string|null, "angle": string|null, "signal_used": string|null, "goal": string|null } ],
  "stop_conditions": string[],
  "escalate_to_human": boolean,
  "escalation_reason": string|null,
  "reasoning": string
}`,
    instruction:
      'Plan a touch sequence across only the channels the campaign has enabled, honouring the ' +
      'stated outreach policy (touch count and spacing) as closely as you can. You are allowed to ' +
      'decide not to contact this prospect at all — set "should_contact" to false and explain why ' +
      'rather than forcing a sequence that does not fit.',
  },
  personalisation: {
    role: 'the Personalisation agent for an outbound sales system, writing one message for one touch',
    shape: `{
  "channel": "email"|"linkedin"|"sms"|"voice",
  "subject": string|null,
  "body": string,
  "word_count": number,
  "personalisation_used": string[],
  "knowledge_used": string[],
  "cta": string|null,
  "needs_human": boolean,
  "needs_human_reason": string|null,
  "reasoning": string
}`,
    instruction:
      'Write the message grounded only in the supplied prospect research and retrieved knowledge ' +
      'chunks — never invent a product claim, case study or statistic that is not in the ' +
      'retrieved knowledge, and never invent a personal fact that is not in the research. If there ' +
      'is nothing specific enough to say, set "needs_human" true, explain why, and still return a ' +
      'best-effort draft in "body" for a person to fix rather than leaving it empty. Match the ' +
      'register and length the campaign\'s messaging policy asks for.',
  },
  conversation: {
    role: 'the Conversation agent for an outbound sales system, reading one inbound reply',
    shape: `{
  "is_human_reply": boolean,
  "intent": "interested"|"meeting_request"|"question"|"objection"|"not_now"|"not_interested"|"opt_out"|"referral"|"wrong_person"|"auto_reply"|"bounce"|"unclear",
  "intent_confidence": number (0-1),
  "sentiment": "positive"|"neutral"|"negative",
  "extracted_facts": string[],
  "questions_asked": string[],
  "objections_raised": string[],
  "referral": { "name": string|null, "contact": string|null }|null,
  "recommended_action": string,
  "followup_delay_days": number|null,
  "requires_human": boolean,
  "escalation_reason": string|null,
  "reasoning": string
}`,
    instruction:
      'Classify the reply and decide what should happen next. Anything that mentions pricing, ' +
      'procurement, a legal question, or asks to stop contact must set "requires_human" true ' +
      'regardless of the classified intent — those always go to a person.',
  },
};

function buildPrompt(agentName, payload) {
  const brief = AGENT_BRIEFS[agentName];
  if (!brief) throw new LlmError(`No LLM prompt is defined for agent "${agentName}"`, { code: 'unsupported_agent' });

  const { _system_prompt, _agent_prompt, ...rest } = payload ?? {};

  const systemParts = [
    `You are ${brief.role}.`,
    brief.instruction,
    `Return exactly this JSON shape (types shown, use null where you do not know):\n${brief.shape}`,
    JSON_ONLY,
  ];
  if (_system_prompt) systemParts.push(`Campaign-wide instruction, follow it unless it conflicts with the rules above:\n${_system_prompt}`);
  if (_agent_prompt) systemParts.push(`Campaign instruction specific to this step:\n${_agent_prompt}`);

  const user = `Input for this call:\n${JSON.stringify(rest, null, 2)}`;

  return { system: systemParts.join('\n\n'), user };
}

/* ── transport ──────────────────────────────────────────────────────── */

async function withTimeout(fn, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fn(controller.signal);
  } finally {
    clearTimeout(timer);
  }
}

async function callGroqWithKey(system, user, key) {
  const res = await withTimeout(
    (signal) =>
      fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${key}`,
        },
        body: JSON.stringify({
          model: env.GROQ_MODEL,
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: user },
          ],
          temperature: 0.4,
          max_tokens: 2000,
          response_format: { type: 'json_object' },
        }),
        signal,
      }),
    env.LLM_TIMEOUT_MS
  ).catch((err) => {
    throw new LlmError(
      err.name === 'AbortError' ? `Groq did not respond within ${env.LLM_TIMEOUT_MS}ms` : `Could not reach Groq: ${err.message}`,
      { code: err.name === 'AbortError' ? 'timeout' : 'network_error' }
    );
  });

  const text = await res.text();
  if (!res.ok) {
    throw new LlmError(`Groq returned HTTP ${res.status}: ${text.slice(0, 400)}`, { code: 'http_error', raw: text });
  }

  const body = parseLooseJson(text);
  const content = body?.choices?.[0]?.message?.content;
  if (!content) throw new LlmError('Groq responded without a message body', { code: 'empty_output', raw: text });

  return {
    text: content,
    usage: body?.usage
      ? {
          tokensIn: body.usage.prompt_tokens ?? null,
          tokensOut: body.usage.completion_tokens ?? null,
          total: body.usage.total_tokens ?? null,
        }
      : null,
  };
}

/**
 * Tries each configured Groq key in order — "if one fails, the other sends."
 * A rate limit or an expired key on the first key falls through to the
 * second rather than dropping straight to Gemini, since they are the same
 * provider and the second key is exactly the thing meant to cover for it.
 */
async function callGroq(system, user) {
  const attempts = [];
  for (const key of env.GROQ_API_KEYS) {
    try {
      return await callGroqWithKey(system, user, key);
    } catch (err) {
      attempts.push(err.message);
    }
  }
  throw new LlmError(attempts.join(' | ') || 'No Groq key is configured', { code: 'all_keys_failed' });
}

async function callGemini(system, user) {
  const url =
    `https://generativelanguage.googleapis.com/v1beta/models/${env.GEMINI_MODEL}:generateContent` +
    `?key=${env.GEMINI_API_KEY}`;

  const res = await withTimeout(
    (signal) =>
      fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          system_instruction: { parts: [{ text: system }] },
          contents: [{ role: 'user', parts: [{ text: user }] }],
          generationConfig: { temperature: 0.4, maxOutputTokens: 2000, responseMimeType: 'application/json' },
        }),
        signal,
      }),
    env.LLM_TIMEOUT_MS
  ).catch((err) => {
    throw new LlmError(
      err.name === 'AbortError' ? `Gemini did not respond within ${env.LLM_TIMEOUT_MS}ms` : `Could not reach Gemini: ${err.message}`,
      { code: err.name === 'AbortError' ? 'timeout' : 'network_error' }
    );
  });

  const text = await res.text();
  if (!res.ok) {
    throw new LlmError(`Gemini returned HTTP ${res.status}: ${text.slice(0, 400)}`, { code: 'http_error', raw: text });
  }

  const body = parseLooseJson(text);
  const content = body?.candidates?.[0]?.content?.parts?.map((p) => p.text).join('') ?? null;
  if (!content) {
    const blockReason = body?.promptFeedback?.blockReason;
    throw new LlmError(
      blockReason ? `Gemini blocked the request: ${blockReason}` : 'Gemini responded without content',
      { code: 'empty_output', raw: text }
    );
  }

  return {
    text: content,
    usage: body?.usageMetadata
      ? {
          tokensIn: body.usageMetadata.promptTokenCount ?? null,
          tokensOut: body.usageMetadata.candidatesTokenCount ?? null,
          total: body.usageMetadata.totalTokenCount ?? null,
        }
      : null,
  };
}

const TRANSPORT = { groq: callGroq, gemini: callGemini };

/**
 * Tries each configured provider in order and returns the first one that
 * answers with parseable JSON. Throws only when every configured provider
 * failed, with every attempt's reason joined together.
 */
export async function callLlm(agentName, payload) {
  const providers = configuredLlmProviders();
  if (providers.length === 0) {
    throw new LlmError('No LLM provider is configured (set GROQ_API_KEY and/or GEMINI_API_KEY).', {
      code: 'not_configured',
    });
  }

  const { system, user } = buildPrompt(agentName, payload);
  const attempts = [];

  for (const name of providers) {
    try {
      const { text, usage } = await TRANSPORT[name](system, user);
      const parsed = parseLooseJson(text);
      if (!parsed || typeof parsed !== 'object') {
        throw new LlmError(`${name} did not return a parseable JSON object`, { code: 'unparseable', raw: text });
      }
      return { output: parsed, provider: name, raw: text, usage };
    } catch (err) {
      attempts.push(`${name}: ${err.message}`);
    }
  }

  throw new LlmError(attempts.join(' | '), { code: 'all_providers_failed' });
}
