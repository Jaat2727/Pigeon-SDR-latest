/**
 * Pigeon SDR API.
 *
 * Boots whether or not it is correctly configured. A server that crashes on a
 * missing variable leaves you with a container in a restart loop and nothing
 * to ask; this one starts, prints what it found, and answers /health with the
 * specific names of anything absent.
 */
import express from 'express';
import cors from 'cors';

import { env, configReport } from './config.js';
import { requireDb } from './db/client.js';
import { notFoundHandler, errorHandler } from './lib/http.js';

import healthRoutes from './routes/health.js';
import queueRoutes from './routes/queue.js';
import campaignRoutes from './routes/campaigns.js';
import prospectRoutes from './routes/prospects.js';
import agentRoutes from './routes/agents.js';
import knowledgeRoutes from './routes/knowledge.js';
import controlRoutes from './routes/controls.js';
import repRoutes from './routes/reps.js';
import jobRoutes from './routes/jobs.js';

import { startWorker } from './worker.js';
import { reapAbandonedJobs } from './orchestrator/jobs.js';

const app = express();

app.disable('x-powered-by');
app.use(express.json({ limit: '2mb' }));

/**
 * CORS. Origins come from CORS_ORIGINS, plus any vercel.app preview once one
 * vercel.app origin is listed, so a new preview deployment is not a config
 * change every time.
 */
const allowed = new Set(env.CORS_ORIGINS);

app.use(
  cors({
    origin(origin, callback) {
      // No origin: curl, server to server, same-origin. Allow it.
      if (!origin) return callback(null, true);

      const clean = origin.replace(/\/+$/, '');
      if (allowed.has(clean)) return callback(null, true);

      const isVercelPreview =
        /^https:\/\/[a-z0-9-]+\.vercel\.app$/i.test(clean) &&
        [...allowed].some((o) => o.endsWith('.vercel.app'));
      if (isVercelPreview) return callback(null, true);

      return callback(new Error(`Origin ${origin} is not in CORS_ORIGINS`));
    },
    credentials: true,
  })
);

app.get('/', (req, res) =>
  res.json({
    name: 'Pigeon SDR API',
    status: 'running',
    health: '/health',
    schema: '/health/schema',
  })
);

app.use('/health', healthRoutes);

// Everything past here needs the database, so one guard covers all of it.
app.use(requireDb);

app.use('/queue', queueRoutes);
app.use('/campaigns', campaignRoutes);
app.use('/prospects', prospectRoutes);
app.use('/agents', agentRoutes);
app.use('/knowledge', knowledgeRoutes);
app.use('/controls', controlRoutes);
app.use('/reps', repRoutes);
app.use('/jobs', jobRoutes);

app.use(notFoundHandler);
app.use(errorHandler);

/* ── boot ─────────────────────────────────────────────────────────────── */

const report = configReport();
const line = '─'.repeat(62);

console.log(line);
console.log('Pigeon SDR API');
console.log(`  node             ${report.node_version}`);
console.log(`  environment      ${report.node_env}`);
console.log(`  database         ${report.database_configured ? 'configured' : 'NOT CONFIGURED'}`);
if (report.missing_required.length) {
  console.log(`  missing env      ${report.missing_required.join(', ')}`);
}
console.log(`  cors origins     ${report.cors_origins.join(', ')}`);
console.log(
  `  llm keys         groq ${report.llm_keys.groq.configured}/${report.llm_keys.groq.max} · ` +
    `gemini ${report.llm_keys.gemini.configured}/${report.llm_keys.gemini.max}`
);
console.log(`  models           ${report.llm_keys.groq.model} · ${report.llm_keys.gemini.model}`);
console.log(`  discovery        ${report.discovery.source} — ${report.discovery.reason}`);
console.log(`  run concurrency  ${report.job_concurrency} prospects at a time`);
console.log('  agent routing');
for (const [agent, engine] of Object.entries(report.agent_routing)) {
  console.log(`    ${agent.padEnd(20)} ${engine}`);
}
console.log(line);

const server = app.listen(env.PORT, env.HOST, async () => {
  console.log(`Listening on http://${env.HOST}:${env.PORT}`);

  // A job that was mid-flight when this process last died cannot be resumed,
  // so it is closed out with a reason instead of sitting at "running" forever
  // and blocking its campaign from starting a new one.
  try {
    await reapAbandonedJobs();
  } catch (err) {
    console.warn(`[jobs] could not clear old jobs: ${err.message}`);
  }

  if (env.WORKER_ENABLED) startWorker();
  else console.log('Worker is off. Drive the pipeline from the app, or set WORKER_ENABLED=true.');
});

for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    console.log(`\n${signal} received, shutting down.`);
    server.close(() => process.exit(0));
  });
}

export default app;
