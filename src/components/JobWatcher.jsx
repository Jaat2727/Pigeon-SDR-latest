/**
 * Watching a job.
 *
 * A run is four model calls per prospect. The server does that after it has
 * answered the request, so the UI's job is to follow along: poll the row,
 * show the counts moving, print each prospect as it is finished with, and
 * offer a Cancel that genuinely stops the work rather than just closing the
 * panel.
 *
 * Polling rather than a socket, deliberately. The state being watched is a
 * database row that a second browser tab, the background worker, or a cancel
 * from the Controls screen can all change. Re-reading the row is correct for
 * all of those, where a stream from one process would not be.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import * as api from '../api/index.js';
import { friendlyError } from '../api/client.js';
import { ActionButton, Icons, Pill, when } from './ui.jsx';

const POLL_MS = 1500;

/**
 * Follows one job until it finishes.
 *
 * @param {string|null} jobId
 * @param {{onFinish?: (job) => void}} [options]
 */
export function useJob(jobId, { onFinish } = {}) {
  const [job, setJob] = useState(null);
  const [error, setError] = useState(null);

  // Held in a ref so changing the callback does not restart the poll, and so
  // the interval always calls the current one rather than the one that
  // existed when it was created.
  const finishRef = useRef(onFinish);
  finishRef.current = onFinish;

  useEffect(() => {
    if (!jobId) {
      setJob(null);
      setError(null);
      return undefined;
    }

    let alive = true;
    let timer = null;
    let announced = false;

    const tick = async () => {
      try {
        const next = await api.getJob(jobId);
        if (!alive) return;

        setJob(next);
        setError(null);

        if (next.finished) {
          clearInterval(timer);
          // Guarded: a finished job that is polled once more before the
          // interval clears would otherwise fire the callback twice, and that
          // callback usually reloads a page's data.
          if (!announced) {
            announced = true;
            finishRef.current?.(next);
          }
        }
      } catch (err) {
        if (!alive) return;
        setError(friendlyError(err));
        clearInterval(timer);
      }
    };

    tick();
    timer = setInterval(tick, POLL_MS);

    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [jobId]);

  const cancel = useCallback(
    async (actor = 'operator') => {
      if (!jobId) return;
      try {
        setJob(await api.cancelJob(jobId, { actor }));
      } catch (err) {
        setError(friendlyError(err));
      }
    },
    [jobId]
  );

  return { job, error, cancel };
}

const STATUS_TONE = {
  queued: 'grey',
  running: 'blue',
  succeeded: 'ok',
  failed: 'stop',
  cancelled: 'warn',
};

const STATUS_LABEL = {
  queued: 'queued',
  running: 'running',
  succeeded: 'finished',
  failed: 'failed',
  cancelled: 'stopped',
};

const EVENT_TONE = {
  ok: 'var(--ok)',
  error: 'var(--stop)',
  stop: 'var(--warn)',
  hold: 'var(--warn)',
  skip: 'var(--ink-3)',
  done: 'var(--ok)',
  info: 'var(--ink-3)',
};

const TYPE_LABEL = {
  campaign_run: 'Pipeline run',
  discovery: 'Finding prospects',
  prospect_advance: 'Advancing one prospect',
};

/**
 * The progress panel. Shows an indeterminate bar until the server knows how
 * many prospects it picked up, because a determinate bar sitting at zero
 * reads as stuck rather than as starting.
 */
export function JobProgress({ job, error, onCancel, actor = 'operator', compact = false }) {
  if (error) {
    return (
      <div className="job-panel">
        <div className="small" style={{ color: 'var(--stop)' }}>{error}</div>
      </div>
    );
  }

  if (!job) {
    return (
      <div className="job-panel">
        <div className="row" style={{ gap: 8 }}>
          <span className="spin" />
          <span className="small dim">Starting</span>
        </div>
      </div>
    );
  }

  const running = !job.finished;
  const pct = job.percent;

  return (
    <div className={`job-panel ${job.status}`}>
      <div className="row" style={{ gap: 8 }}>
        <Pill tone={STATUS_TONE[job.status] ?? 'grey'} dot>
          {STATUS_LABEL[job.status] ?? job.status}
        </Pill>
        <span className="small">{TYPE_LABEL[job.type] ?? job.type}</span>
        <div className="spacer" />
        {job.total > 0 && (
          <span className="tiny muted">
            {job.processed} of {job.total}
            {job.failed > 0 ? ` · ${job.failed} failed` : ''}
          </span>
        )}
        {running && onCancel && (
          <ActionButton className="btn ghost sm" onClick={() => onCancel(actor)} title="Stop this run">
            <Icons.x size={12} /> Stop
          </ActionButton>
        )}
      </div>

      <div className={`job-bar ${pct === null && running ? 'indeterminate' : ''}`}>
        <i
          style={{
            width: pct === null ? '100%' : `${pct}%`,
            background:
              job.status === 'failed' ? 'var(--stop)' :
              job.status === 'cancelled' ? 'var(--warn)' :
              job.status === 'succeeded' ? 'var(--ok)' : 'var(--accent, #6366f1)',
          }}
        />
      </div>

      {running && job.current_label && (
        <div className="tiny muted">Working on {job.current_label}</div>
      )}

      {job.error && <div className="small" style={{ color: 'var(--stop)' }}>{job.error}</div>}

      {!compact && job.events?.length > 0 && (
        <ul className="job-events">
          {[...job.events].reverse().map((e, i) => (
            <li key={`${e.at}-${i}`}>
              <i className="dot" style={{ background: EVENT_TONE[e.level] ?? 'var(--ink-3)' }} />
              <span>{e.message}</span>
              <span className="tiny muted">{when(e.at)}</span>
            </li>
          ))}
        </ul>
      )}

      {job.finished && job.status === 'succeeded' && job.total === 0 && (
        <div className="tiny muted">
          Nothing was picked up. Every prospect in this campaign is either finished or waiting on a person.
        </div>
      )}
    </div>
  );
}

/** Watch + render, for the common case where a page just started a job. */
export function JobPanel({ jobId, onFinish, actor, compact }) {
  const { job, error, cancel } = useJob(jobId, { onFinish });
  if (!jobId) return null;
  return <JobProgress job={job} error={error} onCancel={cancel} actor={actor} compact={compact} />;
}
