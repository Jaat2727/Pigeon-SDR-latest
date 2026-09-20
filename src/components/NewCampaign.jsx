/**
 * Create a campaign. Starts in draft, exactly like the lifecycle in the brief
 * says it should: not permitted to send anything until a person sets it live.
 */
import { useState } from 'react';
import * as api from '../api/index.js';
import { friendlyError } from '../api/client.js';
import { ActionButton, Banner, Modal } from './ui.jsx';

const CHANNELS = ['email', 'linkedin', 'sms', 'voice'];

export default function NewCampaign({ onClose, onCreated }) {
  const [form, setForm] = useState({
    name: '',
    objective: '',
    icp_criteria: '',
    exclusion_criteria: '',
    industry: '',
    company_size: '',
    enabled_channels: ['email'],
  });
  const [error, setError] = useState(null);
  const [saving, setSaving] = useState(false);
  const set = (k) => (e) => setForm({ ...form, [k]: e.target.value });

  const toggleChannel = (c) => {
    const next = form.enabled_channels.includes(c)
      ? form.enabled_channels.filter((x) => x !== c)
      : [...form.enabled_channels, c];
    if (next.length === 0) return;
    setForm({ ...form, enabled_channels: next });
  };

  const create = async () => {
    setError(null);
    if (!form.name.trim()) { setError('A campaign needs a name.'); return; }
    setSaving(true);
    try {
      const created = await api.createCampaign({ ...form, status: 'draft' });
      await onCreated(created.id);
    } catch (err) {
      setError(friendlyError(err));
    } finally {
      setSaving(false);
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
          <ActionButton className="btn primary" onClick={create} disabled={saving}>
            Create as draft
          </ActionButton>
        </>
      }
    >
      <div className="stack-sm">
        {error && <Banner tone="stop">{error}</Banner>}
        <div className="field">
          <label className="label">Name</label>
          <input className="input" value={form.name} onChange={set('name')} placeholder="e.g. US SaaS CTO outreach" autoFocus />
        </div>
        <div className="field">
          <label className="label">Objective</label>
          <input className="input" value={form.objective} onChange={set('objective')} placeholder="Book qualified discovery calls" />
        </div>
        <div className="field">
          <label className="label">Who to target (ICP)</label>
          <textarea className="textarea" rows={3} value={form.icp_criteria} onChange={set('icp_criteria')}
            placeholder="B2B SaaS companies, 50 to 2000 employees, target the CTO or VP Engineering." />
          <span className="hint">Plain sentences. This is passed to the scoring agent as written.</span>
        </div>
        <div className="field">
          <label className="label">Who never to contact</label>
          <textarea className="textarea" rows={2} value={form.exclusion_criteria} onChange={set('exclusion_criteria')}
            placeholder="Agencies, consultancies, competitors." />
        </div>
        <div className="grid grid-2">
          <div className="field">
            <label className="label">Target industry</label>
            <input className="input" value={form.industry} onChange={set('industry')} />
          </div>
          <div className="field">
            <label className="label">Headcount band</label>
            <input className="input" value={form.company_size} onChange={set('company_size')} placeholder="50-2000" />
          </div>
        </div>
        <div className="field">
          <label className="label">Channels</label>
          <div className="row wrap" style={{ gap: 6 }}>
            {CHANNELS.map((c) => (
              <button
                key={c}
                type="button"
                className={`btn sm ${form.enabled_channels.includes(c) ? 'primary' : ''}`}
                onClick={() => toggleChannel(c)}
              >
                {c}
              </button>
            ))}
          </div>
        </div>
        <span className="hint">
          Created in Draft. Nothing goes out until you set it live, and targeting, prompts and
          channels can all be refined first from the campaign&apos;s editor.
        </span>
      </div>
    </Modal>
  );
}
