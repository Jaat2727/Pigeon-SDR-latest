/**
 * Jobs: what the app is doing right now, and the button that stops it.
 *
 * Every long-running action — a campaign run, a discovery sweep — is a row
 * here rather than a request someone has to keep a browser tab open for. The
 * UI polls one of these while it watches a progress bar move.
 */
import express from 'express';
import { asyncHandler, notFound, badRequest, intParam } from '../lib/http.js';
import { getJob, listJobs, cancelJob, activeJobIds, INSTANCE_ID } from '../orchestrator/jobs.js';

const router = express.Router();

/**
 * A job row is wide (it carries its own params and full result) and the list
 * view needs none of that. Sending it anyway makes a polling endpoint that
 * grows with the size of the run it is reporting on.
 */
function mapJob(job, { full = false } = {}) {
  const total = job.total ?? 0;
  const processed = job.processed ?? 0;

  return {
    id: job.id,
    type: job.type,
    status: job.status,
    campaign_id: job.campaign_id,
    campaign_name: job.campaigns?.name ?? null,
    total,
    processed,
    succeeded: job.succeeded ?? 0,
    failed: job.failed ?? 0,
    // Null rather than 0 before the total is known, so the UI can show an
    // indeterminate bar instead of one that sits at zero and looks stuck.
    percent: total > 0 ? Math.min(100, Math.round((processed / total) * 100)) : null,
    current_label: job.current_label ?? null,
    finished: ['succeeded', 'failed', 'cancelled'].includes(job.status),
    error: job.error ?? null,
    created_by: job.created_by ?? null,
    cancel_requested_by: job.cancel_requested_by ?? null,
    created_at: job.created_at,
    started_at: job.started_at,
    finished_at: job.finished_at,
    duration_ms: job.duration_ms ?? null,
    events: Array.isArray(job.events) ? job.events : [],
    ...(full ? { params: job.params ?? {}, result: job.result ?? null } : {}),
  };
}

/** GET /jobs?campaignId=&status=&limit= */
router.get('/', asyncHandler(async (req, res) => {
  const jobs = await listJobs({
    campaignId: req.query.campaignId || null,
    status: req.query.status || null,
    limit: intParam(req.query.limit, 20, { max: 100 }),
  });

  res.json({
    jobs: jobs.map((j) => mapJob(j)),
    running_here: activeJobIds().length,
    instance: INSTANCE_ID,
  });
}));

/** GET /jobs/:id — what the UI polls while a run is in flight. */
router.get('/:id', asyncHandler(async (req, res) => {
  const job = await getJob(req.params.id);
  if (!job) throw notFound('No such job');
  res.json(mapJob(job, { full: true }));
}));

/** POST /jobs/:id/cancel */
router.post('/:id/cancel', asyncHandler(async (req, res) => {
  const result = await cancelJob(req.params.id, req.body?.actor || 'operator');
  if (!result.cancelled) throw badRequest(result.reason);

  const job = await getJob(req.params.id);
  res.json(mapJob(job, { full: true }));
}));

export default router;
