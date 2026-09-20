/**
 * The overview: every campaign, at a glance, the way the problem statement's
 * own mockup shows it — Campaign / ICP / Status / Prospects / Outreach /
 * Meetings, one row per campaign, Live and Paused visually distinct.
 *
 * Nothing here is invented. Every number comes from the same campaign list
 * and queue endpoints the rest of the app uses, counted from real rows. A
 * dashboard that looks alive because of Math.random() is worse than one that
 * honestly says zero.
 */
import { useCallback, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useApp } from '../context/AppContext.jsx';
import { ConnectionBanner } from '../App.jsx';
import * as api from '../api/index.js';
import { friendlyError } from '../api/client.js';
import {
  ActionButton, Banner, Empty, Icons, Note, Pill, Pipeline,
} from '../components/ui.jsx';
import NewCampaign from '../components/NewCampaign.jsx';

export default function Dashboard() {
  const { campaigns, queue, refresh, setError, connection, actor, setScope } = useApp();
  const navigate = useNavigate();
  const [creating, setCreating] = useState(false);
  const [busy, setBusy] = useState(null);
  const [runNotice, setRunNotice] = useState(null);

  const openIn = (campaignId) => {
    setScope(campaignId);
    navigate('/prospects');
  };

  const setStatus = useCallback(async (c, status) => {
    setBusy(c.id);
    try {
      await api.updateCampaign(c.id, { status });
      await refresh();
    } catch (err) {
      setError(friendlyError(err));
    } finally {
      setBusy(null);
    }
  }, [refresh, setError]);

  const runOne = useCallback(async (c) => {
    setBusy(c.id);
    setRunNotice(null);
    try {
      const res = await api.runCampaign(c.id, { limit: 8 });
      setRunNotice(`${c.name}: picked up ${res.picked_up}, advanced ${res.advanced}.`);
      await refresh();
    } catch (err) {
      setError(friendlyError(err));
    } finally {
      setBusy(null);
    }
  }, [refresh, setError]);

  const live = campaigns.filter((c) => c.status === 'live');
  const totalProspects = campaigns.reduce((sum, c) => sum + (c.prospect_count ?? 0), 0);
  const totalMeetings = campaigns.reduce((sum, c) => sum + (c.meetings_count ?? 0), 0);
  const totalContacted = campaigns.reduce((sum, c) => sum + (c.contacted_count ?? 0), 0);

  return (
    <>
      <div className="topbar">
        <div>
          <div className="page-title">Overview</div>
          <div className="page-sub">Every campaign, its state, and whether it needs you</div>
        </div>
        <div className="spacer" />
        <button className="btn primary" onClick={() => setCreating(true)}>
          <Icons.plus size={13} /> New campaign
        </button>
      </div>

      <div className="content stack">
        <ConnectionBanner />

        {runNotice && <Banner tone="info">{runNotice}</Banner>}

        {connection === 'connected' && campaigns.length === 0 && (
          <div className="panel">
            <Empty
              title="No campaigns yet"
              sub="Create one to start researching, scoring and contacting prospects."
              action={<button className="btn primary" onClick={() => setCreating(true)}>
                <Icons.plus size={13} /> New campaign
              </button>}
            />
          </div>
        )}

        {campaigns.length > 0 && (
          <div className="panel">
            <div className="panel-body grid-3" style={{ borderBottom: '1px solid var(--line)' }}>
              <div>
                <div className="muted small">Live campaigns</div>
                <div style={{ fontSize: 24, fontWeight: 600, marginTop: 4 }}>
                  {live.length} <span className="tiny dim">of {campaigns.length}</span>
                </div>
              </div>
              <div>
                <div className="muted small">Prospects across all campaigns</div>
                <div style={{ fontSize: 24, fontWeight: 600, marginTop: 4 }}>{totalProspects}</div>
                <div className="tiny dim" style={{ marginTop: 4 }}>{totalContacted} contacted</div>
              </div>
              <div>
                <div className="muted small">Meetings booked</div>
                <div style={{ fontSize: 24, fontWeight: 600, marginTop: 4 }}>{totalMeetings}</div>
              </div>
            </div>

            {queue?.funnel && (
              <div className="panel-body">
                <Pipeline funnel={queue.funnel} />
              </div>
            )}
          </div>
        )}

        {campaigns.length > 0 && (
          <div className="panel">
            <div className="panel-head">
              <h2>Campaigns</h2>
              <div className="spacer" />
              <span className="tiny muted">
                Pausing one does not touch the others — each row runs off its own status.
              </span>
            </div>
            <div className="panel-body tight">
              <table className="data">
                <thead>
                  <tr>
                    <th>Campaign</th>
                    <th>ICP</th>
                    <th>Status</th>
                    <th className="num-cell">Prospects</th>
                    <th className="num-cell">Outreach</th>
                    <th className="num-cell">Meetings</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {campaigns.map((c) => (
                    <tr key={c.id} className="clickable" onClick={() => openIn(c.id)}>
                      <td>
                        <div className="cell-main">{c.name}</div>
                        {c.objective && <div className="cell-sub">{c.objective}</div>}
                      </td>
                      <td className="small dim">
                        {c.icp_criteria ? c.icp_criteria.slice(0, 60) + (c.icp_criteria.length > 60 ? '…' : '') : '—'}
                      </td>
                      <td>
                        <Pill tone={c.status === 'live' ? 'ok' : c.status === 'paused' ? 'warn' : c.status === 'archived' ? 'grey' : 'line'} dot>
                          {c.status}
                        </Pill>
                      </td>
                      <td className="num-cell">{c.prospect_count ?? 0}</td>
                      <td className="num-cell">{c.contacted_count ?? 0}</td>
                      <td className="num-cell">{c.meetings_count ?? 0}</td>
                      <td style={{ textAlign: 'right' }} onClick={(e) => e.stopPropagation()}>
                        <div className="row" style={{ gap: 5, justifyContent: 'flex-end' }}>
                          {c.status === 'live' && (
                            <ActionButton className="btn sm" disabled={busy === c.id} onClick={() => runOne(c)}>
                              <Icons.play size={12} /> Run
                            </ActionButton>
                          )}
                          {(c.status === 'live' || c.status === 'paused') && (
                            <ActionButton
                              className="btn sm"
                              disabled={busy === c.id}
                              onClick={() => setStatus(c, c.status === 'live' ? 'paused' : 'live')}
                            >
                              {c.status === 'live' ? 'Pause' : 'Resume'}
                            </ActionButton>
                          )}
                          {c.status === 'draft' && (
                            <ActionButton className="btn sm primary" disabled={busy === c.id} onClick={() => setStatus(c, 'live')}>
                              Set live
                            </ActionButton>
                          )}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {campaigns.length < 3 && connection === 'connected' && (
              <div className="panel-body">
                <Note>
                  The demo calls for at least three concurrent campaigns, each with a different ICP.
                  {campaigns.length === 0 ? ' Create the first one.' : ` ${3 - campaigns.length} more to go.`}
                </Note>
              </div>
            )}
          </div>
        )}
      </div>

      {creating && (
        <NewCampaign
          onClose={() => setCreating(false)}
          onCreated={async () => { await refresh(); setCreating(false); navigate('/campaigns'); }}
          actor={actor}
        />
      )}
    </>
  );
}
