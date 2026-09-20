/**
 * Inbox: every send and every reply, across every campaign, one screen.
 *
 * Not a second mailbox — the same `messages` table every prospect's thread
 * already reads from, just not pre-filtered down to one person. Laid out as
 * a list and a reading pane rather than a table, because that is the shape
 * this content actually has: one thing to scan, one thing to read closely,
 * rarely both at once.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useApp } from '../context/AppContext.jsx';
import { ConnectionBanner } from '../App.jsx';
import * as api from '../api/index.js';
import { friendlyError } from '../api/client.js';
import {
  ActionButton, Banner, Empty, EngineTag, Icons, Loading, Modal, Pill, labelOf, when, fullDate,
} from '../components/ui.jsx';

const DIRECTION_TABS = [
  { key: '', label: 'All' },
  { key: 'needsReply', label: 'Needs a reply' },
  { key: 'outbound', label: 'Sent' },
  { key: 'inbound', label: 'Received' },
];

const STATUS_TONE = {
  sent: 'ok', received: 'blue', pending_approval: 'warn',
  failed: 'stop', scheduled: 'line', draft: 'grey', approved: 'line',
};

const AVATAR_HUES = ['#f97316', '#8b5cf6', '#0ea5e9', '#10b981', '#e11d48', '#ca8a04', '#6366f1'];
const hueFor = (name) => {
  let h = 0;
  for (let i = 0; i < name.length; i += 1) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return AVATAR_HUES[h % AVATAR_HUES.length];
};

function Avatar({ name, size = 36 }) {
  const initial = (name || '?').trim().charAt(0).toUpperCase() || '?';
  const hue = hueFor(name || '?');
  return (
    <div
      className="avatar"
      style={{ width: size, height: size, fontSize: size * 0.42, background: `${hue}1f`, color: hue }}
    >
      {initial}
    </div>
  );
}

function ReplyModal({ message, onClose, onDone }) {
  const [body, setBody] = useState('');
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);

  return (
    <Modal
      title={`Simulate a reply · ${message.prospect_name}`}
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>Close</button>
          <ActionButton
            className="btn primary"
            disabled={!body.trim()}
            onClick={async () => {
              setError(null);
              try {
                const res = await api.sendReply(message.prospect_id, {
                  campaignId: message.campaign_id,
                  body: body.trim(),
                });
                setResult(res);
                await onDone();
              } catch (err) {
                setError(friendlyError(err));
              }
            }}
          >
            <Icons.send size={13} /> Send as {message.prospect_name}
          </ActionButton>
        </>
      }
    >
      <div className="stack-sm">
        <Banner tone="info">
          No inbox is connected, so a reply is typed in here — it then goes through the exact path
          a real one would: the conversation agent reads it, classifies it, and moves this prospect
          in <b>{message.campaign_name}</b> according to what they actually said.
        </Banner>

        {error && <Banner tone="stop">{error}</Banner>}

        <div className="field">
          <label className="label">What they wrote back</label>
          <textarea
            className="textarea"
            rows={4}
            value={body}
            onChange={(e) => setBody(e.target.value)}
            placeholder="Try: Sounds useful, can we talk Tuesday? Also what does pricing look like?"
            autoFocus
          />
          <span className="hint">Try an opt-out, a pricing question, or a referral — each takes a different path.</span>
        </div>

        {result && (
          <div className="panel">
            <div className="panel-body stack-sm">
              <div className="row wrap">
                <Pill tone="blue">{labelOf(result.intent)}</Pill>
                <Pill tone="grey">{result.output.sentiment}</Pill>
                <Pill tone="line">{Math.round(result.output.intent_confidence * 100)}% confident</Pill>
                <EngineTag engine={result.engine} />
                {result.output.requires_human && <Pill tone="warn">a person handles this</Pill>}
              </div>
              <div className="small dim">{result.output.recommended_action}</div>
              {result.output.escalation_reason && (
                <div className="small muted">{result.output.escalation_reason}</div>
              )}
            </div>
          </div>
        )}
      </div>
    </Modal>
  );
}

function ListRow({ m, active, onClick }) {
  return (
    <button className={`inbox-row ${active ? 'on' : ''} ${m.direction}`} onClick={onClick}>
      <Avatar name={m.prospect_name} />
      <div className="inbox-row-main">
        <div className="inbox-row-top">
          <span className="inbox-row-name">{m.prospect_name}</span>
          <span className="inbox-row-time">{when(m.created_at)}</span>
        </div>
        <div className="inbox-row-sub">
          {m.direction === 'inbound' ? <Icons.corner size={11} /> : <Icons.send size={11} />}
          <span className="inbox-row-snippet">{m.subject ? `${m.subject} — ${m.body}` : m.body}</span>
        </div>
        <div className="inbox-row-meta">
          <span>{m.campaign_name ?? 'no campaign'}</span>
          <span className="dot-sep" />
          <span>{m.channel}</span>
          {m.intent && <><span className="dot-sep" /><span>{labelOf(m.intent)}</span></>}
        </div>
      </div>
      {m.direction === 'inbound' && <i className="inbox-row-flag" />}
    </button>
  );
}

function Detail({ m, onReply }) {
  if (!m) {
    return (
      <div className="inbox-empty">
        <Icons.mail size={26} />
        <div className="small dim" style={{ marginTop: 10 }}>Select a message to read it</div>
      </div>
    );
  }

  return (
    <div className="inbox-detail">
      <div className="inbox-detail-head">
        <Avatar name={m.prospect_name} size={44} />
        <div style={{ minWidth: 0 }}>
          <div className="inbox-detail-name">{m.prospect_name}</div>
          <div className="tiny muted">
            {m.prospect_company && `${m.prospect_company} · `}
            <Link to={`/prospects/${m.prospect_id}`}>open full thread</Link>
          </div>
        </div>
        <div className="spacer" />
        <Pill tone={m.direction === 'inbound' ? 'blue' : 'grey'}>{m.direction === 'inbound' ? 'received' : 'sent'}</Pill>
        <Pill tone={STATUS_TONE[m.status] ?? 'grey'}>{labelOf(m.status)}</Pill>
      </div>

      <div className="inbox-detail-tags">
        <Pill tone="line">{m.campaign_name ?? 'no campaign'}</Pill>
        <Pill tone="line">{m.channel}</Pill>
        {m.intent && <Pill tone="blue">{labelOf(m.intent)}</Pill>}
        {m.sentiment && <Pill tone="grey">{m.sentiment}</Pill>}
      </div>

      {m.subject && <h2 className="inbox-detail-subject">{m.subject}</h2>}

      <div className="inbox-detail-body">{m.body}</div>

      <div className="inbox-detail-foot">
        <span className="tiny muted">{fullDate(m.created_at)}</span>
        <div className="spacer" />
        <ActionButton className="btn sm primary" onClick={() => onReply(m)}>
          <Icons.corner size={13} /> Simulate a reply
        </ActionButton>
      </div>
    </div>
  );
}

export default function Inbox() {
  const { campaigns, setError, connection } = useApp();
  const [messages, setMessages] = useState(null);
  const [stats, setStats] = useState(null);
  const [tab, setTab] = useState('');
  const [campaignFilter, setCampaignFilter] = useState('');
  const [selectedId, setSelectedId] = useState(null);
  const [replying, setReplying] = useState(null);

  const load = useCallback(async () => {
    try {
      const params = { campaignId: campaignFilter || undefined, limit: 100 };
      if (tab === 'needsReply') params.needsReply = 'true';
      else if (tab) params.direction = tab;

      const [msgs, s] = await Promise.all([api.listMessages(params), api.getMessageStats()]);
      setMessages(msgs);
      setStats(s);
      setSelectedId((current) => (msgs.some((m) => m.id === current) ? current : msgs[0]?.id ?? null));
    } catch (err) {
      setError(friendlyError(err));
      setMessages([]);
    }
  }, [tab, campaignFilter, setError]);

  useEffect(() => { load(); }, [load]);

  const selected = useMemo(() => messages?.find((m) => m.id === selectedId) ?? null, [messages, selectedId]);

  return (
    <>
      <div className="topbar">
        <div>
          <div className="page-title">Inbox</div>
          <div className="page-sub">Every send and every reply, across every campaign</div>
        </div>
        <div className="spacer" />
        {stats && (
          <span className="tiny muted" style={{ marginRight: 4 }}>
            {stats.sent} sent · {stats.received} received
          </span>
        )}
        <select className="select" style={{ width: 190 }} value={campaignFilter} onChange={(e) => setCampaignFilter(e.target.value)}>
          <option value="">All campaigns</option>
          {campaigns.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
        <button className="btn ghost sm" onClick={load}><Icons.refresh size={14} /></button>
      </div>

      <div className="content stack">
        <ConnectionBanner />

        <div className="tabs">
          {DIRECTION_TABS.map((t) => (
            <button key={t.key} className={`tab ${tab === t.key ? 'on' : ''}`} onClick={() => setTab(t.key)}>
              {t.label}
              {t.key === 'needsReply' && stats?.received > 0 && ` (${stats.received})`}
            </button>
          ))}
        </div>

        {!messages ? (
          <div className="panel"><div className="panel-body"><Loading label="Loading messages" /></div></div>
        ) : messages.length === 0 ? (
          <div className="panel">
            <Empty
              title={tab === 'needsReply' ? 'Nothing waiting on a reply' : 'No messages yet'}
              sub={
                tab === 'needsReply'
                  ? 'Every reply that has come in has already been acted on.'
                  : 'Approve a drafted message in Queue, or simulate a reply from a prospect page.'
              }
            />
          </div>
        ) : (
          <div className="inbox-shell">
            <div className="inbox-list">
              {messages.map((m) => (
                <ListRow key={m.id} m={m} active={m.id === selectedId} onClick={() => setSelectedId(m.id)} />
              ))}
            </div>
            <Detail m={selected} onReply={setReplying} />
          </div>
        )}

        {connection === 'connected' && (
          <div className="tiny muted">
            No mailbox is connected for inbound — replies are simulated from here or from a
            prospect's page, and go through the identical classify-and-route path a real one would.
            Outbound email sends for real when SMTP is configured; see Settings → Controls → Delivery.
          </div>
        )}
      </div>

      {replying && (
        <ReplyModal
          message={replying}
          onClose={() => setReplying(null)}
          onDone={async () => { setReplying(null); await load(); }}
        />
      )}
    </>
  );
}
