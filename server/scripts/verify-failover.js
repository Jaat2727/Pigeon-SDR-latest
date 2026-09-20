/**
 * What happens when keys start failing.
 *
 * `fetch` is replaced with a script, so this exercises the real provider walk
 * in llmEngine.js against providers that misbehave on cue. It is a separate
 * file from verify.js because it swaps a global, and because it reads better
 * as six short stories than as another list of assertions.
 *
 * Nothing here hard-codes a model name. The models are declared once, below,
 * and every assertion reads them back out of `process.env`. An earlier version
 * pasted `llama-3.3-70b-versatile` into the assertions themselves, so changing
 * a default in `.env` broke the test suite for a reason that had nothing to do
 * with the behaviour being tested. Model names change; what this file is
 * checking does not.
 *
 * Discovery is deliberately off here, so the ladder is exactly the one the
 * environment declares and each story has one obvious answer. The discovery
 * path has its own file, scripts/verify-models.js.
 *
 *   node scripts/verify-failover.js
 */

// config.js merges three shapes per provider — API_KEY, API_KEYS, and
// API_KEY_1.._6 — so setting only API_KEY here is not isolation: a real
// server/.env sitting next to this script with GROQ_API_KEY_2 or
// GEMINI_API_KEY_2 set (entirely reasonable — that is what a real deployment
// looks like) leaks extra real keys into the pool this test builds, and
// every count-based assertion below goes wrong for a reason that has
// nothing to do with the failover behaviour being tested.
//
// Set to '' rather than deleted: config.js loads server/.env with dotenv
// after this runs, and dotenv fills in anything still *unset* — an empty
// string counts as set and is what stops that refill, where `delete` would
// not.
for (const prefix of ['GROQ', 'GEMINI']) {
  process.env[`${prefix}_API_KEY`] = '';
  process.env[`${prefix}_API_KEYS`] = '';
  for (let i = 1; i <= 6; i += 1) process.env[`${prefix}_API_KEY_${i}`] = '';
}

process.env.GROQ_API_KEY = 'gsk_alpha_1111,gsk_bravo_2222,gsk_charlie_33';
process.env.GEMINI_API_KEY = 'AIza_gem_one_1,AIza_gem_two_2';
process.env.LLM_TIMEOUT_MS = '3000';
process.env.MODEL_AUTO_DISCOVER = 'false';

// The only place a model name appears. Change these and everything below
// still means the same thing.
process.env.GROQ_MODEL = 'test-primary-model';
process.env.GROQ_MODEL_FALLBACKS = 'test-fallback-model,test-last-resort-model';

/** Read back from the environment, exactly as the engine reads them. */
const PRIMARY = process.env.GROQ_MODEL;
const FALLBACKS = process.env.GROQ_MODEL_FALLBACKS.split(',').map((s) => s.trim()).filter(Boolean);
const FIRST_FALLBACK = FALLBACKS[0];

const { callLlm } = await import('../src/agents/llmEngine.js');
const { keyHealth, poolStatus, resetPools, registerKeys } = await import('../src/agents/keyPool.js');
const { resetLadders } = await import('../src/agents/llmEngine.js');

let pass = 0, fail = 0;
const ok = (label, cond, detail = '') => {
  if (cond) { pass++; console.log(`  pass  ${label}`); }
  else { fail++; console.log(`  FAIL  ${label}${detail ? ' — ' + detail : ''}`); }
};

const good = () => new Response(JSON.stringify({
  choices: [{ message: { content: '{"intent":"interested","intent_confidence":0.9,"recommended_action":"reply","reasoning":"ok"}' } }],
  usage: { total_tokens: 42 },
  candidates: [{ content: { parts: [{ text: '{"intent":"interested","intent_confidence":0.9,"recommended_action":"reply","reasoning":"ok"}' }] } }],
  usageMetadata: { totalTokenCount: 42 },
}), { status: 200 });

const payload = { inbound: { message: 'sounds good' } };

/* 1 · a rate-limited key falls through to the next key, same provider */
console.log('\n1 · a rate-limited key falls through to the next key');
globalThis.fetch = async (url, init) => {
  const key = init.headers.Authorization ?? init.headers['x-goog-api-key'];
  if (key?.includes('alpha')) return new Response('{"error":"rate limit"}', { status: 429 });
  return good();
};
let r = await callLlm('conversation', payload);
ok('it still answered', r.output.intent === 'interested');
ok('it stayed on groq rather than jumping to gemini', r.provider === 'groq', r.provider);
ok('a different key served it', !r.key.includes('alpha'), r.key);
ok('the rate-limited key is benched', poolStatus('groq').cooling === 1);
ok('both attempts are reported', r.attempts.length === 2, JSON.stringify(r.attempts.map(a => a.kind ?? 'ok')));

/* 2 · every groq key out means gemini takes over */
console.log('\n2 · every groq key out means gemini takes over');
globalThis.fetch = async (url) => {
  if (String(url).includes('groq')) return new Response('{"error":"rate limit"}', { status: 429 });
  return good();
};
r = await callLlm('conversation', payload);
ok('gemini answered', r.provider === 'gemini', r.provider);
ok('every groq key is now out', poolStatus('groq').healthy === 0);
ok('gemini is untouched', poolStatus('gemini').healthy === 2);

/* 3 · a retired model name is a model problem, not a key problem */
console.log('\n3 · a retired model name is a model problem, not a key problem');
resetPools();
resetLadders();
registerKeys('groq', ['gsk_alpha_1111']);
registerKeys('gemini', []);
let modelsTried = [];
globalThis.fetch = async (url, init) => {
  const body = JSON.parse(init.body);
  modelsTried.push(body.model);
  if (body.model === PRIMARY) {
    return new Response(
      JSON.stringify({ error: { message: `The model \`${PRIMARY}\` has been decommissioned` } }),
      { status: 400 }
    );
  }
  return good();
};
r = await callLlm('conversation', payload);
ok('it climbed to the next model in the ladder', r.model === FIRST_FALLBACK, r.model);
ok('the configured model was tried first', modelsTried[0] === PRIMARY, modelsTried[0]);
ok('the fallback was tried second', modelsTried[1] === FIRST_FALLBACK, modelsTried[1]);
ok('it did not try more models than it needed', modelsTried.length === 2, `${modelsTried.length} tried`);
ok('the key kept its clean record', poolStatus('groq').healthy === 1);
ok('the key is not blamed for it', keyHealth().find(p => p.provider === 'groq').keys[0].failed === 0);

/* 4 · the second call remembers which model worked */
console.log('\n4 · the second call remembers which model worked');
modelsTried = [];
r = await callLlm('conversation', payload);
ok('it goes straight to the model that worked',
  modelsTried.length === 1 && modelsTried[0] === FIRST_FALLBACK, modelsTried.join(' → '));
ok('it does not retry the retired one', !modelsTried.includes(PRIMARY));

/* 5 · a malformed request is not retried on five more keys */
console.log('\n5 · a malformed request is not retried on five more keys');
resetPools();
resetLadders();
registerKeys('groq', ['gsk_a_1', 'gsk_b_2', 'gsk_c_3', 'gsk_d_4']);
let calls = 0;
globalThis.fetch = async () => { calls++; return new Response('{"error":"invalid json body"}', { status: 400 }); };
try { await callLlm('conversation', payload); ok('it threw', false); }
catch (err) { ok('it threw rather than answering', err.code === 'all_providers_failed'); }
ok('it gave up after one key, not four', calls === 1, `${calls} calls`);
ok('no key was benched for our own mistake', poolStatus('groq').healthy === 4);

/* 6 · cancelling aborts the in-flight call */
console.log('\n6 · cancelling aborts the in-flight call');
resetPools();
resetLadders();
registerKeys('groq', ['gsk_a_1']);
globalThis.fetch = (url, init) => new Promise((resolve, reject) => {
  const t = setTimeout(() => resolve(good()), 5000);
  init.signal?.addEventListener('abort', () => { clearTimeout(t); const e = new Error('aborted'); e.name = 'AbortError'; reject(e); });
});
const controller = new AbortController();
const started = Date.now();
setTimeout(() => controller.abort(), 120);
try {
  await callLlm('conversation', payload, { signal: controller.signal });
  ok('it stopped', false, 'it returned instead');
} catch (err) {
  ok('it stopped with a cancellation, not a timeout', err.name === 'CancelledError', err.name);
  ok('it stopped quickly rather than waiting out the call', Date.now() - started < 1500, `${Date.now() - started}ms`);
}
ok('a cancelled call is not held against the key', poolStatus('groq').healthy === 1);

console.log('\n' + '─'.repeat(58));
console.log(fail === 0 ? `All ${pass} failover checks passed.` : `${fail} of ${pass + fail} failed.`);
process.exit(fail === 0 ? 0 : 1);
