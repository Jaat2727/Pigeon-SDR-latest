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

  // When a DronaHQ call fails or returns nothing usable, answer from the
  // deterministic local engine instead of stalling. Every run records which
  // engine produced it either way.
  LOCAL_ENGINE_ENABLED: bool('LOCAL_ENGINE_ENABLED', true),

  // Used to attribute cost to a run when the provider reports none.
  COST_PER_1K_TOKENS_USD: parseFloat(str('COST_PER_1K_TOKENS_USD', '0.015')) || 0.015,
};

/**
 * One webhook URL and key per agent, so an agent can be rolled out or rolled
 * back on its own. A shared DRONAHQ_API_KEY covers all five unless an agent
 * overrides it.
 */
export const DRONAHQ_AGENTS = {
  research: {
    url: str('DRONAHQ_RESEARCH_URL'),
    key: str('DRONAHQ_RESEARCH_KEY') || str('DRONAHQ_API_KEY'),
  },
  icp_fitment: {
    url: str('DRONAHQ_ICP_URL'),
    key: str('DRONAHQ_ICP_KEY') || str('DRONAHQ_API_KEY'),
  },
  outreach_strategy: {
    url: str('DRONAHQ_STRATEGY_URL'),
    key: str('DRONAHQ_STRATEGY_KEY') || str('DRONAHQ_API_KEY'),
  },
  personalisation: {
    url: str('DRONAHQ_PERSONALISATION_URL'),
    key: str('DRONAHQ_PERSONALISATION_KEY') || str('DRONAHQ_API_KEY'),
  },
  conversation: {
    url: str('DRONAHQ_CONVERSATION_URL'),
    key: str('DRONAHQ_CONVERSATION_KEY') || str('DRONAHQ_API_KEY'),
  },
};

/**
 * The environment variable names for one agent.
 *
 * Exported rather than derived from the agent id, because two of them do not
 * match: `icp_fitment` reads DRONAHQ_ICP_URL and `outreach_strategy` reads
 * DRONAHQ_STRATEGY_URL. A screen that built the name by upper-casing the id
 * told people to set DRONAHQ_ICP_FITMENT_URL, which does nothing.
 */
const ENV_STEM = {
  research: 'RESEARCH',
  icp_fitment: 'ICP',
  outreach_strategy: 'STRATEGY',
  personalisation: 'PERSONALISATION',
  conversation: 'CONVERSATION',
};

export function envNamesFor(agentName) {
  const stem = ENV_STEM[agentName];
  if (!stem) return null;
  return { url: `DRONAHQ_${stem}_URL`, key: `DRONAHQ_${stem}_KEY`, sharedKey: 'DRONAHQ_API_KEY' };
}

export function isDronaHqConfigured(agentName) {
  const cfg = DRONAHQ_AGENTS[agentName];
  return Boolean(cfg && cfg.url && cfg.key);
}

/**
 * What is and is not configured. Logged at boot and exposed on /health, so a
 * misconfigured deploy is one request away from explaining itself.
 */
export function configReport() {
  const missing = [];
  if (!env.SUPABASE_URL) missing.push('SUPABASE_URL');
  if (!env.SUPABASE_SERVICE_ROLE_KEY) missing.push('SUPABASE_SERVICE_ROLE_KEY');

  const agent_routing = {};
  for (const name of Object.keys(DRONAHQ_AGENTS)) {
    agent_routing[name] = isDronaHqConfigured(name) ? 'dronahq' : 'local_engine';
  }

  return {
    node_env: env.NODE_ENV,
    node_version: process.version,
    database_configured: missing.length === 0,
    missing_required: missing,
    cors_origins: env.CORS_ORIGINS,
    worker_enabled: env.WORKER_ENABLED,
    local_engine_enabled: env.LOCAL_ENGINE_ENABLED,
    agent_routing,
  };
}

export default env;
