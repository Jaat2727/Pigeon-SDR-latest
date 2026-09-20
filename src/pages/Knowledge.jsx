/**
 * The source material personalisation is allowed to draw on, plus a preview of
 * what retrieval would actually return.
 *
 * The preview is the point of this screen. "Grounded in your knowledge base"
 * is a claim, and a claim someone can check in two clicks is worth more than
 * one they cannot.
 */
import { Fragment, useCallback, useEffect, useState } from 'react';
import { useApp } from '../context/AppContext.jsx';
import { ConnectionBanner } from '../App.jsx';
import * as api from '../api/index.js';
import { friendlyError } from '../api/client.js';
import {
  ActionButton, Banner, Empty, Icons, Loading, Modal, Note, Pill, when,
} from '../components/ui.jsx';

const TYPE_LABEL = {
  product: 'Product',
  brand_voice: 'Brand voice',
  case_study: 'Case study',
  example_email: 'Example email',
  playbook: 'Playbook',
  objection_handling: 'Objection',
  faq: 'FAQ',
  competitor: 'Competitor',
  icp_definition: 'ICP definition',
  persona: 'Persona',
  note: 'Note',
};

function AddChunk({ campaigns, scope, types, onClose, onAdded }) {
  const [form, setForm] = useState({ type: 'note', title: '', content: '', campaignId: scope || '' });
  const [error, setError] = useState(null);

  return (
    <Modal
      title="Add knowledge"
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>Cancel</button>
          <ActionButton
            className="btn primary"
            disabled={!form.content.trim()}
            onClick={async () => {
              setError(null);
              try {
                await api.addKnowledge({ ...form, campaignId: form.campaignId || null });
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
        <div className="grid grid-2">
          <div className="field">
            <label className="label">Type</label>
            <select className="select" value={form.type} onChange={(e) => setForm({ ...form, type: e.target.value })}>
              {types.map((t) => <option key={t} value={t}>{TYPE_LABEL[t] ?? t}</option>)}
            </select>
            <span className="hint">Type decides which step of the pipeline prefers it.</span>
          </div>
          <div className="field">
            <label className="label">Scope</label>
            <select className="select" value={form.campaignId} onChange={(e) => setForm({ ...form, campaignId: e.target.value })}>
              <option value="">Every campaign</option>
              {campaigns.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </div>
        </div>
        <div className="field">
          <label className="label">Title</label>
          <input className="input" value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} />
        </div>
        <div className="field">
          <label className="label">Content</label>
          <textarea
            className="textarea"
            rows={6}
            value={form.content}
            onChange={(e) => setForm({ ...form, content: e.target.value })}
            placeholder="Write it the way you would say it. This text is what an agent is permitted to claim, so anything not in here cannot appear in a message."
          />
        </div>
      </div>
    </Modal>
  );
}

export default function Knowledge() {
  const { campaigns, scope, setScope, setError, connection } = useApp();
  const [chunks, setChunks] = useState(null);
  const [types, setTypes] = useState(['note']);
  const [adding, setAdding] = useState(false);
  const [query, setQuery] = useState('');
  const [preview, setPreview] = useState(null);
  const [expanded, setExpanded] = useState(null);

  const load = useCallback(async () => {
    try {
      setChunks(await api.listKnowledge(scope || undefined));
    } catch (err) {
      setError(friendlyError(err));
      setChunks([]);
    }
  }, [scope, setError]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => { api.knowledgeTypes().then(setTypes).catch(() => {}); }, []);

  const runPreview = async () => {
    if (!query.trim()) return;
    try {
      setPreview(await api.previewRetrieval({ campaignId: scope || null, query, limit: 5 }));
    } catch (err) {
      setError(friendlyError(err));
    }
  };

  return (
    <>
      <div className="topbar">
        <div>
          <div className="page-title">Knowledge</div>
          <div className="page-sub">What a message is allowed to claim</div>
        </div>
        <div className="spacer" />
        <select className="select" style={{ width: 200 }} value={scope} onChange={(e) => setScope(e.target.value)}>
          <option value="">All campaigns</option>
          {campaigns.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
        <button className="btn" onClick={() => setAdding(true)}><Icons.plus size={13} /> Add</button>
      </div>

      <div className="content stack">
        <ConnectionBanner />

        <div className="panel">
          <div className="panel-head">
            <h2>Check what retrieval returns</h2>
          </div>
          <div className="panel-body stack-sm">
            <div className="row">
              <input
                className="input"
                placeholder="Type what an agent would be writing about, e.g. they just raised a Series B"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && runPreview()}
              />
              <ActionButton className="btn primary" onClick={runPreview} disabled={!query.trim()}>
                <Icons.search size={13} /> Retrieve
              </ActionButton>
            </div>

            {preview && (
              <>
                <Note>{preview.note}</Note>
                {preview.results.length === 0 ? (
                  <Empty title="Nothing matched" sub="Personalisation would refuse to write rather than invent a claim." />
                ) : (
                  <div>
                    {preview.results.map((r) => (
                      <div className="draft" key={r.id} style={{ marginTop: 8 }}>
                        <div className="draft-head">
                          <Pill tone="blue">{TYPE_LABEL[r.type] ?? r.type}</Pill>
                          <span className="dim">{r.title}</span>
                          <Pill tone="line">{r.scope}</Pill>
                          <div className="spacer" />
                          <span className="mono">score {r.score}</span>
                        </div>
                        <div className="draft-body">{r.content}</div>
                      </div>
                    ))}
                  </div>
                )}
              </>
            )}
          </div>
        </div>

        <div className="panel">
          <div className="panel-head">
            <h2>Everything in the base</h2>
            <div className="spacer" />
            {chunks && <span className="tiny muted">{chunks.length} chunks</span>}
          </div>
          <div className="panel-body tight">
            {!chunks ? <Loading /> : chunks.length === 0 ? (
              <Empty title="Nothing here yet" sub="Add product facts, objection handling, case studies and brand voice." />
            ) : (
              <table className="data">
                <thead>
                  <tr><th>Type</th><th>Title</th><th>Scope</th><th className="num-cell">Words</th><th>Added</th><th /></tr>
                </thead>
                <tbody>
                  {chunks.map((c) => (
                    <Fragment key={c.id}>
                      <tr className="clickable" onClick={() => setExpanded(expanded === c.id ? null : c.id)}>
                        <td><Pill tone="grey">{TYPE_LABEL[c.type] ?? c.type}</Pill></td>
                        <td>
                          <div className="cell-main">{c.title}</div>
                          {expanded !== c.id && <div className="cell-sub">{c.excerpt}</div>}
                        </td>
                        <td>
                          <Pill tone={c.scope === 'global' ? 'line' : 'blue'}>
                            {c.scope === 'global' ? 'all campaigns' : 'this campaign'}
                          </Pill>
                        </td>
                        <td className="num-cell small">{c.word_count}</td>
                        <td className="small muted">{when(c.created_at)}</td>
                        <td style={{ textAlign: 'right' }}>
                          <ActionButton
                            className="btn ghost sm"
                            onClick={async (e) => {
                              e?.stopPropagation?.();
                              await api.deleteKnowledge(c.id);
                              await load();
                            }}
                          >
                            <Icons.x size={13} />
                          </ActionButton>
                        </td>
                      </tr>
                      {expanded === c.id && (
                        <tr key={`${c.id}-body`}>
                          <td colSpan={6} style={{ background: 'var(--surface-2)' }}>
                            <div className="small" style={{ whiteSpace: 'pre-wrap', lineHeight: 1.6 }}>{c.content}</div>
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>

        {connection === 'connected' && (
          <Note>
            Retrieval is lexical: term overlap, normalised for chunk length, with a boost for the
            chunk types that matter to the step being run. It is not embedding search and is not
            described as such anywhere. Swapping in pgvector later means replacing one scoring
            function.
          </Note>
        )}
      </div>

      {adding && (
        <AddChunk
          campaigns={campaigns}
          scope={scope}
          types={types}
          onClose={() => setAdding(false)}
          onAdded={load}
        />
      )}
    </>
  );
}
