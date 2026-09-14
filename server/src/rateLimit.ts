import rateLimit from 'express-rate-limit';
import type { RequestHandler } from 'express';

export interface UserRateLimiterOptions {
  windowMs: number;
  max: number;
}

/**
 * Per-user rate limiter for the authenticated API routers (homes/assets/teams).
 *
 * Keys by `req.userId` (set by requireAuth, which always runs before this in
 * each router) rather than by IP: these routes are auth-gated, and IP-based
 * limiting unfairly punishes multiple legitimate users behind one NAT/office
 * network. Per-user is the right unit for "is this one account abusing the API".
 *
 * Counters are per-limiter-instance (in-memory), so each router gets its own
 * budget: a user hammering homes never exhausts their team-invite quota.
 * Limits are deliberately generous for interactive usage:
 *  - homes: 600/5min = 2 req/s sustained. The debounced save flow (SAVE_FLUSH_MS
 *    = 500ms) can legitimately PUT up to ~2/s while a user is continuously
 *    editing, so this never trips during normal editing sessions.
 *  - assets: 300/5min = 1 req/s sustained. Covers rapid uploads plus scene
 *    loads re-fetching many model blobs.
 *  - teams: 120/5min. Low-frequency CRUD + invite flows; nothing legitimate
 *    comes close.
 */
export const HOMES_RATE_LIMIT: UserRateLimiterOptions = { windowMs: 5 * 60_000, max: 600 };
export const ASSETS_RATE_LIMIT: UserRateLimiterOptions = { windowMs: 5 * 60_000, max: 300 };
export const TEAMS_RATE_LIMIT: UserRateLimiterOptions = { windowMs: 5 * 60_000, max: 120 };
export const MODEL_UPLOAD_RATE_LIMIT: UserRateLimiterOptions = { windowMs: 5 * 60_000, max: 60 };

export function makeUserRateLimiter({ windowMs, max }: UserRateLimiterOptions): RequestHandler {
  return rateLimit({
    windowMs,
    max,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => req.userId ?? 'anonymous',
  });
}
