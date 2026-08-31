import express from 'express';
import type { Database } from 'better-sqlite3';
import { assetsRouter } from './assets.js';
import { loginHandler, registerHandler } from './auth.js';
import { homesRouter } from './homes.js';
import { initDb } from './db.js';
import { AssetStorage } from './storage.js';

export function createApp(db: Database, assetRoot = 'data/assets'): express.Express {
  initDb(db);
  const app = express();
  // Base64 inflates bodies ~4/3 (up to two near-50MB blobs on upload), so the
  // JSON limit must sit well above MAX_IMPORT_BYTES for our own handler check
  // (not body-parser's) to be the one that fires with the intended message.
  app.use(express.json({ limit: '256mb' }));
  app.post('/api/auth/register', registerHandler(db));
  app.post('/api/auth/login', loginHandler(db));
  app.use('/api/assets', assetsRouter(db, new AssetStorage(assetRoot)));
  app.use('/api/homes', homesRouter(db));
  return app;
}