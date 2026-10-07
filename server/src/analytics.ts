import express, { type RequestHandler } from 'express';
import rateLimit from 'express-rate-limit';
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import type { DbAdapter } from './db.js';
import { asyncHandler } from './asyncHandler.js';

/**
 * Self-hosted, privacy-respecting product analytics + in-app feedback.
 *
 * Data lives in the app's own database (`analytics_events`, `feedback`) — no
 * third party, no cost. No IP address, user agent or account identity is
 * stored: events carry only two random client-generated ids (`sid` per
 * browsing session, `aid` persistent anonymous device id for retention) and a
 * small whitelisted set of flat props. Feedback stores the free text and the
 * email only if the submitter typed one.
 */

const ANALYTICS_EVENT_NAMES = [
  'pageview',
  'session_start',
  'first_plan_created',
  'first_furniture_placed',
  'first_3d_view_opened',
  'split_view_used',
  'plan_saved',
  'plan_exported',
  'signup_modal_opened',
  'signup_completed',
  'login_completed',
] as const;

const EVENT_NAMES = new Set<string>(ANALYTICS_EVENT_NAMES);
const ID_RE = /^[A-Za-z0-9_-]{8,64}$/;
const MAX_EVENTS_PER_REQUEST = 20;
const MAX_PROPS = 8;
const MAX_PROP_STRING = 64;
const MAX_FEEDBACK_CHARS = 2000;
const DAY_MS = 86_400_000;
const MAX_KPI_DAYS = 90;
const MAX_KPI_ROWS = 500_000;

type PropValue = string | number | boolean;

function sanitizeProps(raw: unknown): Record<string, PropValue> | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const out: Record<string, PropValue> = {};
  for (const [key, value] of Object.entries(raw).slice(0, MAX_PROPS)) {
    if (!/^[A-Za-z0-9_]{1,32}$/.test(key)) continue;
    if (typeof value === 'string') out[key] = value.slice(0, MAX_PROP_STRING);
    else if (typeof value === 'number' && Number.isFinite(value)) out[key] = value;
    else if (typeof value === 'boolean') out[key] = value;
  }
  return Object.keys(out).length > 0 ? out : null;
}

/** Client clocks are untrusted: accept their timestamp only if it is plausible. */
function clampTs(raw: unknown, now: number): number {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return now;
  if (raw > now + 60_000 || raw < now - DAY_MS) return now;
  return Math.round(raw);
}

/** Admin token: ANALYTICS_ADMIN_TOKEN, else the shared BUILDMYHOUSE_MCP_BEARER_TOKEN. */
function adminToken(): string | null {
  return process.env.ANALYTICS_ADMIN_TOKEN || process.env.BUILDMYHOUSE_MCP_BEARER_TOKEN || null;
}

const requireAnalyticsAdmin: RequestHandler = (req, res, next) => {
  const expected = adminToken();
  if (!expected) {
    res.status(503).json({ error: 'analytics admin token not configured' });
    return;
  }
  const header = req.headers.authorization ?? '';
  const presented = header.startsWith('Bearer ') ? header.slice(7) : '';
  const a = createHash('sha256').update(presented).digest();
  const b = createHash('sha256').update(expected).digest();
  if (!presented || !timingSafeEqual(a, b)) {
    res.status(401).json({ error: 'unauthorized' });
    return;
  }
  next();
};

const bodySid = (req: express.Request): string => {
  const sid = (req.body as { sid?: unknown } | undefined)?.sid;
  return typeof sid === 'string' && ID_RE.test(sid) ? sid : 'anonymous';
};

const dayOf = (ts: number): string => new Date(ts).toISOString().slice(0, 10);
const median = (xs: number[]): number | null => {
  if (xs.length === 0) return null;
  const s = [...xs].sort((x, y) => x - y);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : Math.round((s[mid - 1]! + s[mid]!) / 2);
};
const rate = (n: number, d: number): number | null => (d > 0 ? Math.round((n / d) * 10_000) / 10_000 : null);

interface EventRow {
  sid: string;
  aid: string | null;
  name: string;
  props: string | null;
  ts: number | string;
}

async function computeKpis(db: DbAdapter, days: number, now = Date.now()) {
  const since = now - days * DAY_MS;
  const rows = (
    await db.all<EventRow>(
      'SELECT sid, aid, name, props, ts FROM analytics_events WHERE ts >= ? ORDER BY ts ASC LIMIT ?',
      since,
      MAX_KPI_ROWS,
    )
  ).map((r) => ({ ...r, ts: Number(r.ts) }));

  // Daily active users: distinct anonymous devices (aid) with any event per UTC day.
  const dauSets = new Map<string, Set<string>>();
  for (const r of rows) {
    const day = dayOf(r.ts);
    if (!dauSets.has(day)) dauSets.set(day, new Set());
    dauSets.get(day)!.add(r.aid ?? r.sid);
  }
  const dailyActiveUsers = [...dauSets.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, set]) => ({ date, users: set.size }));

  // Activation funnel, per session (sid).
  interface Sess { start?: number; first3d?: number; furniture?: number }
  const sessions = new Map<string, Sess>();
  for (const r of rows) {
    const s = sessions.get(r.sid) ?? {};
    if (r.name === 'session_start' && s.start === undefined) s.start = r.ts;
    else if (r.name === 'first_3d_view_opened' && s.first3d === undefined) s.first3d = r.ts;
    else if (r.name === 'first_furniture_placed' && s.furniture === undefined) s.furniture = r.ts;
    sessions.set(r.sid, s);
  }
  const started = [...sessions.values()].filter((s) => s.start !== undefined);
  const opened3d = started.filter((s) => s.first3d !== undefined);
  const furnished3d = opened3d.filter((s) => s.furniture !== undefined);
  const timesTo3d = opened3d.map((s) => Math.max(0, s.first3d! - s.start!));
  const activation = {
    sessions_started: started.length,
    sessions_with_3d_view: opened3d.length,
    sessions_with_furnished_3d_view: furnished3d.length,
    // Launch KPI: share of sessions that reached a furnished 3D view (>=1 furniture + 3D opened).
    activation_rate_furnished_3d: rate(furnished3d.length, started.length),
    rate_3d_view_opened: rate(opened3d.length, started.length),
    time_to_first_3d_view_ms: {
      median: median(timesTo3d),
      mean: timesTo3d.length ? Math.round(timesTo3d.reduce((a, b) => a + b, 0) / timesTo3d.length) : null,
      samples: timesTo3d.length,
    },
  };

  // D1/D7 retention by anonymous device. Cohort day = first day the device was
  // ever seen (all time); only cohorts old enough to have a Dn are counted.
  const firstSeenRows = await db.all<{ aid: string; first_ts: number | string }>(
    'SELECT aid, MIN(ts) AS first_ts FROM analytics_events WHERE aid IS NOT NULL GROUP BY aid',
  );
  const firstDay = new Map(firstSeenRows.map((r) => [r.aid, dayOf(Number(r.first_ts))]));
  const activeDays = new Map<string, Set<string>>();
  for (const r of rows) {
    if (!r.aid) continue;
    if (!activeDays.has(r.aid)) activeDays.set(r.aid, new Set());
    activeDays.get(r.aid)!.add(dayOf(r.ts));
  }
  const today = dayOf(now);
  const plusDays = (day: string, n: number): string => dayOf(Date.parse(`${day}T00:00:00Z`) + n * DAY_MS);
  const retention = (n: number) => {
    let eligible = 0;
    let retained = 0;
    for (const [aid, first] of firstDay) {
      if (first < dayOf(since) || plusDays(first, n) > today) continue;
      eligible++;
      if (activeDays.get(aid)?.has(plusDays(first, n))) retained++;
    }
    return { eligible, retained, rate: rate(retained, eligible) };
  };

  const eventStats = await db.all<{ name: string; events: number | string; sessions: number | string }>(
    'SELECT name, COUNT(*) AS events, COUNT(DISTINCT sid) AS sessions FROM analytics_events WHERE ts >= ? GROUP BY name ORDER BY events DESC',
    since,
  );
  const topEvents = eventStats.map((r) => ({ name: r.name, events: Number(r.events), sessions: Number(r.sessions) }));

  const exportsByKind: Record<string, number> = {};
  for (const r of rows) {
    if (r.name !== 'plan_exported' || !r.props) continue;
    try {
      const kind = String((JSON.parse(r.props) as { kind?: unknown }).kind ?? 'unknown');
      exportsByKind[kind] = (exportsByKind[kind] ?? 0) + 1;
    } catch {
      // malformed props: skip
    }
  }

  const feedbackRows = await db.all<{ id: string; sid: string; message: string; email: string | null; state: string | null; created_at: number | string }>(
    'SELECT id, sid, message, email, state, created_at FROM feedback ORDER BY created_at DESC LIMIT 50',
  );
  const recentFeedback = feedbackRows.map((f) => {
    let state: unknown = null;
    try { state = f.state ? JSON.parse(f.state) : null; } catch { /* keep null */ }
    return { id: f.id, sid: f.sid, message: f.message, email: f.email, state, created_at: new Date(Number(f.created_at)).toISOString() };
  });

  return {
    generated_at: new Date(now).toISOString(),
    window_days: days,
    truncated: rows.length >= MAX_KPI_ROWS,
    daily_active_users: dailyActiveUsers,
    activation,
    retention: { d1: retention(1), d7: retention(7) },
    top_events: topEvents,
    exports_by_kind: exportsByKind,
    recent_feedback: recentFeedback,
  };
}

export function analyticsRouter(db: DbAdapter): express.Router {
  const router = express.Router();

  const eventsLimiter = rateLimit({
    windowMs: 60_000,
    max: 60,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: bodySid,
    validate: false,
  });
  // Per-session cap plus a global cap, since a spammer can mint session ids.
  const feedbackSessionLimiter = rateLimit({
    windowMs: 10 * 60_000,
    max: 5,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: bodySid,
    validate: false,
  });
  const feedbackGlobalLimiter = rateLimit({
    windowMs: 60 * 60_000,
    max: 300,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: () => 'global',
    validate: false,
  });

  router.post(
    '/events',
    eventsLimiter,
    asyncHandler(async (req, res) => {
      const body = (req.body ?? {}) as { sid?: unknown; aid?: unknown; events?: unknown };
      if (typeof body.sid !== 'string' || !ID_RE.test(body.sid)) {
        res.status(400).json({ error: 'invalid sid' });
        return;
      }
      const aid = typeof body.aid === 'string' && ID_RE.test(body.aid) ? body.aid : null;
      if (!Array.isArray(body.events) || body.events.length === 0 || body.events.length > MAX_EVENTS_PER_REQUEST) {
        res.status(400).json({ error: `events must be an array of 1-${MAX_EVENTS_PER_REQUEST}` });
        return;
      }
      const now = Date.now();
      let accepted = 0;
      for (const e of body.events as Array<{ name?: unknown; props?: unknown; ts?: unknown }>) {
        if (typeof e?.name !== 'string' || !EVENT_NAMES.has(e.name)) continue;
        const props = sanitizeProps(e.props);
        await db.run(
          'INSERT INTO analytics_events (id, sid, aid, name, props, ts) VALUES (?, ?, ?, ?, ?, ?)',
          randomUUID(),
          body.sid,
          aid,
          e.name,
          props ? JSON.stringify(props) : null,
          clampTs(e.ts, now),
        );
        accepted++;
      }
      res.status(202).json({ accepted });
    }),
  );

  router.post(
    '/feedback',
    feedbackGlobalLimiter,
    feedbackSessionLimiter,
    asyncHandler(async (req, res) => {
      const body = (req.body ?? {}) as { sid?: unknown; message?: unknown; email?: unknown; state?: unknown };
      if (typeof body.sid !== 'string' || !ID_RE.test(body.sid)) {
        res.status(400).json({ error: 'invalid sid' });
        return;
      }
      const message = typeof body.message === 'string' ? body.message.trim() : '';
      if (!message || message.length > MAX_FEEDBACK_CHARS) {
        res.status(400).json({ error: `message required (max ${MAX_FEEDBACK_CHARS} chars)` });
        return;
      }
      let email: string | null = null;
      if (typeof body.email === 'string' && body.email.trim()) {
        email = body.email.trim().toLowerCase();
        if (email.length > 200 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
          res.status(400).json({ error: 'invalid email' });
          return;
        }
      }
      // App state is plan item counts only: numeric values, a few known keys' worth of props.
      const state = sanitizeProps(body.state);
      await db.run(
        'INSERT INTO feedback (id, sid, message, email, state, created_at) VALUES (?, ?, ?, ?, ?, ?)',
        randomUUID(),
        body.sid,
        message,
        email,
        state ? JSON.stringify(state) : null,
        Date.now(),
      );
      res.status(201).json({ ok: true });
    }),
  );

  router.get(
    '/kpis',
    requireAnalyticsAdmin,
    asyncHandler(async (req, res) => {
      const requested = Number(req.query.days ?? 14);
      const days = Number.isFinite(requested) ? Math.min(MAX_KPI_DAYS, Math.max(1, Math.floor(requested))) : 14;
      res.json(await computeKpis(db, days));
    }),
  );

  return router;
}
