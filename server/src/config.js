/**
 * Every environment variable the server reads is declared here, once. Nothing
 * else in the codebase touches process.env, so a missing variable produces one
 * legible message at boot with a name you can paste straight into Railway,
 * rather than a stack trace on the first request that happens to need it.
 */
import dotenv from 'dotenv';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CALLABLE_AGENTS, getAgentEngine } from './agents/registry.js';
import { registerKeys, keyCount, MAX_KEYS_PER_PROVIDER } from './agents/keyPool.js';

const here = path.dirname(fileURLToPath(import.meta.url));

// A .env next to the server, then one at the repo root. On Railway neither
// exists and the platform injects the variables directly, which is fine.
for (const candidate of [path.resolve(here, '..', '.env'), path.resolve(here, '..', '..', '.env')]) {
  if (fs.existsSync(candidate)) {
    dotenv.config({ path: candidate });
    break;
  }
}

const str = (name, fallback = '') => (process.env[name] ?? fallback).toString().trim();

const bool = (name, fallback = false) => {
  const raw = str(name);
  if (raw === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(raw.toLowerCase());
};

const int = (name, fallback) => {
  const parsed = parseInt(str(name), 10);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const list = (name, fallback = []) => {
  const raw = str(name);
  if (!raw) return fallback;
  return raw.split(',').map((s) => s.trim().replace(/\/+$/, '')).filter(Boolean);
};

/**
 * Collects the keys for one provider from every shape someone might reasonably
 * use, in one place:
 *
 *   GROQ_API_KEY=a,b,c          one variable, comma separated
 *   GROQ_API_KEYS=a,b,c         the plural spelling, same thing
 *   GROQ_API_KEY_1 … _6         one variable per key
 *
 * All three are read and merged, because the alternative is someone adding
 * GROQ_API_KEY_2 in Railway, seeing nothing change, and having no way to tell
 * why. The pool drops duplicates and caps the result, so listing the same key
 * twice is harmless.
 */
function collectKeys(prefix) {
  const keys = [
    ...list(`${prefix}_API_KEY`),
    ...list(`${prefix}_API_KEYS`),
  ];

  for (let i = 1; i <= MAX_KEYS_PER_PROVIDER; i += 1) {
    const single = str(`${prefix}_API_KEY_${i}`);
    if (single) keys.push(single);
  }

  return keys;
}

const groqKeys = collectKeys('GROQ');
const geminiKeys = collectKeys('GEMINI');

// The pool owns the keys from here on. Nothing else in the codebase holds a
// raw key, which is what keeps them out of logs, error messages and /health.
const groqConfigured = registerKeys('groq', groqKeys);
const geminiConfigured = registerKeys('gemini', geminiKeys);

export const env = {
  NODE_ENV: str('NODE_ENV', 'development'),

  // Railway may inject PORT. When it does not, 3001 is what the generated
  // domain should point at.
  PORT: int('PORT', 3001),
  HOST: str('HOST', '0.0.0.0'),

  // Supabase, service role. Server side only, never shipped to the browser.
  SUPABASE_URL: str('SUPABASE_URL').replace(/\/+$/, ''),
  SUPABASE_SERVICE_ROLE_KEY: str('SUPABASE_SERVICE_ROLE_KEY'),

  // Browser origins allowed to call this API.
  CORS_ORIGINS: list('CORS_ORIGINS', [
    'http://localhost:5173',
    'http://localhost:4173',
    'http://127.0.0.1:5173',
  ]),

  // Background worker. Off by default so a demo does not spend budget between
  // takes; the UI drives the pipeline instead.
  WORKER_ENABLED: bool('WORKER_ENABLED', false),
  WORKER_POLL_MS: int('WORKER_POLL_MS', 30000),
  WORKER_BATCH_SIZE: int('WORKER_BATCH_SIZE', 5),

  // Guardrails.
  MAX_AGENT_CALLS_PER_DAY: int('MAX_AGENT_CALLS_PER_DAY', 250),
  AGENT_TIMEOUT_MS: int('AGENT_TIMEOUT_MS', 45000),

  // How many prospects a single run works on at the same time. Two is a
  // deliberate default: it halves wall-clock time against one, and going
  // higher mostly buys rate limits rather than speed.
  JOB_CONCURRENCY: int('JOB_CONCURRENCY', 2),
  // A prospect whose lock is older than this is assumed abandoned — the
  // process holding it died mid-step — and can be picked up again.
  JOB_LOCK_TTL_MS: int('JOB_LOCK_TTL_MS', 300000),

  // When the LLM engine fails or is not configured, answer from the
  // deterministic local engine instead of stalling. Every run records which
  // engine produced it either way.
  LOCAL_ENGINE_ENABLED: bool('LOCAL_ENGINE_ENABLED', true),

  // Used to attribute cost to a run when the provider reports none.
  COST_PER_1K_TOKENS_USD: parseFloat(str('COST_PER_1K_TOKENS_USD', '0.015')) || 0.015,

  // The intelligence layer: Groq, then Gemini, in the order named here. Each
  // provider holds its own pool of up to six keys.
  LLM_PROVIDER_ORDER: list('LLM_PROVIDER_ORDER', ['groq', 'gemini']),
  LLM_TIMEOUT_MS: int('LLM_TIMEOUT_MS', 30000),

  GROQ_KEY_COUNT: groqConfigured,
  GROQ_MODEL: str('GROQ_MODEL', 'llama-3.3-70b-versatile'),
  // Tried in order when the named model is rejected as unknown. A retired
  // model name is one of the most common ways this layer breaks, and it
  // presents as "every provider failed", which sends you looking at keys.
  GROQ_MODEL_FALLBACKS: list('GROQ_MODEL_FALLBACKS', [
    'llama-3.1-8b-instant',
    'llama-3.3-70b-versatile',
  ]),

  GEMINI_KEY_COUNT: geminiConfigured,
  GEMINI_MODEL: str('GEMINI_MODEL', 'gemini-3.6-flash'),
  GEMINI_MODEL_FALLBACKS: list('GEMINI_MODEL_FALLBACKS', [
    'gemini-2.5-flash',
    'gemini-2.0-flash',
    'gemini-1.5-flash',
  ]),

  // ── discovery ──────────────────────────────────────────────────────────
  // Where new prospects come from. `auto` uses Apollo when a key is present
  // and the model's suggestions when it is not, which is the only setting
  // most people need.
  DISCOVERY_SOURCE: str('DISCOVERY_SOURCE', 'auto'),
  DISCOVERY_MAX_PER_RUN: int('DISCOVERY_MAX_PER_RUN', 25),
  APOLLO_API_KEY: str('APOLLO_API_KEY'),
  // Revealing an email spends an Apollo credit per person. Off by default so
  // a demo cannot quietly drain an account.
  APOLLO_REVEAL_EMAILS: bool('APOLLO_REVEAL_EMAILS', false),
  APOLLO_TIMEOUT_MS: int('APOLLO_TIMEOUT_MS', 20000),
};

export function isLlmEngineConfigured() {
  return env.LLM_PROVIDER_ORDER.some((p) => keyCount(p) > 0);
}

export function isDiscoveryConfigured() {
  return Boolean(env.APOLLO_API_KEY) || isLlmEngineConfigured();
}

/** Which discovery source a run would use right now, and why. */
export function discoveryRouting() {
  const setting = env.DISCOVERY_SOURCE;
  const apollo = Boolean(env.APOLLO_API_KEY);

  if (setting === 'none') {
    return { source: 'none', reason: 'DISCOVERY_SOURCE is set to none. Prospects are imported by hand.' };
  }
  if (setting === 'apollo' || (setting === 'auto' && apollo)) {
    return apollo
      ? {
          source: 'apollo',
          reason: 'Apollo is configured, so discovery returns real people from their database.',
          reveals_emails: env.APOLLO_REVEAL_EMAILS,
        }
      : {
          source: 'none',
          reason: 'DISCOVERY_SOURCE is apollo but APOLLO_API_KEY is not set.',
        };
  }
  if (setting === 'llm' || setting === 'auto') {
    return isLlmEngineConfigured()
      ? {
          source: 'llm',
          reason:
            'No Apollo key, so discovery asks the model for candidate companies and roles. ' +
            'These are suggestions to verify, not sourced records, and no email address is invented.',
        }
      : { source: 'none', reason: 'Neither Apollo nor any LLM provider is configured.' };
  }
  return { source: 'none', reason: `Unknown DISCOVERY_SOURCE "${setting}".` };
}

/**
 * What is and is not configured. Logged at boot and exposed on /health, so a
 * misconfigured deploy is one request away from explaining itself.
 */
export function configReport() {
  const missing = [];
  if (!env.SUPABASE_URL) missing.push('SUPABASE_URL');
  if (!env.SUPABASE_SERVICE_ROLE_KEY) missing.push('SUPABASE_SERVICE_ROLE_KEY');

  const llmConfigured = isLlmEngineConfigured();
  const agent_routing = {};
  for (const name of CALLABLE_AGENTS) {
    const engine = getAgentEngine(name);
    agent_routing[name] = engine === 'our_engine' ? 'our_engine' : llmConfigured ? 'llm_engine' : 'local_engine';
  }

  return {
    node_env: env.NODE_ENV,
    node_version: process.version,
    database_configured: missing.length === 0,
    missing_required: missing,
    cors_origins: env.CORS_ORIGINS,
    worker_enabled: env.WORKER_ENABLED,
    local_engine_enabled: env.LOCAL_ENGINE_ENABLED,
    job_concurrency: env.JOB_CONCURRENCY,
    llm_providers: env.LLM_PROVIDER_ORDER.filter((p) => keyCount(p) > 0),
    llm_keys: {
      groq: { configured: keyCount('groq'), max: MAX_KEYS_PER_PROVIDER, model: env.GROQ_MODEL },
      gemini: { configured: keyCount('gemini'), max: MAX_KEYS_PER_PROVIDER, model: env.GEMINI_MODEL },
    },
    discovery: discoveryRouting(),
    agent_routing,
  };
}

export default env;
