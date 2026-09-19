import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useApp } from '../context/AppContext.jsx';
import { ConnectionBanner } from '../App.jsx';
import * as api from '../api/index.js';
import { friendlyError } from '../api/client.js';
import {
  ActionButton, Empty, Icons, Loading, Modal, Pill, Score, StateTag, when,
} from '../components/ui.jsx';

const GROUPS = [
  { key: 'all', label: 'All' },
  { key: 'needs_review', label: 'Needs review', states: ['needs_review'] },
  { key: 'qualified', label: 'Qualified', states: ['qualified', 'strategy_planned'] },
  { key: 'contacted', label: 'In sequence', states: ['contacted'] },
  { key: 'engaged', label: 'Replied', states: ['engaged', 'meeting', 'opportunity'] },
  { key: 'out', label: 'Out', states: ['rejected', 'stopped', 'suppressed', 'opted_out'] },
];

function AddProspect({ campaigns, onClose, onAdded }) {
  const [form, setForm] = useState({
    first_name: '', last_name: '', title: '', email: '',
    company_name: '', company_domain: '', campaignId: campaigns[0]?.id ?? '',
  });
  const [error, setError] = useState(null);
  const set = (k) => (e) => setForm({ ...form, [k]: e.target.value });

  return (
    <Modal
      title="Add a prospect"
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>Cancel</button>
          <ActionButton
            className="btn primary"
            onClick={async () => {
              setError(null);
              try {
                await api.addProspect(form);
                await onAdded();
                onClose();
              } catch (err) {
                setError(friendlyError(err));
              }
            }}
          >
            Add
          </ActionButton>
        </>
      }
    >
      <div className="stack-sm">
        {error && <div className="banner stop">{error}</div>}
        <div className="grid grid-2">
          <div className="field">
            <label className="label">First name</label>
            <input className="input" value={form.first_name} onChange={set('first_name')} />
          </div>
          <div className="field">
            <label className="label">Last name</label>
            <input className="input" value={form.last_name} onChange={set('last_name')} />
          </div>
        </div>
        <div className="field">
          <label className="label">Email</label>
          <input className="input" type="email" value={form.email} onChange={set('email')} />
          <span className="hint">Required unless you give a LinkedIn URL. Duplicates are rejected.</span>
        </div>
        <div className="field">
          <label className="label">Title</label>
          <input className="input" value={form.title} onChange={set('title')} />
        </div>
        <div className="grid grid-2">
          <div className="field">
            <label className="label">Company</label>
            <input className="input" value={form.company_name} onChange={set('company_name')} />
          </div>
          <div className="field">
            <label className="label">Domain</label>
            <input className="input" value={form.company_domain} onChange={set('company_domain')} />
          </div>
        </div>
        <div className="field">
          <label className="label">Campaign</label>
          <select className="select" value={form.campaignId} onChange={set('campaignId')}>
            {campaigns.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </div>
      </div>
    </Modal>
  );
}

export default function Prospects() {
  const { campaigns, scope, setScope, connection, setError } = useApp();
  const navigate = useNavigate();

  const [rows, setRows] = useState(null);
  const [q, setQ] = useState('');
  const [group, setGroup] = useState('all');
  const [adding, setAdding] = useState(false);
  const [sort, setSort] = useState({ key: 'fit_score', dir: 'desc' });

  const load = useCallback(async () => {
    try {
      setRows(await api.listProspects({ campaignId: scope || undefined }));
    } catch (err) {
      setError(friendlyError(err));
      setRows([]);
    }
  }, [scope, setError]);

  useEffect(() => { load(); }, [load]);

  const filtered = useMemo(() => {
    if (!rows) return [];
    const states = GROUPS.find((g) => g.key === group)?.states;
    const needle = q.trim().toLowerCase();

    const out = rows.filter((r) => {
      if (states && !states.includes(r.state)) return false;
      if (!needle) return true;
      return [r.name, r.company, r.title, r.email]
        .filter(Boolean)
        .some((v) => v.toLowerCase().includes(needle));
    });

    const { key, dir } = sort;
    return [...out].sort((a, b) => {
      const av = a[key];
      const bv = b[key];
      if (av === bv) return 0;
      if (av === null || av === undefined) return 1;
      if (bv === null || bv === undefined) return -1;
      const cmp = typeof av === 'number' ? av - bv : String(av).localeCompare(String(bv));
      return dir === 'asc' ? cmp : -cmp;
    });
  }, [rows, group, q, sort]);

  const counts = useMemo(() => {
    const map = {};
    for (const g of GROUPS) {
      map[g.key] = g.states ? (rows ?? []).filter((r) => g.states.includes(r.state)).length : (rows ?? []).length;
    }
    return map;
  }, [rows]);

  const head = (key, label, right = false) => (
    <th
      style={{ cursor: 'pointer', textAlign: right ? 'right' : 'left' }}
      onClick={() => setSort({ key, dir: sort.key === key && sort.dir === 'desc' ? 'asc' : 'desc' })}
    >
      {label}
      {sort.key === key && <span style={{ marginLeft: 4 }}>{sort.dir === 'desc' ? '↓' : '↑'}</span>}
    </th>
  );

  return (
    <>
      <div className="topbar">
        <div>
          <div className="page-title">Prospects</div>
          <div className="page-sub">
            {rows ? `${rows.length} membership${rows.length === 1 ? '' : 's'}` : ' '}
          </div>
        </div>
        <div className="spacer" />
        <select className="select" style={{ width: 200 }} value={scope} onChange={(e) => setScope(e.target.value)}>
          <option value="">All campaigns</option>
          {campaigns.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
        <button className="btn" onClick={() => setAdding(true)} disabled={campaigns.length === 0}>
          <Icons.plus size={13} /> Add
        </button>
      </div>

      <div className="content stack">
        <ConnectionBanner />

        <div className="row wrap">
          <div className="search">
            <Icons.search size={14} />
            <input
              className="input"
              placeholder="Search name, company, title or email"
              value={q}
              onChange={(e) => setQ(e.target.value)}
            />
          </div>
          <div className="tabs" style={{ border: 0 }}>
            {GROUPS.map((g) => (
              <button
                key={g.key}
                className={`tab ${group === g.key ? 'on' : ''}`}
                onClick={() => setGroup(g.key)}
              >
                {g.label} <span className="muted">{counts[g.key] ?? 0}</span>
              </button>
            ))}
          </div>
        </div>

        <div className="panel">
          {!rows ? (
            <Loading label="Loading prospects" />
          ) : filtered.length === 0 ? (
            <Empty
              title={rows.length === 0 ? 'No prospects yet' : 'Nothing matches'}
              sub={rows.length === 0 ? 'Add one, or run a campaign to bring the seeded list to life.' : 'Try a different filter or search.'}
            />
          ) : (
            <table className="data">
              <thead>
                <tr>
                  {head('name', 'Prospect')}
                  {head('company', 'Company')}
                  {head('state', 'State')}
                  {head('fit_score', 'Score', true)}
                  <th>Sequence</th>
                  {head('campaign_name', 'Campaign')}
                  {head('next_action_at', 'Next')}
                </tr>
              </thead>
              <tbody>
                {filtered.map((r) => (
                  <tr
                    key={`${r.campaign_id}-${r.id}`}
                    className="clickable"
                    onClick={() => navigate(`/prospects/${r.id}`)}
                  >
                    <td>
                      <div className="cell-main">{r.name}</div>
                      <div className="cell-sub">{r.title ?? 'No title on record'}</div>
                    </td>
                    <td>
                      <div>{r.company ?? <span className="muted">—</span>}</div>
                      {r.source && <div className="cell-sub">from {r.source}</div>}
                    </td>
                    <td>
                      <StateTag state={r.state} />
                      {r.paused && <Pill tone="warn">paused</Pill>}
                    </td>
                    <td className="num-cell"><Score value={r.fit_score} /></td>
                    <td>
                      {r.total_steps > 0 ? (
                        <span className="small">{r.current_step} of {r.total_steps}</span>
                      ) : (
                        <span className="muted">—</span>
                      )}
                    </td>
                    <td className="small dim">{r.campaign_name}</td>
                    <td className="small muted">{r.next_action_at ? when(r.next_action_at) : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        {connection === 'connected' && rows?.length > 0 && (
          <p className="note">
            One row is one prospect in one campaign. The same person appears once per campaign they
            are in, and can carry a different state and score in each, which is why a name can show
            up twice with two different verdicts.
          </p>
        )}
      </div>

      {adding && (
        <AddProspect campaigns={campaigns} onClose={() => setAdding(false)} onAdded={load} />
      )}
    </>
  );
}
