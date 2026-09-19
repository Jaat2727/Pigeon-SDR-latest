/**
 * The HTTP client.
 *
 * There is no mock mode and no offline fallback. If the API cannot be reached
 * the app says so and shows nothing, because a screen full of invented numbers
 * that looks identical to a working one is the worst outcome available here.
 */

const RAW = import.meta.env.VITE_API_BASE_URL ?? '';
export const API_BASE_URL = RAW.trim().replace(/\/+$/, '');
export const isApiConfigured = API_BASE_URL.length > 0;

export class ApiError extends Error {
  constructor(message, { status, code, body } = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.body = body;
  }
}

/** Turns whatever went wrong into a sentence with a next step in it. */
export function friendlyError(err) {
  if (!isApiConfigured) {
    return 'The API address is not set. Add VITE_API_BASE_URL in the Vercel project settings and redeploy.';
  }
  if (err instanceof ApiError) {
    if (err.code === 'database_not_configured') {
      return 'The API is running but has no database credentials. Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY on the API and redeploy.';
    }
    if (err.status === 404) return 'That is not there any more. Refresh and try again.';
    if (err.status >= 500) return `The API failed: ${err.message}`;
    return err.message;
  }
  if (err?.name === 'AbortError') return 'The request took too long and was cancelled.';
  return `Could not reach the API at ${API_BASE_URL}. Check it is deployed and that this site is listed in CORS_ORIGINS.`;
}

async function request(path, { method = 'GET', body, signal, timeout = 60000 } = {}) {
  if (!isApiConfigured) throw new ApiError('VITE_API_BASE_URL is not set', { code: 'not_configured' });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  if (signal) signal.addEventListener('abort', () => controller.abort(), { once: true });

  try {
    const res = await fetch(`${API_BASE_URL}${path}`, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });

    const text = await res.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = { message: text };
    }

    if (!res.ok) {
      throw new ApiError(data?.message ?? `HTTP ${res.status}`, {
        status: res.status,
        code: data?.error,
        body: data,
      });
    }

    return data;
  } finally {
    clearTimeout(timer);
  }
}

export const get = (path, opts) => request(path, opts);
export const post = (path, body, opts) => request(path, { ...opts, method: 'POST', body: body ?? {} });
export const patch = (path, body, opts) => request(path, { ...opts, method: 'PATCH', body: body ?? {} });
export const put = (path, body, opts) => request(path, { ...opts, method: 'PUT', body: body ?? {} });
export const del = (path, opts) => request(path, { ...opts, method: 'DELETE' });

/** Used by the connection banner. Short timeout: this is a liveness check. */
export async function checkHealth() {
  return request('/health', { timeout: 12000 });
}
