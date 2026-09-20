/**
 * Creating a campaign, in four steps.
 *
 * It used to be one long form of empty boxes. That is a fine way to collect
 * fields and a bad way to get a campaign that works, because the fields are
 * not equally important and the form gave no hint which ones the agents
 * actually read. An empty ICP produces a campaign where every prospect comes
 * back "needs review", and the old form let you create that without a word.
 *
 * So: four steps in the order the decisions actually happen, a template to
 * start from, and a review at the end that says plainly what is missing and
 * what it will cost you. It still creates a draft — nothing goes out until
 * someone sets it live, which is a separate, deliberate act.
 */
import { useState } from 'react';
import * as api from '../api/index.js';
import { friendlyError } from '../api/client.js';
import { ActionButton, Banner, Icons, Modal, Note, Pill } from './ui.jsx';

const CHANNELS = [
  { id: 'email', label: 'Email', note: 'The default. Longest messages, best for detail.' },
  { id: 'linkedin', label: 'LinkedIn', note: 'Short. Good when you have no email address.' },
  { id: 'sms', label: 'SMS', note: 'Very short. Only where you have consent.' },
  { id: 'voice', label: 'Voice', note: 'Planned, not built. Nothing is dialled.', disabled: true },
];

/**
 * Starting points, not presets: every field stays editable. They exist so the
 * first campaign someone builds has sentences in it rather than placeholders,
 * and so the shape of a good ICP is visible from an example.
 */
const TEMPLATES = [
  {
    id: 'saas',
    label: 'B2B SaaS',
    blurb: 'Technical buyer at a funded software company',
    values: {
      objective: 'Book qualified discovery calls with engineering leaders',
      icp_criteria:
        'B2B SaaS companies with 50 to 2000 employees that have raised a Series A or later. ' +
        'The right person is the CTO or VP Engineering. Strong signals are recent funding, ' +
        'open platform or infrastructure roles, and a public engineering blog.',
      exclusion_criteria:
        'Agencies, consultancies and outsourcing firms. Direct competitors. Anyone we have ' +
        'already spoken to in the last six months.',
      target_roles: 'CTO, VP Engineering, Head of Platform',
      industry: 'B2B SaaS',
      company_size: '50-2000',
      outreach_policy: 'Three touches over nine days. Email first, LinkedIn if there is no reply by day five.',
      messaging_policy:
        'Under 90 words. Peer to peer, no superlatives, no "I hope this finds you well". Open on ' +
        'something specific from the research. One clear ask at the end.',
      research_focus: 'Funding, hiring, technology stack and recent engineering announcements',
      enabled_channels: ['email', 'linkedin'],
    },
  },
  {
    id: 'services',
    label: 'Professional services',
    blurb: 'Operations or finance buyer at a mid-market company',
    values: {
      objective: 'Book introductory calls with operations leaders',
      icp_criteria:
        'Mid-market companies with 200 to 5000 employees in manufacturing, logistics or retail. ' +
        'The right person runs operations or finance. Strong signals are expansion into a new ' +
        'market, a new site, or hiring across operations roles.',
      exclusion_criteria: 'Existing clients. Companies under 200 employees. Public sector.',
      target_roles: 'COO, VP Operations, Finance Director',
      industry: 'Manufacturing',
      company_size: '200-5000',
      outreach_policy: 'Four touches over fourteen days, email only.',
      messaging_policy:
        'Under 120 words. Plain language, no jargon. Lead with a comparable company and the ' +
        'specific outcome. One question at the end.',
      research_focus: 'Expansion, new sites, hiring and operational announcements',
      enabled_channels: ['email'],
    },
  },
  {
    id: 'blank',
    label: 'Start empty',
    blurb: 'Write everything yourself',
    values: {},
  },
];

const EMPTY = {
  name: '',
  objective: '',
  icp_criteria: '',
  exclusion_criteria: '',
  target_roles: '',
  industry: '',
  company_size: '',
  outreach_policy: '',
  messaging_policy: '',
  research_focus: '',
  enabled_channels: ['email'],
  require_approval: true,
  rep_id: '',
};

const STEPS = [
  { id: 1, label: 'Basics' },
  { id: 2, label: 'Who to target' },
  { id: 3, label: 'How to reach them' },
  { id: 4, label: 'Review' },
];

export default function NewCampaign({ onClose, onCreated, reps = [] }) {
  const [step, setStep] = useState(1);
  const [template, setTemplate] = useState(null);
  const [form, setForm] = useState(EMPTY);
  const [error, setError] = useState(null);

  const set = (key) => (e) => setForm({ ...form, [key]: e.target.value });

  const applyTemplate = (t) => {
    setTemplate(t.id);
    setForm({ ...EMPTY, ...t.values, name: form.name });
  };

  const toggleChannel = (id) => {
    const next = form.enabled_channels.includes(id)
      ? form.enabled_channels.filter((x) => x !== id)
      : [...form.enabled_channels, id];
    if (next.length === 0) return; // a campaign with no channel can plan nothing
    setForm({ ...form, enabled_channels: next });
  };

  /**
   * What this campaign cannot do yet, worked out here so the review step can
   * say it before the campaign exists rather than after someone tries to set
   * it live. It mirrors the server's own check; the server still enforces it.
   */
  const blockers = [];
  const warnings = [];

  if (!form.name.trim()) blockers.push('It needs a name.');
  if (!form.icp_criteria.trim()) {
    blockers.push('Without an ICP the scoring agent has nothing to score against, so every prospect comes back as needs review.');
  }
  if (!form.target_roles.trim()) {
    warnings.push('With no target roles, discovery has no job title to search for. You would have to import prospects by hand.');
  }
  if (!form.exclusion_criteria.trim()) {
    warnings.push('With no exclusions, nothing gets rejected on principle. Competitors and agencies would be scored like anyone else.');
  }
  if (!form.messaging_policy.trim()) {
    warnings.push('With no messaging policy, length and tone are the model’s choice rather than yours.');
  }
  if (!form.rep_id) {
    warnings.push('With no rep assigned, messages are signed "Sales team".');
  }

  const stepValid = step === 1 ? form.name.trim().length > 0 : step === 2 ? form.icp_criteria.trim().length > 0 : true;

  const create = async () => {
    setError(null);
    try {
      const created = await api.createCampaign({
        ...form,
        target_roles: form.target_roles
          ? form.target_roles.split(',').map((s) => s.trim()).filter(Boolean)
          : [],
        rep_id: form.rep_id || null,
      });
      await onCreated(created.id);
    } catch (err) {
      setError(friendlyError(err));
    }
  };

  return (
    <Modal
      title="New campaign"
      onClose={onClose}
      wide
      footer={
        <>
          <button className="btn" onClick={onClose}>Cancel</button>
          <div className="spacer" />
          {step > 1 && (
            <button className="btn" onClick={() => setStep(step - 1)}>
              <Icons.back size={13} /> Back
            </button>
          )}
          {step < 4 ? (
            <button className="btn primary" disabled={!stepValid} onClick={() => setStep(step + 1)}>
              Next <Icons.chevron size={13} />
            </button>
          ) : (
            <ActionButton className="btn primary" disabled={blockers.length > 0} onClick={create}>
              Create as draft
            </ActionButton>
          )}
        </>
      }
    >
      <div className="stack-sm">
        {error && <Banner tone="stop">{error}</Banner>}

        <ol className="wizard-steps">
          {STEPS.map((s) => (
            <li key={s.id} className={s.id === step ? 'on' : s.id < step ? 'done' : ''}>
              <span className="wizard-n">{s.id < step ? '✓' : s.id}</span>
              {s.label}
            </li>
          ))}
        </ol>

        {/* ── 1 · basics ──────────────────────────────────────────────── */}
        {step === 1 && (
          <>
            <div className="field">
              <label className="label">What is this campaign called</label>
              <input
                className="input"
                value={form.name}
                onChange={set('name')}
                placeholder="US SaaS CTO outreach"
                autoFocus
              />
              <span className="hint">For you, not for prospects. Nobody outside sees it.</span>
            </div>

            <div className="field">
              <label className="label">Start from</label>
              <div className="card-choices">
                {TEMPLATES.map((t) => (
                  <button
                    key={t.id}
                    type="button"
                    className={`card-choice ${template === t.id ? 'on' : ''}`}
                    onClick={() => applyTemplate(t)}
                  >
                    <div className="card-choice-title">{t.label}</div>
                    <div className="tiny muted">{t.blurb}</div>
                  </button>
                ))}
              </div>
              <span className="hint">
                A starting point, not a preset. Every word is editable on the next two steps.
              </span>
            </div>

            <div className="field">
              <label className="label">What does a win look like</label>
              <input
                className="input"
                value={form.objective}
                onChange={set('objective')}
                placeholder="Book qualified discovery calls"
              />
              <span className="hint">Passed to the strategy and message agents as written.</span>
            </div>
          </>
        )}

        {/* ── 2 · targeting ───────────────────────────────────────────── */}
        {step === 2 && (
          <>
            <div className="field">
              <label className="label">Who is a good fit</label>
              <textarea
                className="textarea"
                rows={5}
                value={form.icp_criteria}
                onChange={set('icp_criteria')}
                placeholder="B2B SaaS companies, 50 to 2000 employees, post Series A. The right person is the CTO or VP Engineering."
              />
              <span className="hint">
                Plain sentences. This is handed to the scoring agent exactly as you write it, so the
                more specific it is, the fewer prospects come back undecided.
              </span>
            </div>

            <div className="field">
              <label className="label">Who should never be contacted</label>
              <textarea
                className="textarea"
                rows={3}
                value={form.exclusion_criteria}
                onChange={set('exclusion_criteria')}
                placeholder="Agencies, consultancies, direct competitors, existing customers."
              />
              <span className="hint">
                Checked before scoring. A match here is a reject whatever the fit score would have been.
              </span>
            </div>

            <div className="field">
              <label className="label">Job titles to look for</label>
              <input
                className="input"
                value={form.target_roles}
                onChange={set('target_roles')}
                placeholder="CTO, VP Engineering, Head of Platform"
              />
              <span className="hint">Comma separated. Discovery searches on these directly.</span>
            </div>

            <div className="grid grid-2">
              <div className="field">
                <label className="label">Industry</label>
                <input className="input" value={form.industry} onChange={set('industry')} placeholder="B2B SaaS" />
              </div>
              <div className="field">
                <label className="label">Headcount</label>
                <input className="input" value={form.company_size} onChange={set('company_size')} placeholder="50-2000" />
                <span className="hint">A band like 50-2000, or 500+.</span>
              </div>
            </div>

            <div className="field">
              <label className="label">What research should dig for</label>
              <input
                className="input"
                value={form.research_focus}
                onChange={set('research_focus')}
                placeholder="Funding, hiring, tech stack, recent announcements"
              />
            </div>
          </>
        )}

        {/* ── 3 · outreach ────────────────────────────────────────────── */}
        {step === 3 && (
          <>
            <div className="field">
              <label className="label">Channels</label>
              <div className="card-choices">
                {CHANNELS.map((c) => (
                  <button
                    key={c.id}
                    type="button"
                    disabled={c.disabled}
                    className={`card-choice ${form.enabled_channels.includes(c.id) ? 'on' : ''}`}
                    onClick={() => toggleChannel(c.id)}
                  >
                    <div className="card-choice-title">{c.label}</div>
                    <div className="tiny muted">{c.note}</div>
                  </button>
                ))}
              </div>
              <span className="hint">
                The strategy agent may only plan touches on these. Anything it proposes on a channel
                you have not enabled is dropped before it is scheduled.
              </span>
            </div>

            <div className="field">
              <label className="label">How many touches, and how far apart</label>
              <textarea
                className="textarea"
                rows={2}
                value={form.outreach_policy}
                onChange={set('outreach_policy')}
                placeholder="Three touches over nine days. Email first, LinkedIn if no reply by day five."
              />
            </div>

            <div className="field">
              <label className="label">How the messages should read</label>
              <textarea
                className="textarea"
                rows={4}
                value={form.messaging_policy}
                onChange={set('messaging_policy')}
                placeholder="Under 90 words. Peer to peer, no superlatives. Open on something specific from the research. One clear ask."
              />
              <span className="hint">Length and register both. The message agent follows this closely.</span>
            </div>

            <div className="grid grid-2">
              <div className="field">
                <label className="label">Who the messages come from</label>
                <select className="select" value={form.rep_id} onChange={set('rep_id')}>
                  <option value="">Nobody yet, sign as &quot;Sales team&quot;</option>
                  {reps.map((r) => (
                    <option key={r.id} value={r.id}>{r.full_name ?? r.name}{r.title ? ` · ${r.title}` : ''}</option>
                  ))}
                </select>
              </div>
              <div className="field">
                <label className="label">Before a message goes out</label>
                <select
                  className="select"
                  value={form.require_approval ? 'yes' : 'no'}
                  onChange={(e) => setForm({ ...form, require_approval: e.target.value === 'yes' })}
                >
                  <option value="yes">A person approves every one</option>
                  <option value="no">Send without approval</option>
                </select>
                <span className="hint">
                  {form.require_approval
                    ? 'Drafts land in the approvals queue and wait.'
                    : 'Messages are marked sent as soon as they are written. There is still no email provider connected, so nothing is actually delivered.'}
                </span>
              </div>
            </div>
          </>
        )}

        {/* ── 4 · review ──────────────────────────────────────────────── */}
        {step === 4 && (
          <>
            <div className="review">
              <div className="review-row">
                <span className="label">Name</span>
                <b>{form.name || <span className="muted">not set</span>}</b>
              </div>
              <div className="review-row">
                <span className="label">Objective</span>
                <span>{form.objective || <span className="muted">not set</span>}</span>
              </div>
              <div className="review-row">
                <span className="label">Targets</span>
                <span>
                  {form.target_roles || 'any role'}
                  {form.industry ? ` in ${form.industry}` : ''}
                  {form.company_size ? `, ${form.company_size} people` : ''}
                </span>
              </div>
              <div className="review-row">
                <span className="label">Channels</span>
                <span className="row wrap" style={{ gap: 4 }}>
                  {form.enabled_channels.map((c) => <Pill tone="line" key={c}>{c}</Pill>)}
                </span>
              </div>
              <div className="review-row">
                <span className="label">Approval</span>
                <span>{form.require_approval ? 'Every message waits for a person' : 'No approval step'}</span>
              </div>
            </div>

            {blockers.length > 0 && (
              <Banner tone="stop">
                <b>Cannot be created yet.</b>
                <ul className="tight-list">
                  {blockers.map((b) => <li key={b}>{b}</li>)}
                </ul>
              </Banner>
            )}

            {warnings.length > 0 && (
              <Banner tone="warn">
                <b>It will work, with these gaps.</b>
                <ul className="tight-list">
                  {warnings.map((w) => <li key={w}>{w}</li>)}
                </ul>
              </Banner>
            )}

            <Note>
              Created as a draft. It can be filled with prospects straight away — finding people
              sends nothing — but no message is planned or written until someone sets it live.
            </Note>
          </>
        )}
      </div>
    </Modal>
  );
}
