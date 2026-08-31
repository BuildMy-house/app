import express from 'express';
import type { Database } from 'better-sqlite3';
import { loginHandler, registerHandler } from './auth.js';
import { initDb } from './db.js';

export function createApp(db: Database): express.Express {
  initDb(db);
  const app = express();
  app.use(express.json());
  app.post('/api/auth/register', registerHandler(db));
  app.post('/api/auth/login', loginHandler(db));
  return app;
}