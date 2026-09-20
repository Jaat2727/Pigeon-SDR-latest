/**
 * Asking each provider what models it actually has.
 *
 * This is the file that exists because of a recurring, avoidable outage. The
 * engine used to carry a hand-written ladder of model names. Providers retire
 * models on their own schedule, and every time one went, the entire pipeline
 * failed with "every provider failed" — which reads like a key problem and
 * sends you to look at your keys. It was one stale string, twice.
 *
 * `fetch` is replaced with a script here, so these run offline and check the
 * behaviour rather than the current contents of anyone's Groq account.
 *
 *   node scripts/verify-models.js
 */
process.env.GROQ_API_KEY = 'gsk_alpha_1111';
process.env.GEMINI_API_KEY = 'AIza_gem_one_1';
process.env.MODEL_AUTO_DISCOVER = 'true';
process.env.GROQ_MODEL = 'configured-model';
process.env.GROQ_MODEL_FALLBACKS = 'named-fallback';
process.env.MODEL_CATALOG_TIMEOUT_MS = '2000';

const { rankModels, resolveLadder, getCatalog, staticLadder, clearCatalog, catalogStatus } =
  await import('../src/agents/modelCatalog.js');
const { resetPools, registerKeys } = await import('../src/agents/keyPool.js');

let pass = 0, fail = 0;
const ok = (label, cond, detail = '') => {
  if (cond) { pass++; console.log(`  pass  ${label}`); }
  else { fail++; console.log(`  FAIL  ${label}${detail ? ' — ' + detail : ''}`); }
};

const groqList = (ids) => new Response(JSON.stringify({
  object: 'list',
  data: ids.map((id) => ({ id, object: 'model', active: true, context_window: 131072 })),
}), { status: 200 });

const geminiList = (ids) => new Response(JSON.stringify({
  models: ids.map((id) => ({
    name: `models/${id}`,
    supportedGenerationMethods: ['generateContent', 'countTokens'],
    inputTokenLimit: 1048576,
  })),
}), { status: 200 });

const fresh = () => { resetPools(); registerKeys('groq', ['gsk_alpha_1111']); registerKeys('gemini', ['AIza_gem_one_1']); clearCatalog(); };

/* 1 · ranking picks something that can actually do the job */
console.log('\n1 · ranking picks something that can actually do the job');
const ranked = rankModels([
  { id: 'whisper-large-v3' },
  { id: 'meta-llama/llama-guard-4-12b' },
  { id: 'llama-3.1-8b-instant', context: 131072 },
  { id: 'llama-3.3-70b-versatile', context: 131072 },
  { id: 'text-embedding-004' },
]);
const rankedIds = ranked.map((m) => m.id);
ok('speech models are excluded', !rankedIds.includes('whisper-large-v3'));
ok('safety classifiers are excluded', !rankedIds.some((id) => id.includes('guard')));
ok('embedding models are excluded', !rankedIds.some((id) => id.includes('embedding')));
ok('a capable model outranks a small fast one',
  rankedIds.indexOf('llama-3.3-70b-versatile') < rankedIds.indexOf('llama-3.1-8b-instant'),
  rankedIds.join(', '));
ok('the small one is still available as a fallback', rankedIds.includes('llama-3.1-8b-instant'));

/* 2 · a configured model that exists is always tried first */
console.log('\n2 · a configured model that exists is always tried first');
fresh();
globalThis.fetch = async () => groqList(['llama-3.3-70b-versatile', 'configured-model', 'llama-3.1-8b-instant']);
let resolved = await resolveLadder('groq');
ok('the ladder starts with what you configured', resolved.ladder[0] === 'configured-model', resolved.ladder[0]);
ok('discovery supplied the rest', resolved.ladder.length > 1, resolved.ladder.join(', '));
ok('it reports that your choice was available', resolved.configured_available === true);
ok('the source is recorded as discovered', resolved.source === 'discovered');

/* 3 · a configured model that has been retired does not break the call */
console.log('\n3 · a configured model that has been retired does not break the call');
fresh();
globalThis.fetch = async () => groqList(['llama-3.3-70b-versatile', 'llama-3.1-8b-instant']);
resolved = await resolveLadder('groq');
ok('it says your configured model is gone', resolved.configured_available === false);
ok('it does not put the missing model in the ladder', !resolved.ladder.includes('configured-model'));
ok('it picked a real model instead', resolved.ladder[0] === 'llama-3.3-70b-versatile', resolved.ladder[0]);
ok('it names the best one it found', resolved.best_available === 'llama-3.3-70b-versatile');

/* 4 · a named fallback is honoured, but only if it exists */
console.log('\n4 · a named fallback is honoured, but only if it exists');
fresh();
globalThis.fetch = async () => groqList(['named-fallback', 'llama-3.1-8b-instant']);
resolved = await resolveLadder('groq');
ok('the named fallback is used when it is real', resolved.ladder.includes('named-fallback'));
fresh();
globalThis.fetch = async () => groqList(['llama-3.1-8b-instant']);
resolved = await resolveLadder('groq');
ok('a named fallback that does not exist is dropped', !resolved.ladder.includes('named-fallback'),
  resolved.ladder.join(', '));

/* 5 · a provider that will not answer falls back to the environment */
console.log('\n5 · a provider that will not answer falls back to the environment');
fresh();
globalThis.fetch = async () => new Response('nope', { status: 500 });
resolved = await resolveLadder('groq');
ok('it still produces a ladder', resolved.ladder.length > 0);
ok('the ladder is the one from the environment',
  resolved.ladder.join(',') === staticLadder('groq').join(','), resolved.ladder.join(','));
ok('it says the source was the environment, not discovery', resolved.source === 'env');
ok('the reason is recorded rather than swallowed', Boolean(resolved.error), resolved.error);

/* 6 · a rejected key is reported as a key problem, not a model problem */
console.log('\n6 · a rejected key is reported as a key problem');
fresh();
globalThis.fetch = async () => new Response('{"error":"invalid api key"}', { status: 401 });
const catalog = await getCatalog('groq');
ok('the error names the key', /key was rejected/i.test(catalog.error ?? ''), catalog.error);
ok('no models are claimed', catalog.models.length === 0);

/* 7 · gemini's shape is read correctly */
console.log('\n7 · gemini\'s shape is read correctly');
fresh();
globalThis.fetch = async () => geminiList(['gemini-2.5-flash', 'gemini-2.0-flash']);
const gem = await getCatalog('gemini');
ok('the models/ prefix is stripped', gem.models.every((m) => !m.id.startsWith('models/')),
  gem.models.map((m) => m.id).join(', '));
ok('both models were read', gem.models.length === 2);
ok('a model that cannot generate content is skipped', await (async () => {
  clearCatalog();
  globalThis.fetch = async () => new Response(JSON.stringify({
    models: [
      { name: 'models/embedding-001', supportedGenerationMethods: ['embedContent'] },
      { name: 'models/gemini-2.5-flash', supportedGenerationMethods: ['generateContent'] },
    ],
  }), { status: 200 });
  const c = await getCatalog('gemini');
  return c.models.length === 1 && c.models[0].id === 'gemini-2.5-flash';
})());

/* 8 · the catalogue is cached, not fetched on every call */
console.log('\n8 · the catalogue is cached, not fetched on every call');
fresh();
let fetches = 0;
globalThis.fetch = async () => { fetches++; return groqList(['llama-3.3-70b-versatile']); };
await getCatalog('groq');
await getCatalog('groq');
await getCatalog('groq');
ok('three reads, one request', fetches === 1, `${fetches} requests`);
await getCatalog('groq', { force: true });
ok('a forced refresh does go out again', fetches === 2, `${fetches} requests`);

/* 9 · status is reportable without triggering a fetch */
console.log('\n9 · status is reportable without triggering a fetch');
const before = fetches;
const status = catalogStatus();
ok('reading status makes no request', fetches === before);
ok('it reports both providers', status.length === 2);
ok('it says what is configured', status.find((p) => p.provider === 'groq').configured === 'configured-model');

console.log('\n' + '─'.repeat(58));
console.log(fail === 0 ? `All ${pass} model checks passed.` : `${fail} of ${pass + fail} failed.`);
process.exit(fail === 0 ? 0 : 1);
