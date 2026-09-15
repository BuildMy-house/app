import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import path from 'node:path';
import { assetsRouter } from './assets.js';
import { modelUploadRouter } from './model-upload.js';
import {
  loginHandler,
  registerHandler,
  changePasswordHandler,
  requireAuth,
  meHandler,
  updateNameHandler,
  changeEmailHandler,
  deleteAccountHandler,
  passwordResetRequestHandler,
  passwordResetConfirmHandler,
  magicLinkRequestHandler,
  magicLinkConsumeHandler,
} from './auth.js';
import { homesRouter } from './homes.js';
import { teamsRouter } from './teams.js';
import { initDb, type DbAdapter } from './db.js';
import { AssetStorage } from './storage.js';
import { renderQueue } from './render-queue.js';
import { reportError } from './errorReporting.js';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';

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
  // helmet first, before anything else can set/response headers. CSP is off:
  // this server serves a Vite-built SPA plus WebGL/3D content and textures
  // (/assets/textures/:name), and helmet's strict default CSP breaks inline
  // scripts/WASM/canvas content. A properly-tuned CSP is separate, verified-
  // against-the-real-frontend work — all other helmet defaults stay on.
  app.use(helmet({ contentSecurityPolicy: false }));

  // CORS: explicit allow-list via CORS_ALLOWED_ORIGINS (comma-separated) wins.
  // Dev fallback (when unset, NODE_ENV !== production): localhost:5173 (Vite)
  // and localhost:3000. In production with no env var: no cross-origin at all
  // (same-origin only — the single-container deployment serves its own frontend).
  const allowedOrigins = (process.env.CORS_ALLOWED_ORIGINS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const devOrigins = ['http://localhost:5173', 'http://localhost:3000'];
  app.use(
    cors({
      credentials: true,
      origin(origin, cb) {
        if (!origin) return cb(null, true); // non-browser / same-origin request
        const list = allowedOrigins.length > 0 ? allowedOrigins : process.env.NODE_ENV === 'production' ? [] : devOrigins;
        cb(null, list.includes(origin));
      },
    }),
  );

  // Base64 inflates bodies ~4/3 (up to two near-50MB blobs on upload), so the
  // JSON limit must sit well above MAX_IMPORT_BYTES for our own handler check
  // (not body-parser's) to be the one that fires with the intended message.
  app.use(express.json({ limit: '256mb' }));

  // Pure liveness probe: process is up and responding. No DB ping — production
  // runs Neon, which has its own health monitoring, and a DB check here would
  // flap on transient Neon-side blips that aren't this process's problem.
  app.get('/healthz', (_req, res) => {
    res.status(200).json({ ok: true });
  });
  const assetStorage = new AssetStorage(assetRoot);
  app.post('/api/auth/register', registerHandler(adapter));
  app.post('/api/auth/login', loginHandler(adapter));
  app.put('/api/auth/password', requireAuth, changePasswordHandler(adapter));
  app.get('/api/auth/me', requireAuth, meHandler(adapter));
  app.patch('/api/auth/me', requireAuth, updateNameHandler(adapter));
  app.put('/api/auth/email', requireAuth, changeEmailHandler(adapter));
  app.delete('/api/auth/me', requireAuth, deleteAccountHandler(adapter, assetStorage));
  app.post('/api/auth/password-reset/request', passwordResetRequestHandler(adapter));
  app.post('/api/auth/password-reset/confirm', passwordResetConfirmHandler(adapter));
  app.post('/api/auth/magic-link/request', magicLinkRequestHandler(adapter));
  app.post('/api/auth/magic-link/consume', magicLinkConsumeHandler(adapter));
  app.use('/api/assets', assetsRouter(adapter, assetStorage));
  app.use('/api/models/upload', modelUploadRouter(adapter));
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

    if (!['thumbnail', 'low', 'medium', 'high'].includes(quality ?? 'medium')) {
      res.status(400).json({ error: 'quality must be thumbnail, low, medium, or high' })
      return
    }
    let jobId: string
    try {
      jobId = renderQueue.enqueue(userId, homeId, homeName ?? 'Untitled', homeJson, quality ?? 'medium')
    } catch (error) {
      res.status(503).json({ error: error instanceof Error ? error.message : String(error) })
      return
    }
    res.status(202).json({ jobId, status: 'queued' })
  })

  app.get('/api/render/queue/:jobId/artifact', requireAuth, (req, res) => {
    const job = renderQueue.getJob(req.params.jobId, (req as any).userId!)
    if (!job?.resultPath) {
      res.status(404).json({ error: 'render artifact not found' })
      return
    }
    try {
      res.type('png').send(readFileSync(job.resultPath))
    } catch {
      res.status(404).json({ error: 'render artifact not found' })
    }
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

  // Centralized error handler — LAST in the stack. Logs full detail server-side,
  // but never leaks stack/message/internal detail in the response body, in any
  // environment (same generic response always: simpler and safer than an
  // env-conditional leak).
  app.use(errorHandler);

  return app;
}

// Exported so tests can mount it on a probe app with a route that throws.
export const errorHandler: express.ErrorRequestHandler = (err, req, res, _next) => {
  console.error('Unhandled error:', err);
  // Fire-and-forget: must never delay the 500 response below.
  reportError(err, { path: req.path, method: req.method, userId: (req as any).userId });
  res.status(500).json({ error: 'internal server error' });
};
