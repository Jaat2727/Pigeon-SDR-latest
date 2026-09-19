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

const router = express.Router();

const EXPECTED_TABLES = [
  'reps', 'campaigns', 'prospects', 'campaign_prospects', 'agent_runs',
  'messages', 'activities', 'approvals', 'knowledge_chunks',
  'suppression_list', 'prompt_versions', 'system_control',
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
    config,
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
      ? `Run server/db/01-schema.sql in the Supabase SQL editor. Missing: ${missing.join(', ')}.`
      : 'All twelve tables are present.',
  });
}));

export default router;
