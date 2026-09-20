/**
 * Discovery: how people get into a campaign in the first place.
 *
 * The app used to have no answer to this. Prospects arrived through a manual
 * POST, which meant the "autonomous SDR" could do everything except the first
 * thing a real SDR does.
 *
 * There are two honest sources and they are not equivalent, so the app never
 * blurs them together:
 *
 *   apollo   a real search against a real contact database. Returns actual
 *            people with actual LinkedIn URLs. Needs APOLLO_API_KEY.
 *   llm      the model proposes companies that fit the ICP and names the role
 *            worth approaching at each. These are leads to verify, not sourced
 *            records, and they are written to the database saying exactly
 *            that.
 *
 * Whichever ran, two rules hold. No email address is ever invented — a
 * prospect with no verified email is stored with a null one and the UI shows
 * the gap. And every row records where it came from, in `source` and in
 * `field_provenance`, so a person reading the prospect list can tell a
 * searched record from a suggested one at a glance.
 */
import { supabase, unwrapSoft } from '../../db/client.js';
import { env, discoveryRouting } from '../../config.js';
import { callAgent } from '../../agents/client.js';
import { logActivity } from '../activity.js';
import { isApolloConfigured, searchPeople, revealEmail, ApolloError } from './apollo.js';

/* ── source selection ───────────────────────────────────────────────── */

/**
 * Which source to use for this run. An explicit request wins, and is refused
 * rather than silently downgraded — someone who asked for Apollo and got the
 * model's guesses instead would have no way to know.
 */
export function chooseSource(requested = null) {
  if (requested && requested !== 'auto') {
    if (requested === 'apollo' && !isApolloConfigured()) {
      const err = new Error('Apollo was requested but APOLLO_API_KEY is not set on the API.');
      err.code = 'apollo_not_configured';
      err.status = 400;
      throw err;
    }
    return requested;
  }
  return discoveryRouting().source;
}

/* ── deduplication ──────────────────────────────────────────────────── */

/**
 * Finds a prospect we already hold, by the identifiers that actually identify
 * a person. Email first because it is unique in the schema; then LinkedIn,
 * which is the next strongest; then name plus company domain, which is weaker
 * but catches the same person imported twice without either.
 *
 * Getting this wrong in the permissive direction is the expensive one: a
 * duplicate person means two sequences from the same company landing in one
 * inbox, which is exactly the thing the duplicate-conflict check exists to
 * prevent further down the pipeline.
 */
async function findExisting(candidate) {
  if (candidate.email) {
    const byEmail = unwrapSoft(
      await supabase.from('prospects').select('id, full_name').ilike('email', candidate.email).maybeSingle(),
      null,
      'prospects'
    );
    if (byEmail) return { row: byEmail, matched_on: 'email' };
  }

  if (candidate.linkedin_url) {
    const byLinkedIn = unwrapSoft(
      await supabase
        .from('prospects')
        .select('id, full_name')
        .eq('linkedin_url', candidate.linkedin_url)
        .limit(1),
      [],
      'prospects'
    );
    if (byLinkedIn.length) return { row: byLinkedIn[0], matched_on: 'linkedin' };
  }

  if (candidate.full_name && candidate.company_domain) {
    const byName = unwrapSoft(
      await supabase
        .from('prospects')
        .select('id, full_name')
        .ilike('full_name', candidate.full_name)
        .ilike('company_domain', candidate.company_domain)
        .limit(1),
      [],
      'prospects'
    );
    if (byName.length) return { row: byName[0], matched_on: 'name and company' };
  }

  return null;
}

/* ── writing ────────────────────────────────────────────────────────── */

/**
 * Where each field came from, per field. The prospect page prints this,
 * because a phone number a person typed and one a model produced should not
 * look the same on screen.
 */
function provenanceOf(candidate, source) {
  const provenance = {};
  for (const field of ['email', 'phone', 'title', 'linkedin_url', 'company_name', 'company_domain']) {
    if (candidate[field]) provenance[field] = source;
  }
  return provenance;
}

/**
 * Adds one candidate to one campaign. Returns what happened, in words the UI
 * can print without translating: added, linked (we already knew them, now they
 * are in this campaign too), or already here.
 */
export async function addCandidate(candidate, campaignId, { source, note = null }) {
  const existing = await findExisting(candidate);

  if (existing) {
    const member = unwrapSoft(
      await supabase
        .from('campaign_prospects')
        .select('id')
        .eq('campaign_id', campaignId)
        .eq('prospect_id', existing.row.id)
        .maybeSingle(),
      null,
      'campaign_prospects'
    );

    if (member) {
      return {
        outcome: 'already_here',
        prospect_id: existing.row.id,
        name: candidate.full_name ?? existing.row.full_name ?? candidate.company_name,
        detail: `Already in this campaign (matched on ${existing.matched_on}).`,
      };
    }

    const { error } = await supabase
      .from('campaign_prospects')
      .insert({ campaign_id: campaignId, prospect_id: existing.row.id, state: 'discovered' });
    if (error) throw new Error(`campaign_prospects insert: ${error.message}`);

    return {
      outcome: 'linked',
      prospect_id: existing.row.id,
      name: candidate.full_name ?? existing.row.full_name ?? candidate.company_name,
      detail: `Already known (matched on ${existing.matched_on}), added to this campaign.`,
    };
  }

  const row = {
    first_name: candidate.first_name ?? null,
    last_name: candidate.last_name ?? null,
    // `??` only falls through on null/undefined, and an empty join() is
    // neither — a candidate discovery deliberately left unnamed used to
    // store full_name as '' rather than null, which then broke every
    // downstream `?? fallback` that assumed a real name is either present
    // or null. `||` treats the empty string as absent, which is what it is.
    full_name:
      candidate.full_name ||
      [candidate.first_name, candidate.last_name].filter(Boolean).join(' ') ||
      null,
    title: candidate.title ?? null,
    // Never a guess. A locked Apollo record and a model suggestion both store
    // null here, and the pipeline treats a null email as "we cannot email this
    // person yet" rather than inventing one that bounces.
    email: candidate.email ?? null,
    phone: candidate.phone ?? null,
    linkedin_url: candidate.linkedin_url ?? null,
    company_name: candidate.company_name ?? null,
    company_domain: candidate.company_domain ?? null,
    company_industry: candidate.company_industry ?? null,
    company_employee_count: candidate.company_employee_count ?? null,
    company_hq: candidate.company_hq ?? null,
    notes: note ?? candidate.why_this_company ?? null,
    source,
    field_provenance: provenanceOf(candidate, source),
  };

  const { data, error } = await supabase.from('prospects').insert(row).select('id').single();

  if (error) {
    // 23505 is the unique index on email — someone else inserted the same
    // person between the dedupe check and here. Rare, and recoverable: link to
    // the row that won rather than failing the whole run over it.
    if (error.code === '23505' && candidate.email) {
      const winner = unwrapSoft(
        await supabase.from('prospects').select('id, full_name').ilike('email', candidate.email).maybeSingle(),
        null,
        'prospects'
      );
      if (winner) {
        await supabase
          .from('campaign_prospects')
          .insert({ campaign_id: campaignId, prospect_id: winner.id, state: 'discovered' });
        return {
          outcome: 'linked',
          prospect_id: winner.id,
          name: candidate.full_name,
          detail: 'Added by something else at the same moment; linked to that record.',
        };
      }
    }

    // 23514 is the source check constraint, which only lists the original four
    // values until db/04-runtime.sql has been applied.
    if (error.code === '23514') {
      throw new Error(
        `The database does not accept source "${source}" yet. Run db/04-runtime.sql in the ` +
          'Supabase SQL editor to allow the discovery sources.'
      );
    }

    throw new Error(`prospect insert: ${error.message}`);
  }

  const { error: memberError } = await supabase
    .from('campaign_prospects')
    .insert({ campaign_id: campaignId, prospect_id: data.id, state: 'discovered' });
  if (memberError) throw new Error(`campaign_prospects insert: ${memberError.message}`);

  return {
    outcome: 'added',
    prospect_id: data.id,
    name: row.full_name ?? `${row.title} at ${row.company_name}`,
    detail: candidate.email ? 'Added with a verified email.' : 'Added. No email yet.',
  };
}

/* ── the sources ────────────────────────────────────────────────────── */

async function discoverWithApollo({ campaign, count, filters, signal, onProgress }) {
  await onProgress?.({ level: 'info', message: 'Searching Apollo.' });

  const search = await searchPeople(campaign, { ...filters, per_page: count, signal });

  await onProgress?.({
    level: 'info',
    message:
      `Apollo matched ${search.pagination.total_entries.toLocaleString('en-IN')} people. ` +
      `Taking the first ${search.candidates.length}.`,
  });

  if (env.APOLLO_REVEAL_EMAILS) {
    for (const candidate of search.candidates) {
      if (signal?.aborted) break;
      if (candidate.email) continue;
      const revealed = await revealEmail(candidate, signal);
      if (revealed) Object.assign(candidate, revealed);
    }
  }

  return {
    candidates: search.candidates,
    meta: {
      total_matches: search.pagination.total_entries,
      filters_used: search.filters,
      emails_revealed: env.APOLLO_REVEAL_EMAILS,
    },
    caveats: env.APOLLO_REVEAL_EMAILS
      ? []
      : [
          'Email addresses are locked. Apollo charges a credit per reveal, so this run stored ' +
            'the people without them. Set APOLLO_REVEAL_EMAILS=true to unlock on discovery.',
        ],
  };
}

async function discoverWithLlm({ campaign, count, signal, onProgress }) {
  await onProgress?.({ level: 'info', message: 'Asking the model for candidate companies.' });

  const result = await callAgent(
    'discovery',
    {
      campaign: {
        name: campaign.name,
        objective: campaign.objective,
        icp_criteria: campaign.icp_criteria,
        exclusion_criteria: campaign.exclusion_criteria,
        target_roles: campaign.target_roles ?? [],
        industry: campaign.industry,
        company_size: campaign.company_size,
      },
      how_many: count,
    },
    { campaignId: campaign.id, signal }
  );

  if (result.cancelled) {
    const err = new Error('Cancelled.');
    err.code = 'cancelled';
    throw err;
  }

  if (!result.success) {
    throw new Error(
      `The discovery agent could not produce a list: ${result.error}. ` +
        'Add an APOLLO_API_KEY for a real search, or import prospects from a CSV.'
    );
  }

  return {
    candidates: result.output.candidates.slice(0, count),
    meta: { engine: result.engine, reasoning: result.output.search_reasoning },
    caveats: [
      'These are suggestions from a language model, not records from a contact database. ' +
        'Verify each company and find the actual person before contacting anyone.',
      ...(result.output.caveats ?? []),
    ],
  };
}

/* ── the run ────────────────────────────────────────────────────────── */

/**
 * One discovery run: choose a source, get candidates, write the ones we do not
 * already have, report each one as it lands.
 */
export async function runDiscovery({ campaign, count = 10, source = null, filters = {}, signal, onProgress }) {
  const chosen = chooseSource(source);

  if (chosen === 'none') {
    throw new Error(
      'Discovery has no source configured. Set APOLLO_API_KEY for a real search, or a Groq or ' +
        'Gemini key for model suggestions, or import prospects from a CSV.'
    );
  }

  const capped = Math.min(count, env.DISCOVERY_MAX_PER_RUN);
  const sourceTag = chosen === 'apollo' ? 'apollo' : 'ai_suggested';

  let found;
  try {
    found =
      chosen === 'apollo'
        ? await discoverWithApollo({ campaign, count: capped, filters, signal, onProgress })
        : await discoverWithLlm({ campaign, count: capped, signal, onProgress });
  } catch (err) {
    if (err instanceof ApolloError && err.code === 'no_filters') throw err;
    throw err;
  }

  const summary = { added: 0, linked: 0, already_here: 0, failed: 0 };
  const rows = [];
  let processed = 0;

  for (const candidate of found.candidates) {
    if (signal?.aborted) break;

    try {
      const outcome = await addCandidate(candidate, campaign.id, {
        source: sourceTag,
        note: candidate.why_this_company ?? null,
      });

      summary[outcome.outcome] += 1;
      rows.push(outcome);
      processed += 1;

      await onProgress?.({
        level: outcome.outcome === 'added' ? 'ok' : 'skip',
        message: `${outcome.name}: ${outcome.detail}`,
        processed,
        added: summary.added,
        label: outcome.name,
      });
    } catch (err) {
      summary.failed += 1;
      processed += 1;
      rows.push({ outcome: 'failed', name: candidate.full_name ?? candidate.company_name, detail: err.message });
      await onProgress?.({
        level: 'error',
        message: `${candidate.company_name}: ${err.message}`,
        processed,
        added: summary.added,
      });
    }
  }

  await logActivity({
    campaignId: campaign.id,
    agentName: 'discovery',
    action: 'Discovered prospects',
    detail:
      `${chosen === 'apollo' ? 'Apollo search' : 'Model suggestions'}: ` +
      `${summary.added} added, ${summary.linked} already known, ${summary.already_here} already in this campaign.`,
    status: summary.failed ? 'degraded' : 'success',
    metadata: { source: chosen, ...summary },
  });

  return {
    source: chosen,
    source_label: chosen === 'apollo' ? 'Apollo search' : 'Model suggestions (unverified)',
    requested: capped,
    found: found.candidates.length,
    ...summary,
    caveats: found.caveats ?? [],
    meta: found.meta ?? {},
    rows,
  };
}

export { isApolloConfigured };
