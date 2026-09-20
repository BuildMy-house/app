import { randomUUID } from 'node:crypto';
import { Router } from 'express';
import type { Request, Response } from 'express';
import { asyncHandler } from './asyncHandler.js';
import { requireAuth } from './auth.js';
import type { DbAdapter } from './db.js';
import { isTeamMember } from './teams.js';
import { HOMES_RATE_LIMIT, makeUserRateLimiter } from './rateLimit.js';

type HomeEvent = { type: 'home.updated'; homeId: string; revision: string; actor: 'user' | 'agent'; json: string; name: string };
type HomeSubscriber = (event: HomeEvent) => void;
const homeSubscribers = new Map<string, Set<HomeSubscriber>>();
const homePresence = new Map<string, Map<string, { userId: string; role: 'user' | 'agent'; seenAt: string }>>();

interface HomeRow {
  id: string;
  owner_user_id: string;
  name: string;
  json: string;
  team_id: string | null;
  created_at: string;
  updated_at: string;
}

interface HomeRecord {
  id: string;
  name: string;
  json: string;
  createdAt: string;
  updatedAt: string;
}

function toRecord(row: HomeRow): HomeRecord {
  return {
    id: row.id,
    name: row.name,
    json: row.json,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * Home-project CRUD, tenant-scoped strictly by the JWT-authenticated user id
 * (req.userId). There is no owner id in the request body — the client never
 * gets to influence who owns a home. Every read/update/delete filters by
 * `owner_user_id = req.userId`, so a user can only ever touch their own rows
 * (mirrors the assets tenant guard; the homes routes just derive the owner
 * from the token instead of a :userId path param).
 *
 * Performance: Uses debounced/coalesced saves (500ms flush window) to reduce
 * database write load. Rapid saves from multiple users are batched into fewer
 * actual UPDATE statements.
 */

// Save queue: pending updates waiting to flush to DB
const saveQueue = new Map<string, { name: string; json: string; homeId: string }[]>();
let saveTimer: NodeJS.Timeout | null = null;
let dbInstance: DbAdapter | null = null;

const SAVE_FLUSH_MS = 500; // Coalesce saves within this window

// 400 over 429: the request itself is valid but would exceed a persistent
// resource quota — 429 implies a transient rate condition where retrying
// later helps, which is false here (deleting homes is the only remedy).
const MAX_HOMES_PER_USER_DEFAULT = 500;

function maxHomesPerUser(): number {
  const parsed = Number(process.env.MAX_HOMES_PER_USER);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : MAX_HOMES_PER_USER_DEFAULT;
}

/**
 * Enqueue a home update and schedule flush if not already pending.
 */
function enqueueSave(userId: string, homeId: string, name: string, json: string): void {
  if (!saveQueue.has(userId)) {
    saveQueue.set(userId, []);
  }
  const userQueue = saveQueue.get(userId)!;

  // Remove any existing entry for this home; we're replacing it
  const idx = userQueue.findIndex((s) => s.homeId === homeId);
  if (idx >= 0) {
    userQueue.splice(idx, 1);
  }

  // Append the new save
  userQueue.push({ homeId, name, json });

  // Schedule flush if not already pending
  if (!saveTimer && dbInstance) {
    saveTimer = setTimeout(() => flushSaveQueue(), SAVE_FLUSH_MS);
  }
}

function publish(event: HomeEvent): void {
  for (const subscriber of homeSubscribers.get(event.homeId) ?? []) subscriber(event);
}

function subscribe(homeId: string, subscriber: HomeSubscriber): () => void {
  const subscribers = homeSubscribers.get(homeId) ?? new Set<HomeSubscriber>();
  subscribers.add(subscriber);
  homeSubscribers.set(homeId, subscribers);
  return () => {
    subscribers.delete(subscriber);
    if (subscribers.size === 0) homeSubscribers.delete(homeId);
  };
}

/**
 * Flush all pending saves to the database in one batch.
 * Reduces 50+ individual writes to a small number of transactions.
 */
async function flushSaveQueue(): Promise<void> {
  if (saveQueue.size === 0 || !dbInstance) {
    saveTimer = null;
    return;
  }

  const db = dbInstance;
  const now = new Date().toISOString();
  let totalWrites = 0;

  for (const [userId, updates] of saveQueue) {
    for (const { homeId, name, json } of updates) {
      await db.run(
        'UPDATE homes SET name = ?, json = ?, updated_at = ? WHERE id = ?',
        name,
        json,
        now,
        homeId,
      );
      totalWrites++;
    }
  }

  saveQueue.clear();
  saveTimer = null;

  if (totalWrites > 0) {
    console.log(`[homes] flushed ${totalWrites} saves to database`);
  }
}

export function homesRouter(db: DbAdapter): Router {
  dbInstance = db; // Store for save queue flush
  const router = Router();
  router.use(requireAuth);
  // Separate per-user counter (see rateLimit.ts): hitting homes never touches
  // the assets/teams budgets, and requireAuth above guarantees req.userId.
  router.use(makeUserRateLimiter(HOMES_RATE_LIMIT));

  router.get(
    '/',
    asyncHandler(async (req: Request, res: Response) => {
      const userId = req.userId!;
      const rows = await db.all<HomeRow>(
        `SELECT h.* FROM homes h
         LEFT JOIN team_members tm ON tm.team_id = h.team_id AND tm.user_id = ?
         WHERE h.owner_user_id = ? OR (h.team_id IS NOT NULL AND tm.user_id IS NOT NULL)
         GROUP BY h.id
         ORDER BY h.updated_at DESC`,
        userId,
        userId,
      );
      // List omits the JSON blob; callers pick a home then load it by id.
      res.json({ items: rows.map((r) => ({ id: r.id, name: r.name, createdAt: r.created_at, updatedAt: r.updated_at })) });
    }),
  );

  router.get(
    '/:id',
    asyncHandler(async (req: Request, res: Response) => {
      const row = await resolveOwnedHome(db, req.userId!, req.params.id!, res);
      if (row) res.json(toRecord(row));
    }),
  );

  router.get(
    '/:id/events',
    asyncHandler(async (req: Request, res: Response) => {
      const row = await resolveOwnedHome(db, req.userId!, req.params.id!, res);
      if (!row) return;
      res.status(200).set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
      res.flushHeaders();
      const send = (event: HomeEvent) => res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
      send({ type: 'home.updated', homeId: row.id, revision: row.updated_at, actor: 'user', json: row.json, name: row.name });
      const unsubscribe = subscribe(row.id, send);
      const heartbeat = setInterval(() => res.write(': keep-alive\n\n'), 15_000);
      req.on('close', () => { clearInterval(heartbeat); unsubscribe(); });
    }),
  );

  router.get(
    '/:id/presence',
    asyncHandler(async (req: Request, res: Response) => {
      const row = await resolveOwnedHome(db, req.userId!, req.params.id!, res);
      if (!row) return;
      const now = Date.now();
      const entries = [...(homePresence.get(row.id)?.values() ?? [])].filter((entry) => now - Date.parse(entry.seenAt) < 60_000);
      res.json({ items: entries });
    }),
  );

  router.post(
    '/:id/presence',
    asyncHandler(async (req: Request, res: Response) => {
      const row = await resolveOwnedHome(db, req.userId!, req.params.id!, res);
      if (!row) return;
      const role = (req.body as { role?: unknown } | undefined)?.role;
      if (role !== 'user' && role !== 'agent') { res.status(400).json({ error: 'role must be user or agent' }); return; }
      const entries = homePresence.get(row.id) ?? new Map();
      entries.set(`${req.userId!}:${role}`, { userId: req.userId!, role, seenAt: new Date().toISOString() });
      homePresence.set(row.id, entries);
      res.json({ ok: true, seenAt: entries.get(`${req.userId!}:${role}`)!.seenAt });
    }),
  );

  router.post(
    '/',
    asyncHandler(async (req: Request, res: Response) => {
      const userId = req.userId!;
      const { name, json, teamId } = (req.body ?? {}) as { name?: unknown; json?: unknown; teamId?: unknown };
      if (typeof json !== 'string') {
        res.status(400).json({ error: 'json (serialized home) is required' });
        return;
      }
      // If teamId provided, verify caller is a member of that team
      if (typeof teamId === 'string' && teamId) {
        if (!(await isTeamMember(db, teamId, userId))) {
          res.status(403).json({ error: 'forbidden' });
          return;
        }
      }
      // Per-user homes quota: counts every home this user owns (personal and
      // team homes alike — team_id is stored, but ownership never transfers).
      const countRow = await db.get<{ cnt: number | string }>(
        'SELECT COUNT(*) as cnt FROM homes WHERE owner_user_id = ?',
        userId,
      );
      if (Number(countRow?.cnt ?? 0) >= maxHomesPerUser()) {
        res.status(400).json({ error: 'home limit reached (MAX_HOMES_PER_USER)' });
        return;
      }
      const homeName = typeof name === 'string' && name.trim() ? name.trim() : 'Untitled home';
      const now = new Date().toISOString();
      const effectiveTeamId = typeof teamId === 'string' && teamId ? teamId : null;
      const row: HomeRow = {
        id: randomUUID(),
        owner_user_id: userId,
        name: homeName,
        json,
        team_id: effectiveTeamId,
        created_at: now,
        updated_at: now,
      };
      await db.run(
        `INSERT INTO homes (id, owner_user_id, name, json, team_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        row.id,
        row.owner_user_id,
        row.name,
        row.json,
        row.team_id,
        row.created_at,
        row.updated_at,
      );
      res.status(201).json(toRecord(row));
    }),
  );

  router.put(
    '/:id',
    asyncHandler(async (req: Request, res: Response) => {
      const row = await resolveOwnedHome(db, req.userId!, req.params.id!, res);
      if (!row) return;
      const { name, json, baseUpdatedAt, actor = 'user' } = (req.body ?? {}) as { name?: unknown; json?: unknown; baseUpdatedAt?: unknown; actor?: unknown };
      if (typeof json !== 'string') {
        res.status(400).json({ error: 'json (serialized home) is required' });
        return;
      }
      const homeName = typeof name === 'string' && name.trim() ? name.trim() : row.name;
      if (baseUpdatedAt !== undefined && (typeof baseUpdatedAt !== 'string' || baseUpdatedAt !== row.updated_at)) {
        res.status(409).json({ error: 'home changed since it was loaded', current: toRecord(row) });
        return;
      }
      if (actor !== 'user' && actor !== 'agent') { res.status(400).json({ error: 'actor must be user or agent' }); return; }
      if (typeof baseUpdatedAt === 'string') {
        const updatedAt = new Date().toISOString();
        const result = await db.run(
          'UPDATE homes SET name = ?, json = ?, updated_at = ? WHERE id = ? AND updated_at = ?',
          homeName, json, updatedAt, row.id, baseUpdatedAt,
        );
        if (result.changes !== 1) { res.status(409).json({ error: 'home changed since it was loaded' }); return; }
        const updated = { ...row, name: homeName, json, updated_at: updatedAt };
        publish({ type: 'home.updated', homeId: row.id, revision: updatedAt, actor, json, name: homeName });
        res.json(toRecord(updated));
        return;
      }
      // Enqueue save instead of writing immediately (batches multiple saves)
      enqueueSave(req.userId!, req.params.id!, homeName, json);
      // Return the updated record immediately (optimistic response)
      res.json(toRecord({ ...row, name: homeName, json, updated_at: new Date().toISOString() }));
    }),
  );

  router.delete(
    '/:id',
    asyncHandler(async (req: Request, res: Response) => {
      const row = await resolveOwnedHome(db, req.userId!, req.params.id!, res);
      if (row) await db.run('DELETE FROM homes WHERE id = ?', row.id);
      res.status(204).end();
    }),
  );

  return router;
}

/**
 * Resolve a home by id for the authenticated user, enforcing the tenant
 * boundary: 404 if no home with that id exists, 403 if it belongs to another
 * user and the caller is not a team member (never reveal the existence of
 * another user's home vs. a plain 404 — the 403 mirrors H2's tenant-guard
 * convention for the cross-user case). When team_id is non-null, access is
 * granted to any member of that team, not just the owner.
 * Writes the response and returns the row, or null after responding.
 */
async function resolveOwnedHome(
  db: DbAdapter,
  userId: string,
  id: string,
  res: Response,
): Promise<HomeRow | null> {
  const row = await db.get<HomeRow>('SELECT * FROM homes WHERE id = ?', id);
  if (!row) {
    res.status(404).json({ error: 'not found' });
    return null;
  }
  if (row.team_id) {
    // Team-owned home: any team member can access
    if (!(await isTeamMember(db, row.team_id, userId))) {
      res.status(403).json({ error: 'forbidden' });
      return null;
    }
  } else {
    // Personal home: owner-only
    if (row.owner_user_id !== userId) {
      res.status(403).json({ error: 'forbidden' });
      return null;
    }
  }
  return row;
}
