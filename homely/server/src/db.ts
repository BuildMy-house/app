import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';

export interface UserRow {
  id: string;
  email: string;
  password_hash: string;
  created_at: string;
}

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS users (
    id            TEXT PRIMARY KEY,
    email         TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    created_at    TEXT NOT NULL
  );
`;

// Idempotent init-on-boot: safe to call once per server start, and safe to
// call again (CREATE ... IF NOT EXISTS). No migration framework needed at this scale.
export function initDb(db: Database.Database): void {
  db.exec(SCHEMA);
}

export function openDatabase(path: string): Database.Database {
  mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  return db;
}

export function defaultDbPath(): string {
  // src/db.ts (dev) and dist/db.js (compiled) both sit directly under homely/server/.
  return fileURLToPath(new URL('../data/homely.db', import.meta.url));
}