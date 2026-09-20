/**
 * One-time: clears everything 02-seed.sql wrote, so the app starts genuinely
 * empty for a real test run built through the UI instead of the demo seed.
 * Leaves system_control (kill switch state) alone — that isn't seed data.
 *
 *   node scripts/reset-seed.js
 */
import { createClient } from '@supabase/supabase-js';
import { env } from '../src/config.js';

const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);

// Children before parents, to respect foreign keys.
const TABLES = [
  'approvals',
  'messages',
  'agent_runs',
  'activities',
  'prompt_versions',
  'suppression_list',
  'knowledge_chunks',
  'campaign_prospects',
  'prospects',
  'campaigns',
  'reps',
];

for (const table of TABLES) {
  const { error, count } = await supabase
    .from(table)
    .delete({ count: 'exact' })
    .not('id', 'is', null);
  if (error) {
    console.error(`✗ ${table}: ${error.message}`);
  } else {
    console.log(`✓ ${table}: ${count ?? 0} row(s) deleted`);
  }
}

console.log('\nDone. The app now starts from zero — create a campaign through the UI.');
