/**
 * Jobs: the thing that stopped the Run button from lying.
 *
 * Running a campaign means four agent calls per prospect, each of which can
 * take thirty seconds. Five prospects is ten minutes of work. That used to
 * happen inside the HTTP request, which meant the browser waited, the platform
 * cut the connection somewhere around sixty seconds, and the operator was left
 * looking at a spinner that would never resolve while the server carried on
 * working invisibly behind it. The work was fine. The reporting was the
 * problem, and an operator who cannot see what is happening cannot supervise
 * it, which is the entire job of a control plane.
 *
 * So a run is now a row. `POST /campaigns/:id/run` writes a job, hands back
 * its id, and returns. The work happens after the response. The UI polls the
 * job and watches counts move, prospects appear one at a time, and a Cancel
 * button that genuinely stops it.
 *
 * Three things make that safe rather than merely asynchronous:
 *
 *   cancellation   every job owns an AbortController. Cancelling aborts the
 *                  in-flight model call, not just the loop around it, so stop
 *                  means stop rather than "stop after this thirty seconds".
 *   locking        a prospect is claimed in the database before it is worked
 *                  on. The background worker and a manual run can be looking
 *                  at the same row at the same moment, and without this they
 *                  both advance it and it takes two steps at once.
 *   restart reaping  a job whose process died is marked failed at next boot
 *                  rather than sitting at "running" forever.
 */
import { randomUUID } from 'node:crypto';
import { supabase, unwrapSoft, dbReady } from '../db/client.js';
import { env } from '../config.js';
import { advance, advanceUntilBlocked } from './index.js';
import { isActionAllowed } from './gate.js';
import { runDiscovery } from '../services/discovery/index.js';
import { logActivity } from '../services/activity.js';

/** Identifies this server process, so a restart can tell its own orphans. */
export const INSTANCE_ID = randomUUID();

/** job id → AbortController, for jobs this process is running right now. */
const live = new Map();

const MAX_EVENTS = 60;

export const JOB_TYPES = ['campaign_run', 'discovery', 'prospect_advance'];

/* ── persistence ────────────────────────────────────────────────────── */

async function insertJob(row) {
  const { data, error } = await supabase.from('job_runs').insert(row).select('*').single();
  if (error) throw new Error(`job_runs insert: ${error.message}`);
  return data;
}

async function patchJob(id, patch) {
  const { data, error } = await supabase
    .from('job_runs')
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq('id', id)
    .select('*')
    .maybeSingle();
  if (error) {
    console.warn(`[jobs] could not update ${id}: ${error.message}`);
    return null;
  }
  return data;
}

export async function getJob(id) {
  return unwrapSoft(
    await supabase.from('job_runs').select('*, campaigns(id, name)').eq('id', id).maybeSingle(),
    null,
    'job_runs'
  );
}

export async function listJobs({ campaignId = null, status = null, limit = 20 } = {}) {
  let query = supabase
    .from('job_runs')
    .select('*, campaigns(id, name)')
    .order('created_at', { ascending: false })
    .limit(limit);

  if (campaignId) query = query.eq('campaign_id', campaignId);
  if (status) query = query.in('status', String(status).split(','));

  return unwrapSoft(await query, [], 'job_runs');
}

/** Jobs this process is actively working on. */
export const activeJobIds = () => [...live.keys()];

/* ── events ─────────────────────────────────────────────────────────── */

/**
 * Appends one line to the job's own story. Bounded, because a run over two
 * hundred prospects would otherwise grow a jsonb column without limit and the
 * only part anyone reads is the recent end of it.
 */
export function appendEvent(job, event) {
  const events = Array.isArray(job.events) ? job.events : [];
  const next = [...events, { at: new Date().toISOString(), ...event }];
  return next.slice(-MAX_EVENTS);
}

/* ── locking ────────────────────────────────────────────────────────── */

/**
 * Claims a prospect for this job. Returns false when someone else holds it.
 *
 * The staleness window matters: a process that dies mid-step leaves its lock
 * behind, and without a TTL that prospect is stuck forever with no way to
 * clear it from the UI.
 */
export async function acquireLock(campaignId, prospectId, owner) {
  const staleBefore = new Date(Date.now() - env.JOB_LOCK_TTL_MS).toISOString();

  const { data, error } = await supabase
    .from('campaign_prospects')
    .update({ locked_by: owner, locked_at: new Date().toISOString() })
    .eq('campaign_id', campaignId)
    .eq('prospect_id', prospectId)
    .or(`locked_by.is.null,locked_at.lt.${staleBefore}`)
    .select('id')
    .maybeSingle();

  // 42703: the lock columns are from a later migration. Without them there is
  // no locking, which is the behaviour this code replaced — so carry on rather
  // than refusing to run at all, and say so once.
  if (error?.code === '42703') {
    if (!acquireLock.warned) {
      console.warn('[jobs] campaign_prospects has no lock columns. Run db/04-runtime.sql to enable locking.');
      acquireLock.warned = true;
    }
    return true;
  }
  if (error) {
    console.warn(`[jobs] lock failed: ${error.message}`);
    return false;
  }

  return Boolean(data);
}

export async function releaseLock(campaignId, prospectId) {
  const { error } = await supabase
    .from('campaign_prospects')
    .update({ locked_by: null, locked_at: null })
    .eq('campaign_id', campaignId)
    .eq('prospect_id', prospectId);
  if (error && error.code !== '42703') {
    console.warn(`[jobs] unlock failed: ${error.message}`);
  }
}

/* ── cancellation ───────────────────────────────────────────────────── */

export async function cancelJob(id, actor = 'operator') {
  const job = await getJob(id);
  if (!job) return { cancelled: false, reason: 'No such job' };
  if (!['queued', 'running'].includes(job.status)) {
    return { cancelled: false, reason: `That job already ${job.status}.` };
  }

  // Abort the in-flight model call if this process owns the job. If another
  // instance owns it, the status write below is what stops it: its loop reads
  // the row between prospects.
  live.get(id)?.abort();

  await patchJob(id, {
    status: 'cancelled',
    cancel_requested_by: actor,
    finished_at: new Date().toISOString(),
    events: appendEvent(job, { level: 'stop', message: `Cancelled by ${actor}.` }),
  });

  return { cancelled: true };
}

/** Cancels every live job for a campaign. Used when a campaign is paused. */
export async function cancelJobsForCampaign(campaignId, actor = 'operator') {
  const running = await listJobs({ campaignId, status: 'queued,running', limit: 50 });
  const results = [];
  for (const job of running) {
    results.push(await cancelJob(job.id, actor));
  }
  return results.filter((r) => r.cancelled).length;
}

export async function cancelAllJobs(actor = 'operator') {
  const running = await listJobs({ status: 'queued,running', limit: 100 });
  let count = 0;
  for (const job of running) {
    if ((await cancelJob(job.id, actor)).cancelled) count += 1;
  }
  return count;
}

/** Has someone asked this job to stop since we last looked? */
async function isCancelled(id) {
  const row = unwrapSoft(
    await supabase.from('job_runs').select('status').eq('id', id).maybeSingle(),
    null,
    'job_runs'
  );
  return row?.status === 'cancelled';
}

/* ── the runners ────────────────────────────────────────────────────── */

/**
 * Works `items` with a fixed number in flight at once. Written out rather than
 * pulled from a library because the interesting behaviour is the early exit:
 * when a job is cancelled, the workers stop taking new items immediately
 * instead of draining a queue nobody is waiting for any more.
 */
async function pool(items, size, worker, shouldStop) {
  const queue = [...items];
  const results = [];

  const run = async () => {
    while (queue.length) {
      if (await shouldStop()) return;
      const item = queue.shift();
      results.push(await worker(item));
    }
  };

  await Promise.all(Array.from({ length: Math.max(1, Math.min(size, items.length)) }, run));
  return results;
}

async function runCampaignJob(job, signal) {
  const campaignId = job.campaign_id;
  const limit = job.params?.limit ?? 5;
  const force = job.params?.force === true;
  const only = Array.isArray(job.params?.prospect_ids) ? job.params.prospect_ids : null;

  // States that still have a step waiting for them. Anything else is either
  // finished or waiting on a person, and picking it up would do nothing.
  const PENDING = ['discovered', 'researched', 'qualified', 'strategy_planned', 'contacted'];

  let query = supabase
    .from('campaign_prospects')
    .select('prospect_id, state, prospects(full_name, first_name, last_name, company_name)')
    .eq('campaign_id', campaignId)
    .eq('paused', false)
    .in('state', PENDING)
    .order('created_at', { ascending: true })
    .limit(limit);

  if (only) query = query.in('prospect_id', only);

  const rows = unwrapSoft(await query, [], 'campaign_prospects');

  let current = await patchJob(job.id, {
    total: rows.length,
    events: appendEvent(job, {
      level: 'info',
      message:
        rows.length === 0
          ? 'Nothing to pick up. Every prospect is either finished or waiting on a person.'
          : `Picked up ${rows.length} prospect${rows.length === 1 ? '' : 's'}, ${env.JOB_CONCURRENCY} at a time.`,
    }),
  });

  if (rows.length === 0) {
    return { picked_up: 0, advanced: 0, results: [] };
  }

  let processed = 0;
  let advanced = 0;
  let failed = 0;
  const results = [];

  const nameOf = (row) => {
    const p = row.prospects ?? {};
    return (
      p.full_name ||
      [p.first_name, p.last_name].filter(Boolean).join(' ') ||
      p.company_name ||
      'a prospect'
    );
  };

  await pool(
    rows,
    env.JOB_CONCURRENCY,
    async (row) => {
      const name = nameOf(row);

      const got = await acquireLock(campaignId, row.prospect_id, job.id);
      if (!got) {
        processed += 1;
        current = await patchJob(job.id, {
          processed,
          events: appendEvent(current ?? job, {
            level: 'skip',
            message: `${name} is already being worked on by something else. Skipped.`,
            prospect_id: row.prospect_id,
          }),
        });
        return null;
      }

      try {
        const steps = await advanceUntilBlocked(campaignId, row.prospect_id, { force, signal });
        const last = steps[steps.length - 1] ?? {};
        const moved = steps.filter((s) => s.status === 'advanced').length;

        processed += 1;
        if (moved > 0) advanced += 1;
        if (last.status === 'error') failed += 1;

        results.push({ prospect_id: row.prospect_id, name, steps });

        current = await patchJob(job.id, {
          processed,
          succeeded: advanced,
          failed,
          current_label: name,
          events: appendEvent(current ?? job, {
            level: last.status === 'error' ? 'error' : moved > 0 ? 'ok' : 'hold',
            message:
              last.status === 'error'
                ? `${name}: ${last.reason}`
                : moved > 0
                  ? `${name} moved ${moved} step${moved === 1 ? '' : 's'} and is now ${String(last.state ?? '').replace(/_/g, ' ')}.`
                  : `${name} did not move: ${last.reason ?? 'nothing to do'}`,
            prospect_id: row.prospect_id,
            engine: steps.find((s) => s.engine)?.engine ?? null,
          }),
        });

        return last;
      } finally {
        await releaseLock(campaignId, row.prospect_id);
      }
    },
    async () => signal.aborted || (await isCancelled(job.id))
  );

  return { picked_up: rows.length, advanced, failed, results };
}

async function runDiscoveryJob(job, signal) {
  const campaign = unwrapSoft(
    await supabase.from('campaigns').select('*').eq('id', job.campaign_id).maybeSingle(),
    null,
    'campaigns'
  );
  if (!campaign) throw new Error('That campaign no longer exists.');

  const count = Math.min(job.params?.count ?? 10, env.DISCOVERY_MAX_PER_RUN);

  await patchJob(job.id, {
    total: count,
    events: appendEvent(job, { level: 'info', message: `Looking for up to ${count} prospects.` }),
  });

  const result = await runDiscovery({
    campaign,
    count,
    source: job.params?.source ?? null,
    signal,
    onProgress: async (event) => {
      const fresh = await getJob(job.id);
      if (!fresh) return;
      await patchJob(job.id, {
        processed: event.processed ?? fresh.processed,
        succeeded: event.added ?? fresh.succeeded,
        current_label: event.label ?? fresh.current_label,
        events: appendEvent(fresh, { level: event.level ?? 'ok', message: event.message }),
      });
    },
  });

  return result;
}

async function runProspectAdvanceJob(job, signal) {
  const { campaign_id: campaignId } = job;
  const prospectId = job.params?.prospect_id;
  if (!prospectId) throw new Error('No prospect was named.');

  const got = await acquireLock(campaignId, prospectId, job.id);
  if (!got) throw new Error('That prospect is already being worked on.');

  try {
    const steps =
      job.params?.all === true
        ? await advanceUntilBlocked(campaignId, prospectId, { force: job.params?.force === true, signal })
        : [await advance(campaignId, prospectId, { force: job.params?.force === true, signal })];

    await patchJob(job.id, {
      total: steps.length,
      processed: steps.length,
      succeeded: steps.filter((s) => s.status === 'advanced').length,
      events: appendEvent(job, {
        level: 'ok',
        message: steps.map((s) => `${s.status}: ${s.reason ?? s.state}`).join(' · '),
      }),
    });

    return { steps, final: steps[steps.length - 1] };
  } finally {
    await releaseLock(campaignId, prospectId);
  }
}

const RUNNERS = {
  campaign_run: runCampaignJob,
  discovery: runDiscoveryJob,
  prospect_advance: runProspectAdvanceJob,
};

/* ── the entry point ────────────────────────────────────────────────── */

/**
 * Writes the job row and starts the work. Returns as soon as the row exists —
 * the caller responds to its HTTP request with this and does not wait.
 */
export async function startJob({ type, campaignId = null, params = {}, actor = 'operator' }) {
  if (!JOB_TYPES.includes(type)) throw new Error(`Unknown job type "${type}"`);
  if (!dbReady) throw new Error('The database is not configured, so jobs cannot be recorded.');

  // The gate decides whether work may happen at all. Asking it here means a
  // kill switch produces one clear refusal instead of a job that starts,
  // blocks on every prospect, and reports a confusing zero.
  //
  // Discovery is deliberately checked without the campaign, because the
  // campaign-level check requires a live campaign and finding people is
  // allowed while one is still a draft. Filling a campaign with prospects
  // contacts nobody, and making someone set it live before they can see who
  // they would be approaching gets the review step exactly backwards. The
  // kill switch and an agent pause still stop it.
  const gate =
    type === 'discovery'
      ? await isActionAllowed({ agentName: 'discovery' })
      : await isActionAllowed({ campaignId });

  if (!gate.allowed) {
    const error = new Error(gate.reason);
    error.status = 409;
    error.code = 'blocked';
    throw error;
  }

  // One run per campaign at a time. Two concurrent runs would fight over the
  // same prospects, and the locks would turn the second one into a long list
  // of "skipped", which looks like a bug.
  if (campaignId) {
    const existing = await listJobs({ campaignId, status: 'queued,running', limit: 1 });
    if (existing.length > 0) {
      const error = new Error(
        `A ${existing[0].type.replace(/_/g, ' ')} is already running on this campaign. Wait for it or cancel it first.`
      );
      error.status = 409;
      error.code = 'job_already_running';
      error.job_id = existing[0].id;
      throw error;
    }
  }

  const job = await insertJob({
    type,
    campaign_id: campaignId,
    status: 'queued',
    params,
    created_by: actor,
    owner_instance: INSTANCE_ID,
    events: [{ at: new Date().toISOString(), level: 'info', message: `Queued by ${actor}.` }],
  });

  // Deliberately not awaited. This is the whole point of the module.
  void execute(job);

  return job;
}

async function execute(job) {
  const controller = new AbortController();
  live.set(job.id, controller);

  const started = Date.now();
  await patchJob(job.id, { status: 'running', started_at: new Date().toISOString() });

  try {
    const runner = RUNNERS[job.type];
    const result = await runner({ ...job, status: 'running' }, controller.signal);

    const fresh = await getJob(job.id);
    // A cancel that landed while the last prospect was finishing should not be
    // overwritten with "succeeded". The operator pressed stop; the record
    // should say so.
    if (fresh?.status === 'cancelled') return;

    await patchJob(job.id, {
      status: 'succeeded',
      result,
      finished_at: new Date().toISOString(),
      duration_ms: Date.now() - started,
      events: appendEvent(fresh ?? job, { level: 'done', message: 'Finished.' }),
    });
  } catch (err) {
    const fresh = await getJob(job.id);
    if (fresh?.status === 'cancelled') return;

    await patchJob(job.id, {
      status: 'failed',
      error: err.message,
      finished_at: new Date().toISOString(),
      duration_ms: Date.now() - started,
      events: appendEvent(fresh ?? job, { level: 'error', message: err.message }),
    });

    await logActivity({
      campaignId: job.campaign_id,
      agentName: 'system',
      action: 'A job failed',
      detail: err.message,
      status: 'failed',
    });
  } finally {
    live.delete(job.id);
  }
}

/**
 * Called once at boot. A job that was running when the process died cannot be
 * resumed — its in-memory controller and its position in the loop are both
 * gone — so it is marked failed with a reason rather than left claiming to be
 * running for the rest of time. Any locks it held are released with it.
 */
export async function reapAbandonedJobs() {
  if (!dbReady) return 0;

  const stale = unwrapSoft(
    await supabase
      .from('job_runs')
      .select('id, campaign_id, type')
      .in('status', ['queued', 'running'])
      .neq('owner_instance', INSTANCE_ID),
    [],
    'job_runs'
  );

  for (const job of stale) {
    await patchJob(job.id, {
      status: 'failed',
      error: 'The API restarted while this job was running, so it was stopped.',
      finished_at: new Date().toISOString(),
    });
  }

  const { error } = await supabase
    .from('campaign_prospects')
    .update({ locked_by: null, locked_at: null })
    .not('locked_by', 'is', null);
  if (error && error.code !== '42703') {
    console.warn(`[jobs] could not clear stale locks: ${error.message}`);
  }

  if (stale.length) console.log(`[jobs] cleared ${stale.length} job(s) left over from a previous run.`);
  return stale.length;
}
