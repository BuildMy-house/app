import { randomUUID } from 'node:crypto';
import { Router } from 'express';
import type { Database } from 'better-sqlite3';
import type { Request, Response } from 'express';
import { requireAuth } from './auth.js';

interface HomeRow {
  id: string;
  owner_user_id: string;
  name: string;
  json: string;
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
 */
export function homesRouter(db: Database): Router {
  const router = Router();
  router.use(requireAuth);

  router.get('/', (req: Request, res: Response) => {
    const userId = req.userId!;
    const rows = db
      .prepare('SELECT * FROM homes WHERE owner_user_id = ? ORDER BY updated_at DESC')
      .all(userId) as unknown as HomeRow[];
    // List omits the JSON blob; callers pick a home then load it by id.
    res.json({ items: rows.map((r) => ({ id: r.id, name: r.name, createdAt: r.created_at, updatedAt: r.updated_at })) });
  });

  router.get('/:id', (req: Request, res: Response) => {
    const row = resolveOwnedHome(db, req.userId!, req.params.id!, res);
    if (row) res.json(toRecord(row));
  });

  router.post('/', (req: Request, res: Response) => {
    const userId = req.userId!;
    const { name, json } = (req.body ?? {}) as { name?: unknown; json?: unknown };
    if (typeof json !== 'string') {
      res.status(400).json({ error: 'json (serialized home) is required' });
      return;
    }
    const homeName = typeof name === 'string' && name.trim() ? name.trim() : 'Untitled home';
    const now = new Date().toISOString();
    const row: HomeRow = {
      id: randomUUID(),
      owner_user_id: userId,
      name: homeName,
      json,
      created_at: now,
      updated_at: now,
    };
    db.prepare(
      `INSERT INTO homes (id, owner_user_id, name, json, created_at, updated_at)
       VALUES (@id, @owner_user_id, @name, @json, @created_at, @updated_at)`,
    ).run(row);
    res.status(201).json(toRecord(row));
  });

  router.put('/:id', (req: Request, res: Response) => {
    const row = resolveOwnedHome(db, req.userId!, req.params.id!, res);
    if (!row) return;
    const { name, json } = (req.body ?? {}) as { name?: unknown; json?: unknown };
    if (typeof json !== 'string') {
      res.status(400).json({ error: 'json (serialized home) is required' });
      return;
    }
    const homeName = typeof name === 'string' && name.trim() ? name.trim() : row.name;
    db.prepare('UPDATE homes SET name = ?, json = ?, updated_at = ? WHERE id = ? AND owner_user_id = ?').run(
      homeName,
      json,
      new Date().toISOString(),
      req.params.id,
      req.userId!,
    );
    const updated = db
      .prepare('SELECT * FROM homes WHERE owner_user_id = ? AND id = ?')
      .get(req.userId!, req.params.id) as HomeRow;
    res.json(toRecord(updated));
  });

  router.delete('/:id', (req: Request, res: Response) => {
    const row = resolveOwnedHome(db, req.userId!, req.params.id!, res);
    if (row) db.prepare('DELETE FROM homes WHERE id = ?').run(row.id);
    res.status(204).end();
  });

  return router;
}

/**
 * Resolve a home by id for the authenticated user, enforcing the tenant
 * boundary: 404 if no home with that id exists, 403 if it belongs to another
 * user (never reveal the existence of another user's home vs. a plain 404 —
 * the 403 mirrors H2's tenant-guard convention for the cross-user case).
 * Writes the response and returns the row, or null after responding.
 */
function resolveOwnedHome(
  db: Database,
  userId: string,
  id: string,
  res: Response,
): HomeRow | null {
  const row = db.prepare('SELECT * FROM homes WHERE id = ?').get(id) as HomeRow | undefined;
  if (!row) {
    res.status(404).json({ error: 'not found' });
    return null;
  }
  if (row.owner_user_id !== userId) {
    res.status(403).json({ error: 'forbidden' });
    return null;
  }
  return row;
}
