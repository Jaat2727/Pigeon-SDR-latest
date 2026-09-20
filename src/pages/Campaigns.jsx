import { useCallback, useEffect, useState } from 'react';
import { useApp } from '../context/AppContext.jsx';
import { ConnectionBanner } from '../App.jsx';
import * as api from '../api/index.js';
import { friendlyError } from '../api/client.js';
import {
  ActionButton, Banner, Empty, EngineTag, Icons, Loading, Modal, Note, Pill, Pipeline, Toggle, when,
} from '../components/ui.jsx';
import NewCampaign from '../components/NewCampaign.jsx';

function ActivityFeed({ items }) {
  if (items.length === 0) {
    return <Empty title="Nothing has happened yet" sub="Press Run and every real step lands here." />;
  }
  return (
    <div className="feed">
      {items.map((a) => (
        <div className="feed-item" key={a.id}>
          <div className="feed-rail"><i className={`feed-dot ${a.status}`} /></div>
          <div className="feed-main">
            <div className="feed-top">
              <span className="feed-action">{a.action}</span>
              {a.engine && <EngineTag engine={a.engine} />}
            </div>
            {a.detail && <div className="feed-detail">{a.detail}</div>}
            <div className="feed-meta">
              <span>{a.actor}</span>
              {a.prospect_name && <><span>·</span><span>{a.prospect_name}</span></>}
              <span>·</span>
              <span>{when(a.created_at)}</span>
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

const CHANNELS = ['email', 'linkedin', 'sms', 'voice'];

const PROMPT_AGENTS = [
  ['system', 'System', 'Sent with every agent call for this campaign. Sets the rules that never change.'],
  ['research', 'Research', 'What to prioritise finding, and what to leave null.'],
  ['icp_fitment', 'ICP Fitment', 'How to weigh the dimensions, and what is an automatic reject.'],
  ['outreach_strategy', 'Outreach Strategy', 'Sequence shape, spacing and channel order.'],
  ['personalisation', 'Personalisation', 'Length, register, and when to refuse to write.'],
  ['conversation', 'Conversation', 'How to read replies and what always needs a person.'],
];

function Editor({ campaign, onClose, onSaved, initialTab = 'targeting' }) {
  const { actor } = useApp();
  const [tab, setTab] = useState(initialTab);
  const [form, setForm] = useState({ ...campaign, rep_id: campaign.rep?.id ?? '' });
  const [prompts, setPrompts] = useState(null);
  const [drafts, setDrafts] = useState({});
  const [error, setError] = useState(null);
  const [saved, setSaved] = useState(null);
  const [reps, setReps] = useState(null);
  const [newRepName, setNewRepName] = useState('');
  const [activity, setActivity] = useState(null);
  const [funnel, setFunnel] = useState(null);
  const [running, setRunning] = useState(false);
  const [runNotice, setRunNotice] = useState(null);

  useEffect(() => {
    api.getPrompts(campaign.id)
      .then((rows) => {
        setPrompts(rows);
        setDrafts(Object.fromEntries(rows.map((r) => [r.agent_name, r.active?.content ?? ''])));
      })
      .catch((err) => setError(friendlyError(err)));
  }, [campaign.id]);

  const loadReps = useCallback(() => {
    api.listReps().then(setReps).catch(() => setReps([]));
  }, []);

  useEffect(() => { loadReps(); }, [loadReps]);

  const loadActivity = useCallback(async () => {
    try {
      const [detail, feed] = await Promise.all([
        api.getCampaign(campaign.id),
        api.getActivity({ campaignId: campaign.id, limit: 60 }),
      ]);
      setFunnel(detail.funnel);
      setActivity(feed);
    } catch (err) {
      setError(friendlyError(err));
    }
  }, [campaign.id]);

  useEffect(() => {
    if (tab === 'activity') loadActivity();
  }, [tab, loadActivity]);

  const run = async () => {
    setRunning(true);
    setRunNotice(null);
    setError(null);
    try {
      const res = await api.runCampaign(campaign.id, { limit: 25 });
      setRunNotice(
        res.picked_up === 0
          ? 'Nothing was due — every prospect is already at a checkpoint that needs a person, or scheduled for later.'
          : `Picked up ${res.picked_up} prospect${res.picked_up === 1 ? '' : 's'} and advanced ${res.advanced}. Everything below is from that run.`
      );
      await loadActivity();
      await onSaved();
    } catch (err) {
      setError(friendlyError(err));
    } finally {
      setRunning(false);
    }
  };

  const addRep = async () => {
    if (!newRepName.trim()) return;
    setError(null);
    try {
      const rep = await api.createRep({ full_name: newRepName.trim() });
      setNewRepName('');
      loadReps();
      setForm((f) => ({ ...f, rep_id: rep.id }));
    } catch (err) {
      setError(friendlyError(err));
    }
  };

  const set = (k) => (e) => setForm({ ...form, [k]: e.target.value });

  const toggleChannel = (c) => {
    const next = form.enabled_channels.includes(c)
      ? form.enabled_channels.filter((x) => x !== c)
      : [...form.enabled_channels, c];
    if (next.length === 0) return; // a campaign with no channel can do nothing
    setForm({ ...form, enabled_channels: next });
  };

  const saveSettings = async () => {
    setError(null);
    try {
      await api.updateCampaign(campaign.id, {
        name: form.name,
        objective: form.objective,
        icp_criteria: form.icp_criteria,
        exclusion_criteria: form.exclusion_criteria,
        industry: form.industry,
        company_size: form.company_size,
        enabled_channels: form.enabled_channels,
        outreach_policy: form.outreach_policy,
        messaging_policy: form.messaging_policy,
        research_focus: form.research_focus,
        daily_send_limit: Number(form.daily_send_limit) || 0,
        require_approval: form.require_approval,
        rep_id: form.rep_id || null,
      });
      setSaved('Settings saved. They apply to the next run.');
      await onSaved();
    } catch (err) {
      setError(friendlyError(err));
    }
  };

  const savePrompt = async (agent) => {
    setError(null);
    try {
      await api.savePrompt(campaign.id, agent, { content: drafts[agent], author: actor });
      const rows = await api.getPrompts(campaign.id);
      setPrompts(rows);
      setSaved(`Saved a new version of the ${agent} prompt. It is sent on the next call to that agent.`);
    } catch (err) {
      setError(friendlyError(err));
    }
  };

  return (
    <Modal title={campaign.name} onClose={onClose} wide>
      <div className="tabs" style={{ marginBottom: 14 }}>
        {[['activity', 'Activity'], ['targeting', 'Targeting'], ['execution', 'Execution'], ['prompts', 'Prompts']].map(([k, l]) => (
          <button key={k} className={`tab ${tab === k ? 'on' : ''}`} onClick={() => setTab(k)}>{l}</button>
        ))}
      </div>

      {error && <Banner tone="stop">{error}</Banner>}
      {saved && <Banner tone="info">{saved}</Banner>}
      {runNotice && <Banner tone="info">{runNotice}</Banner>}

      {tab === 'activity' && (
        <div className="stack-sm">
          <div className="row">
            <span className="small dim">
              Every line below is written by a real run — nothing here is typed in ahead of time.
            </span>
            <div className="spacer" />
            <ActionButton
              className="btn primary sm"
              onClick={run}
              disabled={running || campaign.status !== 'live'}
              title={campaign.status !== 'live' ? 'Set this campaign live first' : 'Advance every prospect that has something to do'}
            >
              {running ? <span className="spin" /> : <Icons.play size={13} />} Run this campaign
            </ActionButton>
          </div>

          {campaign.status !== 'live' && (
            <Note>This campaign is {campaign.status}. Set it live to run it — a paused or draft campaign accepts no autonomous action, by design.</Note>
          )}

          {!funnel ? (
            <Loading label="Loading activity" />
          ) : (
            <>
              <Pipeline funnel={funnel} />
              <div className="panel">
                <div className="panel-head"><h3>History</h3></div>
                <div className="panel-body tight">
                  <ActivityFeed items={activity ?? []} />
                </div>
              </div>
            </>
          )}
        </div>
      )}

      {tab === 'targeting' && (
        <div className="stack-sm">
          <div className="field">
            <label className="label">Name</label>
            <input className="input" value={form.name} onChange={set('name')} />
          </div>
          <div className="field">
            <label className="label">Objective</label>
            <input className="input" value={form.objective ?? ''} onChange={set('objective')} />
          </div>
          <div className="field">
            <label className="label">Who to target</label>
            <textarea className="textarea" rows={4} value={form.icp_criteria ?? ''} onChange={set('icp_criteria')} />
            <span className="hint">Passed to the scoring agent as written. Plain sentences, not keywords.</span>
          </div>
          <div className="field">
            <label className="label">Who never to contact</label>
            <textarea className="textarea" rows={3} value={form.exclusion_criteria ?? ''} onChange={set('exclusion_criteria')} />
            <span className="hint">
              Checked before scoring. A match is a reject whatever the fit score would have been.
            </span>
          </div>
          <div className="grid grid-2">
            <div className="field">
              <label className="label">Target industry</label>
              <input className="input" value={form.industry ?? ''} onChange={set('industry')} />
              <span className="hint">Comma separated. Write it the way your prospect records are labelled.</span>
            </div>
            <div className="field">
              <label className="label">Headcount band</label>
              <input className="input" value={form.company_size ?? ''} onChange={set('company_size')} />
              <span className="hint">&quot;50-2000&quot;, &quot;1000+&quot; or &quot;under 500&quot;.</span>
            </div>
          </div>
          <ActionButton className="btn primary" onClick={saveSettings}>Save targeting</ActionButton>
        </div>
      )}

      {tab === 'execution' && (
        <div className="stack-sm">
          <div className="field">
            <label className="label">Channels</label>
            <div className="row wrap" style={{ gap: 6 }}>
              {CHANNELS.map((c) => {
                const on = form.enabled_channels.includes(c);
                return (
                  <button
                    key={c}
                    className={`btn sm ${on ? 'primary' : ''}`}
                    onClick={() => toggleChannel(c)}
                  >
                    {c}
                  </button>
                );
              })}
            </div>
            <span className="hint">
              A step planned on a channel that is off here is dropped before scheduling, whatever the
              strategy agent returns. Voice is gated but not implemented.
            </span>
          </div>

          <div className="field">
            <label className="label">Sequence policy</label>
            <textarea className="textarea" rows={2} value={form.outreach_policy ?? ''} onChange={set('outreach_policy')} />
            <span className="hint">
              A stated number of touches is respected. &quot;Two touches over seven days&quot; plans two.
            </span>
          </div>

          <div className="field">
            <label className="label">Messaging policy</label>
            <textarea className="textarea" rows={3} value={form.messaging_policy ?? ''} onChange={set('messaging_policy')} />
          </div>

          <div className="field">
            <label className="label">Research focus</label>
            <textarea className="textarea" rows={2} value={form.research_focus ?? ''} onChange={set('research_focus')} />
          </div>

          <div className="field">
            <label className="label">Rep (whose identity outreach is sent as)</label>
            <div className="row" style={{ gap: 6 }}>
              <select className="select" value={form.rep_id ?? ''} onChange={set('rep_id')} style={{ flex: 1 }}>
                <option value="">Unassigned</option>
                {(reps ?? []).map((r) => (
                  <option key={r.id} value={r.id}>{r.full_name}{r.title ? ` · ${r.title}` : ''}</option>
                ))}
              </select>
            </div>
            <div className="row" style={{ gap: 6, marginTop: 6 }}>
              <input
                className="input"
                placeholder="Add a new rep by name"
                value={newRepName}
                onChange={(e) => setNewRepName(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && addRep()}
                style={{ flex: 1 }}
              />
              <ActionButton className="btn sm" onClick={addRep} disabled={!newRepName.trim()}>Add</ActionButton>
            </div>
            <span className="hint">Messages this campaign drafts are signed as this rep. Save execution to apply a change.</span>
          </div>

          <div className="grid grid-2">
            <div className="field">
              <label className="label">Daily send limit</label>
              <input className="input" type="number" min="0" value={form.daily_send_limit ?? 0} onChange={set('daily_send_limit')} />
            </div>
            <div className="field">
              <label className="label">Approval before sending</label>
              <div className="row" style={{ gap: 9, paddingTop: 5 }}>
                <Toggle
                  on={form.require_approval !== false}
                  onChange={(v) => setForm({ ...form, require_approval: v })}
                  label="Require approval"
                />
                <span className="small dim">
                  {form.require_approval !== false ? 'Every message waits for a person' : 'Messages send as soon as they are written'}
                </span>
              </div>
            </div>
          </div>

          <ActionButton className="btn primary" onClick={saveSettings}>Save execution</ActionButton>
        </div>
      )}

      {tab === 'prompts' && (
        <div className="stack-sm">
          <Note>
            These are sent to the agent on every call for this campaign, as{' '}
            <code className="mono">_system_prompt</code> and <code className="mono">_agent_prompt</code>.
            Saving writes a new version rather than overwriting, so a change that made things worse
            can be pointed at afterwards.
          </Note>

          {!prompts ? <Loading /> : PROMPT_AGENTS.map(([key, label, help]) => {
            const row = prompts.find((p) => p.agent_name === key);
            const current = row?.active?.content ?? '';
            const draft = drafts[key] ?? '';
            const dirty = draft !== current;

            return (
              <div className="field" key={key}>
                <label className="label">
                  {label}
                  {row?.active && <span className="muted"> · v{row.active.version}</span>}
                  {dirty && <span style={{ color: 'var(--warn)' }}> · unsaved</span>}
                </label>
                <textarea
                  className="textarea"
                  rows={3}
                  value={draft}
                  onChange={(e) => setDrafts({ ...drafts, [key]: e.target.value })}
                />
                <div className="row">
                  <span className="hint">{help}</span>
                  <div className="spacer" />
                  <ActionButton
                    className="btn sm"
                    disabled={!dirty || !draft.trim()}
                    onClick={() => savePrompt(key)}
                  >
                    Save as v{(row?.active?.version ?? 0) + 1}
                  </ActionButton>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </Modal>
  );
}

export default function Campaigns() {
  const { campaigns, refresh, setError, connection, actor } = useApp();
  const [editing, setEditing] = useState(null); // { campaign, tab }
  const [creating, setCreating] = useState(false);
  const [busy, setBusy] = useState(null);
  const [runNotice, setRunNotice] = useState(null);

  const run = useCallback(async (c) => {
    setBusy(c.id);
    setRunNotice(null);
    try {
      const res = await api.runCampaign(c.id, { limit: 25 });
      setRunNotice({
        id: c.id,
        text: res.picked_up === 0
          ? 'Nothing was due right now.'
          : `Picked up ${res.picked_up}, advanced ${res.advanced}. Click the name to see everything it did.`,
      });
      await refresh();
    } catch (err) {
      setError(friendlyError(err));
    } finally {
      setBusy(null);
    }
  }, [refresh, setError]);

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

  const duplicate = useCallback(async (c) => {
    setBusy(c.id);
    try {
      await api.duplicateCampaign(c.id);
      await refresh();
    } catch (err) {
      setError(friendlyError(err));
    } finally {
      setBusy(null);
    }
  }, [refresh, setError]);

  return (
    <>
      <div className="topbar">
        <div>
          <div className="page-title">Campaigns</div>
          <div className="page-sub">Who to target, who never to touch, and how to speak</div>
        </div>
        <div className="spacer" />
        <button className="btn primary" onClick={() => setCreating(true)}>
          <Icons.plus size={13} /> New campaign
        </button>
      </div>

      <div className="content stack">
        <ConnectionBanner />

        {campaigns.length === 0 && connection === 'connected' && (
          <div className="panel">
            <Empty
              title="No campaigns"
              sub="Create one, or run the seed file against your Supabase project to get three."
              action={<button className="btn primary" onClick={() => setCreating(true)}><Icons.plus size={13} /> New campaign</button>}
            />
          </div>
        )}

        {campaigns.map((c) => (
          <div className="panel" key={c.id}>
            <div className="panel-head">
              <Pill tone={c.status === 'live' ? 'ok' : c.status === 'paused' ? 'warn' : c.status === 'archived' ? 'grey' : 'line'} dot>
                {c.status}
              </Pill>
              <h2
                className="clickable"
                style={{ cursor: 'pointer' }}
                onClick={() => setEditing({ campaign: c, tab: 'activity' })}
                title="See what this campaign has actually done"
              >
                {c.name}
              </h2>
              <div className="spacer" />
              <div className="row wrap" style={{ gap: 5 }}>
                {c.enabled_channels.map((ch) => <Pill tone="line" key={ch}>{ch}</Pill>)}
              </div>
              {c.status === 'live' && (
                <ActionButton
                  className="btn sm primary"
                  onClick={() => run(c)}
                  disabled={busy === c.id}
                  title="Advance every prospect in this campaign that has something to do"
                >
                  <Icons.play size={12} /> Run
                </ActionButton>
              )}
              <button className="btn sm" onClick={() => setEditing({ campaign: c, tab: 'targeting' })}>Edit</button>
              <ActionButton className="btn sm" onClick={() => duplicate(c)} title="Clone this campaign's targeting, policy and prompts into a new draft">
                Duplicate
              </ActionButton>
              {c.status !== 'archived' && (
                <button
                  className={`btn sm ${c.status === 'live' ? '' : 'primary'}`}
                  disabled={busy === c.id}
                  onClick={() => setStatus(c, c.status === 'live' ? 'paused' : 'live')}
                >
                  {busy === c.id ? <span className="spin" /> : c.status === 'live' ? 'Pause' : c.status === 'draft' ? 'Set live' : 'Resume'}
                </button>
              )}
              {c.status !== 'archived' && c.status !== 'draft' && (
                <button className="btn sm" disabled={busy === c.id} onClick={() => setStatus(c, 'archived')}>
                  Complete / Archive
                </button>
              )}
              {c.status === 'archived' && (
                <button className="btn sm" disabled={busy === c.id} onClick={() => setStatus(c, 'draft')}>
                  Reopen as draft
                </button>
              )}
            </div>

            <div className="panel-body stack-sm">
              {c.objective && <div className="small dim">{c.objective}</div>}

              <div className="stats">
                <div><div className="stat-n">{c.prospect_count}</div><div className="stat-l">prospects</div></div>
                <div><div className="stat-n">{c.qualified_count}</div><div className="stat-l">qualified</div></div>
                <div><div className="stat-n">{c.contacted_count}</div><div className="stat-l">contacted</div></div>
                <div><div className="stat-n">{c.replied_count}</div><div className="stat-l">replied</div></div>
                <div><div className="stat-n">{c.pending_count}</div><div className="stat-l">still to work</div></div>
              </div>

              <div className="grid grid-2">
                <div>
                  <div className="label">Targeting</div>
                  <div className="small dim">{c.icp_criteria ?? 'Not set'}</div>
                </div>
                <div>
                  <div className="label">Never contact</div>
                  <div className="small dim">{c.exclusion_criteria ?? 'Not set'}</div>
                </div>
              </div>

              <div className="row wrap small muted" style={{ gap: 12 }}>
                <span>Rep: {c.rep?.name ?? 'unassigned'}</span>
                <span>Daily limit: {c.daily_send_limit}</span>
                <span>{c.require_approval !== false ? 'Approval required before sending' : 'Sends without approval'}</span>
                <span>Updated {when(c.updated_at)}</span>
              </div>

              {runNotice?.id === c.id && (
                <Banner tone="info">{runNotice.text}</Banner>
              )}
            </div>
          </div>
        ))}
      </div>

      {editing && (
        <Editor
          campaign={editing.campaign}
          initialTab={editing.tab}
          onClose={() => setEditing(null)}
          onSaved={refresh}
        />
      )}

      {creating && (
        <NewCampaign
          onClose={() => setCreating(false)}
          onCreated={async () => { await refresh(); setCreating(false); }}
          actor={actor}
        />
      )}
    </>
  );
}
