/**
 * The intelligence layer: Groq first, Gemini second, tried in the order named
 * by `LLM_PROVIDER_ORDER`. Each provider holds a pool of up to six keys
 * (see keyPool.js) and this module is what walks them.
 *
 * The order of escalation, for one agent call:
 *
 *   1. a healthy key for provider A          most calls stop here
 *   2. a different healthy key for A         the first one was rate limited
 *   3. a different model on A                the named model was rejected
 *   4. provider B, same walk                 A has nothing usable left
 *   5. throw, and the caller falls back      every provider is out
 *
 * Steps 2 and 3 are the ones worth being deliberate about. A 429 is a fact
 * about one key, so the pool benches that key and the call carries on. A 404
 * naming the model is a fact about the model, so the key keeps its clean
 * record and the provider retries on a different model — and remembers the
 * one that worked, so the next hundred calls do not repeat the discovery.
 *
 * A campaign's own `_system_prompt` / `_agent_prompt` (its wording from the
 * prompt editor) is carried straight into the model call, so a campaign's
 * behaviour still changes per campaign exactly the way the brief asks for.
 *
 * This module never decides whether the output is good enough. It only tries
 * to get a real model's best attempt at the shape, and hands the raw object
 * back for the caller to run through `AGENT_SCHEMAS[agentName].coerce` + zod.
 */
import { parseLooseJson } from '../lib/json.js';
import { env } from '../config.js';
import { leaseKey, poolStatus, reportSuccess, reportFailure, keyCount } from './keyPool.js';
import { resolveLadder, staticLadder } from './modelCatalog.js';

export class LlmError extends Error {
  constructor(message, { code = 'llm_error', kind = null, raw = null, status = null } = {}) {
    super(message);
    this.name = 'LlmError';
    this.code = code;
    this.kind = kind;
    this.raw = raw;
    this.status = status;
  }
}

/** Raised when a job is cancelled mid-call. Never counted against a key. */
export class CancelledError extends Error {
  constructor(message = 'Cancelled') {
    super(message);
    this.name = 'CancelledError';
    this.code = 'cancelled';
  }
}

export function configuredLlmProviders() {
  return env.LLM_PROVIDER_ORDER.filter((name) => keyCount(name) > 0);
}

export function isLlmEngineConfigured() {
  return configuredLlmProviders().length > 0;
}

/* ── model selection ─────────────────────────────────────────────────── */

/**
 * The model each provider is currently using, and the ladder behind it.
 *
 * The ladder is discovered from the provider rather than written down here.
 * A hand-maintained list of model names was the single most common way this
 * layer broke: providers retire models on their own schedule, and a stale
 * string failed the whole pipeline with "every provider failed", which reads
 * like a key problem. See agents/modelCatalog.js.
 */
const activeModel = { groq: env.GROQ_MODEL, gemini: env.GEMINI_MODEL };
const ladders = new Map();
const ladderMeta = new Map();

/**
 * The ladder for a provider, resolved once and reused. The first call pays
 * for one /models request; every call after it is free.
 */
async function ladderFor(provider) {
  if (ladders.has(provider)) return ladders.get(provider);

  let resolved;
  try {
    resolved = await resolveLadder(provider);
  } catch (err) {
    // Discovery is an optimisation. If it throws for a reason the catalogue
    // did not anticipate, the configured model is still a perfectly good
    // thing to try, and failing the call here would be worse than the bug
    // this whole module was written to fix.
    resolved = { ladder: staticLadder(provider), source: 'env', error: err.message };
  }

  const ladder = resolved.ladder.length ? resolved.ladder : staticLadder(provider);

  ladders.set(provider, ladder);
  ladderMeta.set(provider, resolved);
  activeModel[provider] = ladder[0];

  return ladder;
}

/** The next model to try after `current`, or null when the ladder runs out. */
function nextModel(provider, current) {
  const ladder = ladders.get(provider) ?? staticLadder(provider);
  const at = ladder.indexOf(current);
  return ladder[at + 1] ?? null;
}

export const activeModels = () => ({ ...activeModel });

/** What each provider's ladder is, and where it came from. For the UI. */
export function modelLadders() {
  const out = {};
  for (const provider of Object.keys(activeModel)) {
    out[provider] = {
      active: activeModel[provider],
      ladder: ladders.get(provider) ?? staticLadder(provider),
      ...(ladderMeta.get(provider) ?? { source: 'env (not yet resolved)' }),
    };
  }
  return out;
}

/** Forget the resolved ladders so the next call rediscovers them. */
export function resetLadders() {
  ladders.clear();
  ladderMeta.clear();
  activeModel.groq = env.GROQ_MODEL;
  activeModel.gemini = env.GEMINI_MODEL;
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
      '"fields_not_found" and leave it null instead of guessing. Never invent an email address: ' +
      'if you were not given one, leave it null.',
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
  discovery: {
    role: 'the Prospect Discovery agent for an outbound sales system',
    shape: `{
  "candidates": [ { "company_name": string, "company_domain": string|null, "company_industry": string|null, "company_employee_count": number|null, "company_hq": string|null, "title": string, "full_name": string|null, "linkedin_url": string|null, "why_this_company": string, "confidence": "high"|"medium"|"low" } ],
  "search_reasoning": string,
  "caveats": string[]
}`,
    instruction:
      'Propose companies that match the campaign ICP, and for each one name the job title that ' +
      'would be the right person to approach. These are leads to verify, not sourced records. ' +
      'Two rules override everything else: never invent an email address or a phone number, and ' +
      'never invent a specific named individual unless you are confident that person genuinely ' +
      'holds that role at that company — leave "full_name" null and name only the title instead. ' +
      'Put anything a user should check before trusting the list into "caveats".',
  },
};

export function buildPrompt(agentName, payload) {
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

/* ── error classification ───────────────────────────────────────────── */

/**
 * Turns an HTTP status and body into the one fact the pool needs: whose fault
 * was this. Getting this wrong in either direction is expensive — benching a
 * good key over a malformed request wastes capacity, and not benching a
 * rate-limited one wastes every subsequent call.
 */
export function classify(status, body = '') {
  const text = String(body).toLowerCase();

  if (status === 401 || status === 403) return 'invalid_key';
  if (status === 429) return 'rate_limited';
  if (status === 404) return 'model_not_found';
  if (status === 400 && /model|decommission|not found|unsupported/.test(text)) return 'model_not_found';
  if (status === 400) return 'bad_request';
  if (status >= 500) return 'server_error';
  return 'server_error';
}

/* ── transport ──────────────────────────────────────────────────────── */

/**
 * Runs `fn` with an abort signal that fires on our own timeout or on the
 * caller's cancellation, and can tell the two apart afterwards. A cancelled
 * call must never be recorded as a key failure: the key did nothing wrong,
 * and benching it would punish a key for an operator pressing stop.
 */
async function withTimeout(fn, timeoutMs, outerSignal) {
  const controller = new AbortController();
  let timedOut = false;

  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  const onAbort = () => controller.abort();
  outerSignal?.addEventListener('abort', onAbort, { once: true });

  try {
    return await fn(controller.signal);
  } catch (err) {
    if (err?.name === 'AbortError') {
      if (outerSignal?.aborted && !timedOut) throw new CancelledError();
      throw new LlmError(`No response within ${timeoutMs}ms`, { code: 'timeout', kind: 'timeout' });
    }
    throw err;
  } finally {
    clearTimeout(timer);
    outerSignal?.removeEventListener('abort', onAbort);
  }
}

async function callGroqWithKey({ system, user, key, model, signal }) {
  const res = await withTimeout(
    (sig) =>
      fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
        body: JSON.stringify({
          model,
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: user },
          ],
          temperature: 0.4,
          max_tokens: 2000,
          response_format: { type: 'json_object' },
        }),
        signal: sig,
      }).catch((err) => {
        if (err?.name === 'AbortError') throw err;
        throw new LlmError(`Could not reach Groq: ${err.message}`, { code: 'network_error', kind: 'network' });
      }),
    env.LLM_TIMEOUT_MS,
    signal
  );

  const text = await res.text();
  if (!res.ok) {
    const kind = classify(res.status, text);
    throw new LlmError(`Groq returned HTTP ${res.status}: ${text.slice(0, 300)}`, {
      code: 'http_error',
      kind,
      raw: text,
      status: res.status,
    });
  }

  const body = parseLooseJson(text);
  const content = body?.choices?.[0]?.message?.content;
  if (!content) {
    throw new LlmError('Groq responded without a message body', { code: 'empty_output', kind: 'server_error', raw: text });
  }

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

async function callGeminiWithKey({ system, user, key, model, signal }) {
  const url =
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;

  const res = await withTimeout(
    (sig) =>
      fetch(url, {
        method: 'POST',
        // The key goes in a header rather than the query string so it cannot
        // end up in a proxy log or an error message that quotes the URL.
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
        body: JSON.stringify({
          system_instruction: { parts: [{ text: system }] },
          contents: [{ role: 'user', parts: [{ text: user }] }],
          generationConfig: {
            temperature: 0.4,
            maxOutputTokens: 2000,
            responseMimeType: 'application/json',
          },
        }),
        signal: sig,
      }).catch((err) => {
        if (err?.name === 'AbortError') throw err;
        throw new LlmError(`Could not reach Gemini: ${err.message}`, { code: 'network_error', kind: 'network' });
      }),
    env.LLM_TIMEOUT_MS,
    signal
  );

  const text = await res.text();
  if (!res.ok) {
    const kind = classify(res.status, text);
    throw new LlmError(`Gemini returned HTTP ${res.status}: ${text.slice(0, 300)}`, {
      code: 'http_error',
      kind,
      raw: text,
      status: res.status,
    });
  }

  const body = parseLooseJson(text);
  const content = body?.candidates?.[0]?.content?.parts?.map((p) => p.text).join('') ?? null;
  if (!content) {
    const blockReason = body?.promptFeedback?.blockReason;
    throw new LlmError(
      blockReason ? `Gemini blocked the request: ${blockReason}` : 'Gemini responded without content',
      { code: 'empty_output', kind: blockReason ? 'bad_request' : 'server_error', raw: text }
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

const TRANSPORT = { groq: callGroqWithKey, gemini: callGeminiWithKey };

/* ── the walk ───────────────────────────────────────────────────────── */

/**
 * Tries every key this provider has, then every model on the ladder, and
 * returns the first combination that answers. Each attempt is recorded so the
 * caller can show exactly what was tried rather than one merged error string.
 */
async function callProvider(provider, system, user, { signal, attempts }) {
  const status = poolStatus(provider);
  if (status.total === 0) return null;

  const ladder = await ladderFor(provider);
  let model = activeModel[provider] ?? ladder[0];

  // At most one attempt per key, plus room to climb the model ladder.
  const budget = status.total + ladder.length;

  for (let i = 0; i < budget; i += 1) {
    if (signal?.aborted) throw new CancelledError();

    const entry = leaseKey(provider);
    if (!entry) {
      const next = poolStatus(provider).next_available_at;
      attempts.push({
        provider,
        key: null,
        model,
        error: next
          ? `every ${provider} key is cooling down; the next is free in ${Math.ceil((next - Date.now()) / 1000)}s`
          : `no ${provider} key is usable`,
        kind: 'pool_exhausted',
      });
      return null;
    }

    const started = Date.now();

    try {
      const { text, usage } = await TRANSPORT[provider]({ system, user, key: entry.key, model, signal });
      const latency = Date.now() - started;

      const parsed = parseLooseJson(text);
      if (!parsed || typeof parsed !== 'object') {
        // The key and the model both worked. The model's obedience did not,
        // which is a prompt problem, so neither gets benched for it.
        reportSuccess(entry, latency);
        attempts.push({
          provider,
          key: entry.label,
          model,
          error: 'answered, but not with a JSON object',
          kind: 'unparseable',
        });
        continue;
      }

      reportSuccess(entry, latency);
      activeModel[provider] = model;
      attempts.push({ provider, key: entry.label, model, ok: true, latency_ms: latency });

      return { output: parsed, provider, model, key: entry.label, raw: text, usage, latency_ms: latency };
    } catch (err) {
      if (err instanceof CancelledError) throw err;

      const kind = err.kind ?? 'network';
      reportFailure(entry, { kind, message: err.message });
      attempts.push({ provider, key: entry.label, model, error: err.message, kind });

      if (kind === 'model_not_found') {
        const next = nextModel(provider, model);
        if (!next) return null;
        model = next;
        continue;
      }

      // A malformed request will be malformed on every key. Retrying it five
      // more times only makes the error take five times longer to surface.
      if (kind === 'bad_request') return null;
    }
  }

  return null;
}

/**
 * The entry point. Tries each configured provider in order and returns the
 * first that answers with a parseable JSON object.
 *
 * @param {string} agentName
 * @param {object} payload
 * @param {{signal?: AbortSignal}} [options]
 */
export async function callLlm(agentName, payload, { signal } = {}) {
  const providers = configuredLlmProviders();
  if (providers.length === 0) {
    throw new LlmError(
      'No LLM provider is configured. Set GROQ_API_KEY and/or GEMINI_API_KEY (up to six of each).',
      { code: 'not_configured' }
    );
  }

  const { system, user } = buildPrompt(agentName, payload);
  const attempts = [];

  for (const provider of providers) {
    const result = await callProvider(provider, system, user, { signal, attempts });
    if (result) return { ...result, attempts };
  }

  const summary = attempts
    .map((a) => `${a.provider}${a.key ? ` ${a.key}` : ''} (${a.model}): ${a.error}`)
    .join(' | ');

  throw new LlmError(summary || 'Every configured provider failed', {
    code: 'all_providers_failed',
    raw: attempts,
  });
}
