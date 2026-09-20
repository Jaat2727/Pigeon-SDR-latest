/**
 * What happens when keys start failing.
 *
 * `fetch` is replaced with a script, so this exercises the real provider walk
 * in llmEngine.js against providers that misbehave on cue. It is a separate
 * file from verify.js because it swaps a global, and because it reads better
 * as six short stories than as another list of assertions.
 *
 *   node scripts/verify-failover.js
 */
process.env.GROQ_API_KEY = 'gsk_alpha_1111,gsk_bravo_2222,gsk_charlie_33';
process.env.GEMINI_API_KEY = 'AIza_gem_one_1,AIza_gem_two_2';
process.env.GROQ_MODEL = 'openai/gpt-oss-120b';
process.env.GROQ_MODEL_FALLBACKS = 'openai/gpt-oss-20b';
process.env.LLM_TIMEOUT_MS = '3000';

const { callLlm } = await import('../src/agents/llmEngine.js');
const { keyHealth, poolStatus } = await import('../src/agents/keyPool.js');

let pass = 0, fail = 0;
const ok = (label, cond, detail = '') => {
  if (cond) { pass++; console.log(`  pass  ${label}`); }
  else { fail++; console.log(`  FAIL  ${label}${detail ? ' — ' + detail : ''}`); }
};

const seen = [];
const good = (model) => new Response(JSON.stringify({
  choices: [{ message: { content: '{"intent":"interested","intent_confidence":0.9,"recommended_action":"reply","reasoning":"ok"}' } }],
  usage: { total_tokens: 42 },
  candidates: [{ content: { parts: [{ text: '{"intent":"interested","intent_confidence":0.9,"recommended_action":"reply","reasoning":"ok"}' }] } }],
  usageMetadata: { totalTokenCount: 42 },
  model,
}), { status: 200 });

const payload = { inbound: { message: 'sounds good' } };

/* 1 · a rate-limited key falls through to the next key, same provider */
console.log('\n1 · a rate-limited key falls through to the next key');
globalThis.fetch = async (url, init) => {
  const key = init.headers.Authorization ?? init.headers['x-goog-api-key'];
  seen.push(key);
  if (key?.includes('alpha')) return new Response('{"error":"rate limit"}', { status: 429 });
  return good('groq');
};
let r = await callLlm('conversation', payload);
ok('it still answered', r.output.intent === 'interested');
ok('it stayed on groq rather than jumping to gemini', r.provider === 'groq', r.provider);
ok('a different key served it', !r.key.includes('alpha'), r.key);
ok('the rate-limited key is benched', poolStatus('groq').cooling === 1);
ok('both attempts are reported', r.attempts.length === 2, JSON.stringify(r.attempts.map(a => a.kind ?? 'ok')));

/* 2 · every groq key out means gemini takes over */
console.log('\n2 · every groq key out means gemini takes over');
globalThis.fetch = async (url, init) => {
  if (String(url).includes('groq')) return new Response('{"error":"rate limit"}', { status: 429 });
  return good('gemini');
};
r = await callLlm('conversation', payload);
ok('gemini answered', r.provider === 'gemini', r.provider);
ok('every groq key is now out', poolStatus('groq').healthy === 0);
ok('gemini is untouched', poolStatus('gemini').healthy === 2);

/* 3 · a retired model name is a model problem, not a key problem */
console.log('\n3 · a retired model name is a model problem, not a key problem');
const { resetPools, registerKeys } = await import('../src/agents/keyPool.js');
resetPools();
registerKeys('groq', ['gsk_alpha_1111']);
registerKeys('gemini', []);
let modelsTried = [];
globalThis.fetch = async (url, init) => {
  const body = JSON.parse(init.body);
  modelsTried.push(body.model);
  if (body.model === 'openai/gpt-oss-120b') {
    return new Response('{"error":{"message":"The model `openai/gpt-oss-120b` has been decommissioned"}}', { status: 400 });
  }
  return good(body.model);
};
r = await callLlm('conversation', payload);
ok('it climbed to the fallback model', r.model === 'openai/gpt-oss-20b', r.model);
ok('both models were tried in order', modelsTried.join(' → ') === 'openai/gpt-oss-120b → openai/gpt-oss-20b', modelsTried.join(' → '));
ok('the key kept its clean record', poolStatus('groq').healthy === 1);
ok('the key is not blamed for it', keyHealth().find(p => p.provider === 'groq').keys[0].failed === 0);

/* 4 · the second call remembers which model worked */
console.log('\n4 · the second call remembers which model worked');
modelsTried = [];
r = await callLlm('conversation', payload);
ok('it goes straight to the working model', modelsTried.join('') === 'openai/gpt-oss-20b', modelsTried.join(' → '));

/* 5 · a malformed request is not retried on five more keys */
console.log('\n5 · a malformed request is not retried on five more keys');
resetPools();
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
registerKeys('groq', ['gsk_a_1']);
globalThis.fetch = (url, init) => new Promise((resolve, reject) => {
  const t = setTimeout(() => resolve(good('groq')), 5000);
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
