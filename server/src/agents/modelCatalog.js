/**
 * What models each provider actually has, asked at runtime.
 *
 * This module exists because of a specific, repeated failure. The engine used
 * to hold a hand-written ladder of model names in `.env` and `config.js`.
 * Providers retire models constantly: `llama3-70b-8192` worked, then did not,
 * then the replacement was renamed too. Every time, the whole pipeline failed
 * with "Every provider failed", which reads like a key problem and sends you
 * to the wrong place. It was one stale string.
 *
 * So the ladder is now discovered instead of declared. On first use, each
 * provider is asked `GET /models` with a real key, and the answer is the
 * ladder: the model you configured first when it genuinely exists, then the
 * best of whatever else that account can actually reach.
 *
 * Three rules keep this honest:
 *
 *   Your choice wins.    A configured model that exists is always tried
 *                        first. Discovery only supplies what comes after it,
 *                        and what to do when your choice is gone.
 *   Failure is visible.  If the catalogue cannot be fetched, the static list
 *                        from `.env` is used and `/health` says so. Silently
 *                        picking something different from what you configured
 *                        is exactly the confusion this replaced.
 *   Nothing is fatal.    A provider that will not answer /models still gets
 *                        tried with your configured model.
 */
import { env } from '../config.js';
import { peekKey } from './keyPool.js';

const ENDPOINTS = {
  groq: {
    url: 'https://api.groq.com/openai/v1/models',
    headers: (key) => ({ Authorization: `Bearer ${key}` }),
    parse: (body) =>
      (body?.data ?? [])
        .filter((m) => m?.id && m.active !== false)
        .map((m) => ({
          id: m.id,
          context: m.context_window ?? null,
          owner: m.owned_by ?? null,
        })),
  },
  gemini: {
    url: 'https://generativelanguage.googleapis.com/v1beta/models?pageSize=200',
    headers: (key) => ({ 'x-goog-api-key': key }),
    parse: (body) =>
      (body?.models ?? [])
        // Gemini lists embedding and media models alongside chat ones. Only
        // the models that can answer a generateContent call are candidates.
        .filter((m) => (m?.supportedGenerationMethods ?? []).includes('generateContent'))
        .map((m) => ({
          id: String(m.name ?? '').replace(/^models\//, ''),
          context: m.inputTokenLimit ?? null,
          owner: 'google',
        }))
        .filter((m) => m.id),
  },
};

/**
 * Models that answer a chat call but cannot do this job. A safety classifier
 * returns a verdict rather than the JSON object an agent asked for, so
 * falling back to one produces a schema failure on every single call and
 * looks like the model is broken.
 */
const NOT_FOR_REASONING = /guard|moderat|whisper|tts|speech|embed|vision-only|image-gen|imagen|veo|aqa|rerank/i;

/**
 * Preference, as substrings, best first. Applied to whatever the provider
 * actually returned, so this list going stale costs a little ranking quality
 * rather than breaking the pipeline, which is the whole point of the change.
 */
const PREFERRED = [
  'versatile', '120b', '70b', 'gpt-oss', 'pro', 'flash', 'maverick', '32b', 'scout',
];

/** Smaller and cheaper. Fine as a fallback, not as a first choice. */
const LESSER = ['instant', 'mini', 'lite', 'nano', '8b', '7b', '1b', '3b', 'preview', 'exp'];

export function rankModels(models) {
  return [...models]
    .filter((m) => !NOT_FOR_REASONING.test(m.id))
    .map((m) => {
      const id = m.id.toLowerCase();
      let score = 0;

      PREFERRED.forEach((token, i) => {
        if (id.includes(token)) score += (PREFERRED.length - i) * 10;
      });
      LESSER.forEach((token) => {
        if (id.includes(token)) score -= 15;
      });

      // A bigger context window is a reasonable tie-break: these agents send
      // a whole enriched profile plus retrieved knowledge in one call.
      if (m.context) score += Math.min(20, Math.log2(m.context / 1000) * 2);

      return { ...m, score };
    })
    .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
}

/* ── the cache ──────────────────────────────────────────────────────── */

const cache = new Map();

async function fetchCatalog(provider, key) {
  const spec = ENDPOINTS[provider];
  if (!spec) throw new Error(`No model endpoint is known for "${provider}"`);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), env.MODEL_CATALOG_TIMEOUT_MS);

  try {
    const res = await fetch(spec.url, {
      headers: { Accept: 'application/json', ...spec.headers(key) },
      signal: controller.signal,
    });

    const text = await res.text();

    if (!res.ok) {
      if (res.status === 401 || res.status === 403) {
        throw new Error(`the key was rejected (HTTP ${res.status})`);
      }
      throw new Error(`HTTP ${res.status}: ${text.slice(0, 160)}`);
    }

    let body;
    try {
      body = JSON.parse(text);
    } catch {
      throw new Error('the model list was not JSON');
    }

    const models = spec.parse(body);
    if (models.length === 0) throw new Error('the model list came back empty');

    return models;
  } catch (err) {
    if (err?.name === 'AbortError') {
      throw new Error(`no response within ${env.MODEL_CATALOG_TIMEOUT_MS}ms`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The provider's live model list, cached. Returns `{models, error}` rather
 * than throwing: a provider that will not tell us its models is a reason to
 * fall back to the configured list, not a reason to fail the call.
 */
export async function getCatalog(provider, { force = false } = {}) {
  const held = cache.get(provider);
  const fresh = held && Date.now() - held.fetchedAt < env.MODEL_CATALOG_TTL_MS;

  if (fresh && !force) return held;

  // Reading the model list should not cost a key its place in the rota or
  // show up in its call count, so this peeks instead of leasing.
  const key = peekKey(provider);
  if (!key) {
    const entry = { provider, models: [], ranked: [], error: 'no usable key', fetchedAt: Date.now() };
    cache.set(provider, entry);
    return entry;
  }

  try {
    const models = await fetchCatalog(provider, key.key);
    const entry = {
      provider,
      models,
      ranked: rankModels(models),
      error: null,
      fetchedAt: Date.now(),
      fetched_with: key.label,
    };
    cache.set(provider, entry);
    console.log(`[models] ${provider}: ${models.length} available, best is ${entry.ranked[0]?.id ?? 'none'}`);
    return entry;
  } catch (err) {
    const entry = {
      provider,
      models: [],
      ranked: [],
      error: err.message,
      fetchedAt: Date.now(),
      fetched_with: key.label,
    };
    cache.set(provider, entry);
    console.warn(
      `[models] could not read ${provider}'s model list (${err.message}). ` +
        'Falling back to the models named in the environment.'
    );
    return entry;
  }
}

/* ── building the ladder ────────────────────────────────────────────── */

const configuredFor = (provider) => (provider === 'groq' ? env.GROQ_MODEL : env.GEMINI_MODEL);
const fallbacksFor = (provider) =>
  provider === 'groq' ? env.GROQ_MODEL_FALLBACKS : env.GEMINI_MODEL_FALLBACKS;

/** The static ladder, used when discovery is off or the provider will not answer. */
export function staticLadder(provider) {
  return [...new Set([configuredFor(provider), ...fallbacksFor(provider)].filter(Boolean))];
}

/**
 * The models to try, in order.
 *
 * Both halves matter. Putting your configured model first means a working
 * configuration is never quietly overridden. Filling the rest from the live
 * list means that when your configured model is retired overnight, the next
 * call finds a real replacement instead of walking a ladder of names that
 * were also retired.
 */
export async function resolveLadder(provider) {
  const configured = configuredFor(provider);

  if (!env.MODEL_AUTO_DISCOVER) {
    return { ladder: staticLadder(provider), source: 'env', configured_available: null };
  }

  const catalog = await getCatalog(provider);

  if (catalog.error || catalog.ranked.length === 0) {
    return {
      ladder: staticLadder(provider),
      source: 'env',
      error: catalog.error,
      configured_available: null,
    };
  }

  const available = new Set(catalog.models.map((m) => m.id));
  const configuredExists = configured ? available.has(configured) : false;

  const ladder = [
    ...(configuredExists ? [configured] : []),
    // Named fallbacks are still honoured, but only the ones that exist.
    ...fallbacksFor(provider).filter((m) => available.has(m)),
    ...catalog.ranked.map((m) => m.id),
  ];

  if (configured && !configuredExists) {
    console.warn(
      `[models] ${provider.toUpperCase()}_MODEL is set to "${configured}", which this account ` +
        `cannot reach. Using "${catalog.ranked[0]?.id}" instead. ` +
        `Set ${provider.toUpperCase()}_MODEL to one of: ${catalog.ranked.slice(0, 3).map((m) => m.id).join(', ')}`
    );
  }

  return {
    ladder: [...new Set(ladder)].slice(0, env.MODEL_LADDER_MAX),
    source: 'discovered',
    configured_available: configuredExists,
    best_available: catalog.ranked[0]?.id ?? null,
  };
}

/** For /health and the Agents screen. Never triggers a fetch of its own. */
export function catalogStatus() {
  return Object.keys(ENDPOINTS).map((provider) => {
    const held = cache.get(provider);
    return {
      provider,
      configured: configuredFor(provider),
      auto_discover: env.MODEL_AUTO_DISCOVER,
      checked: Boolean(held),
      checked_at: held ? new Date(held.fetchedAt).toISOString() : null,
      available_count: held?.models.length ?? 0,
      error: held?.error ?? null,
      configured_available: held ? held.models.some((m) => m.id === configuredFor(provider)) : null,
      // Enough to choose from in the UI without printing a hundred ids.
      top: (held?.ranked ?? []).slice(0, 8).map((m) => ({ id: m.id, context: m.context })),
    };
  });
}

/** Test seam, and what `POST /agents/models/refresh` calls. */
export function clearCatalog() {
  cache.clear();
}
