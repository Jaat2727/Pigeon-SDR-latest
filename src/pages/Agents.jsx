/**
 * The Agents screen.
 *
 * Two jobs: show what each agent actually did, and let someone check a Groq
 * or Gemini key without leaving the app. The test call is the second one —
 * a bad key, a rate limit, or a model answering with prose instead of JSON
 * is far easier to fix when the deployed app names it than when the only
 * evidence is a column of nulls.
 */
import { useCallback, useEffect, useState } from 'react';
import { useApp } from '../context/AppContext.jsx';
import { ConnectionBanner } from '../App.jsx';
import * as api from '../api/index.js';
import { friendlyError } from '../api/client.js';
import {
  ActionButton, Banner, Empty, EngineTag, Icons, Loading, Modal, Note, Pill, Toggle, when,
} from '../components/ui.jsx';

function TestPanel({ agent, onClose }) {
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);

  return (
    <Modal
      title={`Test ${agent.name}`}
      onClose={onClose}
      wide
      footer={<button className="btn" onClick={onClose}>Close</button>}
    >
      <div className="stack-sm">
        <Note>
          Fires one real request at the configured webhook with a sample payload shaped like the one
          the pipeline sends. Nothing is written to the database, so run it as often as you need.
        </Note>

        <ActionButton
          className="btn primary"
          onClick={async () => {
            setError(null);
            setResult(null);
            try {
              setResult(await api.testAgent(agent.id));
            } catch (err) {
              setError(friendlyError(err));
            }
          }}
        >
          <Icons.play size={13} /> Send a test call
        </ActionButton>

        {error && <Banner tone="stop">{error}</Banner>}

        {result && (
          <>
            <div className="row wrap" style={{ gap: 7 }}>
              <Pill tone={result.valid ? 'ok' : 'stop'} dot>
                {result.valid ? 'Responded with valid output' : result.reachable ? 'Answered, but not usable' : 'Could not reach it'}
              </Pill>
              {result.latency_ms > 0 && <Pill tone="line">{result.latency_ms}ms</Pill>}
              {result.error_code && <Pill tone="warn">{result.error_code.replace(/_/g, ' ')}</Pill>}
            </div>

            {result.error && <div className="small dim">{result.error}</div>}

            {result.guidance && <Banner tone="warn">{result.guidance}</Banner>}

            {result.failing_field && (
              <div className="small">
                The field that failed: <code className="mono">{result.failing_field}</code>
              </div>
            )}

            {result.raw_response !== undefined && result.raw_response !== null && (
              <div className="field">
                <label className="label">What the webhook actually returned</label>
                <pre className="draft-body mono" style={{ margin: 0, border: '1px solid var(--line)', borderRadius: 6 }}>
                  {JSON.stringify(result.raw_response, null, 2)}
                </pre>
              </div>
            )}

            {result.validated_output && (
              <div className="field">
                <label className="label">After reshaping and validation</label>
                <pre className="draft-body mono" style={{ margin: 0, border: '1px solid var(--line)', borderRadius: 6 }}>
                  {JSON.stringify(result.validated_output, null, 2)}
                </pre>
              </div>
            )}
          </>
        )}
      </div>
    </Modal>
  );
}

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
            <tr><th>Engine</th><th>Result</th><th className="num-cell">Latency</th><th className="num-cell">Tokens</th><th>When</th></tr>
          </thead>
          <tbody>
            {runs.map((r) => (
              <tr key={r.id}>
                <td><EngineTag engine={r.engine} /></td>
                <td>
                  <Pill tone={r.status === 'success' ? 'ok' : r.status === 'degraded' ? 'warn' : 'stop'}>{r.status}</Pill>
                  {r.error && <div className="cell-sub" style={{ maxWidth: 380 }}>{r.error}</div>}
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

export default function Agents() {
  const { actor, setError, connection } = useApp();
  const [agents, setAgents] = useState(null);
  const [routing, setRouting] = useState(null);
  const [testing, setTesting] = useState(null);
  const [viewing, setViewing] = useState(null);

  const load = useCallback(async () => {
    try {
      const [a, r] = await Promise.all([api.listAgents(), api.getRouting()]);
      setAgents(a);
      setRouting(r);
    } catch (err) {
      setError(friendlyError(err));
      setAgents([]);
    }
  }, [setError]);

  useEffect(() => { load(); }, [load]);

  const onLlm = (agents ?? []).filter((a) => a.engine === 'llm_engine').length;
  const shouldBe = (agents ?? []).filter((a) => a.configured_engine === 'llm' && a.callable).length;

  return (
    <>
      <div className="topbar">
        <div>
          <div className="page-title">Agents</div>
          <div className="page-sub">What each one did, and which engine actually served it</div>
        </div>
        <div className="spacer" />
        <button className="btn ghost sm" onClick={load}><Icons.refresh size={14} /></button>
      </div>

      <div className="content stack">
        <ConnectionBanner />

        {agents && shouldBe > 0 && onLlm < shouldBe && (
          <Banner tone="warn">
            <b>{shouldBe - onLlm} of {shouldBe} agents are running on the built-in engine.</b>{' '}
            The pipeline works and every result is labelled, but those agents have no Groq or Gemini
            key configured or their last call did not return usable output. Open one and send a test
            call to see which.
          </Banner>
        )}

        {!agents ? <Loading label="Loading agents" /> : (
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
                        {a.configured_engine === 'llm' && (
                          <button className="btn sm" onClick={() => setTesting(a)}>
                            <Icons.play size={12} /> Send a test call
                          </button>
                        )}
                        <button className="btn sm" onClick={() => setViewing(a)} disabled={a.runs === 0}>
                          View runs
                        </button>
                        <div className="spacer" />
                        <span className="tiny muted">{a.paused ? 'paused' : 'running'}</span>
                        <Toggle
                          on={!a.paused}
                          danger={false}
                          label={`Pause ${a.name}`}
                          onChange={async (on) => {
                            await api.pauseAgent(a.id, { paused: !on, actor });
                            await load();
                          }}
                        />
                      </div>

                      {a.configured_engine === 'llm' && !a.llm_configured && (
                        <div className="tiny muted">
                          No key set. Add <code className="mono">GROQ_API_KEY</code> and/or{' '}
                          <code className="mono">GEMINI_API_KEY</code> to the API environment.
                        </div>
                      )}
                    </>
                  ) : (
                    <Note>
                      Planned, not built. It is wired through the same stop controls and the same
                      suppression checks as every other channel, and it runs nothing. Nothing in this
                      app reports activity for it.
                    </Note>
                  )}
                </div>
              </div>
            ))}
          </div>
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
              </dl>
              <Note>
                Read from the API environment, not from history. This is what the next call to each
                agent will use. Fallback is{' '}
                {routing.local_engine_enabled ? 'enabled' : 'disabled'}: when it is off, a failed
                Groq/Gemini call stops the step instead of being answered locally.
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

      {testing && <TestPanel agent={testing} onClose={() => { setTesting(null); load(); }} />}
      {viewing && <RunsPanel agent={viewing} onClose={() => setViewing(null)} />}
    </>
  );
}
