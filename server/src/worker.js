/**
 * The background worker.
 *
 * Off by default. During a demo you drive the pipeline from the app, and a
 * worker firing between takes spends budget and moves prospects out from
 * under you. Turn it on with WORKER_ENABLED=true for a deployment that should
 * keep working without anyone watching.
 *
 * It has one question: which prospects are due? Everything else, including
 * every stop control, is handled by `advance` and the gate it calls.
 */
import { env } from './config.js';
import { supabase, unwrapSoft, dbReady } from './db/client.js';
import { advance } from './orchestrator/index.js';
import { getSystemControl } from './orchestrator/gate.js';

let timer = null;
let running = false;

async function tick() {
  // Overlapping ticks would process the same prospect twice, so a slow pass
  // skips the next one rather than stacking on top of it.
  if (running) return;
  running = true;

  try {
    const control = await getSystemControl();
    if (control.kill_switch) return;

    const due = unwrapSoft(
      await supabase
        .from('campaign_prospects')
        .select('campaign_id, prospect_id, campaigns!inner(status)')
        .eq('paused', false)
        .eq('campaigns.status', 'live')
        .not('next_action_at', 'is', null)
        .lte('next_action_at', new Date().toISOString())
        .order('next_action_at', { ascending: true })
        .limit(env.WORKER_BATCH_SIZE),
      [],
      'worker scan'
    );

    for (const row of due) {
      const result = await advance(row.campaign_id, row.prospect_id);
      if (result.status === 'error') {
        console.warn(`[worker] ${row.prospect_id}: ${result.reason}`);
      }
    }

    if (due.length) console.log(`[worker] processed ${due.length}`);
  } catch (err) {
    console.error('[worker] tick failed:', err.message);
  } finally {
    running = false;
  }
}

export function startWorker() {
  if (!dbReady) {
    console.warn('[worker] not started: the database is not configured.');
    return;
  }
  if (timer) return;

  console.log(`[worker] on, every ${env.WORKER_POLL_MS}ms, up to ${env.WORKER_BATCH_SIZE} per pass.`);
  timer = setInterval(tick, env.WORKER_POLL_MS);
  timer.unref?.();
}

export function stopWorker() {
  if (timer) clearInterval(timer);
  timer = null;
}
