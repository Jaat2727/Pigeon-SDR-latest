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

  // When the LLM engine fails or is not configured, answer from the
  // deterministic local engine instead of stalling. Every run records which
  // engine produced it either way.
  LOCAL_ENGINE_ENABLED: bool('LOCAL_ENGINE_ENABLED', true),

  // Used to attribute cost to a run when the provider reports none.
  COST_PER_1K_TOKENS_USD: parseFloat(str('COST_PER_1K_TOKENS_USD', '0.015')) || 0.015,

  // The intelligence layer: Groq, then Gemini, in the order named here. Each
  // name needs its own key below to count as configured. GROQ_API_KEY may
  // hold more than one key, comma separated — the second is tried if the
  // first is rate-limited or rejected, before moving on to Gemini.
  LLM_PROVIDER_ORDER: list('LLM_PROVIDER_ORDER', ['groq', 'gemini']),
  LLM_TIMEOUT_MS: int('LLM_TIMEOUT_MS', 30000),

  GROQ_API_KEYS: list('GROQ_API_KEY'),
  GROQ_MODEL: str('GROQ_MODEL', 'llama-3.3-70b-versatile'),

  GEMINI_API_KEY: str('GEMINI_API_KEY'),
  GEMINI_MODEL: str('GEMINI_MODEL', 'gemini-3.6-flash'),
};

// Not imported from llmEngine.js to avoid a circular import (llmEngine.js
// reads `env` from here); the check is small enough to keep in sync by hand.
export function isLlmEngineConfigured() {
  return env.GROQ_API_KEYS.length > 0 || Boolean(env.GEMINI_API_KEY);
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
    llm_providers: env.LLM_PROVIDER_ORDER.filter(
      (p) => (p === 'groq' && env.GROQ_API_KEYS.length > 0) || (p === 'gemini' && env.GEMINI_API_KEY)
    ),
    agent_routing,
  };
}

export default env;
