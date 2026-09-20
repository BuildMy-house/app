import { randomUUID } from 'node:crypto';
import { Router } from 'express';
import type { Request, Response } from 'express';
import { asyncHandler } from './asyncHandler.js';
import { requireAuth } from './auth.js';
import type { DbAdapter } from './db.js';
import { timedAsync, fileIoMetrics } from './telemetry.js';
import { ASSETS_RATE_LIMIT, makeUserRateLimiter } from './rateLimit.js';
import { AssetStorage, SAFE_TOKEN_PATTERN } from './storage.js';

// GlTF binary magic number: ASCII "glTF", little-endian (glTF 2.0 spec).
const GLB_MAGIC = 0x46546c67;
const MAX_IMPORT_BYTES = 50 * 1024 * 1024;

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
  size_bytes: number | null;
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

const MAX_TOTAL_ASSET_BYTES_PER_USER_DEFAULT = 1024 * 1024 * 1024; // 1GB

function maxTotalAssetBytes(): number {
  const parsed = Number(process.env.MAX_TOTAL_ASSET_BYTES_PER_USER);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : MAX_TOTAL_ASSET_BYTES_PER_USER_DEFAULT;
}

/**
 * Sum of this user's stored asset bytes (glb + source), excluding `excludeId` —
 * a replace-existing-id upload overwrites that row, so its old size must not
 * count toward the quota twice (the new size fully replaces it).
 * SUM ignores NULL size_bytes (rows predating the migration) and returns NULL
 * over an empty set — both normalize to 0.
 */
async function userAssetBytes(db: DbAdapter, userId: string, excludeId?: string): Promise<number> {
  const row = excludeId
    ? await db.get<{ total: number | string | null }>(
        'SELECT SUM(size_bytes) as total FROM assets WHERE user_id = ? AND id != ?',
        userId,
        excludeId,
      )
    : await db.get<{ total: number | string | null }>(
        'SELECT SUM(size_bytes) as total FROM assets WHERE user_id = ?',
        userId,
      );
  return Number(row?.total ?? 0);
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

export function assetsRouter(db: DbAdapter, storage: AssetStorage): Router {
  const router = Router();
  router.use('/:userId', requireAuth, tenantGuard);
  // Per-user counter (see rateLimit.ts); requireAuth above guarantees req.userId.
  router.use('/:userId', makeUserRateLimiter(ASSETS_RATE_LIMIT));

  router.get(
    '/:userId',
    asyncHandler(async (req: Request, res: Response) => {
      const rows = await db.all<AssetRow>(
        'SELECT * FROM assets WHERE user_id = ? ORDER BY created_at DESC',
        req.params.userId,
      );
      res.json({ items: rows.map(toRecord) });
    }),
  );

  router.post(
    '/:userId',
    asyncHandler(async (req: Request, res: Response) => {
      const { record, glb, source } = (req.body ?? {}) as {
        record?: Partial<UserModelRecord>;
        glb?: unknown;
        source?: unknown;
      };

      if (typeof glb !== 'string') {
        res.status(400).json({ error: 'glb (base64) is required' });
        return;
      }

      type ImportResult = { error: string } | { glbBytes: Buffer; sourceBytes: Buffer | null };
      const importResult: ImportResult = await timedAsync('import', async () => {
        const glbBytes = decodeBase64(glb);
        if (!glbBytes) {
          return { error: 'glb is not valid base64' };
        }

        const validationError = validateGlb(glbBytes);
        if (validationError) {
          return { error: validationError };
        }

        const sourceBytes = source == null ? null : typeof source === 'string' ? decodeBase64(source) : null;
        if (source != null && !sourceBytes) {
          return { error: 'source is not valid base64' };
        }

        return { glbBytes, sourceBytes };
      }, { format: 'glb' });

      if ('error' in importResult) {
        res.status(400).json({ error: importResult.error });
        return;
      }

      const { glbBytes, sourceBytes } = importResult as { glbBytes: Buffer; sourceBytes: Buffer | null };

      const id = typeof record?.id === 'string' ? record.id : randomUUID();
      // H17: client-supplied ids become filesystem filenames (`${id}.glb`), so
      // a traversal id like `../<victim>/<asset>` could overwrite another
      // tenant's stored file. Accept only safe tokens; storage.ts re-checks.
      if (!SAFE_TOKEN_PATTERN.test(id)) {
        res.status(400).json({ error: 'invalid asset id' });
        return;
      }
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
      const existing = await db.get<AssetRow>(
        'SELECT * FROM assets WHERE user_id = ? AND id = ?',
        userId,
        id,
      );

      // Storage quota: new total = everything stored minus the size this
      // upload replaces (if any) plus the incoming bytes. Checked before any
      // file is written so a rejected upload never touches storage.
      const incomingBytes = glbBytes.byteLength + (sourceBytes?.byteLength ?? 0);
      const currentBytes = await userAssetBytes(db, userId, existing ? id : undefined);
      if (currentBytes + incomingBytes > maxTotalAssetBytes()) {
        res.status(413).json({ error: 'storage quota exceeded' });
        return;
      }

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

      const catalogId = typeof record?.catalogId === 'string' ? record.catalogId : id;

      // Use INSERT ... ON CONFLICT for cross-db upsert
      await db.run(
        `INSERT INTO assets
           (id, user_id, catalog_id, name, category, width, depth, height, color, blob_key, glb_path, source_path, size_bytes, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET
           user_id=excluded.user_id, catalog_id=excluded.catalog_id, name=excluded.name,
           category=excluded.category, width=excluded.width, depth=excluded.depth,
           height=excluded.height, color=excluded.color, blob_key=excluded.blob_key,
           glb_path=excluded.glb_path, source_path=excluded.source_path,
           size_bytes=excluded.size_bytes, created_at=excluded.created_at`,
        id,
        userId,
        catalogId,
        name,
        category,
        width,
        depth,
        height,
        color,
        blobKey,
        glbPath,
        sourcePath,
        incomingBytes,
        createdAt,
      );

      const saved = await db.get<AssetRow>(
        'SELECT * FROM assets WHERE user_id = ? AND id = ?',
        userId,
        id,
      );
      res.status(201).json(toRecord(saved!));
    }),
  );

  router.delete(
    '/:userId/:id',
    asyncHandler(async (req: Request, res: Response) => {
      const userId = req.params.userId!;
      const id = req.params.id!;
      const row = await db.get<AssetRow>(
        'SELECT * FROM assets WHERE user_id = ? AND id = ?',
        userId,
        id,
      );
      if (!row) {
        res.status(404).json({ error: 'not found' });
        return;
      }
      storage.remove(userId, row.glb_path.split('/').pop() ?? '');
      if (row.source_path) storage.remove(userId, row.source_path.split('/').pop() ?? '');
      await db.run('DELETE FROM assets WHERE user_id = ? AND id = ?', userId, id);
      res.status(204).end();
    }),
  );

  router.get(
    '/:userId/:id/model',
    asyncHandler(async (req: Request, res: Response) => {
      const userId = req.params.userId!;
      const id = req.params.id!;
      const exportResult = await timedAsync('export', async () => {
        const row = await db.get<AssetRow>(
          'SELECT * FROM assets WHERE user_id = ? AND id = ?',
          userId,
          id,
        );
        if (!row) return { status: 404 };
        const glb = storage.read(userId, row.glb_path.split('/').pop() ?? '');
        if (!glb) return { status: 404 };
        return { glb };
      }, { format: 'glb' });

      if (exportResult.status === 404) {
        res.status(404).end();
        return;
      }
      res.set('Content-Type', 'model/gltf-binary');
      res.send((exportResult as { glb: Buffer }).glb);
    }),
  );

  return router;
}
