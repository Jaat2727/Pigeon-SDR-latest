/**
 * Numbers.
 *
 * Everything here is counted from rows at the moment it is asked for. Nothing
 * is stored, incremented or cached, which means a number on screen can never
 * drift away from the data behind it, and a conversion rate is always the two
 * counts it claims to be.
 *
 * Where a number needs an assumption to exist at all, the assumption is
 * returned beside it and the UI prints it. A reply rate that quietly excludes
 * auto-replies is a different number from one that does not, and the reader
 * deserves to know which one they are looking at.
 */
import { supabase, unwrapSoft } from '../db/client.js';
import { VISIBLE_AGENTS } from '../agents/registry.js';

/**
 * Which funnel stage a state counts towards.
 *
 * The funnel is cumulative: anyone who reached `contacted` was necessarily
 * researched and qualified first, so they count at every earlier stage too.
 * Without that, a prospect moving forward makes an earlier bar go down, which
 * is the single most common way a funnel chart lies.
 */
const STAGE_RANK = {
  discovered: 0,
  researched: 1,
  rejected: 1,      // researched, then turned down
  needs_review: 1,  // researched, decision pending
  suppressed: 1,
  qualified: 2,
  strategy_planned: 2,
  stopped: 2,
  contacted: 3,
  opted_out: 3,
  engaged: 4,
  meeting: 5,
  opportunity: 5,
};

const STAGES = [
  { key: 'discovered', label: 'Discovered' },
  { key: 'researched', label: 'Researched' },
  { key: 'qualified', label: 'Qualified' },
  { key: 'contacted', label: 'Contacted' },
  { key: 'engaged', label: 'Replied' },
  { key: 'meeting', label: 'Meeting' },
];

export async function computeFunnel(campaignId = null) {
  let query = supabase.from('campaign_prospects').select('state');
  if (campaignId) query = query.eq('campaign_id', campaignId);

  const rows = unwrapSoft(await query, [], 'campaign_prospects');

  const counts = STAGES.map((stage, rank) => ({
    ...stage,
    count: rows.filter((r) => (STAGE_RANK[r.state] ?? 0) >= rank).length,
  }));

  const byState = rows.reduce((acc, r) => {
    acc[r.state] = (acc[r.state] ?? 0) + 1;
    return acc;
  }, {});

  return {
    stages: counts,
    by_state: byState,
    total: rows.length,
    assumption:
      'Cumulative. A prospect who reached a later stage is counted at every stage before it, ' +
      'so moving forward never makes an earlier number fall.',
  };
}

/** Agent performance, counted from agent_runs. */
export async function computeAgentPerformance(campaignId = null) {
  let query = supabase
    .from('agent_runs')
    .select('agent_name, engine, status, tokens, cost_usd, latency_ms, created_at')
    .order('created_at', { ascending: false })
    .limit(2000);

  if (campaignId) query = query.eq('campaign_id', campaignId);

  const runs = unwrapSoft(await query, [], 'agent_runs');
  const since = new Date();
  since.setUTCHours(0, 0, 0, 0);

  return VISIBLE_AGENTS.map((agent) => {
    const mine = runs.filter((r) => r.agent_name === agent.id);
    const today = mine.filter((r) => new Date(r.created_at) >= since);
    const ok = mine.filter((r) => r.status === 'success').length;
    const degraded = mine.filter((r) => r.status === 'degraded').length;
    const failed = mine.filter((r) => r.status === 'failed').length;
    const latencies = mine.map((r) => r.latency_ms).filter((n) => Number.isFinite(n));

    return {
      id: agent.id,
      name: agent.name,
      configured_engine: agent.engine,
      callable: agent.callable,
      runs: mine.length,
      runs_today: today.length,
      succeeded: ok,
      degraded,
      failed,
      // A degraded run produced usable output, so it is not a failure. It is
      // also not a clean success, which is why it is reported on its own.
      success_rate: mine.length ? Math.round(((ok + degraded) / mine.length) * 100) : null,
      clean_rate: mine.length ? Math.round((ok / mine.length) * 100) : null,
      // A local run finishes in under a millisecond and reports 0. That is a
      // measurement, not a missing value, so it must not be turned into null.
      avg_latency_ms: latencies.length
        ? Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length)
        : null,
      cost_usd: Number(mine.reduce((sum, r) => sum + Number(r.cost_usd ?? 0), 0).toFixed(4)),
      tokens: mine.reduce((sum, r) => sum + (r.tokens ?? 0), 0),
      // The engine that actually served the most recent run, which is not
      // always the one the agent is configured for.
      last_engine: mine[0]?.engine ?? null,
      last_run_at: mine[0]?.created_at ?? null,
      engines_used: [...new Set(mine.map((r) => r.engine))],
    };
  });
}

/** The headline counters on the Queue screen. */
export async function computeQueueStats() {
  const since = new Date();
  since.setUTCHours(0, 0, 0, 0);
  const iso = since.toISOString();

  const [approvals, runsToday, messagesToday, replies, dueNow] = await Promise.all([
    supabase.from('approvals').select('type').eq('status', 'open'),
    supabase.from('agent_runs').select('engine, status').gte('created_at', iso),
    supabase.from('messages').select('id').eq('direction', 'outbound').eq('status', 'sent').gte('sent_at', iso),
    supabase.from('messages').select('id, is_auto_reply').eq('direction', 'inbound'),
    supabase
      .from('campaign_prospects')
      .select('id')
      .eq('paused', false)
      .not('next_action_at', 'is', null)
      .lte('next_action_at', new Date().toISOString()),
  ]);

  const openApprovals = unwrapSoft(approvals, [], 'approvals');
  const runs = unwrapSoft(runsToday, [], 'agent_runs');
  const inbound = unwrapSoft(replies, [], 'messages');

  const byType = openApprovals.reduce((acc, a) => {
    acc[a.type] = (acc[a.type] ?? 0) + 1;
    return acc;
  }, {});

  return {
    open_approvals: openApprovals.length,
    approvals_by_type: byType,
    agent_runs_today: runs.length,
    fallback_runs_today: runs.filter((r) => r.engine === 'local_engine').length,
    failed_runs_today: runs.filter((r) => r.status === 'failed').length,
    messages_sent_today: unwrapSoft(messagesToday, [], 'messages').length,
    replies_total: inbound.length,
    human_replies_total: inbound.filter((r) => !r.is_auto_reply).length,
    due_now: unwrapSoft(dueNow, [], 'campaign_prospects').length,
  };
}
