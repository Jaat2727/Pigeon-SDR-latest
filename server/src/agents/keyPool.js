/**
 * The API key pool.
 *
 * One provider can hold up to six keys. The point is not just "try the next
 * one" — it is that a key which has just been rate limited should not be the
 * key we reach for on the very next call. Without that, a burst of work hits
 * the same exhausted key over and over, burns a retry on each attempt, and
 * the run crawls while five perfectly good keys sit idle.
 *
 * So every key carries its own state:
 *
 *   healthy     usable now
 *   cooling     failed recently, off the rota until `cooling_until`
 *   disabled    the provider said the key itself is bad (401/403). Off the
 *               rota until someone fixes it or the server restarts.
 *
 * Selection is least-recently-used across the healthy keys, so load spreads
 * evenly instead of hammering key #1 until it dies. A 400 from a provider is
 * never counted against the key, because a malformed request is our fault and
 * disabling a good key over it would be the wrong lesson to learn.
 *
 * Nothing here ever logs or returns a whole key. The UI sees a label built
 * from the first four and last four characters, which is enough to tell six
 * keys apart and useless to anyone who sees a screenshot.
 */

/** Hard ceiling per provider. More than this is almost always a paste error. */
export const MAX_KEYS_PER_PROVIDER = 6;

/**
 * How long a key sits out after each kind of failure. Rate limits escalate
 * with consecutive failures, because a key that is still limited after the
 * first cooldown is limited for longer than we guessed.
 */
const COOLDOWN_MS = {
  rate_limited: [20_000, 60_000, 180_000, 600_000],
  server_error: [15_000, 45_000, 120_000],
  network: [10_000, 30_000, 90_000],
  timeout: [5_000, 20_000, 60_000],
};

const pools = new Map();

/**
 * `gsk_ab…wxyz`, enough to tell six keys apart and no use to anyone else.
 * Six leading characters rather than four, because every Groq key starts
 * `gsk_` and every Gemini key starts `AIza`, so four tells you nothing.
 */
function fingerprint(key) {
  if (key.length <= 12) return `${key.slice(0, 2)}…${key.slice(-2)}`;
  return `${key.slice(0, 6)}…${key.slice(-4)}`;
}

function makeEntry(key, index) {
  return {
    index: index + 1,
    key,
    label: `#${index + 1} ${fingerprint(key)}`,
    state: 'healthy',
    cooling_until: null,
    consecutive_failures: 0,
    calls: 0,
    ok: 0,
    failed: 0,
    last_used_at: null,
    last_ok_at: null,
    last_error: null,
    last_error_kind: null,
    last_latency_ms: null,
    total_latency_ms: 0,
  };
}

/**
 * Registers the keys for a provider. Called once at boot from config.js.
 * Duplicates are dropped rather than registered twice: the same key listed
 * under two variable names is one key, and pretending otherwise would make
 * the pool think it has more capacity than it does.
 */
export function registerKeys(provider, keys) {
  const seen = new Set();
  const clean = [];

  for (const raw of keys ?? []) {
    const key = String(raw ?? '').trim();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    clean.push(key);
    if (clean.length >= MAX_KEYS_PER_PROVIDER) break;
  }

  pools.set(provider, {
    provider,
    entries: clean.map(makeEntry),
    cursor: 0,
    dropped: Math.max(0, (keys ?? []).filter(Boolean).length - clean.length),
  });

  return clean.length;
}

const poolOf = (provider) => pools.get(provider) ?? { provider, entries: [], cursor: 0, dropped: 0 };

export const keyCount = (provider) => poolOf(provider).entries.length;

export const hasKeys = (provider) => keyCount(provider) > 0;

/** Moves any key whose cooldown has expired back onto the rota. */
function thaw(pool) {
  const now = Date.now();
  for (const entry of pool.entries) {
    if (entry.state === 'cooling' && entry.cooling_until && entry.cooling_until <= now) {
      entry.state = 'healthy';
      entry.cooling_until = null;
    }
  }
}

/**
 * The next key to use, or null when every key for this provider is cooling or
 * disabled. Least recently used among the healthy ones.
 */
export function leaseKey(provider) {
  const pool = poolOf(provider);
  if (pool.entries.length === 0) return null;

  thaw(pool);

  const usable = pool.entries.filter((e) => e.state === 'healthy');
  if (usable.length === 0) return null;

  usable.sort((a, b) => (a.last_used_at ?? 0) - (b.last_used_at ?? 0));
  const chosen = usable[0];

  chosen.last_used_at = Date.now();
  chosen.calls += 1;
  return chosen;
}

/**
 * A usable key, without taking it off the rota or counting a call against it.
 *
 * Reading a provider's model list is housekeeping, not work. Leasing for it
 * would inflate the key's call count and shuffle the rotation, which would
 * make the key panel on the Agents screen report activity that never
 * happened.
 */
export function peekKey(provider) {
  const pool = poolOf(provider);
  if (pool.entries.length === 0) return null;

  thaw(pool);
  return pool.entries.find((e) => e.state === 'healthy') ?? null;
}

/**
 * Every key this provider has, in order, with whichever ones are currently
 * unusable and when they come back. Used by `callLlm` to decide whether to
 * keep trying this provider or move on to the next one.
 */
export function poolStatus(provider) {
  const pool = poolOf(provider);
  thaw(pool);

  const healthy = pool.entries.filter((e) => e.state === 'healthy').length;
  const cooling = pool.entries.filter((e) => e.state === 'cooling');
  const disabled = pool.entries.filter((e) => e.state === 'disabled').length;

  return {
    total: pool.entries.length,
    healthy,
    cooling: cooling.length,
    disabled,
    next_available_at: cooling.length
      ? Math.min(...cooling.map((e) => e.cooling_until ?? Infinity))
      : null,
  };
}

export function reportSuccess(entry, latencyMs) {
  if (!entry) return;
  entry.state = 'healthy';
  entry.cooling_until = null;
  entry.consecutive_failures = 0;
  entry.ok += 1;
  entry.last_ok_at = Date.now();
  entry.last_error = null;
  entry.last_error_kind = null;
  entry.last_latency_ms = latencyMs ?? null;
  entry.total_latency_ms += latencyMs ?? 0;
}

/**
 * Failures that are nothing to do with the key. Benching a key for one of
 * these is actively harmful: with a single key configured and a retired model
 * name, it takes the only key out of service, the retry on the fallback model
 * then finds an empty pool, and the whole call fails with "every key is
 * cooling down" — which sends you looking at your keys for a problem that was
 * one wrong model string.
 */
const NOT_THE_KEYS_FAULT = new Set(['bad_request', 'model_not_found']);

/**
 * Records a failure against a key and decides whether the key is at fault.
 *
 * `kind` comes from the transport, which is the only place that can see an
 * HTTP status. The error is always recorded so the UI can show it; only a
 * failure the key is actually responsible for costs it its place.
 */
export function reportFailure(entry, { kind = 'network', message = '' } = {}) {
  if (!entry) return;

  entry.last_error = message.slice(0, 400);
  entry.last_error_kind = kind;

  if (NOT_THE_KEYS_FAULT.has(kind)) return;

  entry.failed += 1;
  entry.consecutive_failures += 1;

  if (kind === 'invalid_key') {
    entry.state = 'disabled';
    entry.cooling_until = null;
    return;
  }

  const ladder = COOLDOWN_MS[kind] ?? COOLDOWN_MS.network;
  const wait = ladder[Math.min(entry.consecutive_failures - 1, ladder.length - 1)];
  entry.state = 'cooling';
  entry.cooling_until = Date.now() + wait;
}

/** Puts a disabled or cooling key back on the rota, from the Agents screen. */
export function reviveKey(provider, index) {
  const pool = poolOf(provider);
  const entry = pool.entries.find((e) => e.index === index);
  if (!entry) return null;

  entry.state = 'healthy';
  entry.cooling_until = null;
  entry.consecutive_failures = 0;
  return describe(entry);
}

export function reviveAll() {
  let revived = 0;
  for (const pool of pools.values()) {
    for (const entry of pool.entries) {
      if (entry.state !== 'healthy') revived += 1;
      entry.state = 'healthy';
      entry.cooling_until = null;
      entry.consecutive_failures = 0;
    }
  }
  return revived;
}

function describe(entry) {
  return {
    index: entry.index,
    label: entry.label,
    state: entry.state,
    cooling_for_ms:
      entry.state === 'cooling' && entry.cooling_until
        ? Math.max(0, entry.cooling_until - Date.now())
        : null,
    calls: entry.calls,
    ok: entry.ok,
    failed: entry.failed,
    // Over settled calls, not leases. A call still in flight has no outcome
    // yet, and counting it as a miss makes a healthy key look like it is
    // failing half the time.
    success_rate: entry.ok + entry.failed ? Math.round((entry.ok / (entry.ok + entry.failed)) * 100) : null,
    avg_latency_ms: entry.ok ? Math.round(entry.total_latency_ms / entry.ok) : null,
    last_latency_ms: entry.last_latency_ms,
    last_used_at: entry.last_used_at ? new Date(entry.last_used_at).toISOString() : null,
    last_ok_at: entry.last_ok_at ? new Date(entry.last_ok_at).toISOString() : null,
    last_error: entry.last_error,
    last_error_kind: entry.last_error_kind,
  };
}

/**
 * Every key of every provider, redacted, for the Agents screen. State lives in
 * this process rather than the database on purpose: it describes what this
 * server instance has seen in the last few minutes, and a stale row claiming a
 * key is dead after a restart would be worse than no row at all.
 */
export function keyHealth() {
  return [...pools.values()].map((pool) => ({
    provider: pool.provider,
    configured: pool.entries.length,
    max: MAX_KEYS_PER_PROVIDER,
    ignored_duplicates: pool.dropped,
    ...poolStatus(pool.provider),
    keys: pool.entries.map(describe),
  }));
}

/** Test seam: forgets every pool. Not called by the server. */
export function resetPools() {
  pools.clear();
}
