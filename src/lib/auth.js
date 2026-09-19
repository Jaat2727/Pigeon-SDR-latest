/**
 * Sign-in.
 *
 * Supabase auth is used for exactly one thing: establishing who is clicking
 * approve. The browser never reads application data from Supabase — every row
 * on every screen comes from the API, which holds the service role key that
 * the browser must never see.
 *
 * If the two public variables are not set, the app opens without a password
 * and says so on the sign-in screen. That is a deployment choice, not a
 * bypass: a demo link nobody can open is not a demo, and pretending there is
 * a login when there is no auth configured would be worse than saying it.
 */
import { createClient } from '@supabase/supabase-js';

const URL = (import.meta.env.VITE_SUPABASE_URL ?? '').trim();
const ANON = (import.meta.env.VITE_SUPABASE_ANON_KEY ?? '').trim();

export const isAuthConfigured = Boolean(URL && ANON);

export const supabase = isAuthConfigured
  ? createClient(URL, ANON, {
      auth: { persistSession: true, autoRefreshToken: true },
      realtime: { transport: globalThis.WebSocket ?? function NoRealtime() {} },
    })
  : null;

/** Used when auth is not configured, so approvals still have an actor. */
export const OPEN_OPERATOR = {
  id: 'open-access',
  email: null,
  name: 'Operator',
  open_access: true,
};

/**
 * Open access remembers itself for the tab.
 *
 * Without this, a deployment with no Supabase auth sends the viewer back to
 * the entry screen on every refresh, and on any link opened directly. It is a
 * per-viewer convenience, so it lives in sessionStorage and every access is
 * guarded: private windows and blocked site data both throw here.
 */
const OPEN_KEY = 'pigeon.open_access';

const rememberOpenAccess = () => {
  try { sessionStorage.setItem(OPEN_KEY, '1'); } catch { /* storage unavailable */ }
};

const openAccessRemembered = () => {
  try { return sessionStorage.getItem(OPEN_KEY) === '1'; } catch { return false; }
};

const forgetOpenAccess = () => {
  try { sessionStorage.removeItem(OPEN_KEY); } catch { /* storage unavailable */ }
};

export async function getSession() {
  // Returns null the first time even when auth is not configured, so the entry
  // screen is always shown once. Without that, a deployment with no Supabase
  // auth drops straight into the app and the sign-in screen only exists in the
  // code.
  if (!supabase) return openAccessRemembered() ? OPEN_OPERATOR : null;
  const { data } = await supabase.auth.getSession();
  const user = data?.session?.user;
  if (!user) return null;
  return {
    id: user.id,
    email: user.email,
    name: user.user_metadata?.full_name || user.email?.split('@')[0] || 'Operator',
    open_access: false,
  };
}

export async function signIn(email, password) {
  if (!supabase) {
    rememberOpenAccess();
    return OPEN_OPERATOR;
  }
  const { data, error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) throw new Error(friendlyAuthError(error.message));
  return {
    id: data.user.id,
    email: data.user.email,
    name: data.user.user_metadata?.full_name || data.user.email.split('@')[0],
    open_access: false,
  };
}

export async function signOut() {
  forgetOpenAccess();
  if (supabase) await supabase.auth.signOut();
}

function friendlyAuthError(message) {
  const m = String(message).toLowerCase();
  if (m.includes('invalid login')) return 'That email and password do not match an account.';
  if (m.includes('email not confirmed')) {
    return 'That account has not confirmed its email. Confirm it in Supabase, or turn off email confirmation for the demo.';
  }
  if (m.includes('rate limit')) return 'Too many attempts. Wait a minute and try again.';
  return message;
}
