/**
 * History, as a floating window rather than a panel wedged into a page.
 *
 * The same `activities` feed every screen already reads from — Queue's home
 * feed and a campaign's Activity tab both used to embed their own cramped
 * copy of this list. One proper version now, opened over whatever screen you
 * were on: global ("every person, every campaign") by default, or scoped to
 * one campaign when opened from one.
 */
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useApp } from '../context/AppContext.jsx';
import * as api from '../api/index.js';
import { friendlyError } from '../api/client.js';
import { EngineTag, Empty, Loading, Modal, when } from './ui.jsx';

function HistoryRow({ item }) {
  return (
    <div className="feed-item">
      <div className="feed-rail"><i className={`feed-dot ${item.status}`} /></div>
      <div className="feed-main">
        <div className="feed-top">
          <span className="feed-action">{item.action}</span>
          {item.engine && <EngineTag engine={item.engine} />}
        </div>
        {item.detail && <div className="feed-detail">{item.detail}</div>}
        <div className="feed-meta">
          <span>{item.actor}</span>
          {item.prospect_name && (
            <>
              <span>·</span>
              <Link to={`/prospects/${item.prospect_id}`}>{item.prospect_name}</Link>
            </>
          )}
          {item.campaign_name && <><span>·</span><span>{item.campaign_name}</span></>}
          <span>·</span>
          <span>{when(item.created_at)}</span>
        </div>
      </div>
    </div>
  );
}

/**
 * @param {string} [campaignId] scope to one campaign; omit for every campaign
 * @param {string} [title]
 * @param {() => void} onClose
 */
export default function HistoryModal({ campaignId: fixedCampaignId, title, onClose }) {
  const { campaigns } = useApp();
  const [campaignId, setCampaignId] = useState(fixedCampaignId ?? '');
  const [q, setQ] = useState('');
  const [items, setItems] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    let cancelled = false;
    setItems(null);
    api.getActivity({ campaignId: campaignId || undefined, limit: 150 })
      .then((rows) => !cancelled && setItems(rows))
      .catch((err) => !cancelled && setError(friendlyError(err)));
    return () => { cancelled = true; };
  }, [campaignId]);

  const filtered = items?.filter((a) => {
    if (!q.trim()) return true;
    const hay = `${a.action} ${a.detail ?? ''} ${a.prospect_name ?? ''} ${a.campaign_name ?? ''}`.toLowerCase();
    return hay.includes(q.trim().toLowerCase());
  });

  return (
    <Modal
      title={title ?? (fixedCampaignId ? 'Campaign history' : 'History — every campaign, every person')}
      onClose={onClose}
      wide
      footer={<button className="btn" onClick={onClose}>Close</button>}
    >
      <div className="stack-sm">
        <div className="row" style={{ gap: 8 }}>
          <input
            className="input"
            placeholder="Search by person, company or what happened"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            style={{ flex: 1 }}
            autoFocus
          />
          {!fixedCampaignId && (
            <select className="select" style={{ width: 200 }} value={campaignId} onChange={(e) => setCampaignId(e.target.value)}>
              <option value="">Every campaign</option>
              {campaigns.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          )}
        </div>

        {error && <div className="banner stop">{error}</div>}

        <div style={{ maxHeight: '58vh', overflowY: 'auto' }}>
          {!items ? (
            <Loading label="Loading history" />
          ) : filtered.length === 0 ? (
            <Empty
              title={q.trim() ? 'Nothing matches that search' : 'Nothing has happened yet'}
              sub={q.trim() ? 'Try a different name or word.' : 'Press Run on a campaign and every real step lands here.'}
            />
          ) : (
            <div className="feed">
              {filtered.map((a) => <HistoryRow key={a.id} item={a} />)}
            </div>
          )}
        </div>

        {items && (
          <div className="tiny muted">
            {filtered.length === items.length
              ? `${items.length} most recent event${items.length === 1 ? '' : 's'}.`
              : `${filtered.length} of ${items.length} shown.`}
          </div>
        )}
      </div>
    </Modal>
  );
}
