/**
 * One prospect, everything about them, on one page.
 *
 * The part that matters is the campaigns block: the same person carries a
 * separate verdict per campaign, and seeing two different answers side by side
 * is the clearest way to show that funnel state is per campaign rather than
 * per person.
 */
import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useApp } from '../context/AppContext.jsx';
import * as api from '../api/index.js';
import { friendlyError } from '../api/client.js';
import {
  ActionButton, Banner, Empty, EngineTag, Icons, Loading, Modal, Note, Pill,
  Score, StateTag, fullDate, labelOf, when,
} from '../components/ui.jsx';

const PROVENANCE_TONE = { manual: 'ok', crm: 'blue', csv: 'blue', ai_enriched: 'warn' };
const PROVENANCE_LABEL = { manual: 'entered by hand', crm: 'from CRM', csv: 'from import', ai_enriched: 'found by an agent' };

function Fact({ label, value, source }) {
  const missing = value === null || value === undefined || value === '';
  return (
    <>
      <dt>{label}</dt>
      <dd>
        {missing ? (
          <span className="muted">not found</span>
        ) : (
          <span className="row" style={{ gap: 6 }}>
            <span>{String(value)}</span>
            {source && <Pill tone={PROVENANCE_TONE[source] ?? 'grey'}>{PROVENANCE_LABEL[source] ?? source}</Pill>}
          </span>
        )}
      </dd>
    </>
  );
}

function ReplyBox({ prospectId, campaigns, onDone, onClose }) {
  const [body, setBody] = useState('');
  const [campaignId, setCampaignId] = useState(campaigns[0]?.campaign_id ?? '');
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);

  return (
    <Modal
      title="Simulate an inbound reply"
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>Close</button>
          <ActionButton
            className="btn primary"
            disabled={!body.trim() || !campaignId}
            onClick={async () => {
              setError(null);
              try {
                const res = await api.sendReply(prospectId, { campaignId, body: body.trim() });
                setResult(res);
                await onDone();
              } catch (err) {
                setError(friendlyError(err));
              }
            }}
          >
            <Icons.send size={13} /> Send as the prospect
          </ActionButton>
        </>
      }
    >
      <div className="stack-sm">
        <Banner tone="info">
          No inbox is connected to this deployment. A reply typed here is recorded as a real inbound
          message and goes through exactly the path a real one would: the conversation agent
          classifies it, the prospect moves, and an opt-out is written to the suppression list.
        </Banner>

        {error && <div className="banner stop">{error}</div>}

        <div className="field">
          <label className="label">Campaign</label>
          <select className="select" value={campaignId} onChange={(e) => setCampaignId(e.target.value)}>
            {campaigns.map((c) => (
              <option key={c.campaign_id} value={c.campaign_id}>{c.campaign_name}</option>
            ))}
          </select>
        </div>

        <div className="field">
          <label className="label">What they wrote</label>
          <textarea
            className="textarea"
            rows={4}
            value={body}
            onChange={(e) => setBody(e.target.value)}
            placeholder="Try: Sounds useful, can we talk Tuesday? Also what does pricing look like?"
          />
          <span className="hint">
            Try an opt-out, a question about pricing, or a referral to a colleague. Each takes a
            different path.
          </span>
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

export default function ProspectDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { refresh, setError } = useApp();

  const [data, setData] = useState(null);
  const [tab, setTab] = useState('story');
  const [replying, setReplying] = useState(false);
  const [notice, setNotice] = useState(null);

  const load = useCallback(async () => {
    try {
      setData(await api.getProspect(id));
    } catch (err) {
      setError(friendlyError(err));
    }
  }, [id, setError]);

  useEffect(() => { load(); }, [load]);

  if (!data) {
    return (
      <>
        <div className="topbar"><div className="page-title">Prospect</div></div>
        <div className="content"><Loading label="Loading" /></div>
      </>
    );
  }

  const e = data.enrichment;
  const prov = data.provenance ?? {};

  const advance = async (campaignId, all) => {
    setNotice(null);
    try {
      const res = await api.advanceProspect(id, { campaignId, all });
      const final = res.final;
      setNotice(
        final.status === 'advanced' ? `Moved to ${labelOf(final.state)}.` :
        final.status === 'blocked' ? final.reason :
        final.status === 'done' ? final.reason :
        `Could not advance: ${final.reason}`
      );
      await load();
      await refresh();
    } catch (err) {
      setError(friendlyError(err));
    }
  };

  return (
    <>
      <div className="topbar">
        <button className="btn ghost sm" onClick={() => navigate('/prospects')}>
          <Icons.back size={14} />
        </button>
        <div>
          <div className="page-title">{data.name}</div>
          <div className="page-sub">
            {[data.title, data.company].filter(Boolean).join(' · ') || 'No title or company on record'}
          </div>
        </div>
        <div className="spacer" />
        <button className="btn" onClick={() => setReplying(true)} disabled={data.campaigns.length === 0}>
          <Icons.send size={13} /> Simulate a reply
        </button>
      </div>

      <div className="content stack">
        {notice && <Banner tone="info">{notice}</Banner>}

        {/* per-campaign verdicts */}
        <div className="panel">
          <div className="panel-head">
            <h2>In {data.campaigns.length} campaign{data.campaigns.length === 1 ? '' : 's'}</h2>
            <div className="spacer" />
            <span className="tiny muted">state and score are held per campaign, not per person</span>
          </div>
          <div className="panel-body tight">
            {data.campaigns.map((c) => (
              <div className="q-item" key={c.campaign_id}>
                <div className="q-head">
                  <span className="q-who">{c.campaign_name}</span>
                  <Pill tone={c.campaign_status === 'live' ? 'ok' : 'grey'}>{c.campaign_status}</Pill>
                  <StateTag state={c.state} />
                  {c.fit_score !== null && (
                    <span className="row" style={{ gap: 5 }}>
                      <Score value={c.fit_score} />
                      {c.icp_confidence && <span className="tiny muted">{c.icp_confidence} confidence</span>}
                    </span>
                  )}
                  <div className="spacer" />
                  {c.next_action_at && <span className="tiny muted">next {when(c.next_action_at)}</span>}
                </div>

                {c.icp_reasoning && <div className="q-reason">{c.icp_reasoning}</div>}

                {c.disqualifiers?.length > 0 && (
                  <div className="row wrap" style={{ marginTop: 6, gap: 5 }}>
                    <span className="tiny muted">excluded on</span>
                    {c.disqualifiers.map((d) => <Pill tone="stop" key={d}>{d}</Pill>)}
                  </div>
                )}

                {c.missing_data?.length > 0 && (
                  <div className="row wrap" style={{ marginTop: 6, gap: 5 }}>
                    <span className="tiny muted">could not find</span>
                    {c.missing_data.map((d) => <span className="chip" key={d}>{d}</span>)}
                  </div>
                )}

                {c.no_contact_reason && (
                  <div className="q-reason"><b>Not contacting:</b> {c.no_contact_reason}</div>
                )}
                {c.stopped_reason && <div className="q-reason"><b>Stopped:</b> {c.stopped_reason}</div>}

                {c.sequence?.length > 0 && (
                  <div style={{ marginTop: 9 }}>
                    {c.sequence.map((s, i) => (
                      <div className="row small" key={s.step ?? i} style={{ gap: 8, padding: '3px 0' }}>
                        <Pill tone={i < c.current_step ? 'ok' : 'line'}>{i < c.current_step ? 'sent' : `step ${i + 1}`}</Pill>
                        <Pill tone="grey">{s.channel}</Pill>
                        <span className="dim">{s.angle ?? 'no angle recorded'}</span>
                        <div className="spacer" />
                        <span className="tiny muted">{s.scheduled_at ? when(s.scheduled_at) : `day ${s.day_offset ?? 0}`}</span>
                      </div>
                    ))}
                  </div>
                )}

                <div className="q-actions">
                  <ActionButton className="btn sm" onClick={() => advance(c.campaign_id, false)}>
                    <Icons.play size={12} /> Advance one step
                  </ActionButton>
                  <ActionButton className="btn sm" onClick={() => advance(c.campaign_id, true)}>
                    Run as far as it goes
                  </ActionButton>
                  <ActionButton
                    className="btn sm"
                    onClick={async () => {
                      await api.pauseProspect(id, { campaignId: c.campaign_id, paused: !c.paused });
                      await load();
                    }}
                  >
                    {c.paused ? 'Resume here' : 'Pause here'}
                  </ActionButton>
                </div>
              </div>
            ))}
          </div>
        </div>

        <div className="tabs">
          {[
            ['story', `History (${data.timeline.length})`],
            ['thread', `Thread (${data.thread.length})`],
            ['profile', 'Profile'],
            ['runs', `Agent runs (${data.runs.length})`],
          ].map(([k, label]) => (
            <button key={k} className={`tab ${tab === k ? 'on' : ''}`} onClick={() => setTab(k)}>
              {label}
            </button>
          ))}
        </div>

        {tab === 'story' && (
          <div className="panel">
            <div className="panel-body tight">
              {data.timeline.length === 0 ? (
                <Empty title="Nothing has happened to this prospect yet" sub="Advance them and this fills in." />
              ) : (
                <div className="feed">
                  {data.timeline.map((a) => (
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
                          {a.campaign_name && <><span>·</span><span>{a.campaign_name}</span></>}
                          <span>·</span><span title={fullDate(a.created_at)}>{when(a.created_at)}</span>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}

        {tab === 'thread' && (
          <div>
            {data.thread.length === 0 ? (
              <div className="panel"><Empty title="No messages yet" sub="Messages appear here once a touch is drafted." /></div>
            ) : (
              data.thread.map((m) => (
                <div className={`msg ${m.direction}`} key={m.id}>
                  <div className="msg-head">
                    <Pill tone={m.direction === 'inbound' ? 'blue' : 'grey'}>{m.direction}</Pill>
                    <Pill tone="line">{m.channel}</Pill>
                    {m.step && <span>touch {m.step}</span>}
                    {m.subject && <span className="dim">{m.subject}</span>}
                    <div className="spacer" />
                    <Pill tone={m.status === 'sent' ? 'ok' : m.status === 'pending_approval' ? 'warn' : 'grey'}>
                      {labelOf(m.status)}
                    </Pill>
                    <span className="tiny muted">{when(m.sent_at ?? m.created_at)}</span>
                  </div>
                  <div className="msg-body">{m.body}</div>
                  {(m.knowledge_used?.length > 0 || m.intent) && (
                    <div className="msg-head" style={{ borderTop: '1px solid var(--line)', borderBottom: 0 }}>
                      {m.intent && <Pill tone="blue">{labelOf(m.intent)}</Pill>}
                      {m.sentiment && <Pill tone="line">{m.sentiment}</Pill>}
                      {m.knowledge_used?.map((k, i) => (
                        <span className="chip" key={k.id ?? i}>{k.title ?? k.source ?? 'source'}</span>
                      ))}
                    </div>
                  )}
                </div>
              ))
            )}
            {data.thread.some((m) => m.status === 'sent') && (
              <Note>
                Delivery is simulated. No email or LinkedIn provider is connected to this
                deployment, so a message marked sent was approved and recorded, not transmitted.
              </Note>
            )}
          </div>
        )}

        {tab === 'profile' && (
          <div className="grid grid-2">
            <div className="panel">
              <div className="panel-head"><h3>Person</h3></div>
              <div className="panel-body">
                <dl className="kv">
                  <Fact label="Name" value={data.name} />
                  <Fact label="Title" value={data.title} source={prov.title} />
                  <Fact label="Seniority" value={e?.person?.seniority} />
                  <Fact label="Email" value={data.email} source={prov.email} />
                  <Fact label="Phone" value={data.phone} source={prov.phone} />
                  <Fact label="LinkedIn" value={data.linkedin_url} source={prov.linkedin_url} />
                  <Fact label="Location" value={e?.person?.location} />
                </dl>
              </div>
            </div>

            <div className="panel">
              <div className="panel-head"><h3>Company</h3></div>
              <div className="panel-body">
                <dl className="kv">
                  <Fact label="Name" value={data.company} source={prov.company_name} />
                  <Fact label="Domain" value={data.company_domain} />
                  <Fact label="Industry" value={e?.company?.industry} source={prov.company_industry} />
                  <Fact label="Headcount" value={e?.company?.employee_count} source={prov.company_employee_count} />
                  <Fact label="Funding" value={e?.company?.funding_stage} />
                  <Fact label="HQ" value={e?.company?.hq_location} />
                </dl>
              </div>
            </div>

            <div className="panel">
              <div className="panel-head"><h3>Signals</h3></div>
              <div className="panel-body stack-sm">
                {e?.signals?.recent_news ? (
                  <div className="small">{e.signals.recent_news}</div>
                ) : (
                  <div className="muted small">No signal found. Personalisation will refuse to write rather than open on nothing.</div>
                )}
                {e?.signals?.hiring_roles?.length > 0 && (
                  <div className="row wrap" style={{ gap: 5 }}>
                    <span className="tiny muted">hiring</span>
                    {e.signals.hiring_roles.map((r) => <span className="chip" key={r}>{r}</span>)}
                  </div>
                )}
                {e?.signals?.tech_stack?.length > 0 && (
                  <div className="row wrap" style={{ gap: 5 }}>
                    <span className="tiny muted">stack</span>
                    {e.signals.tech_stack.map((r) => <span className="chip" key={r}>{r}</span>)}
                  </div>
                )}
              </div>
            </div>

            <div className="panel">
              <div className="panel-head"><h3>Enrichment</h3></div>
              <div className="panel-body stack-sm">
                {e ? (
                  <>
                    <dl className="kv">
                      <Fact label="Confidence" value={e.confidence} />
                      <Fact label="Enriched" value={fullDate(e.enriched_at)} />
                      <Fact label="Stale after" value={fullDate(e.stale_after)} />
                    </dl>
                    {e.fields_not_found?.length > 0 && (
                      <>
                        <div className="tiny muted">
                          {e.fields_not_found.length} field{e.fields_not_found.length === 1 ? '' : 's'} the
                          research could not source, listed rather than filled:
                        </div>
                        <div className="row wrap" style={{ gap: 4 }}>
                          {e.fields_not_found.map((f) => <span className="chip" key={f}>{f}</span>)}
                        </div>
                      </>
                    )}
                    {e.notes && <Note>{e.notes}</Note>}
                  </>
                ) : (
                  <div className="muted small">Not enriched yet.</div>
                )}
              </div>
            </div>
          </div>
        )}

        {tab === 'runs' && (
          <div className="panel">
            {data.runs.length === 0 ? (
              <Empty title="No agent runs yet" />
            ) : (
              <table className="data">
                <thead>
                  <tr>
                    <th>Agent</th><th>Engine</th><th>Result</th>
                    <th className="num-cell">Latency</th><th className="num-cell">Cost</th><th>When</th>
                  </tr>
                </thead>
                <tbody>
                  {data.runs.map((r) => (
                    <tr key={r.id}>
                      <td className="cell-main">{r.agent_name}</td>
                      <td><EngineTag engine={r.engine} /></td>
                      <td>
                        <Pill tone={r.status === 'success' ? 'ok' : r.status === 'degraded' ? 'warn' : 'stop'}>
                          {r.status}
                        </Pill>
                        {r.error && <div className="cell-sub" style={{ maxWidth: 420 }}>{r.error}</div>}
                      </td>
                      <td className="num-cell small">{r.latency_ms ? `${r.latency_ms}ms` : '—'}</td>
                      <td className="num-cell small">${r.cost_usd.toFixed(4)}</td>
                      <td className="small muted" title={fullDate(r.created_at)}>{when(r.created_at)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        )}
      </div>

      {replying && (
        <ReplyBox
          prospectId={id}
          campaigns={data.campaigns}
          onDone={async () => { await load(); await refresh(); }}
          onClose={() => setReplying(false)}
        />
      )}
    </>
  );
}
