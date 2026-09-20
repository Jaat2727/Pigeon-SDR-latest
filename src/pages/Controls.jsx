/**
 * Controls: the stop button, at several levels, plus who is off limits.
 *
 * What this screen reports comes from the same gate the pipeline calls before
 * every action, so what it says is stopping work is what is stopping work. A
 * control panel that reads from a different source than the thing it controls
 * is worse than no control panel.
 *
 * The screen answers three questions in order, because that is the order
 * someone opening it has them in: is anything running, is anything stopping
 * it, and how do I stop it myself.
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

const TYPE_LABEL = {
  campaign_run: 'pipeline run',
  discovery: 'finding prospects',
  prospect_advance: 'advancing one prospect',
};

/* ── who is off limits ────────────────────────────────────────────────── */

function AddSuppression({ campaigns, onClose, onAdded }) {
  const { actor } = useApp();
  const [form, setForm] = useState({ email: '', domain: '', phone: '', reason: '', scope: 'global', campaignId: '' });
  const [error, setError] = useState(null);

  return (
    <Modal
      title="Never contact"
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
            Add the rule
          </ActionButton>
        </>
      }
    >
      <div className="stack-sm">
        {error && <Banner tone="stop">{error}</Banner>}
        <Note>
          Matched with a SQL predicate before any outbound action. A model is never asked to
          remember who is off limits, because a model that forgets one is a model that emails them.
        </Note>
        <div className="field">
          <label className="label">One person, by email</label>
          <input className="input" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
        </div>
        <div className="field">
          <label className="label">Or a whole company, by domain</label>
          <input className="input" placeholder="competitor.com" value={form.domain} onChange={(e) => setForm({ ...form, domain: e.target.value })} />
          <span className="hint">Blocks everyone at that domain, in every campaign that the scope covers.</span>
        </div>
        <div className="field">
          <label className="label">Or a phone number</label>
          <input className="input" value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} />
        </div>
        <div className="field">
          <label className="label">Why</label>
          <input className="input" placeholder="Existing customer" value={form.reason} onChange={(e) => setForm({ ...form, reason: e.target.value })} />
          <span className="hint">Shown to whoever finds this rule later and wonders about it.</span>
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

/* ── the page ─────────────────────────────────────────────────────────── */

export default function Controls() {
  const { actor, campaigns, refresh, setError } = useApp();
  const [controls, setControls] = useState(null);
  const [suppression, setSuppression] = useState(null);
  const [adding, setAdding] = useState(false);
  const [confirmKill, setConfirmKill] = useState(false);

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

  // Running jobs are the fast-moving part of this screen. Without a refresh
  // the "stop this" button stays on screen for a run that finished a minute
  // ago, and pressing it produces a confusing error.
  useEffect(() => {
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') load();
    }, 5000);
    return () => clearInterval(timer);
  }, [load]);

  const after = async () => { await load(); await refresh(); };

  const running = controls?.running_jobs ?? [];

  return (
    <>
      <div className="topbar">
        <div>
          <div className="page-title">Controls</div>
          <div className="page-sub">What is running, what is stopping it, and how to stop it yourself</div>
        </div>
        <div className="spacer" />
        <button className="btn ghost sm" onClick={load}><Icons.refresh size={14} /></button>
      </div>

      <div className="content stack">
        <ConnectionBanner />

        {!controls ? <Loading label="Loading controls" /> : (
          <>
            {/* what is happening right now */}
            <div className="panel">
              <div className="panel-head">
                <h2>Right now</h2>
                <div className="spacer" />
                {running.length > 0 && <Pill tone="blue" dot>{running.length} running</Pill>}
              </div>
              <div className="panel-body stack-sm">
                {controls.gate.blockers.length > 0 ? (
                  <Banner tone="warn">
                    <b>Work is held.</b> {controls.gate.blockers.map((b) => b.detail).join('. ')}.
                    Nothing new will start until that changes.
                  </Banner>
                ) : (
                  <Banner tone="info">
                    Nothing is holding work. {controls.gate.live_campaigns} of{' '}
                    {controls.gate.total_campaigns} campaigns are live.
                  </Banner>
                )}

                {running.length === 0 ? (
                  <div className="small dim">No job is running. Nothing is being sent or scored this second.</div>
                ) : (
                  <table className="data">
                    <thead>
                      <tr><th>Campaign</th><th>Doing</th><th>Progress</th><th>Started</th><th /></tr>
                    </thead>
                    <tbody>
                      {running.map((j) => (
                        <tr key={j.id}>
                          <td className="cell-main">{j.campaign_name ?? '—'}</td>
                          <td className="small">{TYPE_LABEL[j.type] ?? j.type}</td>
                          <td className="small">
                            {j.total > 0 ? `${j.processed} of ${j.total}` : 'starting'}
                          </td>
                          <td className="small muted">
                            {when(j.started_at ?? j.created_at)}
                            {j.created_by && <div className="cell-sub">by {j.created_by}</div>}
                          </td>
                          <td style={{ textAlign: 'right' }}>
                            <ActionButton
                              className="btn sm"
                              onClick={async () => { await api.cancelJob(j.id, { actor }); await after(); }}
                            >
                              Stop
                            </ActionButton>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
            </div>

            {/* 1 · everything */}
            <div className={`panel ${controls.kill_switch ? 'alarmed' : ''}`}>
              <div className="panel-body">
                <div className="row">
                  <div>
                    <h2>Stop everything</h2>
                    <div className="small dim" style={{ marginTop: 3 }}>
                      One switch. No agent runs and no message goes out, in any campaign, until it
                      is turned off. Turning it on also stops anything already in flight: the model
                      call is aborted rather than left to finish.
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
                      // Turning it off is harmless. Turning it on stops work
                      // for everyone, so it asks first.
                      if (on) { setConfirmKill(true); return; }
                      await api.setKillSwitch({ enabled: false, actor });
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
                  <div className="small dim" style={{ marginBottom: 6 }}>
                    Stops anything outbound on that channel, everywhere. Research and scoring carry
                    on, because knowing who would have qualified costs them nothing.
                  </div>
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
                </div>
              </div>

              {/* 3 · agent */}
              <div className="panel">
                <div className="panel-head"><h2>By agent</h2></div>
                <div className="panel-body">
                  <div className="small dim" style={{ marginBottom: 6 }}>
                    A paused agent stops the pipeline at its step. Prospects wait there rather than
                    skipping it, so nothing gets sent without having been scored.
                  </div>
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
                </div>
              </div>
            </div>

            {/* 4 · campaign */}
            <div className="panel">
              <div className="panel-head">
                <h2>By campaign</h2>
                <div className="spacer" />
                <span className="tiny muted">pausing also stops that campaign&apos;s running job</span>
              </div>
              <div className="panel-body tight">
                {controls.campaigns.length === 0 ? (
                  <Empty title="No campaigns yet" sub="Create one from the Campaigns screen." />
                ) : (
                  <table className="data">
                    <thead><tr><th>Campaign</th><th>Status</th><th>Channels</th><th /></tr></thead>
                    <tbody>
                      {controls.campaigns.map((c) => {
                        const busy = running.find((j) => j.campaign_id === c.id);
                        return (
                          <tr key={c.id}>
                            <td className="cell-main">
                              {c.name}
                              {busy && <div className="cell-sub">{TYPE_LABEL[busy.type] ?? busy.type} in progress</div>}
                            </td>
                            <td>
                              <Pill tone={c.status === 'live' ? 'ok' : c.status === 'paused' ? 'warn' : 'grey'} dot>
                                {c.status}
                              </Pill>
                            </td>
                            <td>
                              <div className="row wrap" style={{ gap: 4 }}>
                                {(c.enabled_channels ?? []).map((ch) => (
                                  <Pill tone="line" key={ch}>{CHANNEL_LABEL[ch] ?? ch}</Pill>
                                ))}
                              </div>
                            </td>
                            <td style={{ textAlign: 'right' }}>
                              {c.status === 'draft' ? (
                                <span className="tiny muted">set it live from its own page</span>
                              ) : c.status === 'archived' ? (
                                <span className="tiny muted">archived</span>
                              ) : (
                                <ActionButton
                                  className="btn sm"
                                  onClick={async () => {
                                    try {
                                      await api.setCampaignPause({
                                        campaignId: c.id,
                                        paused: c.status === 'live',
                                        actor,
                                      });
                                      await after();
                                    } catch (err) {
                                      setError(friendlyError(err));
                                    }
                                  }}
                                >
                                  {c.status === 'live' ? 'Pause' : 'Resume'}
                                </ActionButton>
                              )}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                )}
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

            {/* the order of checks */}
            <div className="panel">
              <div className="panel-head">
                <h2>The order these are checked in</h2>
                <div className="spacer" />
                <span className="tiny muted">first match wins, and is the reason shown</span>
              </div>
              <div className="panel-body">
                <ol className="check-order">
                  {controls.check_order.map((c, i) => (
                    <li key={c.level}>
                      <span className="check-n">{i + 1}</span>
                      <div>
                        <div className="check-title">{c.title}</div>
                        <div className="tiny muted">{c.scope}</div>
                        <div className="small dim">{c.detail}</div>
                      </div>
                    </li>
                  ))}
                </ol>
                <Note>
                  The order changes the explanation, not the outcome. When both the kill switch and
                  the suppression list would stop something, &quot;the kill switch is on&quot; is
                  the more useful answer, so the broadest reason is checked first.
                </Note>
              </div>
            </div>
          </>
        )}
      </div>

      {adding && (
        <AddSuppression campaigns={campaigns} onClose={() => setAdding(false)} onAdded={load} />
      )}

      {confirmKill && (
        <Modal
          title="Stop everything?"
          onClose={() => setConfirmKill(false)}
          footer={
            <>
              <button className="btn" onClick={() => setConfirmKill(false)}>Cancel</button>
              <ActionButton
                className="btn danger"
                onClick={async () => {
                  await api.setKillSwitch({ enabled: true, actor });
                  setConfirmKill(false);
                  await after();
                }}
              >
                Stop everything
              </ActionButton>
            </>
          }
        >
          <div className="stack-sm">
            <p>
              Every campaign stops. {running.length > 0
                ? `${running.length} job${running.length === 1 ? '' : 's'} running right now will be cancelled mid-step.`
                : 'Nothing is running right now, so nothing is interrupted.'}
            </p>
            <Note>
              Prospects keep their state and nothing is lost. Turning the switch back off lets work
              resume from where each one stopped.
            </Note>
          </div>
        </Modal>
      )}
    </>
  );
}
