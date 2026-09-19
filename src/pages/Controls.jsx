/**
 * The stop button, at four levels, plus the suppression list.
 *
 * What this screen reports comes from the same gate the pipeline calls before
 * every action, so what it says is stopping work is what is stopping work.
 * A control panel that reads from a different source than the thing it
 * controls is worse than no control panel.
 */
import { useCallback, useEffect, useState } from 'react';
import { useApp } from '../context/AppContext.jsx';
import { ConnectionBanner } from '../App.jsx';
import * as api from '../api/index.js';
import { friendlyError } from '../api/client.js';
import {
  ActionButton, Banner, Empty, Icons, Loading, Modal, Note, Pill, Toggle, when,
} from '../components/ui.jsx';

const CHANNEL_LABEL = { email: 'Email', linkedin: 'LinkedIn', sms: 'SMS', voice: 'Voice' };

function AddSuppression({ campaigns, onClose, onAdded }) {
  const { actor } = useApp();
  const [form, setForm] = useState({ email: '', domain: '', phone: '', reason: '', scope: 'global', campaignId: '' });
  const [error, setError] = useState(null);

  return (
    <Modal
      title="Add a suppression rule"
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>Cancel</button>
          <ActionButton
            className="btn primary"
            disabled={!form.email && !form.domain && !form.phone}
            onClick={async () => {
              setError(null);
              try {
                await api.addSuppression({ ...form, actor });
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
        {error && <Banner tone="stop">{error}</Banner>}
        <Note>
          Matched with a SQL predicate before any outbound action. A model is never asked to
          remember who is off limits.
        </Note>
        <div className="field">
          <label className="label">Email</label>
          <input className="input" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
        </div>
        <div className="field">
          <label className="label">Or a whole domain</label>
          <input className="input" placeholder="competitor.com" value={form.domain} onChange={(e) => setForm({ ...form, domain: e.target.value })} />
        </div>
        <div className="field">
          <label className="label">Or a phone number</label>
          <input className="input" value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} />
        </div>
        <div className="field">
          <label className="label">Why</label>
          <input className="input" value={form.reason} onChange={(e) => setForm({ ...form, reason: e.target.value })} />
        </div>
        <div className="field">
          <label className="label">Applies to</label>
          <select className="select" value={form.scope} onChange={(e) => setForm({ ...form, scope: e.target.value })}>
            <option value="global">Every campaign</option>
            <option value="campaign">One campaign</option>
          </select>
        </div>
        {form.scope === 'campaign' && (
          <div className="field">
            <label className="label">Campaign</label>
            <select className="select" value={form.campaignId} onChange={(e) => setForm({ ...form, campaignId: e.target.value })}>
              <option value="">Pick one</option>
              {campaigns.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </div>
        )}
      </div>
    </Modal>
  );
}

export default function Controls() {
  const { actor, campaigns, refresh, setError } = useApp();
  const [controls, setControls] = useState(null);
  const [suppression, setSuppression] = useState(null);
  const [adding, setAdding] = useState(false);

  const load = useCallback(async () => {
    try {
      const [c, s] = await Promise.all([api.getControls(), api.listSuppression()]);
      setControls(c);
      setSuppression(s);
    } catch (err) {
      setError(friendlyError(err));
      setControls(null);
    }
  }, [setError]);

  useEffect(() => { load(); }, [load]);

  const after = async () => { await load(); await refresh(); };

  return (
    <>
      <div className="topbar">
        <div>
          <div className="page-title">Controls</div>
          <div className="page-sub">Four ways to stop it, and who is off limits</div>
        </div>
        <div className="spacer" />
        <button className="btn ghost sm" onClick={load}><Icons.refresh size={14} /></button>
      </div>

      <div className="content stack">
        <ConnectionBanner />

        {!controls ? <Loading label="Loading controls" /> : (
          <>
            {controls.gate.blockers.length > 0 ? (
              <Banner tone="warn">
                <b>Work is currently held.</b>{' '}
                {controls.gate.blockers.map((b) => b.detail).join('. ')}.
              </Banner>
            ) : (
              <Banner tone="info">
                Nothing is holding work. {controls.gate.live_campaigns} of{' '}
                {controls.gate.total_campaigns} campaigns are live.
              </Banner>
            )}

            {/* 1 · everything */}
            <div className="panel">
              <div className="panel-body">
                <div className="row">
                  <div>
                    <h2>Stop everything</h2>
                    <div className="small dim" style={{ marginTop: 3 }}>
                      One switch. No agent runs, no message goes out, in any campaign, until it is
                      turned off. Checked first, before every other control.
                    </div>
                  </div>
                  <div className="spacer" />
                  <Pill tone={controls.kill_switch ? 'stop' : 'ok'} dot>
                    {controls.kill_switch ? 'everything stopped' : 'running'}
                  </Pill>
                  <Toggle
                    on={controls.kill_switch}
                    danger
                    label="Kill switch"
                    onChange={async (on) => {
                      await api.setKillSwitch({ enabled: on, actor });
                      await after();
                    }}
                  />
                </div>
                {controls.updated_at && (
                  <div className="tiny muted" style={{ marginTop: 8 }}>
                    Last changed {when(controls.updated_at)}
                    {controls.updated_by ? ` by ${controls.updated_by}` : ''}
                  </div>
                )}
              </div>
            </div>

            <div className="grid grid-2">
              {/* 2 · channel */}
              <div className="panel">
                <div className="panel-head"><h2>By channel</h2></div>
                <div className="panel-body">
                  {controls.channels.map((c) => (
                    <div className="row" key={c.channel} style={{ padding: '7px 0' }}>
                      <span>{CHANNEL_LABEL[c.channel] ?? c.channel}</span>
                      {!c.implemented && <Pill tone="grey">not built</Pill>}
                      <div className="spacer" />
                      <span className="tiny muted">{c.paused ? 'paused' : 'running'}</span>
                      <Toggle
                        on={c.paused}
                        danger
                        disabled={!c.implemented}
                        label={`Pause ${CHANNEL_LABEL[c.channel] ?? c.channel}`}
                        onChange={async (on) => {
                          await api.setChannelPause({ channel: c.channel, paused: on, actor });
                          await after();
                        }}
                      />
                    </div>
                  ))}
                  <Note>Applies across every campaign at once. A campaign that only has one channel stops entirely when that channel does.</Note>
                </div>
              </div>

              {/* 3 · agent */}
              <div className="panel">
                <div className="panel-head"><h2>By agent</h2></div>
                <div className="panel-body">
                  {controls.agents.map((a) => (
                    <div className="row" key={a.id} style={{ padding: '7px 0' }}>
                      <span>{a.name}</span>
                      {!a.callable && <Pill tone="grey">not built</Pill>}
                      <div className="spacer" />
                      <span className="tiny muted">{a.paused ? 'paused' : 'running'}</span>
                      <Toggle
                        on={a.paused}
                        danger
                        disabled={!a.callable}
                        label={`Pause ${a.name}`}
                        onChange={async (on) => {
                          await api.pauseAgent(a.id, { paused: on, actor });
                          await after();
                        }}
                      />
                    </div>
                  ))}
                  <Note>A paused agent stops the pipeline at its step. Prospects wait there rather than skipping it.</Note>
                </div>
              </div>
            </div>

            {/* 4 · campaign */}
            <div className="panel">
              <div className="panel-head"><h2>By campaign</h2></div>
              <div className="panel-body tight">
                <table className="data">
                  <thead><tr><th>Campaign</th><th>Status</th><th>Channels</th><th /></tr></thead>
                  <tbody>
                    {controls.campaigns.map((c) => (
                      <tr key={c.id}>
                        <td className="cell-main">{c.name}</td>
                        <td>
                          <Pill tone={c.status === 'live' ? 'ok' : c.status === 'paused' ? 'warn' : 'grey'} dot>
                            {c.status}
                          </Pill>
                        </td>
                        <td>
                          <div className="row wrap" style={{ gap: 4 }}>
                            {(c.enabled_channels ?? []).map((ch) => <Pill tone="line" key={ch}>{ch}</Pill>)}
                          </div>
                        </td>
                        <td style={{ textAlign: 'right' }}>
                          <ActionButton
                            className="btn sm"
                            onClick={async () => {
                              await api.updateCampaign(c.id, { status: c.status === 'live' ? 'paused' : 'live' });
                              await after();
                            }}
                          >
                            {c.status === 'live' ? 'Pause' : 'Set live'}
                          </ActionButton>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>

            {/* suppression */}
            <div className="panel">
              <div className="panel-head">
                <h2>Never contact</h2>
                <div className="spacer" />
                {suppression && <span className="tiny muted">{suppression.length} rules</span>}
                <button className="btn sm" onClick={() => setAdding(true)}><Icons.plus size={12} /> Add</button>
              </div>
              <div className="panel-body tight">
                {!suppression ? <Loading /> : suppression.length === 0 ? (
                  <Empty title="No suppression rules" sub="An opt-out reply adds one here automatically." />
                ) : (
                  <table className="data">
                    <thead><tr><th>Matches</th><th>Why</th><th>Scope</th><th>Added</th><th /></tr></thead>
                    <tbody>
                      {suppression.map((s) => (
                        <tr key={s.id}>
                          <td className="mono">{s.email ?? s.domain ?? s.phone}</td>
                          <td className="small dim">{s.reason ?? '—'}</td>
                          <td>
                            <Pill tone={s.scope === 'global' ? 'stop' : 'warn'}>
                              {s.scope === 'global' ? 'everywhere' : s.campaign_name ?? 'one campaign'}
                            </Pill>
                          </td>
                          <td className="small muted">{when(s.created_at)}</td>
                          <td style={{ textAlign: 'right' }}>
                            <ActionButton
                              className="btn ghost sm"
                              onClick={async () => { await api.removeSuppression(s.id); await load(); }}
                            >
                              <Icons.x size={13} />
                            </ActionButton>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
            </div>

            <Note>
              Research and scoring still run for a suppressed prospect, because knowing that someone
              on the list would have qualified is useful and costs them nothing. The stop happens
              the moment anything outbound begins.
            </Note>
          </>
        )}
      </div>

      {adding && (
        <AddSuppression campaigns={campaigns} onClose={() => setAdding(false)} onAdded={load} />
      )}
    </>
  );
}
