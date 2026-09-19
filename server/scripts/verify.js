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
} from '../src/agents/schemas.js';
import { unwrapEnvelope, isAsyncAcknowledgement, parseLooseJson } from '../src/agents/dronahq.js';
import { runLocalEngine } from '../src/agents/localEngine.js';
import { AGENT_REGISTRY, getAgent, PIPELINE } from '../src/agents/registry.js';
import { envNamesFor, DRONAHQ_AGENTS } from '../src/config.js';

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
ok('every callable dronahq agent has env names',
  AGENT_REGISTRY.filter((a) => a.callable && a.engine === 'dronahq').every((a) => envNamesFor(a.id)));
ok('env names match the config keys',
  Object.keys(DRONAHQ_AGENTS).every((id) => envNamesFor(id) !== null));
ok('icp_fitment reads DRONAHQ_ICP_URL, not DRONAHQ_ICP_FITMENT_URL',
  envNamesFor('icp_fitment').url === 'DRONAHQ_ICP_URL');
ok('outreach_strategy reads DRONAHQ_STRATEGY_URL',
  envNamesFor('outreach_strategy').url === 'DRONAHQ_STRATEGY_URL');
ok('voice is registered but not callable', getAgent('voice_sdr').callable === false);

/* ── envelopes ────────────────────────────────────────────────────────── */
group('DronaHQ envelopes');

const CORE = { verdict: 'qualify', fit_score: 80 };

ok('bare object', unwrapEnvelope(CORE).verdict === 'qualify');
ok('response wrapper', unwrapEnvelope({ response: CORE }).verdict === 'qualify');
ok('data wrapper', unwrapEnvelope({ data: CORE }).verdict === 'qualify');
ok('output wrapper', unwrapEnvelope({ output: CORE }).verdict === 'qualify');
ok('result wrapper', unwrapEnvelope({ result: CORE }).verdict === 'qualify');
ok('nested wrappers', unwrapEnvelope({ data: { output: CORE } }).verdict === 'qualify');
ok('stringified json', unwrapEnvelope({ response: JSON.stringify(CORE) }).verdict === 'qualify');
ok('markdown fenced json',
  unwrapEnvelope({ output: '```json\n' + JSON.stringify(CORE) + '\n```' }).verdict === 'qualify');
ok('single-element array', unwrapEnvelope([CORE]).verdict === 'qualify');
ok('prose around json',
  unwrapEnvelope({ message: `Here you go: ${JSON.stringify(CORE)} hope that helps` })?.verdict === 'qualify');
ok('loose json parses a fenced body', parseLooseJson('```\n{"a":1}\n```')?.a === 1);

ok('background acknowledgement is detected',
  isAsyncAcknowledgement({ run_id: 'r1', thread_id: 't1' }));
ok('camelCase acknowledgement is detected',
  isAsyncAcknowledgement({ runId: 'r1', threadId: 't1' }));
ok('a run id alongside real output is not an acknowledgement',
  !isAsyncAcknowledgement({ run_id: 'r1', response: CORE }));
ok('real output is not an acknowledgement', !isAsyncAcknowledgement(CORE));

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

/* ── summary ──────────────────────────────────────────────────────────── */
console.log('\n' + '─'.repeat(62));
if (fail === 0) console.log(`\x1b[32mAll ${pass} checks passed.\x1b[0m`);
else console.log(`\x1b[31m${fail} of ${pass + fail} checks failed.\x1b[0m`);
console.log('─'.repeat(62));

process.exit(fail === 0 ? 0 : 1);
