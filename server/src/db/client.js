/**
 * Supabase client, service role.
 *
 * This module does not throw when credentials are absent. A server that dies
 * at import time gives you a container in a restart loop and no way to ask it
 * what is wrong. Instead it starts, `dbReady` is false, /health names the
 * missing variables, and the data routes answer 503 with that same message.
 */
import { createClient } from '@supabase/supabase-js';
import { env } from '../config.js';
import { unavailable } from '../lib/http.js';

export const dbReady = Boolean(env.SUPABASE_URL && env.SUPABASE_SERVICE_ROLE_KEY);

export const supabase = dbReady
  ? createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
      global: { headers: { 'x-application-name': 'pigeon-sdr' } },
      // createClient builds a realtime client whether or not you open a
      // channel, and its constructor asks the runtime for a global WebSocket.
      // Node 22 has one, Node 20 does not, and without this the import throws
      // before any of our code runs. This API talks to Supabase over REST and
      // never opens a socket, so supplying a transport costs nothing and makes
      // the runtime version irrelevant.
      realtime: { transport: globalThis.WebSocket ?? function NoRealtime() {} },
    })
  : null;

if (!dbReady) {
  console.warn(
    '[db] SUPABASE_URL and/or SUPABASE_SERVICE_ROLE_KEY are not set. The API will ' +
      'start, but every data route will answer 503 until they are configured.'
  );
}

/** Mounted ahead of the data routes so one message covers every endpoint. */
export function requireDb(req, res, next) {
  if (!dbReady) {
    return res.status(503).json({
      error: 'database_not_configured',
      message:
        'The server is running but has no database credentials. Set SUPABASE_URL and ' +
        'SUPABASE_SERVICE_ROLE_KEY in the deployment environment and redeploy.',
    });
  }
  return next();
}

/**
 * Turns a supabase-js result into data, or throws. Route handlers can then use
 * ordinary control flow instead of checking `error` at every call site.
 */
export function unwrap({ data, error }, context = 'query') {
  if (error) {
    const err = new Error(`${context}: ${error.message}`);
    err.code = error.code;
    err.details = error.details;
    err.hint = error.hint;
    throw err;
  }
  return data;
}

/**
 * Like `unwrap`, but tolerates the small set of errors that mean "this part of
 * the schema is not there yet" rather than "this query is wrong". Returns the
 * fallback so a half-applied schema degrades one feature at a time instead of
 * failing a whole page.
 *
 *   42P01     undefined table
 *   42703     undefined column
 *   PGRST116  no rows matched a .single()
 *   PGRST200  no foreign key behind an embedded select
 *   PGRST205  table missing from the PostgREST schema cache
 */
const TOLERATED = new Set(['42P01', '42703', 'PGRST116', 'PGRST200', 'PGRST205']);

export function unwrapSoft({ data, error }, fallback = null, context = 'query') {
  if (error) {
    if (TOLERATED.has(error.code)) {
      console.warn(`[db] ${context} degraded: ${error.message}`);
      return fallback;
    }
    const err = new Error(`${context}: ${error.message}`);
    err.code = error.code;
    throw err;
  }
  return data ?? fallback;
}

/** A quick connectivity check for /health. */
export async function pingDatabase() {
  if (!dbReady) throw unavailable('Database credentials are not set');
  const { error } = await supabase.from('system_control').select('id').limit(1);
  if (error) throw new Error(error.message);
  return true;
}

export default supabase;
