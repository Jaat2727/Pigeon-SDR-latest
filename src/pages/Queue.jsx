/**
 * The home screen. What needs a person, first. The pipeline above it is
 * context, not the point.
 */
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useApp } from '../context/AppContext.jsx';
import { ConnectionBanner } from '../App.jsx';
import * as api from '../api/index.js';
import { friendlyError } from '../api/client.js';
import {
  ActionButton, Banner, Empty, Icons, Loading, Note, Pill,
  Pipeline, Score, StateTag, when,
} from '../components/ui.jsx';
import HistoryModal from '../components/HistoryModal.jsx';

const TYPE_LABEL = {
  message_approval: 'Message to approve',
  icp_review: 'Scoring needs a decision',
  reply_escalation: 'Reply needs you',
  duplicate_conflict: 'Duplicate across campaigns',
};

const TYPE_TONE = {
  message_approval: 'blue',
  icp_review: 'warn',
  reply_escalation: 'stop',
  duplicate_conflict: 'warn',
};

function ApprovalItem({ item, onDone }) {
  const { actor, setError } = useApp();
  const [open, setOpen] = useState(item.type === 'message_approval');
  const [result, setResult] = useState(null);

  const act = async (fn) => {
    try {
      const res = await fn();
      // A send the gate refused is not a success, and saying "sent" here would
      // be the single most misleading thing this screen could do.
      if (res?.outcome?.action === 'blocked') setResult(res.outcome.reason);
      else await onDone();
    } catch (err) {
      setError(friendlyError(err));
    }
  };

  const msg = item.message;

  return (
    <div className="q-item">
      <div className="q-head">
        <Pill tone={TYPE_TONE[item.type] ?? 'grey'}>{TYPE_LABEL[item.type] ?? item.type}</Pill>
        {item.prospect_id ? (
          <Link to={`/prospects/${item.prospect_id}`} className="q-who">
            {item.prospect_name}
          </Link>
        ) : (
          <span className="q-who">{item.prospect_name ?? '—'}</span>
        )}
        {item.prospect_company && <span className="small muted">{item.prospect_company}</span>}
        <div className="spacer" />
        <span className="tiny muted">{when(item.created_at)}</span>
      </div>

      <div className="q-reason">{item.reason}</div>

      {item.campaign_name && (
        <div className="tiny muted" style={{ marginTop: 3 }}>
          {item.campaign_name} · raised by {item.source_agent_name}
        </div>
      )}

      {msg && (
        <>
          <button className="btn ghost sm" style={{ marginTop: 8 }} onClick={() => setOpen(!open)}>
            <Icons.chevron size={12} style={{ transform: open ? 'rotate(90deg)' : 'none' }} />
            {open ? 'Hide draft' : 'Show draft'}
          </button>
          {open && (
            <div className="draft">
              <div className="draft-head">
                <Pill tone="line">{msg.channel}</Pill>
                {msg.step && <span>Touch {msg.step}</span>}
                {msg.subject && <span className="dim">{msg.subject}</span>}
                <div className="spacer" />
                {msg.knowledge_used?.length > 0 && (
                  <span className="tiny">
                    {msg.knowledge_used.length} source{msg.knowledge_used.length === 1 ? '' : 's'}
                  </span>
                )}
              </div>
              <div className="draft-body">{msg.body}</div>
            </div>
          )}
        </>
      )}

      {item.type === 'icp_review' && item.payload && (
        <div className="row wrap" style={{ marginTop: 8, gap: 8 }}>
          <span className="small muted">Score</span>
          <Score value={item.payload.fit_score} />
          {(item.payload.missing_data ?? []).length > 0 && (
            <span className="tiny muted">
              missing: {item.payload.missing_data.join(', ')}
            </span>
          )}
        </div>
      )}

      {item.type === 'duplicate_conflict' && item.payload?.campaigns && (
        <div className="row wrap" style={{ marginTop: 8, gap: 6 }}>
          {item.payload.campaigns.map((c) => (
            <span className="chip" key={c.id}>{c.name} · {c.state.replace(/_/g, ' ')}</span>
          ))}
        </div>
      )}

      {result && (
        <div style={{ marginTop: 9 }}>
          <Banner tone="warn">{result}</Banner>
        </div>
      )}

      <div className="q-actions">
        <ActionButton
          className="btn primary sm"
          onClick={() => act(() => api.approve(item.id, { actor }))}
        >
          <Icons.check size={13} />
          {item.type === 'message_approval' ? 'Approve and send' :
           item.type === 'icp_review' ? 'Qualify' :
           item.type === 'duplicate_conflict' ? 'Keep in this campaign' : 'Mark handled'}
        </ActionButton>

        {item.type === 'message_approval' && (
          <ActionButton
            className="btn sm"
            title="Send this, then draft the next touch straight away"
            onClick={() => act(() => api.approveAndContinue(item.id, { actor }))}
          >
            Approve and continue
          </ActionButton>
        )}

        <ActionButton
          className="btn sm"
          onClick={() => act(() => api.reject(item.id, { actor }))}
        >
          <Icons.x size={13} />
          {item.type === 'icp_review' ? 'Reject' : 'Discard'}
        </ActionButton>
      </div>
    </div>
  );
}


export default function Queue() {
  const { queue, campaigns, scope, setScope, refresh, connection, setError } = useApp();
  const [running, setRunning] = useState(false);
  const [lastRun, setLastRun] = useState(null);
  const [filter, setFilter] = useState('all');
  const [historyOpen, setHistoryOpen] = useState(false);

  const live = campaigns.filter((c) => c.status === 'live');
  const target = scope || live[0]?.id;

  const run = async () => {
    if (!target) return;
    setRunning(true);
    setLastRun(null);
    try {
      const res = await api.runCampaign(target, { limit: 8 });
      setLastRun(res);
      await refresh();
    } catch (err) {
      setError(friendlyError(err));
    } finally {
      setRunning(false);
    }
  };

  const approvals = queue?.approvals ?? [];
  const shown = filter === 'all' ? approvals : approvals.filter((a) => a.type === filter);
  const counts = queue?.stats?.approvals_by_type ?? {};

  const campaignName = campaigns.find((c) => c.id === target)?.name;

  return (
    <>
      <div className="topbar">
        <div>
          <div className="page-title">Queue</div>
          <div className="page-sub">What the system needs a person for</div>
        </div>
        <div className="spacer" />
        <select className="select" style={{ width: 210 }} value={scope} onChange={(e) => setScope(e.target.value)}>
          <option value="">All campaigns</option>
          {campaigns.map((c) => (
            <option key={c.id} value={c.id}>{c.name}</option>
          ))}
        </select>
        <button className="btn ghost sm" onClick={() => setHistoryOpen(true)} title="History">
          <Icons.activity size={14} />
          History
        </button>
        <button className="btn ghost sm" onClick={refresh} title="Refresh">
          <Icons.refresh size={14} />
        </button>
        <button className="btn primary" onClick={run} disabled={running || !target || connection !== 'connected'}>
          {running ? <span className="spin" /> : <Icons.play size={13} />}
          Run {campaignName ? 'campaign' : ''}
        </button>
      </div>

      <div className="content stack">
        <ConnectionBanner />

        {lastRun && (
          <Banner tone="info">
            Picked up {lastRun.picked_up} prospect{lastRun.picked_up === 1 ? '' : 's'} and advanced{' '}
            {lastRun.advanced}. Everything below was written by that run.
          </Banner>
        )}

        {!queue && connection === 'connected' && <Loading label="Loading the queue" />}

        {queue && (
          <>
            <Pipeline funnel={queue.funnel} />

            <div className="panel">
              <div className="panel-body">
                <div className="stats">
                  <div>
                    <div className="stat-n">{queue.stats.open_approvals}</div>
                    <div className="stat-l">waiting on you</div>
                  </div>
                  <div>
                    <div className="stat-n">{queue.stats.agent_runs_today}</div>
                    <div className="stat-l">agent runs today</div>
                  </div>
                  <div>
                    <div className="stat-n">{queue.stats.fallback_runs_today}</div>
                    <div className="stat-l">served by fallback</div>
                  </div>
                  <div>
                    <div className="stat-n">{queue.stats.messages_sent_today}</div>
                    <div className="stat-l">sent today</div>
                  </div>
                  <div>
                    <div className="stat-n">{queue.stats.human_replies_total}</div>
                    <div className="stat-l">replies from people</div>
                  </div>
                  <div>
                    <div className="stat-n">{queue.stats.due_now}</div>
                    <div className="stat-l">due now</div>
                  </div>
                </div>
                {queue.stats.fallback_runs_today > 0 && (
                  <Note>
                    {queue.stats.fallback_runs_today} of today&apos;s {queue.stats.agent_runs_today} runs
                    were answered by the built-in engine rather than a real model call. Every one is
                    labelled as such on the prospect it belongs to.
                  </Note>
                )}
              </div>
            </div>

            <div className="panel">
              <div className="panel-head">
                <h2>Needs a person</h2>
                <div className="spacer" />
                <div className="tabs" style={{ border: 0 }}>
                  <button className={`tab ${filter === 'all' ? 'on' : ''}`} onClick={() => setFilter('all')}>
                    All {approvals.length > 0 && `(${approvals.length})`}
                  </button>
                  {Object.entries(counts).map(([type, n]) => (
                    <button
                      key={type}
                      className={`tab ${filter === type ? 'on' : ''}`}
                      onClick={() => setFilter(type)}
                    >
                      {TYPE_LABEL[type]?.split(' ')[0] ?? type} ({n})
                    </button>
                  ))}
                </div>
              </div>
              <div className={shown.length === 0 ? 'panel-body' : 'q-list'}>
                {shown.length === 0 ? (
                  <Empty
                    title={approvals.length === 0 ? 'Nothing is waiting on you' : 'Nothing of that kind'}
                    sub={
                      approvals.length === 0
                        ? 'Press Run on a campaign to move prospects through the pipeline.'
                        : 'Try another filter.'
                    }
                  />
                ) : (
                  shown.map((a) => <ApprovalItem key={a.id} item={a} onDone={refresh} />)
                )}
              </div>
            </div>
          </>
        )}
      </div>

      {historyOpen && <HistoryModal onClose={() => setHistoryOpen(false)} />}
    </>
  );
}
