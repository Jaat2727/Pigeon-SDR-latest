/**
 * Health and schema checks.
 *
 * These exist so a broken deploy explains itself in one browser request
 * instead of through a stack trace in a log tab. /health answers even when
 * the database is unreachable, which is the case where you most need it to.
 */
import express from 'express';
import { supabase, dbReady } from '../db/client.js';
import { asyncHandler } from '../lib/http.js';
import { configReport } from '../config.js';
import { keyHealth } from '../agents/keyPool.js';
import { catalogStatus } from '../agents/modelCatalog.js';
import { pingApollo, isApolloConfigured } from '../services/discovery/apollo.js';

const router = express.Router();

const EXPECTED_TABLES = [
  'reps', 'campaigns', 'prospects', 'campaign_prospects', 'agent_runs',
  'messages', 'activities', 'approvals', 'knowledge_chunks',
  'suppression_list', 'prompt_versions', 'system_control',
  // From db/04-runtime.sql. Absent means jobs cannot be recorded, which the
  // schema check names specifically rather than leaving as a 500 on first run.
  'job_runs',
];

router.get('/', asyncHandler(async (req, res) => {
  const config = configReport();

  if (!dbReady) {
    return res.status(200).json({
      status: 'degraded',
      database: 'not_configured',
      message: `Missing: ${config.missing_required.join(', ')}. Set these in the API environment.`,
      config,
    });
  }

  const started = Date.now();
  const { error } = await supabase.from('system_control').select('id').limit(1);

  if (error) {
    return res.status(200).json({
      status: 'degraded',
      database: 'unreachable',
      message: error.message,
      hint: 'Check that SUPABASE_URL points at the right project and the service role key is current.',
      config,
    });
  }

  res.json({
    status: 'ok',
    database: 'connected',
    db_latency_ms: Date.now() - started,
    uptime_s: Math.round(process.uptime()),
    keys: keyHealth(),
    models: catalogStatus(),
    config,
  });
}));

/**
 * GET /health/providers
 *
 * Proves the outbound side works: which keys this process holds and what
 * state each is in, plus a one-record Apollo search that spends no credits.
 * Separate from /health because it makes a real network call, and a liveness
 * check that depends on a third party is not a liveness check.
 */
router.get('/providers', asyncHandler(async (req, res) => {
  const apollo = req.query.probe === 'false' || !isApolloConfigured()
    ? { configured: isApolloConfigured() }
    : await pingApollo();

  res.json({
    llm: keyHealth(),
    models: catalogStatus(),
    apollo,
    discovery: configReport().discovery,
  });
}));

/**
 * Which tables the schema file was supposed to create, and which are actually
 * there. A missing table here means the SQL was not run, or was run against a
 * different project.
 */
router.get('/schema', asyncHandler(async (req, res) => {
  if (!dbReady) {
    return res.status(503).json({ ok: false, message: 'Database is not configured' });
  }

  const results = await Promise.all(
    EXPECTED_TABLES.map(async (table) => {
      const { error, count } = await supabase.from(table).select('*', { count: 'exact', head: true });
      return { table, present: !error, rows: count ?? 0, error: error?.message ?? null };
    })
  );

  const missing = results.filter((r) => !r.present).map((r) => r.table);

  res.json({
    ok: missing.length === 0,
    missing,
    tables: results,
    message: missing.length
      ? missing.length === 1 && missing[0] === 'job_runs'
        ? 'Run server/db/04-runtime.sql in the Supabase SQL editor. Everything else is present, but runs cannot be recorded without job_runs.'
        : `Run server/db/01-schema.sql, then 04-runtime.sql, in the Supabase SQL editor. Missing: ${missing.join(', ')}.`
      : `All ${EXPECTED_TABLES.length} tables are present.`,
  });
}));

export default router;
