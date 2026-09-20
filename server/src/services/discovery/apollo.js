/**
 * Apollo: the source that returns real people.
 *
 * Two calls matter here.
 *
 *   mixed_people/search   finds people matching a set of filters. Free of
 *                         credits, and it is what fills a campaign.
 *   people/match          reveals a verified email for one person, and spends
 *                         a credit each time. Off unless APOLLO_REVEAL_EMAILS
 *                         is set, because a demo that quietly drains someone's
 *                         Apollo balance is a bad demo.
 *
 * The single most important line in this file is `unlockedEmail`. Apollo
 * returns the literal string `email_not_unlocked@domain.com` for a person
 * whose email you have not paid to see. Stored naively that becomes a
 * deliverable-looking address on a prospect record, the personalisation agent
 * writes to it, and the operator believes they have a contactable lead. It is
 * a placeholder, so it is thrown away and the field stays null.
 */
import { env } from '../../config.js';

const BASE = 'https://api.apollo.io/api/v1';

export class ApolloError extends Error {
  constructor(message, { code = 'apollo_error', status = null } = {}) {
    super(message);
    this.name = 'ApolloError';
    this.code = code;
    this.status = status;
  }
}

export const isApolloConfigured = () => Boolean(env.APOLLO_API_KEY);

async function apollo(path, body, signal) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), env.APOLLO_TIMEOUT_MS);
  const onAbort = () => controller.abort();
  signal?.addEventListener('abort', onAbort, { once: true });

  try {
    const res = await fetch(`${BASE}${path}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'Cache-Control': 'no-cache',
        'x-api-key': env.APOLLO_API_KEY,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    const text = await res.text();

    if (!res.ok) {
      if (res.status === 401 || res.status === 403) {
        throw new ApolloError(
          'Apollo rejected the API key. Check APOLLO_API_KEY, and that the key has the ' +
            'master or search scope enabled in Apollo under Settings → Integrations → API.',
          { code: 'invalid_key', status: res.status }
        );
      }
      if (res.status === 429) {
        throw new ApolloError('Apollo rate limit reached. Wait a minute and try again.', {
          code: 'rate_limited',
          status: 429,
        });
      }
      if (res.status === 422) {
        throw new ApolloError(`Apollo rejected the search filters: ${text.slice(0, 300)}`, {
          code: 'bad_filters',
          status: 422,
        });
      }
      throw new ApolloError(`Apollo returned HTTP ${res.status}: ${text.slice(0, 300)}`, {
        code: 'http_error',
        status: res.status,
      });
    }

    try {
      return JSON.parse(text);
    } catch {
      throw new ApolloError('Apollo returned something that was not JSON.', { code: 'unparseable' });
    }
  } catch (err) {
    if (err instanceof ApolloError) throw err;
    if (err?.name === 'AbortError') {
      throw new ApolloError(
        signal?.aborted ? 'Cancelled.' : `Apollo did not respond within ${env.APOLLO_TIMEOUT_MS}ms.`,
        { code: signal?.aborted ? 'cancelled' : 'timeout' }
      );
    }
    throw new ApolloError(`Could not reach Apollo: ${err.message}`, { code: 'network_error' });
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}

/** Apollo's placeholder for a locked email, in every form it appears in. */
export function unlockedEmail(value) {
  const email = String(value ?? '').trim().toLowerCase();
  if (!email || !email.includes('@')) return null;
  if (email.startsWith('email_not_unlocked')) return null;
  if (email.endsWith('@domain.com')) return null;
  if (email === 'null' || email === 'none') return null;
  return email;
}

function cleanDomain(value) {
  const raw = String(value ?? '').trim().toLowerCase();
  if (!raw) return null;
  const host = raw.replace(/^https?:\/\//, '').replace(/^www\./, '').split(/[/?#]/)[0];
  return /^[a-z0-9.-]+\.[a-z]{2,}$/.test(host) ? host : null;
}

/**
 * "50-2000", "50 to 2000", "1,001-5,000" all mean the same thing, and Apollo
 * wants "50,2000". Operators type the band however they think of it, so the
 * parsing is deliberately forgiving rather than making them learn a format.
 */
export function employeeRange(companySize) {
  const raw = String(companySize ?? '').replace(/,/g, '').trim();
  if (!raw) return null;

  const pair = raw.match(/(\d+)\s*(?:-|–|to|—)\s*(\d+)/i);
  if (pair) return [`${pair[1]},${pair[2]}`];

  const plus = raw.match(/(\d+)\s*\+/);
  if (plus) return [`${plus[1]},1000000`];

  const single = raw.match(/(\d+)/);
  if (single) {
    const n = parseInt(single[1], 10);
    return [`${Math.max(1, Math.floor(n / 2))},${n * 2}`];
  }

  return null;
}

/** Turns a campaign, plus whatever the operator typed in the dialog, into Apollo filters. */
export function buildSearchFilters(campaign, overrides = {}) {
  const titles = overrides.titles?.length
    ? overrides.titles
    : Array.isArray(campaign.target_roles) && campaign.target_roles.length
      ? campaign.target_roles
      : [];

  const keywords = overrides.keywords?.length
    ? overrides.keywords
    : [campaign.industry].filter(Boolean);

  const ranges = overrides.employee_ranges?.length
    ? overrides.employee_ranges
    : employeeRange(campaign.company_size);

  const filters = { page: overrides.page ?? 1, per_page: Math.min(overrides.per_page ?? 25, 100) };

  if (titles.length) filters.person_titles = titles;
  if (overrides.locations?.length) filters.person_locations = overrides.locations;
  if (ranges?.length) filters.organization_num_employees_ranges = ranges;
  if (keywords.length) filters.q_organization_keyword_tags = keywords;
  if (overrides.domains?.length) filters.q_organization_domains_list = overrides.domains;
  if (overrides.seniorities?.length) filters.person_seniorities = overrides.seniorities;

  return filters;
}

export function mapPerson(person) {
  const org = person.organization ?? person.account ?? {};

  return {
    external_id: person.id ?? null,
    first_name: person.first_name ?? null,
    last_name: person.last_name ?? null,
    full_name: person.name || [person.first_name, person.last_name].filter(Boolean).join(' ') || null,
    title: person.title ?? null,
    seniority: person.seniority ?? null,
    email: unlockedEmail(person.email),
    email_status: unlockedEmail(person.email) ? (person.email_status ?? null) : 'locked',
    phone: person.phone_numbers?.[0]?.sanitized_number ?? null,
    linkedin_url: person.linkedin_url ?? null,
    location: [person.city, person.state, person.country].filter(Boolean).join(', ') || null,
    company_name: org.name ?? person.organization_name ?? null,
    company_domain: cleanDomain(org.primary_domain ?? org.website_url ?? person.organization_website_url),
    company_industry: org.industry ?? null,
    company_employee_count: org.estimated_num_employees ?? null,
    company_hq:
      [org.city, org.state, org.country].filter(Boolean).join(', ') ||
      org.raw_address ||
      null,
    confidence: 'high',
  };
}

/**
 * Searches Apollo and returns mapped candidates. `pagination` comes back too,
 * so the UI can say "25 of 1,340 matches" rather than implying the search
 * found exactly what it returned.
 */
export async function searchPeople(campaign, { signal, ...overrides } = {}) {
  if (!isApolloConfigured()) {
    throw new ApolloError('APOLLO_API_KEY is not set.', { code: 'not_configured' });
  }

  const filters = buildSearchFilters(campaign, overrides);

  // Apollo matches almost everyone when handed no filters at all, which
  // produces a random list that looks like a working search and is not one.
  const hasFilter = ['person_titles', 'person_locations', 'organization_num_employees_ranges', 'q_organization_keyword_tags', 'q_organization_domains_list']
    .some((k) => filters[k]?.length);

  if (!hasFilter) {
    throw new ApolloError(
      'This campaign has nothing to search on. Give it target roles, an industry or a headcount ' +
        'band first, or set them in the discover dialog.',
      { code: 'no_filters' }
    );
  }

  const body = await apollo('/mixed_people/search', filters, signal);
  const people = Array.isArray(body.people) ? body.people : [];

  return {
    filters,
    candidates: people.map(mapPerson).filter((p) => p.company_name && p.title),
    pagination: {
      page: body.pagination?.page ?? filters.page,
      per_page: body.pagination?.per_page ?? filters.per_page,
      total_entries: body.pagination?.total_entries ?? people.length,
      total_pages: body.pagination?.total_pages ?? 1,
    },
  };
}

/**
 * Spends one Apollo credit to reveal a verified email. Returns null rather
 * than throwing when the reveal fails, because a failed reveal should leave
 * the prospect in the campaign with a null email, not lose the prospect.
 */
export async function revealEmail(candidate, signal) {
  if (!isApolloConfigured() || !env.APOLLO_REVEAL_EMAILS) return null;

  try {
    const body = await apollo(
      '/people/match',
      {
        id: candidate.external_id ?? undefined,
        first_name: candidate.first_name ?? undefined,
        last_name: candidate.last_name ?? undefined,
        organization_name: candidate.company_name ?? undefined,
        domain: candidate.company_domain ?? undefined,
        linkedin_url: candidate.linkedin_url ?? undefined,
        reveal_personal_emails: true,
      },
      signal
    );

    const email = unlockedEmail(body?.person?.email);
    return email ? { email, email_status: body?.person?.email_status ?? 'verified' } : null;
  } catch (err) {
    if (err.code === 'cancelled') throw err;
    return null;
  }
}

/** A cheap call used by /health to prove the key works without spending credits. */
export async function pingApollo(signal) {
  if (!isApolloConfigured()) return { configured: false };
  try {
    await apollo('/mixed_people/search', { person_titles: ['CTO'], page: 1, per_page: 1 }, signal);
    return { configured: true, reachable: true };
  } catch (err) {
    return { configured: true, reachable: false, error: err.message, code: err.code };
  }
}
