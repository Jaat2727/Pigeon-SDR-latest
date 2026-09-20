/**
 * Local engine — the deterministic fallback that runs when the LLM engine
 * (Groq/Gemini) is not configured for an agent, times out, errors, or
 * returns a response whose load-bearing fields are all null.
 *
 * Its job is to keep the pipeline moving and to make the failure visible rather
 * than silent. Three rules hold throughout:
 *
 *   1. It never invents facts about a prospect. It only reasons over values
 *      already present in the database row or already returned by research.
 *   2. Every run it produces is written to `agent_runs` with
 *      engine = 'local_engine', so the UI shows which engine decided what and a
 *      reviewer can tell a model decision from a rule decision.
 *   3. When it cannot decide with the data it has, it returns needs_review or
 *      needs_human rather than guessing. An escalation is a correct answer.
 *
 * This is deliberately rule-based, not a second LLM. A rule that is wrong is
 * inspectable; a second model that is wrong is not.
 */

import {
  toStringOrNull,
  toNumberOrNull,
} from './schemas.js';

const SENIORITY_RANK = {
  'c-level': 5, cxo: 5, founder: 5, ceo: 5, cto: 5, cio: 5, cfo: 5, coo: 5, chief: 5,
  vp: 4, 'vice president': 4, svp: 4, evp: 4,
  director: 3, head: 3,
  manager: 2, lead: 2, principal: 2,
  senior: 1, staff: 1,
  ic: 0, engineer: 0, analyst: 0, associate: 0,
};

function seniorityScore(title, seniority) {
  const haystack = `${seniority || ''} ${title || ''}`.toLowerCase();
  let best = null;
  for (const [term, rank] of Object.entries(SENIORITY_RANK)) {
    if (haystack.includes(term)) best = best === null ? rank : Math.max(best, rank);
  }
  return best;
}

/**
 * Titles and the roles a campaign targets are rarely written the same way. A
 * campaign says "CIO"; the CRM says "Chief Information Officer". Substring
 * matching alone scored that person as a mismatch, which meant a CIO campaign
 * penalised actual CIOs. Both spellings are generated for every comparison.
 */
const ROLE_ALIASES = [
  ['cto', 'chief technology officer', 'chief technical officer'],
  ['cio', 'chief information officer'],
  ['ceo', 'chief executive officer'],
  ['cfo', 'chief financial officer'],
  ['coo', 'chief operating officer'],
  ['cmo', 'chief marketing officer'],
  ['cdo', 'chief digital officer', 'chief data officer'],
  ['ciso', 'chief information security officer'],
  ['vp', 'vice president'],
  ['svp', 'senior vice president'],
  ['evp', 'executive vice president'],
  ['avp', 'associate vice president'],
  ['hr', 'human resources'],
  ['eng', 'engineering'],
  ['ops', 'operations'],
  ['sre', 'site reliability engineering'],
];

/** Every way a role string might be written, lowercased. */
function roleVariants(text) {
  const base = String(text || '').toLowerCase().trim();
  if (!base) return [];
  const variants = new Set([base]);

  for (const group of ROLE_ALIASES) {
    for (const form of group) {
      if (!new RegExp(`\\b${form.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(base)) continue;
      for (const alt of group) {
        if (alt !== form) variants.add(base.replace(new RegExp(`\\b${form}\\b`, 'g'), alt));
      }
    }
  }

  return [...variants];
}

/**
 * True when a campaign's target role describes this title, comparing every
 * spelling of each. Falls back to requiring all words of the target to appear,
 * so "VP Engineering" matches "VP of Engineering".
 */
function roleMatches(title, seniority, targetRole) {
  const haystacks = [
    ...roleVariants(title),
    ...roleVariants(`${title || ''} ${seniority || ''}`),
  ];
  const needles = roleVariants(targetRole);

  return needles.some((needle) =>
    haystacks.some(
      (hay) =>
        hay.includes(needle) ||
        needle.split(/\s+/).filter((w) => w.length > 1).every((word) => hay.includes(word))
    )
  );
}

/**
 * Splits free-text criteria into comparable keyword tokens.
 *
 * The dot is kept inside a token so version numbers and domains survive
 * ("node.js", "2.1"), then trimmed from the ends. Without that trim, the last
 * word of every sentence carried its full stop: a campaign that said "target
 * the CTO." produced the term "cto.", which matches nothing, and a perfect
 * role match scored zero on ICP language.
 */
function keywords(text) {
  if (!text) return [];
  const flat = typeof text === 'string' ? text : JSON.stringify(text);
  return flat
    .toLowerCase()
    .split(/[^a-z0-9+#.]+/)
    .map((w) => w.replace(/^\.+|\.+$/g, ''))
    .filter((w) => w.length > 2 && !STOPWORDS.has(w));
}

const STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'must', 'have', 'has', 'are', 'not', 'any', 'all',
  'who', 'their', 'from', 'that', 'this', 'than', 'more', 'less', 'least', 'over',
  'under', 'between', 'company', 'companies', 'people', 'person', 'target', 'exclude',
  'excluding', 'including', 'include', 'should', 'would', 'been', 'was', 'were',
  // Qualifiers and connectors that carry no categorical meaning on their own.
  // Matching a prospect on one of these produces a false exclusion.
  'inside', 'outside', 'large', 'small', 'first', 'other', 'others', 'only',
  'within', 'across', 'about', 'above', 'below', 'where', 'which', 'while',
  'also', 'very', 'such', 'them', 'they', 'these', 'those', 'into', 'onto',
]);

/**
 * Turns free-text exclusion criteria into terms that can safely be matched
 * against a profile.
 *
 * Two things make a naive keyword match wrong here, and both were observed:
 *
 *   · A word can appear in the exclusions for grammatical reasons while also
 *     describing the target. "agencies that resell voice platforms" contains
 *     "voice", so matching single tokens rejected every voice AI company in a
 *     campaign whose whole ICP was voice AI companies. Any term that also
 *     appears in the ICP criteria carries no discriminating signal, so it is
 *     dropped.
 *   · Geographic negation inverts meaning. "any organisation outside India"
 *     contains "India", so matching it rejected precisely the Indian prospects
 *     the campaign was built for. Those clauses are removed; geography is
 *     scored as its own dimension rather than as a keyword.
 *
 * What survives is categorical: two-word phrases, and distinctive single words
 * of six characters or more.
 */
function exclusionTerms(exclusionText, icpText) {
  if (!exclusionText) return { phrases: [], words: [] };

  const raw = (typeof exclusionText === 'string' ? exclusionText : JSON.stringify(exclusionText)).toLowerCase();

  // Drop geographic negation clauses up to the next clause boundary.
  const cleaned = raw.replace(
    /\b(?:head(?:quartered|quarters)?\s+)?(?:outside|other than|not in|beyond)\s+(?:the\s+)?[^,.;]*/g,
    ' '
  );

  const icpSet = new Set(keywords(icpText));

  const clauses = cleaned.split(/[,.;]|\band\b|\bor\b/);
  const phrases = [];
  const words = new Set();

  for (const clause of clauses) {
    const tokens = clause
      .split(/[^a-z0-9+#]+/)
      .filter((w) => w.length > 2 && !STOPWORDS.has(w));

    for (let i = 0; i < tokens.length - 1; i += 1) {
      const bigram = `${tokens[i]} ${tokens[i + 1]}`;
      if (!icpSet.has(tokens[i]) || !icpSet.has(tokens[i + 1])) phrases.push(bigram);
    }

    for (const token of tokens) {
      if (token.length >= 6 && !icpSet.has(token)) words.add(token);
    }
  }

  return { phrases, words: [...words] };
}

function overlapRatio(needles, haystackText) {
  if (!needles.length) return 0;
  const hay = (haystackText || '').toLowerCase();
  const hits = needles.filter((n) => hay.includes(n));
  return hits.length / needles.length;
}

function flattenProfile(profile) {
  if (!profile) return '';
  try {
    return JSON.stringify(profile).toLowerCase();
  } catch {
    return '';
  }
}

/* ── Agent 1 · ICP fitment ──────────────────────────────────────────── */

export function localIcpFitment({ enriched_profile, campaign }) {
  const profile = enriched_profile || {};
  const person = profile.person || profile;
  const company = profile.company || {};
  const flat = flattenProfile(profile);

  const missing = [];
  const title = toStringOrNull(person.title);
  const seniority = toStringOrNull(person.seniority);
  const companyName = toStringOrNull(company.name ?? person.company_name);
  const industry = toStringOrNull(company.industry);
  const headcount = toNumberOrNull(company.employee_count);

  if (!title) missing.push('title');
  if (!seniority) missing.push('seniority');
  if (!companyName) missing.push('company');
  if (!industry) missing.push('industry');
  if (headcount === null) missing.push('employee_count');

  // Exclusions are checked first and are absolute, exactly as the brief
  // requires: one hit is an immediate reject at score 0, whatever the rest of
  // the profile looks like.
  const exclusions = exclusionTerms(campaign?.exclusion_criteria, campaign?.icp_criteria);
  const disqualifiers = [
    ...exclusions.phrases.filter((p) => flat.includes(p)),
    ...exclusions.words.filter((w) => flat.includes(w)),
  ];

  if (disqualifiers.length > 0) {
    return {
      fit_score: 0,
      verdict: 'reject',
      confidence: 'high',
      dimension_scores: { exclusion: { score: 0, evidence: disqualifiers.join(', ') } },
      reasoning:
        `Matched this campaign's exclusion criteria on: ${disqualifiers.join(', ')}. ` +
        'Exclusions are evaluated before any scoring and override every other signal, ' +
        'so no fit score was calculated.',
      disqualifiers,
      missing_data: missing,
    };
  }

  // Not enough data to judge is its own answer, not a low score.
  if (missing.length >= 4) {
    return {
      fit_score: 0,
      verdict: 'needs_review',
      confidence: 'low',
      dimension_scores: null,
      reasoning:
        `Scoring was not attempted: ${missing.join(', ')} are all absent from the ` +
        'enriched profile. A score built on this little data would not be meaningful, ' +
        'so this prospect is routed to human review instead.',
      disqualifiers: [],
      missing_data: missing,
    };
  }

  const icpTerms = keywords(campaign?.icp_criteria);

  // These arrive as an array (target_roles is jsonb), as a single string
  // (industry is text), as a comma-separated string from a hand-edited
  // campaign, or as null. Treating a string as an array is how this scorer
  // used to throw and take the whole ICP step down with it.
  const asTerms = (value) => {
    if (value === null || value === undefined) return [];
    const items = Array.isArray(value) ? value : String(value).split(/[,;|/]/);
    return items.map((r) => String(r).trim().toLowerCase()).filter(Boolean);
  };

  const roleTerms = asTerms(campaign?.target_roles);
  const industryTerms = asTerms(campaign?.industry);

  const dimensions = {};

  // Role match. A literal match against a target role scores full marks; with
  // no literal match the seniority rank still counts, so a C-level prospect is
  // never scored as if they were junior just because their title is worded
  // differently from the campaign's target list.
  const rank = seniorityScore(title, seniority);
  const seniorityDerived = rank === null ? 50 : Math.min(100, 40 + rank * 12);
  const roleHit = roleTerms.length ? roleTerms.some((r) => roleMatches(title, seniority, r)) : null;

  const roleScore =
    roleHit === true ? 100 : roleHit === false ? Math.min(70, seniorityDerived) : seniorityDerived;

  dimensions.role = {
    score: roleScore,
    evidence: title
      ? roleHit === true
        ? `Title "${title}" matches a target role for this campaign`
        : `Title "${title}"${seniority ? ` (${seniority})` : ''} is not on the target list; scored on seniority`
      : 'No title on record',
  };

  // Industry match
  const industryHay = `${industry || ''} ${company.sub_industry || ''} ${company.description || ''}`.toLowerCase();

  // Three outcomes, not two. A prospect whose industry is unknown is scored
  // neutrally; only a prospect whose industry is known and wrong is penalised.
  // Treating an absent field as a mismatch punishes a thin record exactly as
  // hard as a bad fit, which is the opposite of what the three-state verdict
  // exists to prevent.
  const industryHit = !industryTerms.length || !industry
    ? null
    : industryTerms.some((t) => industryHay.includes(t));

  const industryScore = industryHit === true ? 100 : industryHit === false ? 30 : 50;
  dimensions.industry = {
    score: industryScore,
    evidence: industry ? `Industry: ${industry}` : 'No industry on record',
  };

  // Company size band, read out of the campaign's free-text size range.
  //
  // Three shapes, because operators write all three: "50-2000", "1000+" and
  // "under 500". A band that only understood the first silently scored every
  // open-ended campaign at the neutral default, which made headcount a
  // dimension that looked considered and was not.
  let sizeScore = 50;
  let sizeEvidence = headcount === null ? 'Headcount unknown' : `Headcount: ${headcount}`;

  const sizeText = String(campaign?.company_size || '');
  const num = (s) => parseInt(String(s).replace(/,/g, ''), 10);

  let lo = null;
  let hi = null;
  let bandLabel = null;

  const range = sizeText.match(/(\d[\d,]*)\s*(?:[-–—]|to)\s*(\d[\d,]*)/i);
  const atLeast = sizeText.match(/(?:^|\s)(\d[\d,]*)\s*\+/) || sizeText.match(/(?:over|above|more than|at least)\s+(\d[\d,]*)/i);
  const atMost = sizeText.match(/(?:under|below|fewer than|less than|up to)\s+(\d[\d,]*)/i);

  if (range) {
    lo = num(range[1]);
    hi = num(range[2]);
    bandLabel = `${lo}-${hi}`;
  } else if (atLeast) {
    lo = num(atLeast[1]);
    bandLabel = `${lo} or more`;
  } else if (atMost) {
    hi = num(atMost[1]);
    bandLabel = `up to ${hi}`;
  }

  let outOfBand = false;

  if (headcount !== null && bandLabel) {
    const inside = (lo === null || headcount >= lo) && (hi === null || headcount <= hi);
    outOfBand = !inside;
    // Zero, not a low score. A campaign that writes "50 to 2000 employees"
    // is stating a boundary, not a preference, and a company outside it
    // should not be carried over the line by a strong title.
    sizeScore = inside ? 100 : 0;
    sizeEvidence = `Headcount ${headcount} is ${inside ? 'inside' : 'outside'} the target band ${bandLabel}`;
  }

  dimensions.company_size = { score: sizeScore, evidence: sizeEvidence };

  // Free-text ICP overlap. Deliberately a small share of the total: a
  // prospect who matches on role, industry and size is a good prospect even if
  // the campaign's prose happens to use different words from their CRM record.
  // Weighting it heavily made well-matched prospects fail on vocabulary.
  //
  // The haystack carries every spelling of the title, because a campaign that
  // writes "target the CTO" and a CRM that stores "Chief Technology Officer"
  // are describing the same person. Comparing the two literally scored a
  // perfect role match at zero on vocabulary, which was enough on its own to
  // push a clean qualify into the review queue.
  const icpHaystack = `${flat} ${roleVariants(title).join(' ')} ${roleVariants(`${title} ${seniority}`).join(' ')}`;
  const icpOverlap = overlapRatio(icpTerms, icpHaystack);
  dimensions.icp_language = {
    score: Math.round(icpOverlap * 100),
    evidence: icpTerms.length
      ? `${Math.round(icpOverlap * 100)}% of the campaign's ICP wording appears in the researched profile`
      : 'No free-text ICP criteria configured for this campaign',
  };

  // Buying signals
  const signals = profile.signals || {};
  const signalCount =
    (signals.intent_signals?.length || 0) +
    (signals.hiring_roles?.length || 0) +
    (signals.recent_news ? 1 : 0);
  dimensions.signals = {
    score: Math.min(100, signalCount * 25),
    evidence: signalCount ? `${signalCount} buying signal(s) detected` : 'No buying signals detected',
  };

  // Role dominates, then industry and size, which are the two facts a campaign
  // usually states as boundaries. Vocabulary overlap is the smallest share on
  // purpose: a prospect who matches on role, industry and size is a good
  // prospect even when the campaign's prose uses different words from their
  // CRM record, and weighting it heavily made well-matched prospects fail on
  // wording alone.
  const weights = { role: 0.35, industry: 0.2, company_size: 0.2, icp_language: 0.1, signals: 0.15 };
  const fitScore = Math.round(
    Object.entries(weights).reduce((sum, [k, w]) => sum + (dimensions[k]?.score ?? 50) * w, 0)
  );

  // A missing field caps confidence. It only forces needs_review when the
  // field is one the verdict actually turns on.
  //
  // Role carries 35 percent of the weight, so without a title there is no
  // score worth reporting and the honest answer is that a person should look.
  // Not knowing a company's funding stage is different: it lowers confidence
  // and says so, but a CTO at a company inside the target band is still a
  // qualify. An earlier version treated any two absent fields as grounds to
  // refuse a decision, which sent every prospect to the review queue and made
  // the three-state verdict useless.
  const DECISIVE = ['title', 'company'];
  const decisiveMissing = missing.filter((m) => DECISIVE.includes(m));

  const confidenceFor = () =>
    missing.length === 0 ? 'high' : missing.length <= 2 ? 'medium' : 'low';

  let verdict;
  let confidence;

  if (decisiveMissing.length > 0 || missing.length >= 4) {
    verdict = 'needs_review';
    confidence = 'low';
  } else if (outOfBand) {
    // A campaign that writes a headcount band is stating a boundary. A company
    // outside it is not automatically a reject, because an exception may be
    // worth making, but it is never an automatic qualify either. Scoring alone
    // could not express that: at 0.2 of the weight, a perfect title carried a
    // 9000-person company over the line by a single point.
    verdict = 'needs_review';
    confidence = 'medium';
  } else if (fitScore >= 65) {
    verdict = 'qualify';
    confidence = confidenceFor();
  } else if (fitScore < 45) {
    verdict = 'reject';
    confidence = confidenceFor();
  } else {
    verdict = 'needs_review';
    confidence = 'medium';
  }

  const topDimension = Object.entries(dimensions).sort((a, b) => b[1].score - a[1].score)[0];
  const weakDimension = Object.entries(dimensions).sort((a, b) => a[1].score - b[1].score)[0];

  return {
    fit_score: fitScore,
    verdict,
    confidence,
    dimension_scores: dimensions,
    reasoning:
      `Scored ${fitScore}/100 across role, industry, company size, ICP language and buying signals. ` +
      `Strongest dimension: ${topDimension[0]} (${topDimension[1].score}) — ${topDimension[1].evidence}. ` +
      `Weakest: ${weakDimension[0]} (${weakDimension[1].score}) — ${weakDimension[1].evidence}.` +
      (outOfBand
        ? ` Headcount ${headcount} is outside the campaign's stated band of ${bandLabel}, so this is sent for review rather than qualified automatically.`
        : '') +
      (missing.length
        ? ` ${missing.length} field(s) were absent from the profile (${missing.join(', ')}), which caps confidence at ${confidence}.`
        : ''),
    disqualifiers: [],
    missing_data: missing,
  };
}

/* ── Agent 2 · Research ─────────────────────────────────────────────── */

/**
 * The local engine cannot reach the open web, so it enriches only by
 * restructuring and deriving from the fields already on the prospect row.
 * Every field it could not fill is named in fields_not_found rather than
 * filled with a plausible-looking guess.
 */
export function localResearch({ stub }) {
  const s = stub || {};
  const fullName = [s.first_name, s.last_name].filter(Boolean).join(' ') || null;
  const title = toStringOrNull(s.title);
  const domain =
    toStringOrNull(s.company_domain) ||
    (toStringOrNull(s.email)?.includes('@') ? s.email.split('@')[1] : null);

  const derivedSeniority = (() => {
    const rank = seniorityScore(title, s.seniority);
    if (toStringOrNull(s.seniority)) return s.seniority;
    if (rank === null) return null;
    if (rank >= 5) return 'C-Level';
    if (rank === 4) return 'VP';
    if (rank === 3) return 'Director';
    if (rank === 2) return 'Manager';
    return 'Individual Contributor';
  })();

  const person = {
    full_name: fullName,
    title,
    seniority: derivedSeniority,
    department: toStringOrNull(s.department),
    location: toStringOrNull(s.location),
    timezone: toStringOrNull(s.timezone),
    linkedin_url: toStringOrNull(s.linkedin_url),
    email: toStringOrNull(s.email),
    email_status: toStringOrNull(s.email_status) || (s.email ? 'unverified' : null),
    phone: toStringOrNull(s.phone),
    phone_type: toStringOrNull(s.phone_type),
    tenure_months: toNumberOrNull(s.tenure_months),
    recent_activity: toStringOrNull(s.recent_activity),
    previous_companies: Array.isArray(s.previous_companies) ? s.previous_companies : [],
  };

  const company = {
    name: toStringOrNull(s.company_name),
    domain,
    industry: toStringOrNull(s.company_industry),
    sub_industry: toStringOrNull(s.company_sub_industry),
    employee_count: toNumberOrNull(s.company_employee_count),
    hq_location: toStringOrNull(s.company_hq),
    funding_stage: toStringOrNull(s.company_funding_stage),
    last_funding_date: toStringOrNull(s.company_last_funding_date),
    description: toStringOrNull(s.company_description),
  };

  const notFound = [];
  for (const [k, v] of Object.entries(person)) {
    if (v === null || (Array.isArray(v) && v.length === 0)) notFound.push(`person.${k}`);
  }
  for (const [k, v] of Object.entries(company)) {
    if (v === null) notFound.push(`company.${k}`);
  }

  return {
    person,
    company,
    signals: {
      tech_stack: Array.isArray(s.tech_stack) ? s.tech_stack : [],
      hiring_roles: Array.isArray(s.hiring_roles) ? s.hiring_roles : [],
      // `notes` is whatever the import carried: a line from the CRM, a note
      // the rep typed, a field a data provider filled. Carrying it forward is
      // not enrichment, it is refusing to throw away input the system was
      // handed. It stays attributed to the import in `sources`, so nothing
      // downstream can mistake it for something this engine found out.
      recent_news: toStringOrNull(s.recent_news) ?? toStringOrNull(s.notes),
      intent_signals: Array.isArray(s.intent_signals) ? s.intent_signals : [],
    },
    sources: ['internal_crm_record'],
    research_notes:
      'Enriched from the existing prospect record by the local engine. No external ' +
      'data source was queried, so any field absent from the CRM record is reported ' +
      'as not found rather than inferred.',
    confidence: notFound.length > 10 ? 'low' : notFound.length > 5 ? 'medium' : 'high',
    fields_not_found: notFound,
  };
}

/* ── Agent 3 · Outreach strategy ────────────────────────────────────── */

export function localOutreachStrategy({ enriched_profile, icp_result, campaign, contact_history }) {
  // `campaign` supplies enabled_channels below; the rest is read from icp_result.
  const profile = enriched_profile || {};
  const person = profile.person || profile;
  const icp = icp_result || {};
  const enabled = (campaign?.enabled_channels?.length ? campaign.enabled_channels : ['email']).filter(
    (c) => ['email', 'linkedin', 'sms', 'voice'].includes(c)
  );
  const channels = enabled.length ? enabled : ['email'];

  const history = Array.isArray(contact_history) ? contact_history : [];
  const escalations = [];

  if (icp.verdict === 'needs_review') escalations.push('ICP verdict is needs_review');
  if (icp.confidence === 'low') escalations.push('ICP confidence is low');
  if (!toStringOrNull(person.title)) escalations.push('prospect title is unknown');
  if (!toStringOrNull(person.seniority)) escalations.push('prospect seniority is unknown');
  if ((icp.fit_score ?? 0) >= 90) escalations.push('fit score is 90 or above, worth a human touch');
  if (toNumberOrNull(person.tenure_months) !== null && person.tenure_months < 1) {
    escalations.push('prospect has been in role under one month');
  }
  const negativeNews = /layoff|acquisition|acquired|lawsuit|litigation|bankrupt|shut down/i.test(
    profile?.signals?.recent_news || ''
  );
  if (negativeNews) escalations.push('recent company news is negative');
  if (history.some((h) => ['opt_out', 'not_interested'].includes(h?.intent))) {
    escalations.push('prospect previously responded negatively or opted out');
  }

  if (icp.verdict === 'reject') {
    return {
      should_contact: false,
      no_contact_reason: `ICP verdict is reject (score ${icp.fit_score ?? 0}). No outreach is planned.`,
      priority: 'low',
      sequence: [],
      stop_conditions: [],
      escalate_to_human: false,
      escalation_reason: null,
      reasoning: 'Rejected prospects are never sequenced. The gate is enforced before planning, not after.',
    };
  }

  const priority = (icp.fit_score ?? 50) >= 80 ? 'high' : (icp.fit_score ?? 50) >= 60 ? 'medium' : 'low';

  // Three to five touches, alternating across the enabled channels, never
  // opening on voice.
  const nonVoice = channels.filter((c) => c !== 'voice');
  const openers = nonVoice.length ? nonVoice : ['email'];

  // The campaign's own policy decides the length when it states one. An
  // operator who wrote "two touches over seven days" and then watched four go
  // out has learned that the policy field is decoration, and will stop
  // writing anything in it.
  const WORD_NUMBERS = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6 };
  const policyText = String(campaign?.outreach_policy || '').toLowerCase();
  const stated = policyText.match(
    /(\d+|one|two|three|four|five|six)\s*(?:-|\s)?\s*(?:touch|touches|step|steps|email|emails|message|messages)/
  );

  const statedCount = stated
    ? WORD_NUMBERS[stated[1]] ?? parseInt(stated[1], 10)
    : null;

  const touchCount = Number.isFinite(statedCount) && statedCount >= 1 && statedCount <= 6
    ? statedCount
    : priority === 'high'
      ? 5
      : priority === 'medium'
        ? 4
        : 3;

  const angles = [
    { angle: 'Open on the strongest signal found in research', goal: 'earn a reply' },
    { angle: 'Share a relevant customer outcome', goal: 'establish relevance' },
    { angle: 'Ask a specific question about their current approach', goal: 'start a conversation' },
    { angle: 'Offer a concrete next step with a time box', goal: 'book a meeting' },
    { angle: 'Short break-up note leaving the door open', goal: 'close the loop cleanly' },
  ];

  const signalUsed =
    profile?.signals?.intent_signals?.[0] ||
    profile?.signals?.recent_news ||
    profile?.signals?.hiring_roles?.[0] ||
    (profile?.company?.funding_stage ? `funding stage ${profile.company.funding_stage}` : null);

  const sequence = Array.from({ length: touchCount }, (_, i) => ({
    step: i + 1,
    channel: i === 0 ? openers[0] : channels[i % channels.length],
    day_offset: [0, 3, 7, 12, 18][i],
    send_window: '09:00-17:00',
    angle: angles[i].angle,
    signal_used: i === 0 ? signalUsed : null,
    goal: angles[i].goal,
  }));

  if (sequence.length > 5) escalations.push('plan requires more than five touches');

  return {
    should_contact: true,
    no_contact_reason: null,
    priority,
    sequence,
    stop_conditions: [
      'prospect replies with any intent',
      'prospect opts out',
      'email hard bounces',
      'campaign is paused',
    ],
    escalate_to_human: escalations.length > 0,
    escalation_reason: escalations.length ? escalations.join('; ') : null,
    reasoning:
      `Planned ${touchCount} touches across ${channels.join(', ')} at ${priority} priority based on ` +
      `an ICP score of ${icp.fit_score ?? 'unknown'}. Day offsets widen as the sequence progresses so ` +
      'later touches are spaced further apart. Voice is never used as a first touch.',
  };
}

/* ── Agent 4 · Personalisation ──────────────────────────────────────── */

// Tone and length live in the per-agent prompt rather than the campaign policy
// object, so this signature does not read `campaign`.
export function localPersonalisation({ enriched_profile, current_step, retrieved_knowledge, rep }) {
  const profile = enriched_profile || {};
  const person = profile.person || profile;
  const company = profile.company || {};
  const step = current_step || {};
  const channel = step.channel || 'email';
  const knowledge = Array.isArray(retrieved_knowledge) ? retrieved_knowledge : [];

  const firstName = (toStringOrNull(person.full_name) || '').split(' ')[0] || null;
  const companyName = toStringOrNull(company.name);
  const title = toStringOrNull(person.title);

  // The rule that keeps this honest: with nothing specific to say about the
  // prospect, it refuses to write filler and hands the message to a human.
  const personalisationFacts = [];
  if (profile?.signals?.recent_news) {
    personalisationFacts.push({ claim: profile.signals.recent_news, source_field: 'signals.recent_news' });
  }
  if (profile?.signals?.hiring_roles?.length) {
    personalisationFacts.push({
      claim: `hiring for ${profile.signals.hiring_roles.slice(0, 2).join(' and ')}`,
      source_field: 'signals.hiring_roles',
    });
  }
  if (profile?.signals?.tech_stack?.length) {
    personalisationFacts.push({
      claim: `running ${profile.signals.tech_stack.slice(0, 2).join(' and ')}`,
      source_field: 'signals.tech_stack',
    });
  }
  if (company.funding_stage) {
    personalisationFacts.push({ claim: `${company.funding_stage} stage`, source_field: 'company.funding_stage' });
  }

  if (!firstName || !companyName || personalisationFacts.length === 0) {
    const gaps = [];
    if (!firstName) gaps.push('first name');
    if (!companyName) gaps.push('company name');
    if (personalisationFacts.length === 0) gaps.push('any specific signal to reference');
    return {
      channel,
      subject: null,
      body: '',
      word_count: 0,
      personalisation_used: [],
      knowledge_used: [],
      cta: null,
      needs_human: true,
      needs_human_reason:
        `Not enough researched context to write a message worth sending — missing ${gaps.join(', ')}. ` +
        'Writing generic filler would waste the touch, so this is routed to a human instead.',
      reasoning:
        'The personalisation agent will not produce a message it cannot ground in a real profile field.',
    };
  }

  /**
   * A knowledge chunk cut at a fixed character count lands mid-word, and a
   * sentence that stops at "spent roughly nin" is worse than no sentence.
   * Take whole sentences up to the budget, and nothing if the first one does
   * not fit.
   */
  const firstSentences = (text, budget = 180) => {
    const clean = String(text || '').replace(/\s+/g, ' ').trim();
    if (!clean) return '';
    // The lookahead is what stops "2.1 percent" being read as the end of a
    // sentence, which truncated a case study at "went from 2." and quoted a
    // number that was not the number.
    const sentences = clean.match(/[^.!?]+[.!?]+(?=\s|$)/g) ?? [clean];
    let out = '';
    for (const s of sentences) {
      if ((out + s).length > budget) break;
      out += s;
    }
    return out.trim();
  };

  const knowledgeUsed = knowledge.slice(0, 2).map((k) => ({
    claim: firstSentences(k.content, 200),
    source: k.title || k.type || 'knowledge_base',
  }));

  /**
   * A signal is a sentence ("Announced a $40M Series B in March"), a fragment
   * ("hiring for X"), or a label ("Series B stage"). Only the fragment reads
   * correctly after "is", so the sentence form gets its own line and the rest
   * gets joined. Gluing all three onto "is" produced "Northwind Data is
   * Announced a $40M Series B", which is the kind of sentence that tells a
   * reader in four words that nobody wrote this.
   */
  const lead = personalisationFacts[0];
  const leadClaim = String(lead.claim).trim();
  const leadIsSentence = /^[A-Z]/.test(leadClaim) && /[.!?]$/.test(leadClaim);
  const observation = leadIsSentence
    ? `${companyName}: ${leadClaim}`
    : `Saw that ${companyName} is ${leadClaim}.`;

  const repName = rep?.full_name || rep?.identity || 'the team';
  const cta =
    step.goal === 'book a meeting'
      ? 'Would 15 minutes on Tuesday or Thursday work?'
      : 'Worth a short conversation?';

  let subject = null;
  let body;

  if (channel === 'email') {
    // The step angle is an internal instruction to the writer, not a subject
    // line. Putting it in the header shipped "open on the strongest signal
    // found in research" to the prospect.
    subject = companyName
      ? `Quick question about ${companyName}`.slice(0, 78)
      : 'Quick question';

    const supporting = knowledgeUsed[0]?.claim ? `${knowledgeUsed[0].claim}\n\n` : '';

    body =
      `Hi ${firstName},\n\n` +
      `${observation}\n\n` +
      supporting +
      `Given your role as ${title || 'a leader there'}, this may be relevant to how your team is set up right now.\n\n` +
      `${cta}\n\n` +
      `Best,\n${repName}`;
  } else if (channel === 'linkedin') {
    body =
      `Hi ${firstName} — ${leadIsSentence ? leadClaim : `noticed ${companyName} is ${leadClaim}.`} ` +
      `Working with a few ${company.industry || 'similar'} teams on exactly this. ${cta}`;
  } else if (channel === 'sms') {
    body = `Hi ${firstName}, ${repName} here re: ${companyName}. ${cta} Reply STOP to opt out.`;
  } else {
    body =
      `Call opener for ${firstName} at ${companyName}: reference that ${leadClaim} ` +
      `confirm their role as ${title || 'unknown'}, then ask about their current approach. ${cta}`;
  }

  return {
    channel,
    subject,
    body,
    word_count: body.split(/\s+/).filter(Boolean).length,
    personalisation_used: personalisationFacts,
    knowledge_used: knowledgeUsed,
    cta,
    needs_human: false,
    needs_human_reason: null,
    reasoning:
      `Wrote one ${channel} message for step ${step.step ?? 1}, grounded in ` +
      `${personalisationFacts.length} researched field(s) and ${knowledgeUsed.length} knowledge chunk(s). ` +
      'No claim in the message is unsourced.',
  };
}

/* ── Agent 5 · Conversation ─────────────────────────────────────────── */

const INTENT_RULES = [
  // Opt-out is checked first and overrides every other reading.
  { intent: 'opt_out', sentiment: 'negative', re: /\b(unsubscribe|opt.?out|remove me|take me off|stop emailing|do not contact|don'?t contact)\b/i },
  { intent: 'bounce', sentiment: 'neutral', re: /\b(mailer-daemon|undeliverable|delivery (has )?failed|address not found|recipient rejected)\b/i },
  { intent: 'auto_reply', sentiment: 'neutral', re: /\b(out of (the )?office|ooo\b|on (annual |parental )?leave|auto(matic)?[- ]reply|away from my desk)\b/i },
  { intent: 'wrong_person', sentiment: 'neutral', re: /\b(wrong person|not (the )?right (person|contact)|no longer (with|at)|i (don'?t|do not) handle|not my (area|remit))\b/i },
  { intent: 'referral', sentiment: 'positive', re: /\b(loop in|speak (to|with)|reach out to|copying|cc'?ing|better (person|contact)|my colleague|talk to)\b/i },
  { intent: 'meeting_request', sentiment: 'positive', re: /\b(book|schedule|calendar|calendly|set up a (call|time|meeting)|next week works|how about (mon|tue|wed|thu|fri))\b/i },
  { intent: 'not_interested', sentiment: 'negative', re: /\b(not interested|no thanks|we'?re all set|already have|happy with our current|pass\b|not a fit)\b/i },
  { intent: 'not_now', sentiment: 'neutral', re: /\b(not (right )?now|circle back|later this|next (quarter|year)|q[1-4]\b|revisit|bad timing|busy right now)\b/i },
  { intent: 'objection', sentiment: 'negative', re: /\b(too expensive|budget|pricing is|concern|worried|security review|procurement|can'?t justify|why (should|would) we)\b/i },
  { intent: 'question', sentiment: 'neutral', re: /\b(how (does|do|much)|what (is|are|does)|can you (send|share|tell)|more (details|info)|pricing\?|\?)\b/i },
  { intent: 'interested', sentiment: 'positive', re: /\b(interested|sounds (good|interesting)|tell me more|keen|worth a (chat|look)|evaluating)\b/i },
];

// Classification is channel-agnostic: the same intent rules run over an email,
// an SMS or a call transcript, so only the message text is read.
export function localConversation({ message }) {
  const text = toStringOrNull(message) || '';
  const matches = INTENT_RULES.filter((rule) => rule.re.test(text));
  const top = matches[0] || null;

  const intent = top?.intent ?? 'unclear';
  const sentiment = top?.sentiment ?? 'neutral';

  // Confidence reflects how cleanly the text matched: one clear rule hit is
  // high, several competing hits is medium, nothing matched is low.
  const confidence = matches.length === 0 ? 0.3 : matches.length === 1 ? 0.85 : 0.6;

  const isAutomated = ['auto_reply', 'bounce'].includes(intent);

  const questions = text
    .split(/(?<=[.?!])\s+/)
    .filter((s) => s.trim().endsWith('?'))
    .map((s) => s.trim())
    .slice(0, 5);

  const objections = matches.filter((m) => m.intent === 'objection').length
    ? [text.slice(0, 200)]
    : [];

  let referral = null;
  if (intent === 'referral') {
    const nameMatch = text.match(/\b(?:speak|talk|reach out) (?:to|with) ([A-Z][a-z]+(?: [A-Z][a-z]+)?)/);
    const emailMatch = text.match(/[\w.+-]+@[\w-]+\.[\w.]+/);
    referral = { name: nameMatch?.[1] ?? null, contact: emailMatch?.[0] ?? null };
  }

  const ACTIONS = {
    opt_out: 'suppress_prospect',
    bounce: 'mark_email_invalid',
    auto_reply: 'reschedule_followup',
    wrong_person: 'escalate_to_human',
    referral: 'escalate_to_human',
    meeting_request: 'book_meeting',
    interested: 'reply_and_advance',
    question: 'reply_with_answer',
    objection: 'escalate_to_human',
    not_now: 'schedule_followup',
    not_interested: 'stop_sequence',
    unclear: 'escalate_to_human',
  };

  const DELAYS = { auto_reply: 7, not_now: 90, question: null, interested: null };

  /**
   * Subjects a person handles, whatever the intent says.
   *
   * A reply can be a perfectly cheerful meeting_request and still mention
   * pricing, a security review or a procurement process, and an autonomous
   * answer to any of those is how an outbound system creates a commercial or
   * legal problem. Intent decides what happens next; these decide who does it.
   */
  const SENSITIVE = [
    { re: /\b(pricing|price|cost|quote|how much|budget|discount|contract terms)\b/i, topic: 'pricing' },
    { re: /\b(security review|infosec|soc ?2|iso ?27001|pen ?test|vulnerability|data residency)\b/i, topic: 'security review' },
    { re: /\b(procurement|vendor onboarding|msa|dpa|legal|nda|terms and conditions)\b/i, topic: 'procurement or legal' },
    { re: /\b(gdpr|hipaa|rbi|irdai|sebi|compliance|audit|regulator)\b/i, topic: 'compliance' },
    { re: /\b(complaint|unacceptable|escalate|frustrat|angry|disappointed)\b/i, topic: 'a complaint' },
  ];

  const sensitiveHit = SENSITIVE.find((s) => s.re.test(text)) ?? null;

  const requiresHuman =
    ['objection', 'referral', 'wrong_person', 'unclear'].includes(intent) ||
    confidence < 0.5 ||
    sensitiveHit !== null;

  return {
    is_human_reply: !isAutomated,
    intent,
    intent_confidence: confidence,
    sentiment,
    extracted_facts: questions.map((q) => ({ fact: 'prospect asked a question', quote: q })),
    questions_asked: questions,
    objections_raised: objections,
    referral,
    recommended_action: ACTIONS[intent] ?? 'escalate_to_human',
    followup_delay_days: DELAYS[intent] ?? null,
    requires_human: requiresHuman,
    escalation_reason: requiresHuman
      ? sensitiveHit
        ? `The reply raises ${sensitiveHit.topic}, which is answered by a person rather than by an agent.`
        : intent === 'unclear'
          ? 'Reply did not match any known intent pattern with sufficient confidence.'
          : `Intent "${intent}" is one a human should handle rather than an autonomous reply.`
      : null,
    reasoning:
      matches.length === 0
        ? 'No intent pattern matched this reply, so it is classified as unclear and escalated rather than guessed.'
        : `Matched ${matches.length} intent pattern(s); highest-precedence match is "${intent}". ` +
          'Opt-out and delivery-failure patterns are evaluated before every other reading.',
  };
}

/* ── Agent 6 · Follow-up timing (always local by design) ────────────── */

export function localFollowupTiming({ sequence, current_step, last_touch_at, working_hours }) {
  const steps = Array.isArray(sequence) ? sequence : [];
  const idx = Number.isFinite(current_step) ? current_step : 0;
  const next = steps[idx + 1];

  if (!next) {
    return {
      should_continue: false,
      next_step: null,
      next_action_at: null,
      reasoning: `Sequence is complete after ${steps.length} touch(es). No further outreach is scheduled.`,
    };
  }

  const base = last_touch_at ? new Date(last_touch_at) : new Date();
  const currentOffset = steps[idx]?.day_offset ?? 0;
  const gapDays = Math.max(1, (next.day_offset ?? currentOffset + 3) - currentOffset);

  const when = new Date(base.getTime() + gapDays * 86400000);

  // Never schedule a send onto a weekend; roll forward to Monday.
  const day = when.getUTCDay();
  if (day === 6) when.setUTCDate(when.getUTCDate() + 2);
  if (day === 0) when.setUTCDate(when.getUTCDate() + 1);

  const [startHour] = String(working_hours?.start || '09:00').split(':').map(Number);
  when.setUTCHours(Number.isFinite(startHour) ? startHour : 9, 0, 0, 0);

  return {
    should_continue: true,
    next_step: next,
    next_action_at: when.toISOString(),
    reasoning:
      `Next touch is step ${next.step} on ${next.channel}, ${gapDays} day(s) after the last one. ` +
      'Weekend sends are rolled forward to the next working day and the send time is pinned to the ' +
      'start of the campaign working window.',
  };
}

/* ── dispatch ───────────────────────────────────────────────────────── */

export const LOCAL_ENGINE = {
  research: localResearch,
  icp_fitment: localIcpFitment,
  outreach_strategy: localOutreachStrategy,
  personalisation: localPersonalisation,
  conversation: localConversation,
  followup_timing: localFollowupTiming,
};

/**
 * Agents that deliberately have no local implementation, and the reason why.
 * Discovery is the important one: every other agent transforms something it
 * was handed, so a rule-based version degrades gracefully. Discovery invents
 * the input itself, and a deterministic version of that is not a fallback,
 * it is a fabricated list of companies presented as sourced leads.
 */
const NO_LOCAL_ENGINE = {
  discovery:
    'Discovery has no offline fallback on purpose. Finding companies requires either Apollo or a ' +
    'model; a rule-based version would be inventing company names, which is worse than returning ' +
    'nothing. Add a Groq or Gemini key, or an APOLLO_API_KEY, or import prospects from a CSV.',
};

export function runLocalEngine(agentName, payload) {
  const fn = LOCAL_ENGINE[agentName];
  if (!fn) {
    throw new Error(
      NO_LOCAL_ENGINE[agentName] ?? `No local engine implementation for agent "${agentName}"`
    );
  }
  return fn(payload || {});
}
