/**
 * The one way anything in this system calls an agent.
 *
 * The path is the same every time: DronaHQ, then reshape, then validate, then
 * one retry with the validation error handed back to the agent, then the
 * deterministic local engine. Whatever happens, a row lands in `agent_runs`
 * naming the engine that actually produced the output.
 *
 * That last part is the point. A fallback that quietly impersonates a model
 * call is worse than no fallback, because it makes the system look like it is
 * working when it is not. Every run is attributed, the UI badges it, and the
 * agent performance numbers are counted from those rows rather than stored.
 */
import { callDronaHq, DronaHqError, unwrapEnvelope } from './dronahq.js';
import { runLocalEngine } from './localEngine.js';
import { AGENT_SCHEMAS, isEmptyOutput } from './schemas.js';
import { getAgentEngine } from './registry.js';
import { env, isDronaHqConfigured, envNamesFor } from '../config.js';
import { supabase, dbReady } from '../db/client.js';

/** Rough token estimate when the provider reports none. Four chars per token. */
function estimateTokens(input, output) {
  const size = JSON.stringify(input ?? {}).length + JSON.stringify(output ?? {}).length;
  return Math.max(1, Math.round(size / 4));
}

const costOf = (tokens) => Number(((tokens / 1000) * env.COST_PER_1K_TOKENS_USD).toFixed(6));

/**
 * Reshape then validate. Coercion handles the shapes DronaHQ genuinely
 * returns (numbers as strings, arrays as stringified JSON, alternate field
 * names); the schema then only fails on something the pipeline cannot proceed
 * without.
 */
function validate(agentName, rawOutput, context) {
  const spec = AGENT_SCHEMAS[agentName];
  if (!spec) return { valid: true, output: rawOutput, coerced: rawOutput };

  const coerced = spec.coerce(rawOutput, context);

  if (isEmptyOutput(agentName, coerced)) {
    return {
      valid: false,
      coerced,
      reason:
        `every load-bearing field came back empty (${spec.requiredFields.join(', ')}). ` +
        'That is what a webhook with no response schema looks like from this side.',
    };
  }

  const parsed = spec.schema.safeParse(coerced);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return {
      valid: false,
      coerced,
      reason: `field "${issue.path.join('.') || '(root)'}" ${issue.message}`,
      failingField: issue.path.join('.'),
    };
  }

  return { valid: true, output: parsed.data, coerced };
}

async function recordRun(row) {
  if (!dbReady) return null;
  try {
    const { data, error } = await supabase.from('agent_runs').insert(row).select('id').single();
    if (error) {
      console.warn(`[agent_runs] could not record a run: ${error.message}`);
      return null;
    }
    return data.id;
  } catch (err) {
    console.warn(`[agent_runs] could not record a run: ${err.message}`);
    return null;
  }
}

/**
 * @param {string} agentName          registry id
 * @param {object} payload            what the agent receives
 * @param {object} meta
 * @param {string} [meta.campaignId]
 * @param {string} [meta.prospectId]
 * @param {object} [meta.localPayload] the shape the local engine expects, if it differs
 * @param {Array}  [meta.retrievedChunks]
 * @param {string} [meta.coerceContext] extra context for coercion, e.g. the channel
 * @returns {Promise<{success, output, engine, degraded, agentRunId, error, errorCode}>}
 */
export async function callAgent(agentName, payload, meta = {}) {
  const started = Date.now();
  const configuredEngine = getAgentEngine(agentName);
  const chunkIds = (meta.retrievedChunks ?? []).map((c) => c.id).filter(Boolean);

  const base = {
    campaign_id: meta.campaignId ?? null,
    prospect_id: meta.prospectId ?? null,
    agent_name: agentName,
    input: payload,
    retrieved_chunk_ids: chunkIds,
  };

  const attempts = [];
  let rawResponse = null;

  // ── DronaHQ, with one retry that tells the agent what was wrong ──────────
  if (configuredEngine === 'dronahq' && isDronaHqConfigured(agentName)) {
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      try {
        const body =
          attempt === 1
            ? payload
            : { ...payload, _previous_attempt_error: attempts[attempts.length - 1] };

        const response = await callDronaHq(agentName, body);
        rawResponse = response;

        const unwrapped = unwrapEnvelope(response);
        const result = validate(agentName, unwrapped, meta.coerceContext);

        if (result.valid) {
          const tokens = estimateTokens(payload, result.output);
          const agentRunId = await recordRun({
            ...base,
            engine: 'dronahq',
            status: attempt === 1 ? 'success' : 'degraded',
            output: result.output,
            raw_response: rawResponse,
            tokens,
            cost_usd: costOf(tokens),
            latency_ms: Date.now() - started,
          });
          return {
            success: true,
            output: result.output,
            engine: 'dronahq',
            degraded: attempt > 1,
            agentRunId,
          };
        }

        attempts.push(result.reason);
      } catch (err) {
        attempts.push(err.message);
        // A misconfiguration does not get better on a second identical call.
        if (err instanceof DronaHqError && err.code !== 'timeout') break;
      }
    }
  } else if (configuredEngine === 'dronahq') {
    const names = envNamesFor(agentName);
    attempts.push(
      `DronaHQ is not configured for "${agentName}". Set ${names?.url ?? 'its webhook URL'} ` +
        `and ${names?.key ?? 'a key'} in the server environment.`
    );
  }

  // ── local engine ────────────────────────────────────────────────────────
  const localAllowed = configuredEngine === 'our_engine' || env.LOCAL_ENGINE_ENABLED;

  if (localAllowed) {
    try {
      const output = runLocalEngine(agentName, meta.localPayload ?? payload);
      const engine = configuredEngine === 'our_engine' ? 'our_engine' : 'local_engine';
      const tokens = estimateTokens(payload, output);

      const agentRunId = await recordRun({
        ...base,
        engine,
        // A local run that only happened because DronaHQ failed is degraded.
        // A local run for an agent that is meant to be local is a success.
        status: attempts.length ? 'degraded' : 'success',
        output,
        raw_response: rawResponse,
        error: attempts.length ? attempts.join(' | ') : null,
        tokens,
        cost_usd: engine === 'our_engine' ? 0 : costOf(tokens),
        latency_ms: Date.now() - started,
      });

      return {
        success: true,
        output,
        engine,
        degraded: attempts.length > 0,
        fallbackReason: attempts.length ? attempts[attempts.length - 1] : null,
        agentRunId,
      };
    } catch (err) {
      attempts.push(`local engine: ${err.message}`);
    }
  }

  // ── nothing worked ──────────────────────────────────────────────────────
  const error = attempts.join(' | ') || 'No engine was available for this agent';
  const agentRunId = await recordRun({
    ...base,
    engine: configuredEngine === 'our_engine' ? 'our_engine' : 'dronahq',
    status: 'failed',
    raw_response: rawResponse,
    error,
    latency_ms: Date.now() - started,
  });

  return { success: false, output: null, engine: null, degraded: true, error, agentRunId };
}

/**
 * Fires one real call at the configured webhook and reports exactly what came
 * back, including the raw body. Writes nothing to the database, so it can be
 * run from the Agents screen as many times as needed while wiring up DronaHQ.
 */
export async function probeAgent(agentName, payload) {
  const started = Date.now();

  if (!isDronaHqConfigured(agentName)) {
    return {
      reachable: false,
      valid: false,
      error_code: 'not_configured',
      error: `No webhook URL or key is set for "${agentName}".`,
      latency_ms: 0,
    };
  }

  try {
    const response = await callDronaHq(agentName, payload);
    const unwrapped = unwrapEnvelope(response);
    const result = validate(agentName, unwrapped);

    return {
      reachable: true,
      valid: result.valid,
      latency_ms: Date.now() - started,
      raw_response: response,
      unwrapped_output: unwrapped,
      coerced_output: result.coerced,
      validated_output: result.valid ? result.output : null,
      error: result.valid ? null : result.reason,
      failing_field: result.failingField ?? null,
      error_code: result.valid ? null : 'schema_mismatch',
    };
  } catch (err) {
    return {
      reachable: err.code !== 'network_error' && err.code !== 'timeout',
      valid: false,
      latency_ms: Date.now() - started,
      raw_response: err.raw ?? null,
      error: err.message,
      error_code: err.code ?? 'unknown',
    };
  }
}
