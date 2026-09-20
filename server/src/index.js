/**
 * Pigeon SDR API.
 *
 * Boots whether or not it is correctly configured. A server that dies on a
 * missing variable leaves you with a container in a restart loop and nothing
 * to ask; this one starts, prints what it found, and answers /health with the
 * specific names of anything absent.
 */
import { randomUUID } from 'node:crypto';
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

import { startWorker, stopWorker } from './worker.js';
import { reapAbandonedJobs, cancelAllJobs, activeJobIds } from './orchestrator/jobs.js';

const app = express();

app.disable('x-powered-by');
app.use(express.json({ limit: '2mb' }));

/**
 * A request id on everything.
 *
 * When a run misbehaves you are reading three things at once: the browser
 * network tab, the Railway log, and a row in `agent_runs`. Without a shared
 * id, tying them together means comparing timestamps and hoping. The id is
 * echoed in the response header, so anything you can see you can grep for.
 */
app.use((req, res, next) => {
  req.id = req.get('x-request-id') || randomUUID().slice(0, 8);
  res.setHeader('x-request-id', req.id);

  const started = Date.now();
  res.on('finish', () => {
    // Health checks run every few seconds on most platforms and would bury
    // everything else. Only the interesting ones are logged.
    if (req.path.startsWith('/health') && res.statusCode < 400) return;

    const ms = Date.now() - started;
    const level = res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'log';
    console[level](`[${req.id}] ${res.statusCode} ${req.method} ${req.originalUrl} ${ms}ms`);
  });

  next();
});

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
    exposedHeaders: ['x-request-id'],
  })
);

app.get('/', (req, res) =>
  res.json({
    name: 'Pigeon SDR API',
    status: 'running',
    health: '/health',
    schema: '/health/schema',
    providers: '/health/providers',
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
console.log(
  `  models           ${report.model_auto_discover ? 'discovered from each provider' : 'fixed to the environment'}` +
    `, preferring ${report.llm_keys.groq.model} · ${report.llm_keys.gemini.model}`
);
console.log(`  discovery        ${report.discovery.source} — ${report.discovery.reason}`);
console.log(`  run concurrency  ${report.job_concurrency} prospects at a time`);
console.log('  agent routing');
for (const [agent, engine] of Object.entries(report.agent_routing)) {
  console.log(`    ${agent.padEnd(20)} ${engine}`);
}
console.log(line);

const server = app.listen(env.PORT, env.HOST, async () => {
  console.log(`Listening on http://${env.HOST}:${env.PORT}`);

  try {
    await reapAbandonedJobs();
  } catch (err) {
    console.warn(`[jobs] could not clear old jobs: ${err.message}`);
  }

  if (env.WORKER_ENABLED) startWorker();
  else console.log('Worker is off. Drive the pipeline from the app, or set WORKER_ENABLED=true.');
});

/**
 * Failing to bind is worth explaining properly, because the usual cause is
 * this server's own previous instance still holding the port after a watcher
 * restart. A bare stack trace sends people looking for a bug in their code.
 */
server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`\nPort ${env.PORT} is already in use.\n`);
    console.error('Usually this is a previous instance of this server that did not exit.');
    console.error('To find and stop it:\n');
    if (process.platform === 'win32') {
      console.error(`  netstat -ano | findstr :${env.PORT}`);
      console.error('  taskkill /PID <the number in the last column> /F\n');
      console.error('  ...or, to clear every stray node at once:');
      console.error('  taskkill /IM node.exe /F\n');
    } else {
      console.error(`  lsof -ti :${env.PORT} | xargs kill -9\n`);
    }
    console.error(`Or run this one somewhere else:  PORT=${env.PORT + 1} npm run dev\n`);
    process.exit(1);
  }

  console.error('[server] failed to start:', err);
  process.exit(1);
});

/* ── shutting down ────────────────────────────────────────────────────── */

/**
 * Every open socket, tracked.
 *
 * This is the part that makes `node --watch` usable on Windows. `server.close()`
 * stops accepting new connections but waits for the open ones to end on their
 * own, and the app polls a job every 1.5 seconds over a keep-alive connection
 * that never ends. So close() never called back, the old process stayed alive
 * holding port 3001, and the restarted one crashed with EADDRINUSE while the
 * orphan carried on serving the environment variables you had just edited.
 *
 * Tracking the sockets means we can end them ourselves and actually release
 * the port.
 */
const sockets = new Set();

server.on('connection', (socket) => {
  sockets.add(socket);
  socket.on('close', () => sockets.delete(socket));
});

// Below the platform's own idle timeouts, so a connection this server is
// finished with does not sit open waiting to be reused.
server.keepAliveTimeout = 30_000;
server.headersTimeout = 35_000;

let shuttingDown = false;

async function shutdown(signal) {
  // A second Ctrl+C means "I meant it". The first one gets a clean exit; the
  // second stops waiting.
  if (shuttingDown) {
    console.log('\nStill shutting down. Forcing exit.');
    process.exit(1);
  }
  shuttingDown = true;

  console.log(`\n${signal} received, shutting down.`);

  // Nothing new gets picked up while we are leaving.
  stopWorker();

  // In-flight jobs hold open model calls that can run for another thirty
  // seconds. Cancelling aborts them, so the process is not kept alive by work
  // nobody is waiting for any more.
  const running = activeJobIds().length;
  if (running > 0) {
    console.log(`  cancelling ${running} running job${running === 1 ? '' : 's'}`);
    try {
      await cancelAllJobs('shutdown');
    } catch (err) {
      console.warn(`  could not cancel cleanly: ${err.message}`);
    }
  }

  // Last resort. If something is genuinely stuck, exiting late is better than
  // holding the port forever, which is the failure this whole block is about.
  const giveUp = setTimeout(() => {
    console.warn('  shutdown took too long, exiting anyway.');
    process.exit(1);
  }, env.SHUTDOWN_TIMEOUT_MS);
  giveUp.unref();

  server.close((err) => {
    if (err) console.warn(`  server.close: ${err.message}`);
    clearTimeout(giveUp);
    console.log(`  port ${env.PORT} released.`);
    process.exit(0);
  });

  // Give requests already in progress a moment to answer, then end every
  // remaining socket so close() can finish.
  setTimeout(() => {
    for (const socket of sockets) socket.destroy();
    sockets.clear();
  }, env.SHUTDOWN_GRACE_MS);
}

// SIGINT is Ctrl+C. SIGTERM is what Railway and `node --watch` send.
// SIGUSR2 is nodemon's restart signal. SIGBREAK is Ctrl+Break on Windows.
for (const signal of ['SIGINT', 'SIGTERM', 'SIGUSR2', 'SIGBREAK']) {
  try {
    process.on(signal, () => shutdown(signal));
  } catch {
    // Not every signal exists on every platform. Missing one is not a reason
    // to refuse to boot.
  }
}

/**
 * A crash should still release the port. Without this, an unhandled error
 * leaves the process wedged and the next `npm run dev` fails to bind for a
 * reason that has nothing to do with the code you just changed.
 */
process.on('uncaughtException', (err) => {
  console.error('[fatal] uncaught exception:', err);
  shutdown('uncaughtException');
});

process.on('unhandledRejection', (reason) => {
  console.error('[fatal] unhandled rejection:', reason);
  shutdown('unhandledRejection');
});

export default app;
