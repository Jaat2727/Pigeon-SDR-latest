/**
 * Shared state: who is signed in, whether the API is reachable, the campaign
 * list, and the queue.
 *
 * The queue is here rather than inside the Queue page because the sidebar
 * badge and the Queue screen have to agree, and two components polling the
 * same endpoint on different timers is how they stop agreeing.
 */
import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import * as api from '../api/index.js';
import { checkHealth, isApiConfigured, friendlyError } from '../api/client.js';
import { getSession, signIn as doSignIn, signOut as doSignOut, isAuthConfigured, OPEN_OPERATOR } from '../lib/auth.js';

const Ctx = createContext(null);

export const useApp = () => {
  const value = useContext(Ctx);
  if (!value) throw new Error('useApp must be used inside AppProvider');
  return value;
};

const POLL_MS = 20000;

export function AppProvider({ children }) {
  const [user, setUser] = useState(null);
  const [authReady, setAuthReady] = useState(false);

  const [connection, setConnection] = useState(isApiConfigured ? 'checking' : 'not_configured');
  const [health, setHealth] = useState(null);

  const [campaigns, setCampaigns] = useState([]);
  const [queue, setQueue] = useState(null);
  const [scope, setScope] = useState(''); // '' means every campaign
  const [error, setError] = useState(null);
  const [activeJobs, setActiveJobs] = useState([]);

  const scopeRef = useRef(scope);
  scopeRef.current = scope;

  /* ── auth ──────────────────────────────────────────────────────────── */

  useEffect(() => {
    let cancelled = false;
    getSession()
      .then((session) => !cancelled && setUser(session))
      .catch(() => !cancelled && setUser(null))
      .finally(() => !cancelled && setAuthReady(true));
    return () => { cancelled = true; };
  }, []);

  const signIn = useCallback(async (email, password) => {
    const session = await doSignIn(email, password);
    setUser(session);
    return session;
  }, []);

  const signOut = useCallback(async () => {
    await doSignOut();
    setUser(isAuthConfigured ? null : OPEN_OPERATOR);
  }, []);

  /* ── connection ────────────────────────────────────────────────────── */

  const probe = useCallback(async () => {
    if (!isApiConfigured) {
      setConnection('not_configured');
      return false;
    }
    try {
      const result = await checkHealth();
      setHealth(result);
      setConnection(result.status === 'ok' ? 'connected' : 'degraded');
      return result.status === 'ok';
    } catch (err) {
      setHealth(null);
      setConnection('unreachable');
      setError(friendlyError(err));
      return false;
    }
  }, []);

  /* ── data ──────────────────────────────────────────────────────────── */

  const refresh = useCallback(async () => {
    if (!isApiConfigured) return;
    try {
      const [q, cs] = await Promise.all([api.getQueue(scopeRef.current || undefined), api.listCampaigns()]);
      setQueue(q);
      setCampaigns(cs);
      setConnection('connected');
      setError(null);
    } catch (err) {
      setError(friendlyError(err));
      if (err?.status === undefined) setConnection('unreachable');
    }
  }, []);

  // First load, once signed in.
  useEffect(() => {
    if (!user) return;
    probe().then((ok) => ok && refresh());
  }, [user, probe, refresh]);

  // Poll, but not while the tab is hidden. A laptop closed for an hour should
  // not wake up to sixty queued requests.
  useEffect(() => {
    if (!user || !isApiConfigured) return undefined;

    let timer = null;

    const start = () => {
      stop();
      timer = setInterval(() => {
        if (document.visibilityState === 'visible') refresh();
      }, POLL_MS);
    };
    const stop = () => { if (timer) clearInterval(timer); timer = null; };

    const onVisible = () => {
      if (document.visibilityState === 'visible') refresh();
    };

    start();
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      stop();
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [user, refresh]);

  // Refresh when the scope changes, without waiting for the next tick.
  useEffect(() => {
    if (user) refresh();
  }, [scope, user, refresh]);

  /* ── jobs, watched from everywhere ────────────────────────────────────
   * A campaign run or a discovery sweep takes minutes and happens on the
   * server regardless of which screen is open. Without this, leaving the
   * page that started it makes the work invisible — nothing on Agents,
   * Prospects or Queue would say anything is happening, so a run that is
   * genuinely still going looks like it silently did nothing. Polled
   * faster than the general refresh because "is something running" is the
   * one thing worth noticing quickly. */
  const refreshJobs = useCallback(async () => {
    if (!isApiConfigured) return;
    try {
      const { jobs } = await api.listJobs({ status: 'queued,running', limit: 20 });
      setActiveJobs(jobs);
    } catch {
      // A failed poll should not blank out a bar someone is watching.
    }
  }, []);

  useEffect(() => {
    if (!user || !isApiConfigured) return undefined;

    let timer = null;
    const tick = () => { if (document.visibilityState === 'visible') refreshJobs(); };

    tick();
    timer = setInterval(tick, 5000);
    document.addEventListener('visibilitychange', tick);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', tick);
    };
  }, [user, refreshJobs]);

  const actor = user?.name ?? 'operator';

  const value = {
    user, authReady, signIn, signOut, isAuthConfigured, actor,
    connection, health, probe,
    campaigns, queue, refresh,
    scope, setScope,
    error, setError,
    activeJobs, refreshJobs,
    openApprovals: queue?.stats?.open_approvals ?? 0,
  };

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
