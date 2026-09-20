/**
 * The Agents screen.
 *
 * It has three jobs, in this order of importance:
 *
 *   explain     Six agents with names and paragraphs tells a reader nothing
 *               about what actually happens. The flow at the top shows what
 *               each one is handed and what it gives back, so the handoffs —
 *               which are the interesting part — are visible.
 *   prove       The playground runs one agent against an input you can edit,
 *               and shows every stage: the prompt sent, which key and model
 *               answered, the raw text, the reshaped object, and whether it
 *               validated. Changing the input and watching the verdict change
 *               is the fastest way to understand what an agent reacts to.
 *   diagnose    The key panel turns "everything failed" into "Groq key #3 is
 *               rate limited for another forty seconds and key #5 was
 *               rejected".
 */
import { useCallback, useEffect, useState } from 'react';
import { useApp } from '../context/AppContext.jsx';
import { ConnectionBanner } from '../App.jsx';
import * as api from '../api/index.js';
import { friendlyError } from '../api/client.js';
import {
  ActionButton, Banner, Empty, EngineTag, Icons, Loading, Modal, Note, Pill, Toggle, when,
} from '../components/ui.jsx';

/* ── the flow ─────────────────────────────────────────────────────────── */

const FLOW = [
  { id: 'discovery', state: 'discovered' },
  { id: 'research', state: 'researched' },
  { id: 'icp_fitment', state: 'qualified / rejected' },
  { id: 'outreach_strategy', state: 'strategy planned' },
  { id: 'personalisation', state: 'waiting for approval' },
];

function Flow({ agents }) {
  const byId = new Map((agents ?? []).map((a) => [a.id, a]));
  const inbound = byId.get('conversation');
  const timing = byId.get('followup_timing');

  return (
    <div className="panel">
      <div className="panel-head">
        <h2>How a prospect moves</h2>
        <div className="spacer" />
        <span className="tiny muted">left to right, one step per pass</span>
      </div>

      <div className="panel-body stack-sm">
        <div className="flow">
          {FLOW.map((step, i) => {
            const agent = byId.get(step.id);
            if (!agent) return null;
            return (
              <div className="flow-step" key={step.id}>
                <div className="flow-n">{i + 1}</div>
                <div className="flow-name">{agent.name}</div>
                <div className="flow-io">
                  <span className="flow-label">in</span> {agent.takes}
                </div>
                <div className="flow-io">
                  <span className="flow-label">out</span> {agent.gives}
                </div>
                <div className="flow-state">
                  leaves the prospect at <b>{step.state}</b>
                </div>
                <div className="row" style={{ gap: 5, marginTop: 7 }}>
                  <EngineTag engine={agent.engine} />
                  {agent.paused && <Pill tone="warn">paused</Pill>}
                </div>
              </div>
            );
          })}
        </div>

        <div className="grid grid-2">
          {inbound && (
            <div className="flow-aside">
              <div className="flow-name">{inbound.name}</div>
              <div className="small dim">
                Runs when a reply arrives, not as part of the march above. It reads the message,
                decides what it means, and moves the prospect to engaged, meeting, stopped or
                opted out accordingly.
              </div>
            </div>
          )}
          {timing && (
            <div className="flow-aside">
              <div className="flow-name">{timing.name}</div>
              <div className="small dim">
                No model behind it, on purpose. Working hours, weekends and the gap since the last
                touch are arithmetic, and a model would only add variance to an answer that has a
                correct one.
              </div>
            </div>
          )}
        </div>

        <Note>
          Every step passes one gate first: kill switch, then channel pause, then agent pause, then
          campaign status, then the prospect&apos;s own state, then the suppression list. Whichever
          stops it first is the reason shown on the timeline.
        </Note>
      </div>
    </div>
  );
}

/* ── keys ─────────────────────────────────────────────────────────────── */

const KEY_TONE = { healthy: 'ok', cooling: 'warn', disabled: 'stop' };

const KEY_EXPLAIN = {
  healthy: 'Usable now.',
  cooling: 'Failed recently and is off the rota until its cooldown expires.',
  disabled: 'The provider rejected this key itself. It stays off until you fix it or revive it here.',
};

/**
 * Which model this provider is on, and where that came from.
 *
 * This line exists because of a specific failure that kept recurring. A
 * provider retires a model, every call starts failing with "every provider
 * failed", and that reads like a key problem, so you go and check your keys.
 * The engine now asks each provider what it actually has, and this says both
 * what it picked and whether your configured choice was among them.
 */
function ModelLine({ provider, ladder, catalog }) {
  if (!ladder) return null;

  const discovered = ladder.source === 'discovered';
  const missing = ladder.configured_available === false;

  return (
    <div className="model-line">
      <div className="row wrap" style={{ gap: 6 }}>
        <span className="tiny muted">on</span>
        <Pill tone={missing ? 'warn' : 'line'}>{ladder.active}</Pill>
        {discovered ? (
          <span className="tiny muted">
            picked from {catalog?.available_count ?? '?'} this account can reach
          </span>
        ) : (
          <span className="tiny muted">from your environment, not checked against the provider</span>
        )}
      </div>

      {missing && (
        <div className="tiny" style={{ color: 'var(--warn)', marginTop: 4 }}>
          {provider.toUpperCase()}_MODEL names a model this account cannot reach, so the best
          available one is being used instead. Set it to{' '}
          <code className="mono">{ladder.best_available}</code> to stop the warning.
        </div>
      )}

      {ladder.error && (
        <div className="tiny" style={{ color: 'var(--ink-3)', marginTop: 4 }}>
          Could not read the model list ({ladder.error}), so the environment&apos;s list is being
          used.
        </div>
      )}

      {ladder.ladder?.length > 1 && (
        <div className="tiny muted" style={{ marginTop: 4 }}>
          If that one is rejected: {ladder.ladder.slice(1, 4).join(', then ')}
        </div>
      )}
    </div>
  );
}

function KeyPanel({ keys, onReload, actor }) {
  if (!keys) return null;

  const total = keys.providers.reduce((sum, p) => sum + p.configured, 0);
  const unhealthy = keys.providers.reduce((sum, p) => sum + p.cooling + p.disabled, 0);

  return (
    <div className="panel">
      <div className="panel-head">
        <h2>Model keys</h2>
        <div className="spacer" />
        <ActionButton
          className="btn sm"
          onClick={async () => {
            await api.refreshModels();
            await onReload();
          }}
          title="Ask each provider for its model list again, now"
        >
          <Icons.refresh size={12} /> Recheck models
        </ActionButton>
        {unhealthy > 0 && (
          <ActionButton
            className="btn sm"
            onClick={async () => {
              await api.reviveKeys({ actor });
              await onReload();
            }}
            title="Put every cooled or rejected key back on the rota"
          >
            <Icons.refresh size={12} /> Retry all keys
          </ActionButton>
        )}
      </div>

      <div className="panel-body stack-sm">
        {total === 0 ? (
          <Banner tone="warn">
            <b>No key is configured.</b> Every agent that should reason will answer from the
            built-in rule engine instead, and each result will say so. Add{' '}
            <code className="mono">GROQ_API_KEY</code> and{' '}
            <code className="mono">GEMINI_API_KEY</code> to the API environment. Each accepts up to
            six keys, comma separated, or as{' '}
            <code className="mono">GROQ_API_KEY_1</code> through{' '}
            <code className="mono">_6</code>.
          </Banner>
        ) : (
          <div className="small dim">
            Tried in this order: {keys.configured_order.join(', then ')}. Within a provider, the
            least recently used healthy key goes first, so load spreads instead of hammering key #1
            until it is rate limited.
          </div>
        )}

        {keys.providers.map((p) => (
          <div key={p.provider} className="key-provider">
            <div className="row" style={{ gap: 7 }}>
              <b style={{ textTransform: 'capitalize' }}>{p.provider}</b>
              <Pill tone="line">{p.configured} of {p.max} keys</Pill>
              <Pill tone={p.healthy > 0 ? 'ok' : 'stop'} dot>
                {p.healthy} usable
              </Pill>
              {p.cooling > 0 && <Pill tone="warn">{p.cooling} cooling</Pill>}
              {p.disabled > 0 && <Pill tone="stop">{p.disabled} rejected</Pill>}
              <div className="spacer" />
            </div>

            {p.configured === 0 ? (
              <div className="tiny muted" style={{ marginTop: 6 }}>
                No key set for {p.provider}.
              </div>
            ) : (
              <div className="key-grid">
                {p.keys.map((k) => (
                  <div className={`key-chip ${k.state}`} key={k.label} title={KEY_EXPLAIN[k.state]}>
                    <div className="row" style={{ gap: 6 }}>
                      <span className="mono tiny">{k.label}</span>
                      <div className="spacer" />
                      <Pill tone={KEY_TONE[k.state]} dot>{k.state}</Pill>
                    </div>

                    <div className="tiny muted">
                      {k.calls === 0
                        ? 'not used yet'
                        : `${k.ok} ok · ${k.failed} failed${k.avg_latency_ms ? ` · ${k.avg_latency_ms}ms avg` : ''}`}
                    </div>

                    {k.state === 'cooling' && k.cooling_for_ms !== null && (
                      <div className="tiny" style={{ color: 'var(--warn)' }}>
                        back in {Math.ceil(k.cooling_for_ms / 1000)}s
                      </div>
                    )}

                    {k.last_error && (
                      <div className="tiny" style={{ color: 'var(--stop)' }}>
                        {k.last_error_kind?.replace(/_/g, ' ')}: {k.last_error.slice(0, 90)}
                      </div>
                    )}

                    {k.state !== 'healthy' && (
                      <ActionButton
                        className="btn ghost sm"
                        onClick={async () => {
                          await api.reviveKeys({ provider: p.provider, index: k.index, actor });
                          await onReload();
                        }}
                      >
                        Retry this key
                      </ActionButton>
                    )}
                  </div>
                ))}
              </div>
            )}

            <ModelLine
              provider={p.provider}
              ladder={keys.model_ladders?.[p.provider]}
              catalog={(keys.catalog ?? []).find((c) => c.provider === p.provider)}
            />
          </div>
        ))}

        <Note>
          Key state lives in the API process, not the database. It describes what this instance has
          seen in the last few minutes, and a stored row claiming a key was dead after a restart
          would be worse than none.
        </Note>
      </div>
    </div>
  );
}

/* ── the playground ───────────────────────────────────────────────────── */

const Stage = ({ title, sub, children, open = false }) => (
  <details className="trace-stage" open={open}>
    <summary>
      <span>{title}</span>
      {sub && <span className="tiny muted">{sub}</span>}
    </summary>
    <div className="trace-body">{children}</div>
  </details>
);

const Json = ({ value }) => (
  <pre className="code-block mono">
    {typeof value === 'string' ? value : JSON.stringify(value, null, 2)}
  </pre>
);

function Playground({ agent, onClose }) {
  const [scenarios, setScenarios] = useState(null);
  const [chosen, setChosen] = useState(null);
  const [payload, setPayload] = useState('');
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);
  const [jsonError, setJsonError] = useState(null);

  useEffect(() => {
    api.getScenarios(agent.id)
      .then((list) => {
        setScenarios(list);
        if (list.length) {
          setChosen(list[0].id);
          setPayload(JSON.stringify(list[0].payload, null, 2));
        }
      })
      .catch(() => setScenarios([]));
  }, [agent.id]);

  const pickScenario = (id) => {
    const scenario = scenarios.find((s) => s.id === id);
    if (!scenario) return;
    setChosen(id);
    setPayload(JSON.stringify(scenario.payload, null, 2));
    setResult(null);
    setJsonError(null);
  };

  const run = async () => {
    setError(null);
    setResult(null);
    setJsonError(null);

    let parsed;
    try {
      parsed = JSON.parse(payload);
    } catch (err) {
      setJsonError(`That is not valid JSON: ${err.message}`);
      return;
    }

    try {
      setResult(await api.testAgent(agent.id, { payload: parsed }));
    } catch (err) {
      setError(friendlyError(err));
    }
  };

  const active = scenarios?.find((s) => s.id === chosen);

  return (
    <Modal
      title={`${agent.name} · try it`}
      onClose={onClose}
      wide
      footer={<button className="btn" onClick={onClose}>Close</button>}
    >
      <div className="stack-sm">
        <Note>
          One real call to Groq or Gemini with the input below. Nothing is written to the database,
          so change the input and run it as often as you like — that is the point. Every stage of
          what happened comes back underneath.
        </Note>

        {scenarios === null ? (
          <Loading label="Loading examples" />
        ) : scenarios.length > 0 && (
          <div className="field">
            <label className="label">Start from an example</label>
            <div className="seg">
              {scenarios.map((s) => (
                <button
                  key={s.id}
                  type="button"
                  className={`seg-item ${chosen === s.id ? 'on' : ''}`}
                  onClick={() => pickScenario(s.id)}
                >
                  {s.label}
                </button>
              ))}
            </div>
            {active && <span className="hint">{active.description}</span>}
          </div>
        )}

        <div className="field">
          <label className="label">What the agent receives</label>
          <textarea
            className="textarea mono"
            rows={12}
            value={payload}
            onChange={(e) => { setPayload(e.target.value); setJsonError(null); }}
            spellCheck={false}
          />
          {jsonError && <span className="hint" style={{ color: 'var(--stop)' }}>{jsonError}</span>}
        </div>

        <div className="row" style={{ gap: 7 }}>
          <ActionButton className="btn primary" onClick={run}>
            <Icons.play size={13} /> Run it
          </ActionButton>
          {active && (
            <button className="btn sm" onClick={() => pickScenario(active.id)}>
              Reset the input
            </button>
          )}
        </div>

        {error && <Banner tone="stop">{error}</Banner>}

        {result && (
          <>
            <div className="row wrap" style={{ gap: 7 }}>
              <Pill tone={result.valid ? 'ok' : result.reachable ? 'warn' : 'stop'} dot>
                {result.valid
                  ? 'Valid output'
                  : result.reachable
                    ? 'Answered, but the shape was wrong'
                    : 'Could not get an answer'}
              </Pill>
              {result.provider && <Pill tone="violet">{result.provider}</Pill>}
              {result.model && <Pill tone="line" >{result.model}</Pill>}
              {result.key && <Pill tone="line">key {result.key}</Pill>}
              {result.call_latency_ms > 0 && <Pill tone="line">{result.call_latency_ms}ms</Pill>}
            </div>

            {result.error && <div className="small" style={{ color: 'var(--stop)' }}>{result.error}</div>}
            {result.guidance && <Banner tone="warn">{result.guidance}</Banner>}

            {result.failing_field && (
              <div className="small">
                The field that failed validation: <code className="mono">{result.failing_field}</code>
              </div>
            )}

            {result.attempts?.length > 0 && (
              <Stage
                title="What was tried"
                sub={`${result.attempts.length} attempt${result.attempts.length === 1 ? '' : 's'}`}
                open={!result.valid}
              >
                <table className="data">
                  <thead>
                    <tr><th>Provider</th><th>Key</th><th>Model</th><th>Result</th></tr>
                  </thead>
                  <tbody>
                    {result.attempts.map((a, i) => (
                      <tr key={i}>
                        <td>{a.provider}</td>
                        <td className="mono tiny">{a.key ?? '—'}</td>
                        <td className="mono tiny">{a.model}</td>
                        <td>
                          {a.ok
                            ? <Pill tone="ok">answered in {a.latency_ms}ms</Pill>
                            : <span className="small" style={{ color: 'var(--stop)' }}>{a.error}</span>}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </Stage>
            )}

            {result.prompt && (
              <Stage title="1 · The prompt that was sent" sub="system, then the input as JSON">
                <div className="label">System</div>
                <Json value={result.prompt.system} />
                <div className="label" style={{ marginTop: 8 }}>User</div>
                <Json value={result.prompt.user} />
              </Stage>
            )}

            {result.raw_response !== undefined && result.raw_response !== null && (
              <Stage title="2 · What the model actually said" sub="raw text, before anything touched it">
                <Json value={result.raw_response} />
              </Stage>
            )}

            {result.coerced_output && (
              <Stage
                title="3 · After reshaping"
                sub="strings turned into numbers, alternate field names mapped"
                open={!result.valid}
              >
                <Json value={result.coerced_output} />
              </Stage>
            )}

            {result.validated_output && (
              <Stage title="4 · After validation" sub="this is what the pipeline would act on" open>
                <Json value={result.validated_output} />
              </Stage>
            )}
          </>
        )}
      </div>
    </Modal>
  );
}

/* ── runs ─────────────────────────────────────────────────────────────── */

function RunsPanel({ agent, onClose }) {
  const [runs, setRuns] = useState(null);

  useEffect(() => {
    api.getAgentRuns(agent.id).then(setRuns).catch(() => setRuns([]));
  }, [agent.id]);

  return (
    <Modal title={`${agent.name} · recent runs`} onClose={onClose} wide
      footer={<button className="btn" onClick={onClose}>Close</button>}>
      {!runs ? <Loading /> : runs.length === 0 ? (
        <Empty title="No runs yet" sub="Run a campaign and this fills in." />
      ) : (
        <table className="data">
          <thead>
            <tr>
              <th>Engine</th><th>Served by</th><th>Result</th>
              <th className="num-cell">Latency</th><th className="num-cell">Tokens</th><th>When</th>
            </tr>
          </thead>
          <tbody>
            {runs.map((r) => (
              <tr key={r.id}>
                <td><EngineTag engine={r.engine} /></td>
                <td className="tiny mono">
                  {r.llm_provider ? `${r.llm_provider} ${r.llm_key ?? ''}` : '—'}
                  {r.llm_model && <div className="cell-sub">{r.llm_model}</div>}
                </td>
                <td>
                  <Pill tone={r.status === 'success' ? 'ok' : r.status === 'degraded' ? 'warn' : 'stop'}>{r.status}</Pill>
                  {r.error && <div className="cell-sub" style={{ maxWidth: 340 }}>{r.error}</div>}
                </td>
                <td className="num-cell small">{r.latency_ms ? `${r.latency_ms}ms` : '—'}</td>
                <td className="num-cell small">{r.tokens}</td>
                <td className="small muted">{when(r.created_at)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Modal>
  );
}

/* ── the page ─────────────────────────────────────────────────────────── */

export default function Agents() {
  const { actor, setError, connection } = useApp();
  const [agents, setAgents] = useState(null);
  const [routing, setRouting] = useState(null);
  const [keys, setKeys] = useState(null);
  const [testing, setTesting] = useState(null);
  const [viewing, setViewing] = useState(null);

  const loadKeys = useCallback(async () => {
    try {
      setKeys(await api.getKeys());
    } catch {
      setKeys(null);
    }
  }, []);

  const load = useCallback(async () => {
    try {
      const [a, r] = await Promise.all([api.listAgents(), api.getRouting()]);
      setAgents(a);
      setRouting(r);
      await loadKeys();
    } catch (err) {
      setError(friendlyError(err));
      setAgents([]);
    }
  }, [setError, loadKeys]);

  useEffect(() => { load(); }, [load]);

  // Keys cool down on a timer, so a static panel goes stale while you read it.
  useEffect(() => {
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') loadKeys();
    }, 10000);
    return () => clearInterval(timer);
  }, [loadKeys]);

  const onLlm = (agents ?? []).filter((a) => a.engine === 'llm_engine').length;
  const shouldBe = (agents ?? []).filter((a) => a.configured_engine === 'llm' && a.callable).length;

  return (
    <>
      <div className="topbar">
        <div>
          <div className="page-title">Agents</div>
          <div className="page-sub">What each one does, what it is handed, and what came back</div>
        </div>
        <div className="spacer" />
        <button className="btn ghost sm" onClick={load}><Icons.refresh size={14} /></button>
      </div>

      <div className="content stack">
        <ConnectionBanner />

        {agents && shouldBe > 0 && onLlm < shouldBe && (
          <Banner tone="warn">
            <b>{shouldBe - onLlm} of {shouldBe} agents are running on the built-in engine.</b>{' '}
            The pipeline still works and every result is labelled, but those agents either have no
            key or their last call did not return usable output. The key panel below says which,
            and &quot;try it&quot; on an agent card shows exactly what came back.
          </Banner>
        )}

        {!agents ? <Loading label="Loading agents" /> : (
          <>
            <Flow agents={agents} />

            <KeyPanel keys={keys} onReload={loadKeys} actor={actor} />

            <div className="grid grid-2">
              {agents.map((a) => (
                <div className="panel" key={a.id}>
                  <div className="panel-head">
                    <h3>{a.name}</h3>
                    <div className="spacer" />
                    <EngineTag engine={a.engine} />
                    <Pill tone={
                      a.status === 'active' ? 'ok' :
                      a.status === 'paused' ? 'warn' :
                      a.status === 'not_built' ? 'grey' : 'line'
                    }>
                      {a.status.replace(/_/g, ' ')}
                    </Pill>
                  </div>

                  <div className="panel-body stack-sm">
                    <div className="small dim">{a.description}</div>

                    {a.callable ? (
                      <>
                        {a.takes && (
                          <dl className="kv tight">
                            <dt>takes</dt><dd className="small">{a.takes}</dd>
                            <dt>gives</dt><dd className="small">{a.gives}</dd>
                          </dl>
                        )}

                        <div className="stats">
                          <div><div className="stat-n">{a.runs}</div><div className="stat-l">runs</div></div>
                          <div><div className="stat-n">{a.runs_today}</div><div className="stat-l">today</div></div>
                          <div>
                            <div className="stat-n">{a.success_rate === null ? '—' : `${a.success_rate}%`}</div>
                            <div className="stat-l">usable output</div>
                          </div>
                          <div>
                            <div className="stat-n">{a.clean_rate === null ? '—' : `${a.clean_rate}%`}</div>
                            <div className="stat-l">first try</div>
                          </div>
                          <div><div className="stat-n">{a.degraded}</div><div className="stat-l">degraded</div></div>
                          <div>
                            <div className="stat-n">
                              {a.avg_latency_ms === null ? '—' : `${a.avg_latency_ms}ms`}
                            </div>
                            <div className="stat-l">avg latency</div>
                          </div>
                        </div>

                        {a.runs === 0 && (
                          <Note>No runs yet, so there are no rates to report. These stay blank rather than showing 100%.</Note>
                        )}

                        <div className="row wrap" style={{ gap: 7 }}>
                          {a.testable && (
                            <button className="btn sm primary" onClick={() => setTesting(a)}>
                              <Icons.play size={12} /> Try it
                            </button>
                          )}
                          <button className="btn sm" onClick={() => setViewing(a)} disabled={a.runs === 0}>
                            View runs
                          </button>
                          <div className="spacer" />
                          <span className="tiny muted">{a.paused ? 'paused' : 'running'}</span>
                          <Toggle
                            on={!a.paused}
                            label={`Pause ${a.name}`}
                            onChange={async (on) => {
                              await api.pauseAgent(a.id, { paused: !on, actor });
                              await load();
                            }}
                          />
                        </div>

                        {a.configured_engine === 'llm' && !a.llm_configured && (
                          <div className="tiny muted">
                            No key set, so this runs on the built-in engine. See the key panel above.
                          </div>
                        )}
                      </>
                    ) : (
                      <Note>
                        Planned, not built. It is wired through the same stop controls and the same
                        suppression checks as every other channel, and it runs nothing. Nothing in
                        this app reports activity for it.
                      </Note>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </>
        )}

        {routing && (
          <div className="panel">
            <div className="panel-head"><h3>Routing right now</h3></div>
            <div className="panel-body">
              <dl className="kv">
                {Object.entries(routing.agent_routing).map(([name, engine]) => (
                  <div key={name} style={{ display: 'contents' }}>
                    <dt>{name.replace(/_/g, ' ')}</dt>
                    <dd><EngineTag engine={engine} /></dd>
                  </div>
                ))}
                <dt>discovery source</dt>
                <dd>
                  <Pill tone={routing.discovery?.source === 'apollo' ? 'ok' : routing.discovery?.source === 'llm' ? 'warn' : 'grey'}>
                    {routing.discovery?.source ?? 'none'}
                  </Pill>
                  <div className="tiny muted" style={{ marginTop: 4 }}>{routing.discovery?.reason}</div>
                </dd>
              </dl>
              <Note>
                Read from the API environment, not from history. This is what the next call to each
                agent will use. The built-in engine is{' '}
                {routing.local_engine_enabled ? 'enabled' : 'disabled'}: when it is off, a failed
                Groq and Gemini call stops the step instead of being answered locally.
              </Note>
            </div>
          </div>
        )}

        {connection === 'connected' && (
          <Note>
            Usable output counts a clean success and a degraded one together, because both produced
            output the pipeline could act on. Degraded is reported separately: it means the first
            attempt failed and either a retry or the built-in engine answered instead.
          </Note>
        )}
      </div>

      {testing && <Playground agent={testing} onClose={() => { setTesting(null); load(); }} />}
      {viewing && <RunsPanel agent={viewing} onClose={() => setViewing(null)} />}
    </>
  );
}
