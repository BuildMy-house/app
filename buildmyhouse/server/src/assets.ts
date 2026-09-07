import { randomUUID } from 'node:crypto';
import { Router } from 'express';
import type { Database } from 'better-sqlite3';
import type { Request, Response } from 'express';
import { requireAuth } from './auth.js';
import { AssetStorage } from './storage.js';

// GlTF binary magic number: ASCII "glTF", little-endian (glTF 2.0 spec).
const GLB_MAGIC = 0x46546c67;
export const MAX_IMPORT_BYTES = 50 * 1024 * 1024;

interface UserModelRecord {
  id: string;
  catalogId: string;
  name: string;
  category: string;
  width: number;
  depth: number;
  height: number;
  color: number | null;
  blobKey: string;
  createdAt: number;
}

interface AssetRow {
  id: string;
  user_id: string;
  catalog_id: string;
  name: string;
  category: string;
  width: number;
  depth: number;
  height: number;
  color: number | null;
  blob_key: string;
  glb_path: string;
  source_path: string | null;
  created_at: number;
}

/**
 * Mirror the client-side cap + magic-number check (homely/src/core/user-catalog.ts).
 * A public endpoint must never rely on client-side-only validation, so every
 * uploaded GLB is revalidated here before it is stored.
 */
function validateGlb(buffer: Buffer): string | null {
  if (buffer.byteLength > MAX_IMPORT_BYTES) {
    return `model is ${(buffer.byteLength / 1024 / 1024).toFixed(1)} MB — the import limit is ${MAX_IMPORT_BYTES / 1024 / 1024} MB`;
  }
  if (buffer.byteLength < 12) {
    return 'model is too small to be a GLB file';
  }
  if (buffer.readUInt32LE(0) !== GLB_MAGIC) {
    return 'model is not a GLB file — missing glTF magic number';
  }
  return null;
}

/** Decode a base64 string; rejects malformed input with a null. */
function decodeBase64(value: string): Buffer | null {
  if (typeof value !== 'string') return null;
  // Reject after verifying canonical padding so malformed base64 fails loudly.
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(value) || value.length % 4 !== 0) return null;
  try {
    return Buffer.from(value, 'base64');
  } catch {
    return null;
  }
}

function toRecord(row: AssetRow): UserModelRecord {
  return {
    id: row.id,
    catalogId: row.catalog_id,
    name: row.name,
    category: row.category,
    width: row.width,
    depth: row.depth,
    height: row.height,
    color: row.color,
    blobKey: row.blob_key,
    createdAt: row.created_at,
  };
}

/**
 * Require auth AND the JWT-authenticated user id to match the :userId path
 * param. Never trust the path param alone — otherwise any caller could pass
 * any userId and read/write someone else's assets.
 */
function tenantGuard(req: Request, res: Response, next: () => void): void {
  if (req.userId !== req.params.userId) {
    res.status(403).json({ error: 'forbidden' });
    return;
  }
  next();
}

export function assetsRouter(db: Database, storage: AssetStorage): Router {
  const router = Router();
  router.use('/:userId', requireAuth, tenantGuard);

  router.get('/:userId', (req: Request, res: Response) => {
    const rows = db
      .prepare('SELECT * FROM assets WHERE user_id = ? ORDER BY created_at DESC')
      .all(req.params.userId) as unknown as AssetRow[];
    res.json({ items: rows.map(toRecord) });
  });

  router.post('/:userId', (req: Request, res: Response) => {
    const { record, glb, source } = (req.body ?? {}) as {
      record?: Partial<UserModelRecord>;
      glb?: unknown;
      source?: unknown;
    };

    if (typeof glb !== 'string') {
      res.status(400).json({ error: 'glb (base64) is required' });
      return;
    }
    const glbBytes = decodeBase64(glb);
    if (!glbBytes) {
      res.status(400).json({ error: 'glb is not valid base64' });
      return;
    }

    const validationError = validateGlb(glbBytes);
    if (validationError) {
      res.status(400).json({ error: validationError });
      return;
    }

    const sourceBytes = source == null ? null : typeof source === 'string' ? decodeBase64(source) : null;
    if (source != null && !sourceBytes) {
      res.status(400).json({ error: 'source is not valid base64' });
      return;
    }

    const id = typeof record?.id === 'string' ? record.id : randomUUID();
    const userId = req.params.userId!;
    const name = typeof record?.name === 'string' ? record.name : 'Untitled model';
    const category = typeof record?.category === 'string' ? record.category : '';
    const width = typeof record?.width === 'number' ? record.width : 0;
    const depth = typeof record?.depth === 'number' ? record.depth : 0;
    const height = typeof record?.height === 'number' ? record.height : 0;
    const color = typeof record?.color === 'number' ? record.color : null;
    const blobKey = `blob:${id}`;
    const createdAt = typeof record?.createdAt === 'number' ? record.createdAt : Date.now();

    // An upload replaces any existing asset with the same id for this user.
    const existing = db.prepare('SELECT * FROM assets WHERE user_id = ? AND id = ?').get(userId, id) as
      | AssetRow
      | undefined;
    if (existing) {
      storage.remove(userId, existing.glb_path.split('/').pop() ?? '');
      if (existing.source_path) storage.remove(userId, existing.source_path.split('/').pop() ?? '');
    }

    const glbFileName = `${id}.glb`;
    const glbPath = storage.save(userId, glbFileName, glbBytes);
    let sourcePath: string | null = null;
    if (sourceBytes) {
      sourcePath = storage.save(userId, `${id}.source`, sourceBytes);
    }

    db.prepare(
      `INSERT OR REPLACE INTO assets
         (id, user_id, catalog_id, name, category, width, depth, height, color, blob_key, glb_path, source_path, created_at)
       VALUES
         (@id, @user_id, @catalog_id, @name, @category, @width, @depth, @height, @color, @blob_key, @glb_path, @source_path, @created_at)`,
    ).run({
      id,
      user_id: userId,
      catalog_id: typeof record?.catalogId === 'string' ? record.catalogId : id,
      name,
      category,
      width,
      depth,
      height,
      color,
      blob_key: blobKey,
      glb_path: glbPath,
      source_path: sourcePath,
      created_at: createdAt,
    });

    res.status(201).json(toRecord(
      db.prepare('SELECT * FROM assets WHERE user_id = ? AND id = ?').get(userId, id) as AssetRow,
    ));
  });

  router.delete('/:userId/:id', (req: Request, res: Response) => {
    const userId = req.params.userId!;
    const id = req.params.id!;
    const row = db.prepare('SELECT * FROM assets WHERE user_id = ? AND id = ?').get(userId, id) as
      | AssetRow
      | undefined;
    if (!row) {
      res.status(404).json({ error: 'not found' });
      return;
    }
    storage.remove(userId, row.glb_path.split('/').pop() ?? '');
    if (row.source_path) storage.remove(userId, row.source_path.split('/').pop() ?? '');
    db.prepare('DELETE FROM assets WHERE user_id = ? AND id = ?').run(userId, id);
    res.status(204).end();
  });

  router.get('/:userId/:id/model', (req: Request, res: Response) => {
    const userId = req.params.userId!;
    const id = req.params.id!;
    const row = db.prepare('SELECT * FROM assets WHERE user_id = ? AND id = ?').get(userId, id) as
      | AssetRow
      | undefined;
    if (!row) {
      res.status(404).end();
      return;
    }
    const glb = storage.read(userId, row.glb_path.split('/').pop() ?? '');
    if (!glb) {
      res.status(404).end();
      return;
    }
    res.set('Content-Type', 'model/gltf-binary');
    res.send(glb);
  });

  return router;
}
