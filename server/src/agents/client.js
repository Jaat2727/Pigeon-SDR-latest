/**
 * The one way anything in this system calls an agent.
 *
 * DronaHQ was the original plan, per the brief. It was wired, tested, and
 * dropped: every one of the five DronaHQ webhooks we configured answered in
 * Background mode (a run acknowledgement, never the actual output) and that
 * is a setting on DronaHQ's side, not something fixable from here. Rather
 * than ship a "DronaHQ integration" that silently produces nothing, the
 * intelligence layer runs on real models instead: Groq, then Gemini, each
 * with its own pool of up to six keys.
 *
 * The path is the same every time: LLM engine, then reshape, then validate,
 * then one retry with the validation error handed back to the model; if no
 * provider is configured or all of them fail, the deterministic local engine.
 * Whatever happens, a row lands in `agent_runs` naming the engine, the
 * provider, the model and the key that actually produced the output.
 *
 * That last part is the point. A fallback that quietly impersonates a model
 * call is worse than no fallback, because it makes the system look like it is
 * working when it is not. Every run is attributed, the UI badges it, and the
 * agent performance numbers are counted from those rows rather than stored.
 */
import { callLlm, isLlmEngineConfigured, buildPrompt, CancelledError } from './llmEngine.js';
import { runLocalEngine } from './localEngine.js';
import { AGENT_SCHEMAS, isEmptyOutput } from './schemas.js';
import { getAgentEngine } from './registry.js';
import { env } from '../config.js';
import { supabase, dbReady } from '../db/client.js';

/** Rough token estimate when the provider reports none. Four chars per token. */
function estimateTokens(input, output) {
  const size = JSON.stringify(input ?? {}).length + JSON.stringify(output ?? {}).length;
  return Math.max(1, Math.round(size / 4));
}

const costOf = (tokens) => Number(((tokens / 1000) * env.COST_PER_1K_TOKENS_USD).toFixed(6));

/**
 * Reshape then validate. Coercion handles the shapes a model genuinely
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
      reason: `every load-bearing field came back empty (${spec.requiredFields.join(', ')}).`,
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
      // 42703 is an undefined column: the provider/model/key columns come from
      // a later migration. Rather than lose the run entirely, drop those three
      // fields and write the row the original schema can hold.
      if (error.code === '42703') {
        const { llm_provider, llm_model, llm_key, ...core } = row;
        const retry = await supabase.from('agent_runs').insert(core).select('id').single();
        if (!retry.error) return retry.data.id;
      }
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
 * @param {AbortSignal} [meta.signal]  cancels an in-flight model call
 * @returns {Promise<{success, output, engine, degraded, agentRunId, error, cancelled}>}
 */
export async function callAgent(agentName, payload, meta = {}) {
  const started = Date.now();
  const configuredEngine = getAgentEngine(agentName);
  const chunkIds = (meta.retrievedChunks ?? []).map((c) => c.id).filter(Boolean);
  const signal = meta.signal;

  const base = {
    campaign_id: meta.campaignId ?? null,
    prospect_id: meta.prospectId ?? null,
    agent_name: agentName,
    input: payload,
    retrieved_chunk_ids: chunkIds,
  };

  const attempts = [];
  let rawResponse = null;
  let provider = null;
  let model = null;
  let key = null;

  // ── LLM engine ─────────────────────────────────────────────────────────
  // Groq's keys, then Gemini's, then one retry that hands the model its own
  // validation error back — the same shape of second chance a DronaHQ retry
  // used to get.
  if (configuredEngine === 'llm' && isLlmEngineConfigured()) {
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      if (signal?.aborted) {
        return { success: false, output: null, engine: null, cancelled: true, error: 'Cancelled' };
      }

      try {
        const body =
          attempt === 1
            ? payload
            : { ...payload, _previous_attempt_error: attempts[attempts.length - 1] };

        const llm = await callLlm(agentName, body, { signal });
        provider = llm.provider;
        model = llm.model;
        key = llm.key;
        rawResponse = { provider: llm.provider, model: llm.model, key: llm.key, text: llm.raw };

        const result = validate(agentName, llm.output, meta.coerceContext);

        if (result.valid) {
          const tokens = llm.usage?.total ?? estimateTokens(payload, result.output);
          const agentRunId = await recordRun({
            ...base,
            engine: 'llm_engine',
            status: attempt === 1 ? 'success' : 'degraded',
            output: result.output,
            raw_response: rawResponse,
            error: attempt > 1 ? attempts[attempts.length - 1] : null,
            tokens,
            cost_usd: costOf(tokens),
            latency_ms: Date.now() - started,
            llm_provider: llm.provider,
            llm_model: llm.model,
            llm_key: llm.key,
          });
          return {
            success: true,
            output: result.output,
            engine: 'llm_engine',
            provider: llm.provider,
            model: llm.model,
            key: llm.key,
            degraded: attempt > 1,
            agentRunId,
          };
        }

        attempts.push(result.reason);
      } catch (err) {
        if (err instanceof CancelledError) {
          return { success: false, output: null, engine: null, cancelled: true, error: 'Cancelled' };
        }
        attempts.push(err.message);
      }
    }
  } else if (configuredEngine === 'llm') {
    attempts.push(
      `No LLM provider is configured for "${agentName}". Set GROQ_API_KEY and/or GEMINI_API_KEY ` +
        'in the server environment.'
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
        // A local run that only happened because the LLM engine failed is
        // degraded. A local run for an agent that is meant to be local is a
        // success.
        status: attempts.length ? 'degraded' : 'success',
        output,
        raw_response: rawResponse,
        error: attempts.length ? attempts.join(' | ') : null,
        tokens,
        cost_usd: engine === 'our_engine' ? 0 : costOf(tokens),
        latency_ms: Date.now() - started,
        llm_provider: provider,
        llm_model: model,
        llm_key: key,
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
    engine: configuredEngine === 'our_engine' ? 'our_engine' : 'llm_engine',
    status: 'failed',
    raw_response: rawResponse,
    error,
    latency_ms: Date.now() - started,
    llm_provider: provider,
    llm_model: model,
    llm_key: key,
  });

  return { success: false, output: null, engine: null, degraded: true, error, agentRunId };
}

/**
 * Fires one real call at the LLM engine and reports every stage of what
 * happened: the prompt that was sent, which key and model answered, the raw
 * text, the reshaped object, and the validated result. Writes nothing to the
 * database, so it can be run from the Agents screen as often as needed while
 * checking a key or a prompt.
 */
export async function probeAgent(agentName, payload) {
  const started = Date.now();

  let prompt = null;
  try {
    prompt = buildPrompt(agentName, payload);
  } catch {
    prompt = null;
  }

  if (!isLlmEngineConfigured()) {
    return {
      reachable: false,
      valid: false,
      error_code: 'not_configured',
      error:
        'No LLM provider is configured. Set GROQ_API_KEY and/or GEMINI_API_KEY (up to six of each).',
      prompt,
      latency_ms: 0,
    };
  }

  try {
    const llm = await callLlm(agentName, payload);
    const result = validate(agentName, llm.output);

    return {
      reachable: true,
      valid: result.valid,
      provider: llm.provider,
      model: llm.model,
      key: llm.key,
      attempts: llm.attempts,
      prompt,
      latency_ms: Date.now() - started,
      call_latency_ms: llm.latency_ms,
      raw_response: llm.raw,
      parsed_output: llm.output,
      coerced_output: result.coerced,
      validated_output: result.valid ? result.output : null,
      error: result.valid ? null : result.reason,
      failing_field: result.failingField ?? null,
      error_code: result.valid ? null : 'schema_mismatch',
    };
  } catch (err) {
    return {
      reachable: false,
      valid: false,
      prompt,
      attempts: Array.isArray(err.raw) ? err.raw : undefined,
      latency_ms: Date.now() - started,
      error: err.message,
      error_code: err.code ?? 'unknown',
    };
  }
}
