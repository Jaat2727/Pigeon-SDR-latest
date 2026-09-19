/**
 * DronaHQ transport.
 *
 * One module owns every outbound call to a DronaHQ agent webhook: the HTTP
 * request, the timeout, and the job of digging the actual model output out of
 * whatever envelope DronaHQ wrapped it in.
 *
 * Why the unwrapping is this thorough: a DronaHQ agent webhook can answer in
 * several shapes depending on how the agent's "Configure Response" step is set
 * up, and the shape is not stable across agents in the same workspace. The most
 * common cause of an agent that "returns nulls" is a webhook still set to
 * Background mode, which answers with a run acknowledgement rather than output.
 * That case is detected explicitly below and reported with the fix, because no
 * amount of parsing on this side can recover output that was never sent.
 */
import { DRONAHQ_AGENTS, env, isDronaHqConfigured } from '../config.js';

export class DronaHqError extends Error {
  constructor(message, { code = 'dronahq_error', status = null, raw = null } = {}) {
    super(message);
    this.name = 'DronaHqError';
    this.code = code;
    this.status = status;
    this.raw = raw;
  }
}

/** Strips markdown fences and parses the first JSON object or array it finds. */
export function parseLooseJson(input) {
  if (input === null || input === undefined) return null;
  if (typeof input === 'object') return input;
  if (typeof input !== 'string') return null;

  const text = input.trim();
  if (!text) return null;

  try {
    return JSON.parse(text);
  } catch {
    /* keep trying */
  }

  const fenced = text.match(/```(?:json|JSON)?\s*([\s\S]*?)```/);
  if (fenced) {
    try {
      return JSON.parse(fenced[1].trim());
    } catch {
      /* keep trying */
    }
  }

  // First balanced-looking object or array in the text.
  const firstBrace = text.search(/[{[]/);
  if (firstBrace !== -1) {
    const opener = text[firstBrace];
    const closer = opener === '{' ? '}' : ']';
    const lastClose = text.lastIndexOf(closer);
    if (lastClose > firstBrace) {
      try {
        return JSON.parse(text.slice(firstBrace, lastClose + 1));
      } catch {
        /* give up */
      }
    }
  }

  return null;
}

/** Keys DronaHQ and similar platforms use to wrap the real payload. */
const ENVELOPE_KEYS = ['response', 'output', 'result', 'data', 'body', 'payload', 'answer', 'message', 'content'];

/**
 * Walks down through wrapper objects until it reaches something that looks like
 * agent output rather than another envelope. Depth-limited so a self-referential
 * shape cannot loop.
 */
export function unwrapEnvelope(payload, depth = 0) {
  if (depth > 6) return payload;
  let value = payload;

  if (typeof value === 'string') {
    const parsed = parseLooseJson(value);
    if (parsed === null) return value;
    value = parsed;
  }

  if (Array.isArray(value)) {
    if (value.length === 0) return null;
    // A single-element array is a wrapper; a longer one is real output.
    return value.length === 1 ? unwrapEnvelope(value[0], depth + 1) : value;
  }

  if (!value || typeof value !== 'object') return value;

  const keys = Object.keys(value);

  // An object that is nothing but one envelope key is definitely a wrapper.
  const envelopeOnly = keys.filter((k) => ENVELOPE_KEYS.includes(k));
  if (envelopeOnly.length > 0 && keys.length <= 4) {
    for (const key of ENVELOPE_KEYS) {
      if (!(key in value)) continue;
      const inner = value[key];
      if (inner === null || inner === undefined) continue;
      if (typeof inner === 'string' && parseLooseJson(inner) === null) continue;
      const unwrapped = unwrapEnvelope(inner, depth + 1);
      if (unwrapped && typeof unwrapped === 'object') return unwrapped;
    }
  }

  return value;
}

/**
 * Detects the background-run acknowledgement. This is the single most common
 * reason a working-looking DronaHQ agent yields nothing usable.
 */
export function isAsyncAcknowledgement(body) {
  if (!body || typeof body !== 'object') return false;
  const hasRunHandles = Boolean(body.run_id || body.runId || body.thread_id || body.threadId);
  const hasOutput = ENVELOPE_KEYS.some(
    (k) => body[k] !== undefined && body[k] !== null && body[k] !== ''
  );
  return hasRunHandles && !hasOutput;
}

const ASYNC_FIX =
  'The agent webhook answered with a background-run acknowledgement (run_id/thread_id) ' +
  'instead of the agent output. Fix it in DronaHQ, not in code: open the agent, go to the ' +
  'Webhook trigger, open "Configure Response", switch the response type from Background to ' +
  'Standard, and paste the agent output JSON Schema into the response schema box. Until that ' +
  'is changed the webhook will never return a body for this call to read.';

/**
 * Calls one DronaHQ agent and returns the unwrapped output object.
 * Throws DronaHqError on transport, HTTP, envelope or parse failure.
 */
export async function callDronaHq(agentName, payload, { timeoutMs = env.AGENT_TIMEOUT_MS } = {}) {
  if (!isDronaHqConfigured(agentName)) {
    throw new DronaHqError(`DronaHQ is not configured for agent "${agentName}"`, {
      code: 'not_configured',
    });
  }

  const { url, key } = DRONAHQ_AGENTS[agentName];
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'api-key': key,
        Authorization: `Bearer ${key}`,
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
  } catch (err) {
    throw new DronaHqError(
      err.name === 'AbortError'
        ? `DronaHQ agent "${agentName}" did not respond within ${timeoutMs}ms`
        : `Could not reach DronaHQ agent "${agentName}": ${err.message}`,
      { code: err.name === 'AbortError' ? 'timeout' : 'network_error' }
    );
  } finally {
    clearTimeout(timer);
  }

  const text = await res.text();

  if (!res.ok) {
    throw new DronaHqError(
      `DronaHQ agent "${agentName}" returned HTTP ${res.status}: ${text.slice(0, 400)}`,
      { code: 'http_error', status: res.status, raw: text }
    );
  }

  const body = parseLooseJson(text);
  if (body === null) {
    throw new DronaHqError(
      `DronaHQ agent "${agentName}" returned a body that is not JSON: ${text.slice(0, 200)}`,
      { code: 'unparseable', raw: text }
    );
  }

  if (isAsyncAcknowledgement(body)) {
    throw new DronaHqError(`Agent "${agentName}": ${ASYNC_FIX}`, {
      code: 'async_acknowledgement',
      raw: body,
    });
  }

  if (body && typeof body === 'object' && body.success === false) {
    throw new DronaHqError(
      `DronaHQ agent "${agentName}" reported a failure: ${JSON.stringify(body).slice(0, 400)}`,
      { code: 'agent_reported_failure', raw: body }
    );
  }

  const output = unwrapEnvelope(body);
  if (output === null || output === undefined || typeof output !== 'object') {
    throw new DronaHqError(
      `DronaHQ agent "${agentName}" returned no readable output object. Raw body: ${text.slice(0, 300)}`,
      { code: 'empty_output', raw: body }
    );
  }

  return {
    output,
    raw: body,
    // Usage figures, when the platform reports them.
    tokensIn:
      Number(body?.usage?.prompt_tokens ?? body?.usage?.input_tokens ?? body?.tokens_in) || null,
    tokensOut:
      Number(body?.usage?.completion_tokens ?? body?.usage?.output_tokens ?? body?.tokens_out) || null,
    costUsd: Number(body?.usage?.cost ?? body?.cost_usd) || null,
  };
}
