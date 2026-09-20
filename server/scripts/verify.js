/**
 * Offline checks for the agent layer.
 *
 * No network, no database. Every assertion here is about logic that has burned
 * us at least once, so a regression shows up in two seconds rather than during
 * a demo.
 *
 *   node scripts/verify.js
 */
import {
  AGENT_SCHEMAS, isEmptyOutput, coerceIcp, coerceResearch, coerceStrategy,
  coercePersonalisation, coerceConversation, toArray, toNumberOrNull, toObject, INTENTS,
  personName,
} from '../src/agents/schemas.js';
import { parseLooseJson } from '../src/lib/json.js';
import { runLocalEngine } from '../src/agents/localEngine.js';
import { AGENT_REGISTRY, getAgent, PIPELINE } from '../src/agents/registry.js';
import {
  registerKeys, leaseKey, reportSuccess, reportFailure, reviveKey,
  keyHealth, poolStatus, keyCount, resetPools, MAX_KEYS_PER_PROVIDER,
} from '../src/agents/keyPool.js';
import { classify } from '../src/agents/llmEngine.js';
import { employeeRange, buildSearchFilters, unlockedEmail, mapPerson } from '../src/services/discovery/apollo.js';
import { appendEvent } from '../src/orchestrator/jobs.js';
import { readiness } from '../src/routes/campaigns.js';

let pass = 0;
let fail = 0;

const ok = (label, condition, detail = '') => {
  if (condition) {
    pass += 1;
    console.log(`\x1b[32mpass\x1b[0m  ${label}`);
  } else {
    fail += 1;
    console.log(`\x1b[31mFAIL\x1b[0m  ${label}${detail ? ` — ${detail}` : ''}`);
  }
};

const group = (name) => console.log(`\n\x1b[2m${name}\x1b[0m`);

/* ── registry ─────────────────────────────────────────────────────────── */
group('Registry');

ok('every agent has an id, a name and an engine',
  AGENT_REGISTRY.every((a) => a.id && a.name && a.engine));
ok('ids are unique',
  new Set(AGENT_REGISTRY.map((a) => a.id)).size === AGENT_REGISTRY.length);
ok('every pipeline step is a real agent', PIPELINE.every((id) => getAgent(id)));
ok('every callable agent meant to reason runs on the llm engine',
  AGENT_REGISTRY.filter((a) => a.callable && a.id !== 'followup_timing').every((a) => a.engine === 'llm'));
ok('follow-up timing is deliberately deterministic', getAgent('followup_timing').engine === 'our_engine');
ok('voice is registered but not callable', getAgent('voice_sdr').callable === false);

/* ── loose JSON parsing ──────────────────────────────────────────────── */
group('Loose JSON parsing');

ok('bare object passes through', parseLooseJson({ a: 1 })?.a === 1);
ok('plain json string parses', parseLooseJson('{"a":1}')?.a === 1);
ok('loose json parses a fenced body', parseLooseJson('```\n{"a":1}\n```')?.a === 1);
ok('loose json parses prose around a json object',
  parseLooseJson('Sure, here you go: {"a":1} hope that helps')?.a === 1);
ok('unparseable text returns null', parseLooseJson('not json at all') === null);

/* ── coercion ─────────────────────────────────────────────────────────── */
group('Coercion');

ok('score as a string becomes a number', coerceIcp({ verdict: 'qualify', fit_score: '82' }).fit_score === 82);
ok('"qualified" becomes "qualify"', coerceIcp({ verdict: 'qualified', fit_score: 80 }).verdict === 'qualify');
ok('"Rejected" becomes "reject"', coerceIcp({ verdict: 'Rejected', fit_score: 10 }).verdict === 'reject');
ok('"needs review" becomes "needs_review"',
  coerceIcp({ verdict: 'needs review', fit_score: 50 }).verdict === 'needs_review');
ok('score is clamped to 100', coerceIcp({ verdict: 'qualify', fit_score: 140 }).fit_score === 100);
ok('alternate key "score" is read', coerceIcp({ verdict: 'qualify', score: 61 }).fit_score === 61);
ok('stringified array', toArray('["a","b"]').length === 2);
ok('comma separated string', toArray('a, b, c').length === 3);
ok('null becomes an empty array', toArray(null).length === 0);
ok('"N/A" becomes null', toNumberOrNull('N/A') === null);
ok('stringified object', toObject('{"a":1}')?.a === 1);

ok('flat research is nested',
  coerceResearch({ full_name: 'A B', title: 'CTO', company_name: 'X' }).person.full_name === 'A B');
ok('nested research stays nested',
  coerceResearch({ person: { full_name: 'A B' }, company: { name: 'X' } }).company.name === 'X');

ok('a sequence step on an unknown channel is dropped',
  coerceStrategy({ sequence: [{ step: 1, channel: 'carrier_pigeon', day_offset: 0 }] }).sequence.length === 0);
ok('a valid sequence step survives',
  coerceStrategy({ sequence: [{ step: 1, channel: 'email', day_offset: 0 }] }).sequence.length === 1);

ok('word count is derived when absent',
  coercePersonalisation({ body: 'one two three', channel: 'email' }).word_count === 3);

ok('confidence given as 0-100 is normalised',
  coerceConversation({ intent: 'interested', intent_confidence: 90 }).intent_confidence === 0.9);
ok('confidence given as 0-1 is left alone',
  coerceConversation({ intent: 'interested', intent_confidence: 0.9 }).intent_confidence === 0.9);
ok('a referral is assembled from loose fields',
  coerceConversation({ intent: 'referral', referral_name: 'Dana' }).referral?.name === 'Dana');

/* ── empty detection ──────────────────────────────────────────────────── */
group('Empty output detection');

ok('all-null ICP is empty', isEmptyOutput('icp_fitment', coerceIcp({ verdict: null, fit_score: null })));
ok('a real ICP result is not empty',
  !isEmptyOutput('icp_fitment', coerceIcp({ verdict: 'qualify', fit_score: 80 })));
ok('research with no person or company is empty',
  isEmptyOutput('research', coerceResearch({})));
ok('an empty sequence is empty', isEmptyOutput('outreach_strategy', coerceStrategy({ sequence: [] })));
ok('an empty body is empty', isEmptyOutput('personalisation', coercePersonalisation({ body: '' })));
ok('a null intent is empty', isEmptyOutput('conversation', coerceConversation({ intent: null })));

/* ── schemas ──────────────────────────────────────────────────────────── */
group('Schemas');

for (const [name, spec] of Object.entries(AGENT_SCHEMAS)) {
  ok(`${name} declares required fields`, spec.requiredFields.length > 0);
  ok(`${name} has a coercer and a schema`, typeof spec.coerce === 'function' && spec.schema);
}
ok('the intent enum has all twelve values', INTENTS.length === 12);

/* ── local engine ─────────────────────────────────────────────────────── */
group('Local engine');

const CAMPAIGN = {
  icp_criteria: 'B2B SaaS companies with 50 to 2000 employees. Target the CTO.',
  exclusion_criteria: 'Consulting firms and agencies. Any organisation outside the United States.',
  target_roles: ['CTO', 'VP Engineering'],
  industry: 'B2B SaaS',
  company_size: '50-2000',
};

const profileOf = (over = {}) => ({
  person: { full_name: 'A B', title: 'Chief Technology Officer', seniority: 'C-Level', ...over.person },
  company: { name: 'Acme', industry: 'B2B SaaS', employee_count: 300, ...over.company },
  signals: { recent_news: 'Raised a Series B', ...over.signals },
});

const icp = (over) => runLocalEngine('icp_fitment', { enriched_profile: profileOf(over), campaign: CAMPAIGN });

ok('a clean fit qualifies', icp().verdict === 'qualify', JSON.stringify(icp().fit_score));
ok('a full title matches an abbreviated target role', icp().dimension_scores.role.score === 100);
ok('an out-of-band headcount scores zero',
  icp({ company: { employee_count: 9000 } }).dimension_scores.company_size.score === 0);
ok('a perfect role cannot carry an out-of-band company to qualify',
  icp({ company: { employee_count: 9000 } }).verdict !== 'qualify');
ok('an in-band company with a perfect role does qualify', icp().verdict === 'qualify');
ok('an excluded industry is rejected at zero',
  icp({ company: { industry: 'Management Consulting' } }).verdict === 'reject');
ok('a geographic exclusion does not reject a matching prospect',
  icp().disqualifiers.length === 0);
ok('a profile with no title goes to review, not reject',
  icp({ person: { title: null, seniority: null } }).verdict === 'needs_review');
ok('missing firmographics lower confidence rather than forcing review',
  icp({ company: { industry: null } }).verdict === 'qualify');

ok('an open-ended size band is understood',
  runLocalEngine('icp_fitment', {
    enriched_profile: profileOf({ company: { employee_count: 12000, industry: 'Banking' } }),
    campaign: { ...CAMPAIGN, industry: 'Banking', company_size: '1000+', exclusion_criteria: 'Cooperative banks.' },
  }).dimension_scores.company_size.score === 100);

ok('an industry given as text, not an array, does not throw',
  typeof icp().fit_score === 'number');

const strategy = (policy) => runLocalEngine('outreach_strategy', {
  enriched_profile: profileOf(),
  icp_result: { verdict: 'qualify', fit_score: 80, confidence: 'high' },
  campaign: { ...CAMPAIGN, enabled_channels: ['email', 'linkedin'], outreach_policy: policy },
  contact_history: [],
});

ok('a stated touch count is respected', strategy('Two touches over seven days.').sequence.length === 2);
ok('a written number is respected', strategy('Three touches over nine days.').sequence.length === 3);
ok('no stated count falls back to priority', strategy('Keep it short.').sequence.length >= 3);
ok('a rejected prospect is never sequenced',
  runLocalEngine('outreach_strategy', {
    enriched_profile: profileOf(),
    icp_result: { verdict: 'reject', fit_score: 0 },
    campaign: { ...CAMPAIGN, enabled_channels: ['email'] },
  }).should_contact === false);

const email = runLocalEngine('personalisation', {
  enriched_profile: profileOf(),
  current_step: { step: 1, channel: 'email', angle: 'open on the funding', goal: 'earn a reply' },
  retrieved_knowledge: [{ title: 'Case study', content: 'Reply rate went from 2.1 percent to 6.4 percent over eleven weeks. That is the change.' }],
  rep: { identity: 'Nishu' },
});

ok('a message is written when there is a signal', email.needs_human === false && email.body.length > 0);
ok('the subject is not the internal angle', !email.subject.toLowerCase().includes('open on the'));
ok('a quoted case study is not cut mid-number', !/2\.$/.test(email.body.split('\n')[2] ?? ''));
ok('a decimal does not end a quoted sentence', !email.body.includes('from 2. '));
ok('no signal means no message',
  runLocalEngine('personalisation', {
    enriched_profile: { person: { full_name: 'A B', title: 'CTO' }, company: { name: 'Acme' }, signals: {} },
    current_step: { step: 1, channel: 'email' },
    retrieved_knowledge: [],
    rep: { identity: 'Nishu' },
  }).needs_human === true);

const reply = (text) => runLocalEngine('conversation', { message: text });

ok('an opt-out is caught', reply('Please take me off your list.').intent === 'opt_out');
ok('a polite opt-out is still an opt-out', reply('Thanks but please unsubscribe me.').intent === 'opt_out');
ok('a meeting request is caught', reply('Can we book 15 minutes on Tuesday?').intent === 'meeting_request');
ok('pricing routes to a human', reply('Looks good. What does pricing look like?').requires_human === true);
ok('a security review routes to a human', reply('Send it to our infosec team for security review.').requires_human === true);
ok('procurement routes to a human', reply('Our procurement process needs an MSA first.').requires_human === true);
ok('a plain question does not need a human', reply('How does the research step work?').requires_human === false);
ok('an out of office is not a human reply', reply('I am out of office until Monday.').is_human_reply === false);


/* ── key pool ─────────────────────────────────────────────────────────── */
group('Key pool');

resetPools();
registerKeys('groq', [
  'gsk_key_one_aaaaaaaa', 'gsk_key_two_bbbbbbbb', 'gsk_key_one_aaaaaaaa',
  'gsk_key_three_cccccc', 'gsk_key_four_dddddd', 'gsk_key_five_eeeeee',
  'gsk_key_six_ffffff', 'gsk_key_seven_gggggg',
]);

ok('six keys is the ceiling', keyCount('groq') === MAX_KEYS_PER_PROVIDER);
ok('a key listed twice counts once',
  !keyHealth().find((p) => p.provider === 'groq').keys.some((k, i, all) =>
    all.findIndex((o) => o.label === k.label) !== i));
ok('no whole key ever leaves the pool',
  JSON.stringify(keyHealth()).includes('gsk_ke') &&
  !JSON.stringify(keyHealth()).includes('gsk_key_one_aaaaaaaa'));

resetPools();
registerKeys('groq', ['gsk_alpha_11111111', 'gsk_bravo_22222222', 'gsk_charlie_33333']);

const leased = [leaseKey('groq'), leaseKey('groq'), leaseKey('groq')].map((k) => k.label);
ok('leases rotate rather than reusing one key',
  new Set(leased).size === 3, leased.join(', '));
ok('a fourth lease comes back round to the first', leaseKey('groq').label === leased[0]);

resetPools();
registerKeys('groq', ['gsk_alpha_11111111', 'gsk_bravo_22222222']);
const first = leaseKey('groq');
reportFailure(first, { kind: 'rate_limited', message: '429' });
ok('a rate-limited key is benched', poolStatus('groq').cooling === 1);
ok('the next lease skips the benched key', leaseKey('groq').label !== first.label);

const dead = leaseKey('groq');
reportFailure(dead, { kind: 'invalid_key', message: '401' });
ok('a rejected key is disabled, not merely cooled', poolStatus('groq').disabled === 1);
ok('with every key out, leasing returns nothing rather than a bad key',
  leaseKey('groq') === null);
ok('the pool says when a key comes back', poolStatus('groq').next_available_at > Date.now());

ok('reviving puts a key back on the rota',
  reviveKey('groq', 2).state === 'healthy' && leaseKey('groq') !== null);

resetPools();
registerKeys('gemini', ['AIza_only_one_key_here']);
const solo = leaseKey('gemini');
reportFailure(solo, { kind: 'bad_request', message: '400 malformed' });
ok('a malformed request is not counted against the key',
  poolStatus('gemini').healthy === 1 && solo.failed === 0);
reportSuccess(solo, 240);
ok('a success clears the consecutive failure count', solo.consecutive_failures === 0);

// A retired model name used to bench the key it was tried on. With one key
// configured that took the only key out of service, and the retry on the
// fallback model then failed with "every key is cooling down" — sending you
// to look at your keys for a problem that was one wrong model string.
reportFailure(solo, { kind: 'model_not_found', message: '404 model decommissioned' });
ok('a wrong model name does not bench the key it was tried on',
  poolStatus('gemini').healthy === 1 && solo.state === 'healthy');
ok('the model error is still recorded against the key for display',
  solo.last_error_kind === 'model_not_found');
ok('success rate is measured over settled calls only',
  keyHealth().find((p) => p.provider === 'gemini').keys[0].success_rate === 100);

resetPools();

/* ── error classification ─────────────────────────────────────────────── */
group('Provider error classification');

ok('401 means the key is bad', classify(401) === 'invalid_key');
ok('403 means the key is bad', classify(403) === 'invalid_key');
ok('429 means slow down, not throw the key away', classify(429) === 'rate_limited');
ok('404 means the model name is wrong', classify(404) === 'model_not_found');
ok('a 400 naming the model is a model problem',
  classify(400, 'The model `llama-3.1-70b` has been decommissioned') === 'model_not_found');
ok('a plain 400 is our own malformed request', classify(400, 'invalid json body') === 'bad_request');
ok('a 503 is the provider having a bad day', classify(503) === 'server_error');

/* ── Apollo ───────────────────────────────────────────────────────────── */
group('Apollo');

ok('a locked email is never stored as an address',
  unlockedEmail('email_not_unlocked@domain.com') === null);
ok('the bare placeholder domain is rejected too',
  unlockedEmail('anything@domain.com') === null);
ok('a real address survives', unlockedEmail('ayush@arrivio.global') === 'ayush@arrivio.global');
ok('a locked person is marked locked, not emailable',
  mapPerson({ email: 'email_not_unlocked@domain.com', title: 'CTO', organization: { name: 'Acme' } })
    .email_status === 'locked');
ok('a person with a locked email still arrives with their company',
  mapPerson({ email: 'email_not_unlocked@domain.com', title: 'CTO', organization: { name: 'Acme' } })
    .company_name === 'Acme');
ok('a company URL becomes a bare domain',
  mapPerson({ title: 'CTO', organization: { name: 'Acme', website_url: 'https://www.acme.com/about' } })
    .company_domain === 'acme.com');

ok('a hyphenated band parses', employeeRange('50-2000')?.[0] === '50,2000');
ok('a written band parses', employeeRange('50 to 2000')?.[0] === '50,2000');
ok('thousands separators do not break it', employeeRange('1,001-5,000')?.[0] === '1001,5000');
ok('an open-ended band parses', employeeRange('500+')?.[0] === '500,1000000');
ok('an empty band is no filter at all', employeeRange('') === null);

const filters = buildSearchFilters(
  { target_roles: ['CTO'], industry: 'B2B SaaS', company_size: '50-2000' },
  { locations: ['United States'] }
);
ok('campaign roles become person titles', filters.person_titles?.[0] === 'CTO');
ok('the headcount band reaches Apollo', filters.organization_num_employees_ranges?.[0] === '50,2000');
ok('an override beats the campaign value',
  buildSearchFilters({ target_roles: ['CTO'] }, { titles: ['VP Sales'] }).person_titles[0] === 'VP Sales');
ok('per_page is capped at Apollo’s limit',
  buildSearchFilters({ target_roles: ['CTO'] }, { per_page: 500 }).per_page === 100);

/* ── discovery output ─────────────────────────────────────────────────── */
group('Discovery');

const coerceDiscovery = AGENT_SCHEMAS.discovery.coerce;

const discovered = coerceDiscovery({
  candidates: [
    { company: 'Acme Ltd', website: 'https://www.acme.io/careers', role: 'CTO', confidence: 'High' },
    { company_name: 'Globex', title: 'VP Engineering', full_name: 'the CTO of Globex' },
    { company_name: 'NoRole' },
    { company_name: 'Initech', title: 'CTO', full_name: 'Priya Raman', employee_count: '250' },
  ],
  reasoning: 'matched on industry',
});

ok('alternate field names are understood', discovered.candidates[0].company_name === 'Acme Ltd');
ok('a website becomes a bare domain', discovered.candidates[0].company_domain === 'acme.io');
ok('confidence casing is normalised', discovered.candidates[0].confidence === 'high');
ok('a description dressed up as a name is dropped',
  discovered.candidates[1].full_name === null);
ok('a real-looking name is kept', discovered.candidates[2].full_name === 'Priya Raman');
ok('a role description is never mistaken for a name',
  personName('the CTO of Globex') === null && personName('Head of Engineering') === null);
ok('a single word is not a name', personName('Priya') === null);
ok('a name with a particle survives', personName('Ludwig van Beethoven') === 'Ludwig van Beethoven');
ok('a hyphenated name survives', personName('Jean-Luc Picard') === 'Jean-Luc Picard');
ok('an all-lowercase string is not a name', personName('someone at acme') === null);
ok('a candidate with no role is not a candidate', discovered.candidates.length === 3);
ok('a headcount given as a string becomes a number',
  discovered.candidates[2].company_employee_count === 250);
ok('an empty candidate list fails rather than writing nothing',
  isEmptyOutput('discovery', coerceDiscovery({ candidates: [] })) === true);
ok('discovery has no local engine, on purpose', (() => {
  try {
    runLocalEngine('discovery', {});
    return false;
  } catch (err) {
    return /no offline fallback/i.test(err.message);
  }
})());

/* ── jobs ─────────────────────────────────────────────────────────────── */
group('Jobs');

let eventJob = { events: [] };
for (let i = 0; i < 80; i += 1) eventJob = { events: appendEvent(eventJob, { message: `step ${i}` }) };
ok('the event log is bounded', eventJob.events.length === 60);
ok('the newest events are the ones kept',
  eventJob.events[eventJob.events.length - 1].message === 'step 79');
ok('an event carries a timestamp', Boolean(eventJob.events[0].at));
ok('a job with no events yet does not throw',
  appendEvent({}, { message: 'first' }).length === 1);

/* ── campaign readiness ───────────────────────────────────────────────── */
group('Campaign readiness');

const bare = readiness({ name: 'Untitled', enabled_channels: [] });
ok('a campaign with no ICP cannot go live', bare.ready === false);
ok('the missing ICP is named, not just counted',
  bare.blockers.some((b) => b.field === 'icp_criteria'));
ok('no channel is also a blocker', bare.blockers.some((b) => b.field === 'enabled_channels'));

const workable = readiness({
  name: 'US SaaS CTOs',
  icp_criteria: 'B2B SaaS, 50 to 2000 people, target the CTO.',
  enabled_channels: ['email'],
});
ok('an ICP and a channel are enough to go live', workable.ready === true);
ok('missing nice-to-haves are warnings, not blockers',
  workable.warnings.length > 0 && workable.blockers.length === 0);
ok('a campaign with no target roles is warned that discovery has nothing to search for',
  workable.warnings.some((w) => w.field === 'target_roles'));


/* ── summary ──────────────────────────────────────────────────────────── */
console.log('\n' + '─'.repeat(62));
if (fail === 0) console.log(`\x1b[32mAll ${pass} checks passed.\x1b[0m`);
else console.log(`\x1b[31m${fail} of ${pass + fail} checks failed.\x1b[0m`);
console.log('─'.repeat(62));

process.exit(fail === 0 ? 0 : 1);
