/**
 * Shared primitives. One file, because there are eleven of them and eleven
 * files of nine lines each is harder to read than this.
 */
import { useEffect, useRef, useState } from 'react';

/* ── icons ───────────────────────────────────────────────────────────── */

const ico = (d, extra) => (props) => (
  <svg
    viewBox="0 0 24 24"
    width={props?.size ?? 15}
    height={props?.size ?? 15}
    fill="none"
    stroke="currentColor"
    strokeWidth="1.8"
    strokeLinecap="round"
    strokeLinejoin="round"
    className={props?.className}
    aria-hidden="true"
  >
    <path d={d} />
    {extra}
  </svg>
);

export const Icons = {
  queue: ico('M3 5h18M3 12h18M3 19h12'),
  people: ico('M16 20v-1a4 4 0 0 0-4-4H7a4 4 0 0 0-4 4v1', <circle key="c" cx="9.5" cy="7" r="3.2" />),
  target: ico('M12 3v3M12 18v3M3 12h3M18 12h3', <circle key="c" cx="12" cy="12" r="5" />),
  bot: ico('M9 2v3M15 2v3M8 11v1M16 11v1M9.5 16h5', <rect key="r" x="3.5" y="5" width="17" height="14" rx="3" />),
  book: ico('M4 5.5A2.5 2.5 0 0 1 6.5 3H20v15H6.5A2.5 2.5 0 0 0 4 20.5zM20 18v3H6.5'),
  shield: ico('M12 3l8 3.5v5c0 5-3.4 8.6-8 9.5-4.6-.9-8-4.5-8-9.5v-5z'),
  search: ico('M20.5 20.5l-4.3-4.3', <circle key="c" cx="11" cy="11" r="6.5" />),
  check: ico('M4.5 12.5l5 5 10-11'),
  x: ico('M6 6l12 12M18 6L6 18'),
  play: ico('M6 4.5l13 7.5-13 7.5z'),
  chevron: ico('M9 5l7 7-7 7'),
  back: ico('M15 5l-7 7 7 7'),
  plus: ico('M12 5v14M5 12h14'),
  warn: ico('M12 8.5v5M12 17h.01M10.3 3.9L2.6 17.4A2 2 0 0 0 4.3 20.4h15.4a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z'),
  info: ico('M12 16v-5M12 8h.01', <circle key="c" cx="12" cy="12" r="9" />),
  refresh: ico('M20 12a8 8 0 1 1-2.4-5.7M20 4v4h-4'),
  send: ico('M21 3L10.5 13.5M21 3l-6.8 18-3.7-7.5L3 10z'),
  logout: ico('M15 17l5-5-5-5M20 12H9M12 20H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h6'),
};

/* ── small display pieces ────────────────────────────────────────────── */

export function Pill({ tone = 'grey', children, dot = false }) {
  return (
    <span className={`pill ${tone}`}>
      {dot && <i className="dot" />}
      {children}
    </span>
  );
}

const STATE_TONE = {
  discovered: 'grey',
  researched: 'grey',
  qualified: 'ok',
  strategy_planned: 'blue',
  contacted: 'blue',
  engaged: 'ok',
  meeting: 'ok',
  opportunity: 'ok',
  rejected: 'stop',
  needs_review: 'warn',
  stopped: 'grey',
  suppressed: 'stop',
  opted_out: 'stop',
};

export const labelOf = (s) => String(s ?? '').replace(/_/g, ' ');

/** Channel names are proper nouns. Title-casing turns LinkedIn into Linkedin. */
const CHANNEL_LABEL = { email: 'Email', linkedin: 'LinkedIn', sms: 'SMS', voice: 'Voice' };
export const channelLabel = (c) => CHANNEL_LABEL[c] ?? c;

export const StateTag = ({ state }) => <Pill tone={STATE_TONE[state] ?? 'grey'}>{labelOf(state)}</Pill>;

/**
 * Which engine produced a result. Three states, never two: a fallback that
 * looks like a model call is the one thing this badge exists to prevent.
 */
export function EngineTag({ engine }) {
  const map = {
    dronahq: { tone: 'blue', label: 'DronaHQ' },
    local_engine: { tone: 'warn', label: 'Fallback' },
    our_engine: { tone: 'grey', label: 'Rule-based' },
  };
  const cfg = map[engine];
  if (!cfg) return null;
  return <Pill tone={cfg.tone}>{cfg.label}</Pill>;
}

export function Score({ value }) {
  if (value === null || value === undefined) return <span className="muted">—</span>;
  const tone = value >= 65 ? 'var(--ok)' : value >= 45 ? 'var(--warn)' : 'var(--stop)';
  return <span className="score" style={{ color: tone }}>{value}</span>;
}

export function Empty({ title, sub, action }) {
  return (
    <div className="empty">
      <div className="empty-title">{title}</div>
      {sub && <div className="empty-sub">{sub}</div>}
      {action && <div style={{ marginTop: 13 }}>{action}</div>}
    </div>
  );
}

export function Banner({ tone = 'info', icon = true, children }) {
  const I = tone === 'info' ? Icons.info : Icons.warn;
  return (
    <div className={`banner ${tone}`}>
      {icon && <I size={15} />}
      <div>{children}</div>
    </div>
  );
}

export const Note = ({ children }) => <p className="note">{children}</p>;

export function Loading({ label = 'Loading' }) {
  return (
    <div className="empty">
      <span className="spin" />
      <div className="empty-sub" style={{ marginTop: 9 }}>{label}</div>
    </div>
  );
}

export function Toggle({ on, onChange, danger = false, disabled = false, label }) {
  return (
    <button
      type="button"
      className={`toggle ${on ? 'on' : ''} ${danger ? 'danger' : ''}`}
      onClick={() => !disabled && onChange(!on)}
      disabled={disabled}
      aria-pressed={on}
      aria-label={label}
    >
      <i />
    </button>
  );
}

/* ── time ────────────────────────────────────────────────────────────── */

export function when(iso) {
  if (!iso) return '—';
  const then = new Date(iso);
  const secs = Math.round((Date.now() - then.getTime()) / 1000);
  if (secs < 0) {
    const ahead = Math.abs(secs);
    if (ahead < 3600) return `in ${Math.round(ahead / 60)}m`;
    if (ahead < 86400) return `in ${Math.round(ahead / 3600)}h`;
    return `in ${Math.round(ahead / 86400)}d`;
  }
  if (secs < 60) return 'just now';
  if (secs < 3600) return `${Math.round(secs / 60)}m ago`;
  if (secs < 86400) return `${Math.round(secs / 3600)}h ago`;
  if (secs < 604800) return `${Math.round(secs / 86400)}d ago`;
  return then.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

export const fullDate = (iso) =>
  iso ? new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : '—';

/* ── modal ───────────────────────────────────────────────────────────── */

export function Modal({ title, onClose, children, footer, wide = false }) {
  const ref = useRef(null);

  useEffect(() => {
    const onKey = (e) => e.key === 'Escape' && onClose();
    document.addEventListener('keydown', onKey);
    ref.current?.focus();
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div
        className="modal"
        ref={ref}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        style={wide ? { maxWidth: 760 } : undefined}
      >
        <div className="modal-head">
          <h2>{title}</h2>
          <div className="spacer" />
          <button className="btn ghost sm" onClick={onClose} aria-label="Close">
            <Icons.x size={14} />
          </button>
        </div>
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-foot">{footer}</div>}
      </div>
    </div>
  );
}

/* ── async button ────────────────────────────────────────────────────── */

/**
 * A button whose click is a network call. Keeps its own pending state so a
 * double click cannot fire the same approval twice, and clears it on unmount
 * so a navigation mid-request does not warn.
 */
export function ActionButton({ onClick, children, className = 'btn', disabled, title }) {
  const [busy, setBusy] = useState(false);
  const alive = useRef(true);

  useEffect(() => () => { alive.current = false; }, []);

  return (
    <button
      className={className}
      title={title}
      disabled={busy || disabled}
      onClick={async () => {
        setBusy(true);
        try {
          await onClick();
        } finally {
          if (alive.current) setBusy(false);
        }
      }}
    >
      {busy ? <span className="spin" /> : children}
    </button>
  );
}

/* ── pipeline ────────────────────────────────────────────────────────── */

export function Pipeline({ funnel }) {
  const stages = funnel?.stages ?? [];
  const top = Math.max(1, ...stages.map((s) => s.count));

  return (
    <div>
      <div className="pipeline">
        {stages.map((s) => (
          <div className="stage" key={s.key}>
            <div className="stage-n">{s.count}</div>
            <div className="stage-l">{s.label}</div>
            <div className="stage-bar">
              <i style={{ width: `${(s.count / top) * 100}%` }} />
            </div>
          </div>
        ))}
      </div>
      {funnel?.assumption && <Note>{funnel.assumption}</Note>}
    </div>
  );
}
