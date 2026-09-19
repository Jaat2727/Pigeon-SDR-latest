/**
 * HTTP plumbing. Route handlers throw; this turns a throw into a response
 * with a status and a message a person can act on.
 */

export class HttpError extends Error {
  constructor(status, message, extra = {}) {
    super(message);
    this.status = status;
    Object.assign(this, extra);
  }
}

export const badRequest = (message, extra) => new HttpError(400, message, extra);
export const notFound = (message, extra) => new HttpError(404, message, extra);
export const conflict = (message, extra) => new HttpError(409, message, extra);
export const unavailable = (message, extra) => new HttpError(503, message, extra);

/** Wraps an async handler so a rejected promise reaches the error middleware. */
export const asyncHandler = (fn) => (req, res, next) =>
  Promise.resolve(fn(req, res, next)).catch(next);

export function notFoundHandler(req, res) {
  res.status(404).json({
    error: 'route_not_found',
    message: `No route for ${req.method} ${req.originalUrl}`,
  });
}

export function errorHandler(err, req, res, _next) {
  const status = err.status ?? 500;

  // A 500 is a bug in this server, so it goes to the log in full. A 4xx is the
  // caller's problem and is already described by the response.
  if (status >= 500) console.error(`[error] ${req.method} ${req.originalUrl}`, err);

  res.status(status).json({
    error: err.code ?? (status >= 500 ? 'internal_error' : 'request_error'),
    message: err.message ?? 'Something went wrong',
    ...(err.details ? { details: err.details } : {}),
  });
}

/** Reads a positive integer query parameter, clamped, with a default. */
export function intParam(value, fallback, { min = 1, max = 500 } = {}) {
  const n = parseInt(value, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}
