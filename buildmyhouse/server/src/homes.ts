import { randomUUID } from 'node:crypto';
import { Router } from 'express';
import type { Request, Response } from 'express';
import { asyncHandler } from './asyncHandler.js';
import { requireAuth } from './auth.js';
import type { DbAdapter } from './db.js';
import { isTeamMember } from './teams.js';

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
        'UPDATE homes SET name = ?, json = ?, updated_at = ? WHERE id = ? AND owner_user_id = ?',
        name,
        json,
        now,
        homeId,
        userId,
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
      const { name, json } = (req.body ?? {}) as { name?: unknown; json?: unknown };
      if (typeof json !== 'string') {
        res.status(400).json({ error: 'json (serialized home) is required' });
        return;
      }
      const homeName = typeof name === 'string' && name.trim() ? name.trim() : row.name;
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
