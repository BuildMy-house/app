import { randomUUID } from 'node:crypto';
import { Router } from 'express';
import type { Request, Response } from 'express';
import { asyncHandler } from './asyncHandler.js';
import { requireAuth } from './auth.js';
import type { DbAdapter } from './db.js';

interface WaitlistRow {
  id: string;
  user_id: string;
  source: string;
  created_at: string;
}

function validSource(source: unknown): source is string {
  return typeof source === 'string' && source.length >= 1 && source.length <= 40 && /^[a-z0-9_-]+$/.test(source);
}

/**
 * Waitlist signup: one row per user (UNIQUE(user_id)), POST is idempotent —
 * joining twice returns the original createdAt with alreadyJoined=true.
 */
export function waitlistRouter(db: DbAdapter): Router {
  const router = Router();
  router.use(requireAuth);

  router.get(
    '/me',
    asyncHandler(async (req: Request, res: Response) => {
      const row = await db.get<WaitlistRow>('SELECT * FROM waitlist WHERE user_id = ?', req.userId!);
      if (!row) {
        res.json({ joined: false });
        return;
      }
      res.json({ joined: true, createdAt: row.created_at });
    }),
  );

  router.post(
    '/',
    asyncHandler(async (req: Request, res: Response) => {
      const { source } = (req.body ?? {}) as { source?: unknown };
      const effectiveSource = source === undefined ? 'pricing' : source;
      if (!validSource(effectiveSource)) {
        res.status(400).json({ error: 'source must be 1-40 chars of [a-z0-9_-]' });
        return;
      }
      const id = randomUUID();
      const createdAt = new Date().toISOString();
      try {
        await db.run(
          'INSERT INTO waitlist (id, user_id, source, created_at) VALUES (?, ?, ?, ?)',
          id,
          req.userId!,
          effectiveSource,
          createdAt,
        );
        res.json({ joined: true, alreadyJoined: false, createdAt });
        return;
      } catch (err) {
        // UNIQUE(user_id) violation ⇒ already joined; return the original row.
        const existing = await db.get<WaitlistRow>('SELECT * FROM waitlist WHERE user_id = ?', req.userId!);
        if (!existing) throw err;
        res.json({ joined: true, alreadyJoined: true, createdAt: existing.created_at });
      }
    }),
  );

  return router;
}
