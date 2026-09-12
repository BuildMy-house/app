import express from 'express';
import type { Database } from 'better-sqlite3';
import path from 'node:path';
import { assetsRouter } from './assets.js';
import { loginHandler, registerHandler, changePasswordHandler, requireAuth } from './auth.js';
import { homesRouter } from './homes.js';
import { initDb } from './db.js';
import { AssetStorage } from './storage.js';

export function createApp(
  db: Database,
  assetRoot = 'data/assets',
  staticDir?: string,
): express.Express {
  initDb(db);
  const app = express();
  // Base64 inflates bodies ~4/3 (up to two near-50MB blobs on upload), so the
  // JSON limit must sit well above MAX_IMPORT_BYTES for our own handler check
  // (not body-parser's) to be the one that fires with the intended message.
  app.use(express.json({ limit: '256mb' }));
  app.post('/api/auth/register', registerHandler(db));
  app.post('/api/auth/login', loginHandler(db));
  app.put('/api/auth/password', requireAuth, changePasswordHandler(db));
  app.use('/api/assets', assetsRouter(db, new AssetStorage(assetRoot)));
  app.use('/api/homes', homesRouter(db));

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