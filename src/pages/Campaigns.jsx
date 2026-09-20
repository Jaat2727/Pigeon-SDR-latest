/**
 * Campaigns: the control plane.
 *
 * The two buttons that matter are Find people and Run, and both of them start
 * a job rather than waiting for a result. A pipeline run is four model calls
 * per prospect, which is minutes; the old version did that inside the request
 * and the browser gave up long before the work did. Now the button starts
 * something you can watch and stop.
 */
import { useCallback, useEffect, useState } from 'react';
import { useApp } from '../context/AppContext.jsx';
import { ConnectionBanner } from '../App.jsx';
import * as api from '../api/index.js';
import { friendlyError } from '../api/client.js';
import {
  ActionButton, Banner, Empty, EngineTag, Icons, Loading, Modal, Note, Pill, Pipeline, Toggle, when,
} from '../components/ui.jsx';
import { JobPanel } from '../components/JobWatcher.jsx';
import NewCampaign from '../components/NewCampaign.jsx';

const CHANNELS = ['email', 'linkedin', 'sms', 'voice'];

const PROMPT_AGENTS = [
  ['system', 'System', 'Sent with every agent call for this campaign. Sets the rules that never change.'],
  ['discovery', 'Discovery', 'What kind of company to look for, and what to avoid proposing.'],
  ['research', 'Research', 'What to prioritise finding, and what to leave null.'],
  ['icp_fitment', 'ICP Fitment', 'How to weigh the dimensions, and what is an automatic reject.'],
  ['outreach_strategy', 'Outreach Strategy', 'Sequence shape, spacing and channel order.'],
  ['personalisation', 'Personalisation', 'Length, register, and when to refuse to write.'],
  ['conversation', 'Conversation', 'How to read replies and what always needs a person.'],
];

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

/* ── finding people ───────────────────────────────────────────────────── */

const SOURCE_NOTE = {
  apollo:
    'A real search against Apollo\'s contact database. Real people, real LinkedIn URLs. Email ' +
    'addresses stay locked unless APOLLO_REVEAL_EMAILS is on, because each reveal spends a credit.',
  llm:
    'The model proposes companies that fit the ICP and names the role worth approaching at each ' +
    'one. These are leads to verify, not sourced records. No email address is ever invented, and a ' +
    'person is only named when the model is confident they hold that role.',
  none: 'No source is configured on the API. Import a list instead.',
};

function DiscoverDialog({ campaign, onClose, onStarted }) {
  const { actor } = useApp();
  const [detail, setDetail] = useState(null);
  const [count, setCount] = useState(10);
  const [titles, setTitles] = useState('');
  const [locations, setLocations] = useState('');
  const [preview, setPreview] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    api.getCampaign(campaign.id)
      .then((c) => {
        setDetail(c);
        setTitles((c.target_roles ?? []).join(', '));
      })
      .catch((err) => setError(friendlyError(err)));
  }, [campaign.id]);

  const source = detail?.discovery?.source ?? null;

  const filters = () => ({
    titles: titles.split(',').map((s) => s.trim()).filter(Boolean),
    locations: locations.split(',').map((s) => s.trim()).filter(Boolean),
  });

  const runPreview = async () => {
    setError(null);
    setPreview(null);
    try {
      setPreview(await api.previewDiscovery(campaign.id, { count, filters: filters() }));
    } catch (err) {
      setError(friendlyError(err));
    }
  };

  const start = async () => {
    setError(null);
    try {
      const res = await api.discoverProspects(campaign.id, { count, filters: filters(), actor });
      onStarted(res.job_id);
      onClose();
    } catch (err) {
      setError(friendlyError(err));
    }
  };

  return (
    <Modal
      title={`Find people for ${campaign.name}`}
      onClose={onClose}
      wide
      footer={
        <>
          <button className="btn" onClick={onClose}>Cancel</button>
          <div className="spacer" />
          {source === 'apollo' && (
            <ActionButton className="btn" onClick={runPreview}>
              <Icons.search size={13} /> Preview
            </ActionButton>
          )}
          <ActionButton className="btn primary" disabled={!source || source === 'none'} onClick={start}>
            Find {count} people
          </ActionButton>
        </>
      }
    >
      <div className="stack-sm">
        {error && <Banner tone="stop">{error}</Banner>}

        {!detail ? <Loading /> : (
          <>
            <Banner tone={source === 'apollo' ? 'info' : 'warn'}>
              <b>
                {source === 'apollo' ? 'Searching Apollo' :
                 source === 'llm' ? 'Using model suggestions' : 'No source configured'}
              </b>
              <div className="small" style={{ marginTop: 4 }}>{SOURCE_NOTE[source] ?? detail.discovery?.reason}</div>
            </Banner>

            <div className="grid grid-2">
              <div className="field">
                <label className="label">How many</label>
                <input
                  className="input"
                  type="number"
                  min="1"
                  max="25"
                  value={count}
                  onChange={(e) => setCount(Math.max(1, Math.min(25, Number(e.target.value) || 1)))}
                />
              </div>
              <div className="field">
                <label className="label">Job titles</label>
                <input
                  className="input"
                  value={titles}
                  onChange={(e) => setTitles(e.target.value)}
                  placeholder="CTO, VP Engineering"
                />
                <span className="hint">Starts from the campaign&apos;s target roles.</span>
              </div>
            </div>

            {source === 'apollo' && (
              <div className="field">
                <label className="label">Where</label>
                <input
                  className="input"
                  value={locations}
                  onChange={(e) => setLocations(e.target.value)}
                  placeholder="United States, United Kingdom"
                />
                <span className="hint">Comma separated. Leave empty to search everywhere.</span>
              </div>
            )}

            <div className="small dim">
              Searching on: {detail.icp_criteria ? 'the campaign ICP, ' : ''}
              {detail.industry ? `${detail.industry}, ` : ''}
              {detail.company_size ? `${detail.company_size} employees, ` : ''}
              {titles || 'any title'}.
            </div>

            {preview && (
              preview.previewable === false ? (
                <Note>{preview.reason}</Note>
              ) : (
                <>
                  <div className="row" style={{ gap: 8 }}>
                    <Pill tone="ok" dot>{preview.total_matches.toLocaleString('en-IN')} people match</Pill>
                    <Pill tone="line">showing {preview.showing}</Pill>
                    {preview.emails_locked > 0 && (
                      <Pill tone="warn">{preview.emails_locked} without an email</Pill>
                    )}
                  </div>
                  <table className="data">
                    <thead><tr><th>Name</th><th>Title</th><th>Company</th><th>Email</th></tr></thead>
                    <tbody>
                      {preview.candidates.map((c, i) => (
                        <tr key={i}>
                          <td className="cell-main">{c.full_name ?? '—'}</td>
                          <td className="small">{c.title}</td>
                          <td className="small">
                            {c.company_name}
                            {c.company_domain && <div className="cell-sub mono">{c.company_domain}</div>}
                          </td>
                          <td className="small">
                            {c.email
                              ? <span className="mono tiny">{c.email}</span>
                              : <Pill tone="grey">locked</Pill>}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  <Note>
                    Nothing has been saved yet. Press Find to add these to the campaign; anyone
                    already in it is linked rather than duplicated.
                  </Note>
                </>
              )
            )}
          </>
        )}
      </div>
    </Modal>
  );
}

/* ── importing a list ─────────────────────────────────────────────────── */

/**
 * A small CSV reader. Handles quoted fields with commas in them, which is the
 * one thing that breaks a naive split and the one thing a company name is
 * likely to contain.
 */
function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];

    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') { cell += '"'; i += 1; }
        else quoted = false;
      } else cell += ch;
      continue;
    }

    if (ch === '"') quoted = true;
    else if (ch === ',') { row.push(cell); cell = ''; }
    else if (ch === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; }
    else if (ch !== '\r') cell += ch;
  }

  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows.filter((r) => r.some((c) => c.trim()));
}

/** Maps whatever a spreadsheet called a column to what the API expects. */
const COLUMN_ALIASES = {
  first_name: ['first_name', 'first name', 'firstname', 'given name'],
  last_name: ['last_name', 'last name', 'lastname', 'surname', 'family name'],
  full_name: ['full_name', 'full name', 'name', 'contact', 'contact name'],
  title: ['title', 'job title', 'role', 'position', 'job_title'],
  email: ['email', 'email address', 'work email', 'e-mail'],
  phone: ['phone', 'phone number', 'mobile', 'telephone'],
  linkedin_url: ['linkedin_url', 'linkedin', 'linkedin url', 'profile', 'profile url'],
  company_name: ['company_name', 'company', 'organisation', 'organization', 'account'],
  company_domain: ['company_domain', 'domain', 'website', 'company website', 'url'],
  company_industry: ['company_industry', 'industry', 'sector'],
  company_employee_count: ['company_employee_count', 'employees', 'headcount', 'size', 'employee count'],
  company_hq: ['company_hq', 'location', 'hq', 'headquarters', 'city'],
  notes: ['notes', 'note', 'comment', 'comments'],
};

function mapHeaders(header) {
  return header.map((raw) => {
    const clean = raw.trim().toLowerCase();
    for (const [field, aliases] of Object.entries(COLUMN_ALIASES)) {
      if (aliases.includes(clean)) return field;
    }
    return null;
  });
}

function ImportDialog({ campaign, onClose, onImported }) {
  const { actor } = useApp();
  const [text, setText] = useState('');
  const [parsed, setParsed] = useState(null);
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);

  const read = () => {
    setError(null);
    setResult(null);

    const rows = parseCsv(text);
    if (rows.length < 2) {
      setError('That needs a header row and at least one row of data.');
      setParsed(null);
      return;
    }

    const fields = mapHeaders(rows[0]);
    if (!fields.some(Boolean)) {
      setError(
        'None of those column names were recognised. Use headers like: name, title, email, company, domain.'
      );
      setParsed(null);
      return;
    }

    const records = rows.slice(1).map((cells) => {
      const record = {};
      fields.forEach((field, i) => {
        if (field && cells[i]?.trim()) record[field] = cells[i].trim();
      });
      return record;
    });

    setParsed({ fields: fields.filter(Boolean), records, ignored: fields.filter((f) => !f).length });
  };

  const send = async () => {
    setError(null);
    try {
      const res = await api.importProspects({ campaignId: campaign.id, rows: parsed.records, actor });
      setResult(res);
      await onImported();
    } catch (err) {
      setError(friendlyError(err));
    }
  };

  return (
    <Modal
      title={`Import into ${campaign.name}`}
      onClose={onClose}
      wide
      footer={
        <>
          <button className="btn" onClick={onClose}>{result ? 'Done' : 'Cancel'}</button>
          <div className="spacer" />
          {!parsed && <button className="btn" disabled={!text.trim()} onClick={read}>Read it</button>}
          {parsed && !result && (
            <ActionButton className="btn primary" onClick={send}>
              Import {parsed.records.length} row{parsed.records.length === 1 ? '' : 's'}
            </ActionButton>
          )}
        </>
      }
    >
      <div className="stack-sm">
        {error && <Banner tone="stop">{error}</Banner>}

        {!parsed && (
          <>
            <Note>
              Paste CSV, with a header row. Recognised columns: name (or first name and last name),
              title, email, phone, linkedin, company, domain, industry, employees, location, notes.
              Anything else is ignored rather than guessed at.
            </Note>
            <textarea
              className="textarea mono"
              rows={10}
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder={'name,title,email,company,domain\nPriya Raman,CTO,priya@example.com,Example Inc,example.com'}
              spellCheck={false}
            />
          </>
        )}

        {parsed && !result && (
          <>
            <div className="row" style={{ gap: 8 }}>
              <Pill tone="ok" dot>{parsed.records.length} rows read</Pill>
              <Pill tone="line">{parsed.fields.length} columns matched</Pill>
              {parsed.ignored > 0 && <Pill tone="grey">{parsed.ignored} columns ignored</Pill>}
              <div className="spacer" />
              <button className="btn sm" onClick={() => setParsed(null)}>Start over</button>
            </div>

            <table className="data">
              <thead>
                <tr>{parsed.fields.map((f) => <th key={f}>{f.replace(/_/g, ' ')}</th>)}</tr>
              </thead>
              <tbody>
                {parsed.records.slice(0, 8).map((r, i) => (
                  <tr key={i}>
                    {parsed.fields.map((f) => <td key={f} className="small">{r[f] ?? '—'}</td>)}
                  </tr>
                ))}
              </tbody>
            </table>

            {parsed.records.length > 8 && (
              <div className="tiny muted">Showing the first 8 of {parsed.records.length}.</div>
            )}

            <Note>
              A row needs an email, a LinkedIn URL, or both a name and a company. Anything with less
              than that is rejected rather than imported as an unreachable record.
            </Note>
          </>
        )}

        {result && (
          <>
            <div className="row wrap" style={{ gap: 7 }}>
              <Pill tone="ok" dot>{result.added} added</Pill>
              {result.linked > 0 && <Pill tone="blue">{result.linked} already known</Pill>}
              {result.already_here > 0 && <Pill tone="grey">{result.already_here} already here</Pill>}
              {result.failed > 0 && <Pill tone="stop">{result.failed} rejected</Pill>}
            </div>

            {result.results.some((r) => r.outcome === 'failed') && (
              <table className="data">
                <thead><tr><th>Row</th><th>Why it was rejected</th></tr></thead>
                <tbody>
                  {result.results.filter((r) => r.outcome === 'failed').map((r, i) => (
                    <tr key={i}>
                      <td className="cell-main">{r.name ?? '—'}</td>
                      <td className="small dim">{r.detail}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </>
        )}
      </div>
    </Modal>
  );
}

/* ── deleting a campaign ─────────────────────────────────────────────── */

function DeleteCampaign({ campaign, onClose, onDeleted }) {
  const [keepProspects, setKeepProspects] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  return (
    <Modal
      title={`Delete "${campaign.name}"?`}
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>Cancel</button>
          <ActionButton
            className="btn danger"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              setError(null);
              try {
                const res = await api.deleteCampaign(campaign.id, { keepProspects });
                await onDeleted(res);
              } catch (err) {
                setError(friendlyError(err));
                setBusy(false);
              }
            }}
          >
            Delete campaign
          </ActionButton>
        </>
      }
    >
      <div className="stack-sm">
        {error && <Banner tone="stop">{error}</Banner>}

        <p style={{ margin: 0 }}>
          This removes the campaign itself and everything that only exists because of it: its
          prompts, its message history, its knowledge chunks, its pending approvals. This cannot
          be undone.
        </p>

        <div className="field">
          <label className="label">
            What happens to the {campaign.prospect_count ?? 0} prospect{campaign.prospect_count === 1 ? '' : 's'} in it
          </label>

          <div className="card-choices" style={{ gridTemplateColumns: '1fr' }}>
            <button
              type="button"
              className={`card-choice ${keepProspects ? 'on' : ''}`}
              onClick={() => setKeepProspects(true)}
            >
              <div className="card-choice-title">Keep them (recommended)</div>
              <div className="small dim">
                They stay in the database, just no longer linked to this campaign. If a future
                campaign searches for the same people, they are found and linked again instead of
                being added as duplicates.
              </div>
            </button>

            <button
              type="button"
              className={`card-choice ${!keepProspects ? 'on' : ''}`}
              onClick={() => setKeepProspects(false)}
            >
              <div className="card-choice-title">Delete them too</div>
              <div className="small dim">
                Removes every prospect who was <i>only</i> in this campaign. Anyone also being
                worked by another live campaign is always left alone, whichever option is picked
                here — deleting a person out from under a campaign that still has them mid-sequence
                would be a worse surprise than one extra row.
              </div>
            </button>
          </div>
        </div>
      </div>
    </Modal>
  );
}

/* ── the editor ───────────────────────────────────────────────────────── */

function Editor({ campaign, onClose, onSaved, initialTab = 'activity' }) {
  const { actor } = useApp();
  const [tab, setTab] = useState(initialTab);
  const [form, setForm] = useState({ ...campaign, rep_id: campaign.rep_id ?? campaign.rep?.id ?? '' });
  const [prompts, setPrompts] = useState(null);
  const [drafts, setDrafts] = useState({});
  const [error, setError] = useState(null);
  const [saved, setSaved] = useState(null);
  const [reps, setReps] = useState(null);
  const [newRepName, setNewRepName] = useState('');
  const [activity, setActivity] = useState(null);
  const [detail, setDetail] = useState(null);
  const [jobId, setJobId] = useState(null);

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
      const [c, feed] = await Promise.all([
        api.getCampaign(campaign.id),
        api.getActivity({ campaignId: campaign.id, limit: 60 }),
      ]);
      setDetail(c);
      setActivity(feed);
      // A run started from the campaign list, or from another tab, should be
      // visible here rather than leaving this screen looking idle.
      if (c.running_job && !jobId) setJobId(c.running_job.id);
    } catch (err) {
      setError(friendlyError(err));
    }
  }, [campaign.id, jobId]);

  useEffect(() => {
    if (tab === 'activity') loadActivity();
  }, [tab, loadActivity]);

  const run = async () => {
    setError(null);
    try {
      const res = await api.runCampaign(campaign.id, { limit: 25, actor });
      setJobId(res.job_id);
    } catch (err) {
      setError(friendlyError(err));
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
    setSaved(null);
    try {
      await api.updateCampaign(campaign.id, {
        name: form.name,
        objective: form.objective,
        icp_criteria: form.icp_criteria,
        exclusion_criteria: form.exclusion_criteria,
        target_roles: form.target_roles,
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
      setSaved('Saved. These apply to the next run, not to work already in flight.');
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

  const rolesText = Array.isArray(form.target_roles) ? form.target_roles.join(', ') : (form.target_roles ?? '');

  return (
    <Modal title={campaign.name} onClose={onClose} wide>
      <div className="tabs" style={{ marginBottom: 14 }}>
        {[['activity', 'Activity'], ['targeting', 'Targeting'], ['execution', 'Execution'], ['prompts', 'Prompts']].map(([k, l]) => (
          <button key={k} className={`tab ${tab === k ? 'on' : ''}`} onClick={() => setTab(k)}>{l}</button>
        ))}
      </div>

      {error && <Banner tone="stop">{error}</Banner>}
      {saved && <Banner tone="info">{saved}</Banner>}

      {tab === 'activity' && (
        <div className="stack-sm">
          <div className="row">
            <span className="small dim">
              Every line below was written by a real run. Nothing here is typed in ahead of time.
            </span>
            <div className="spacer" />
            <ActionButton
              className="btn primary sm"
              onClick={run}
              disabled={campaign.status !== 'live'}
              title={campaign.status !== 'live' ? 'Set this campaign live first' : 'Advance every prospect that has something to do'}
            >
              <Icons.play size={13} /> Run this campaign
            </ActionButton>
          </div>

          {campaign.status !== 'live' && (
            <Note>
              This campaign is {campaign.status}. Set it live to run it — a paused or draft campaign
              accepts no autonomous action, by design. Finding people still works, because that
              sends nothing.
            </Note>
          )}

          {jobId && (
            <JobPanel
              jobId={jobId}
              actor={actor}
              onFinish={async () => { await loadActivity(); await onSaved(); }}
            />
          )}

          {!detail ? (
            <Loading label="Loading activity" />
          ) : (
            <>
              <Pipeline funnel={detail.funnel} />
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
          <div className="field">
            <label className="label">Job titles to look for</label>
            <input
              className="input"
              value={rolesText}
              onChange={(e) => setForm({ ...form, target_roles: e.target.value.split(',').map((s) => s.trim()).filter(Boolean) })}
              placeholder="CTO, VP Engineering"
            />
            <span className="hint">Comma separated. Discovery searches on these directly.</span>
          </div>
          <div className="grid grid-2">
            <div className="field">
              <label className="label">Target industry</label>
              <input className="input" value={form.industry ?? ''} onChange={set('industry')} />
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
              {CHANNELS.map((c) => (
                <button
                  key={c}
                  className={`btn sm ${form.enabled_channels.includes(c) ? 'primary' : ''}`}
                  onClick={() => toggleChannel(c)}
                >
                  {c}
                </button>
              ))}
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
            <select className="select" value={form.rep_id ?? ''} onChange={set('rep_id')}>
              <option value="">Unassigned</option>
              {(reps ?? []).map((r) => (
                <option key={r.id} value={r.id}>{r.full_name}{r.title ? ` · ${r.title}` : ''}</option>
              ))}
            </select>
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
            <span className="hint">Messages this campaign drafts are signed as this rep. Save to apply a change.</span>
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

/* ── the page ─────────────────────────────────────────────────────────── */

const NEXT_LABEL = { live: 'Set live', paused: 'Pause', archived: 'Archive', draft: 'Reopen as draft' };

export default function Campaigns() {
  const { campaigns, refresh, setError, connection, actor } = useApp();
  const [editing, setEditing] = useState(null);
  const [creating, setCreating] = useState(false);
  const [discovering, setDiscovering] = useState(null);
  const [importing, setImporting] = useState(null);
  const [deleting, setDeleting] = useState(null);
  const [busy, setBusy] = useState(null);
  const [reps, setReps] = useState([]);

  // jobs started from this screen: campaign id → job id
  const [jobs, setJobs] = useState({});

  useEffect(() => {
    api.listReps().then(setReps).catch(() => setReps([]));
  }, []);

  // A campaign already running when this page loads — started from its editor,
  // or from another browser tab — should show its progress here too.
  useEffect(() => {
    setJobs((current) => {
      const next = { ...current };
      for (const c of campaigns) {
        if (c.running_job && !next[c.id]) next[c.id] = c.running_job.id;
      }
      return next;
    });
  }, [campaigns]);

  const watch = (campaignId) => (jobId) => setJobs((j) => ({ ...j, [campaignId]: jobId }));

  const run = useCallback(async (c) => {
    setBusy(c.id);
    try {
      const res = await api.runCampaign(c.id, { limit: 25, actor });
      setJobs((j) => ({ ...j, [c.id]: res.job_id }));
    } catch (err) {
      setError(friendlyError(err));
    } finally {
      setBusy(null);
    }
  }, [setError, actor]);

  const setStatus = useCallback(async (c, status) => {
    setBusy(c.id);
    try {
      await api.updateCampaign(c.id, { status, actor });
      await refresh();
    } catch (err) {
      setError(friendlyError(err));
    } finally {
      setBusy(null);
    }
  }, [refresh, setError, actor]);

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
              title="No campaigns yet"
              sub="A campaign holds the targeting, the policy and the prompts. Everything else follows from it."
              action={<button className="btn primary" onClick={() => setCreating(true)}><Icons.plus size={13} /> New campaign</button>}
            />
          </div>
        )}

        {campaigns.map((c) => {
          const transitions = c.allowed_transitions ?? [];
          const ready = c.readiness;

          return (
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

                {c.status !== 'archived' && (
                  <>
                    <button className="btn sm" onClick={() => setDiscovering(c)} title="Find people who match this campaign's ICP">
                      <Icons.search size={12} /> Find people
                    </button>
                    <button className="btn sm" onClick={() => setImporting(c)} title="Paste a list you already have">
                      Import
                    </button>
                  </>
                )}

                {c.status === 'live' && (
                  <ActionButton
                    className="btn sm primary"
                    onClick={() => run(c)}
                    disabled={busy === c.id || Boolean(c.running_job)}
                    title={c.running_job ? 'Something is already running on this campaign' : 'Advance every prospect that has something to do'}
                  >
                    <Icons.play size={12} /> Run
                  </ActionButton>
                )}

                <button className="btn sm" onClick={() => setEditing({ campaign: c, tab: 'targeting' })}>Edit</button>
                <ActionButton className="btn sm" onClick={() => duplicate(c)} title="Clone the targeting, policy and prompts into a new draft">
                  Duplicate
                </ActionButton>

                {transitions.map((next) => (
                  <button
                    key={next}
                    className={`btn sm ${next === 'live' ? 'primary' : ''}`}
                    disabled={busy === c.id || (next === 'live' && ready && !ready.ready)}
                    title={
                      next === 'live' && ready && !ready.ready
                        ? ready.blockers.map((b) => b.message).join(' ')
                        : undefined
                    }
                    onClick={() => setStatus(c, next)}
                  >
                    {busy === c.id ? <span className="spin" /> : NEXT_LABEL[next] ?? next}
                  </button>
                ))}

                <button
                  className="btn sm ghost"
                  style={{ color: 'var(--stop)' }}
                  onClick={() => setDeleting(c)}
                  title="Delete this campaign"
                >
                  <Icons.x size={12} />
                </button>
              </div>

              <div className="panel-body stack-sm">
                {c.objective && <div className="small dim">{c.objective}</div>}

                {ready && !ready.ready && c.status === 'draft' && (
                  <Banner tone="warn">
                    <b>Not ready to go live.</b>{' '}
                    {ready.blockers.map((b) => b.message).join(' ')}{' '}
                    <button className="btn sm" style={{ marginTop: 8 }} onClick={() => setEditing({ campaign: c, tab: 'targeting' })}>
                      Fix it
                    </button>
                  </Banner>
                )}

                {jobs[c.id] && (
                  <JobPanel
                    jobId={jobs[c.id]}
                    actor={actor}
                    onFinish={async () => { await refresh(); }}
                  />
                )}

                <div className="stats">
                  <div><div className="stat-n">{c.prospect_count}</div><div className="stat-l">prospects</div></div>
                  <div><div className="stat-n">{c.qualified_count}</div><div className="stat-l">qualified</div></div>
                  <div><div className="stat-n">{c.contacted_count}</div><div className="stat-l">contacted</div></div>
                  <div><div className="stat-n">{c.replied_count}</div><div className="stat-l">replied</div></div>
                  <div><div className="stat-n">{c.pending_count}</div><div className="stat-l">still to work</div></div>
                </div>

                {c.prospect_count === 0 && c.status !== 'archived' && (
                  <Note>
                    No prospects yet. Find people searches for them, Import takes a list you already
                    have. Both work while the campaign is still a draft, because neither sends
                    anything.
                  </Note>
                )}

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
              </div>
            </div>
          );
        })}
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
          reps={reps}
          onClose={() => setCreating(false)}
          onCreated={async () => { await refresh(); setCreating(false); }}
        />
      )}

      {discovering && (
        <DiscoverDialog
          campaign={discovering}
          onClose={() => setDiscovering(null)}
          onStarted={watch(discovering.id)}
        />
      )}

      {importing && (
        <ImportDialog
          campaign={importing}
          onClose={() => setImporting(null)}
          onImported={refresh}
        />
      )}

      {deleting && (
        <DeleteCampaign
          campaign={deleting}
          onClose={() => setDeleting(null)}
          onDeleted={async () => { setDeleting(null); await refresh(); }}
        />
      )}
    </>
  );
}
