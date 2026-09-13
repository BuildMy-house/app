import express from 'express';
import path from 'node:path';
import { assetsRouter } from './assets.js';
import { loginHandler, registerHandler, changePasswordHandler, requireAuth } from './auth.js';
import { homesRouter } from './homes.js';
import { teamsRouter } from './teams.js';
import { initDb, type DbAdapter } from './db.js';
import { AssetStorage } from './storage.js';
import { renderQueue } from './render-queue.js';
import Database from 'better-sqlite3';

export async function createApp(
  dbOrAdapter: DbAdapter | Database.Database,
  assetRoot = 'data/assets',
  staticDir?: string,
): Promise<express.Express> {
  let adapter: DbAdapter;

  // Support both legacy Database and new DbAdapter for backward compat
  if ('_brand' in dbOrAdapter && (dbOrAdapter as DbAdapter)._brand === 'DbAdapter') {
    adapter = dbOrAdapter as DbAdapter;
  } else {
    const rawDb = dbOrAdapter as Database.Database;
    // Wrap raw better-sqlite3 in a basic async adapter for backward compat
    adapter = {
      _brand: 'DbAdapter' as const,
      async get(sql, ...params) { return rawDb.prepare(sql).get(...params) as any; },
      async all(sql, ...params) { return rawDb.prepare(sql).all(...params) as any[]; },
      async run(sql, ...params) {
        const info = rawDb.prepare(sql).run(...params);
        return { changes: info.changes, lastInsertRowid: info.lastInsertRowid };
      },
      async exec(sql) { rawDb.exec(sql); },
      async transaction(fn) {
        rawDb.exec('BEGIN');
        try {
          const result = await fn(this as DbAdapter);
          rawDb.exec('COMMIT');
          return result;
        } catch (err) {
          rawDb.exec('ROLLBACK');
          throw err;
        }
      },
      async initSchema() { initDb(rawDb); },
    };
  }

  await adapter.initSchema();
  const app = express();
  // Base64 inflates bodies ~4/3 (up to two near-50MB blobs on upload), so the
  // JSON limit must sit well above MAX_IMPORT_BYTES for our own handler check
  // (not body-parser's) to be the one that fires with the intended message.
  app.use(express.json({ limit: '256mb' }));
  app.post('/api/auth/register', registerHandler(adapter));
  app.post('/api/auth/login', loginHandler(adapter));
  app.put('/api/auth/password', requireAuth, changePasswordHandler(adapter));
  app.use('/api/assets', assetsRouter(adapter, new AssetStorage(assetRoot)));
  app.use('/api/homes', homesRouter(adapter));
  app.use('/api/teams', teamsRouter(adapter));

  // Render queue API: enqueue studio/high-quality renders (optional premium feature)
  app.post('/api/render/queue', requireAuth, (req, res) => {
    const userId = (req as any).userId!
    const { homeId, homeName, homeJson, quality } = (req.body ?? {}) as any

    if (!homeId || !homeJson) {
      res.status(400).json({ error: 'homeId and homeJson required' })
      return
    }

    const jobId = renderQueue.enqueue(userId, homeId, homeName ?? 'Untitled', homeJson, quality ?? 'standard')
    res.status(202).json({ jobId, status: 'queued' })
  })

  // Get render job status
  app.get('/api/render/queue/:jobId', requireAuth, (req, res) => {
    const userId = (req as any).userId!
    const jobId = (req as any).params?.jobId
    const job = renderQueue.getJob(jobId, userId)

    if (!job) {
      res.status(404).json({ error: 'job not found' })
      return
    }

    res.json({
      id: job.id,
      status: job.status,
      quality: job.quality,
      createdAt: job.createdAt,
      startedAt: job.startedAt,
      completedAt: job.completedAt,
      error: job.error,
      resultPath: job.resultPath,
    })
  })

  // List all render jobs for the authenticated user
  app.get('/api/render/queue', requireAuth, (req, res) => {
    const userId = (req as any).userId!
    const jobs = renderQueue.getUserJobs(userId)

    res.json({
      jobs: jobs.map((j) => ({
        id: j.id,
        status: j.status,
        quality: j.quality,
        homeName: j.homeName,
        createdAt: j.createdAt,
        completedAt: j.completedAt,
      })),
    })
  })

  // Get queue status (estimated wait time, etc.)
  app.get('/api/render/status', (_req, res) => {
    const status = renderQueue.getStatus()
    res.json(status)
  })

  // Content negotiation for textures: serve WebP to modern browsers, PNG fallback.
  // Reduces transfer size by 40-60% without requiring pre-conversion.
  app.get('/assets/textures/:name', (req, res) => {
    const name = (req as any).params?.name;
    if (!name || !name.match(/^[a-z0-9-]+$/)) {
      res.status(400).send('Invalid texture name');
      return;
    }

    // Check if browser accepts WebP (via Accept header negotiation)
    const acceptWebP = (req as any).headers?.accept?.includes('image/webp');

    // Try WebP first if browser supports it
    if (acceptWebP) {
      try {
        const webpPath = path.join(assetRoot, `${name}.webp`);
        return (res as any).sendFile(webpPath, (err: any) => {
          // If WebP not found, fall back to PNG
          if (err) {
            const pngPath = path.join(assetRoot, `${name}.png`);
            (res as any).sendFile(pngPath);
          }
        });
      } catch {
        // Fall through to PNG
      }
    }

    // Serve PNG (no WebP available or browser doesn't support)
    const pngPath = path.join(assetRoot, `${name}.png`);
    (res as any).sendFile(pngPath);
  });

  if (staticDir) {
    app.use(express.static(staticDir));
    // SPA fallback: any GET that didn't match an API route serves index.html.
    app.get('*', (_req, res) => {
      res.sendFile(path.join(staticDir, 'index.html'));
    });
  }

  return app;
}
