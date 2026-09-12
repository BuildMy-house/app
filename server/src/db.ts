import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { Pool } from 'pg';

export type DeploymentMode = 'sqlite' | 'postgres';

export function getDeploymentMode(): DeploymentMode {
  const url = process.env.DATABASE_URL;
  if (url && url.startsWith('postgresql://')) return 'postgres';
  return 'sqlite';
}

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

  CREATE TABLE IF NOT EXISTS assets (
    id          TEXT PRIMARY KEY,
    user_id     TEXT NOT NULL,
    catalog_id  TEXT NOT NULL,
    name        TEXT NOT NULL,
    category    TEXT NOT NULL,
    width       REAL NOT NULL,
    depth       REAL NOT NULL,
    height      REAL NOT NULL,
    color       INTEGER,
    blob_key    TEXT NOT NULL,
    glb_path    TEXT NOT NULL,
    source_path TEXT,
    created_at  INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_assets_user ON assets (user_id);

  CREATE TABLE IF NOT EXISTS homes (
    id            TEXT PRIMARY KEY,
    owner_user_id TEXT NOT NULL,
    name          TEXT NOT NULL,
    json          TEXT NOT NULL,
    created_at    TEXT NOT NULL,
    updated_at    TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_homes_owner ON homes (owner_user_id);

  CREATE TABLE IF NOT EXISTS teams (
    id         TEXT PRIMARY KEY,
    name       TEXT NOT NULL,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS team_members (
    team_id   TEXT NOT NULL,
    user_id   TEXT NOT NULL,
    role      TEXT NOT NULL,
    joined_at TEXT NOT NULL,
    PRIMARY KEY (team_id, user_id)
  );
  CREATE INDEX IF NOT EXISTS idx_team_members_user ON team_members (user_id);
`;

// Idempotent init-on-boot: safe to call once per server start, and safe to
// call again (CREATE ... IF NOT EXISTS). No migration framework needed at this scale.
export function initDb(db: Database.Database): void {
  db.exec(SCHEMA);
  // Guarded migration: add team_id to homes if missing (existing rows get NULL).
  const cols = db.pragma('table_info(homes)') as { name: string }[];
  if (!cols.some((c) => c.name === 'team_id')) {
    db.exec('ALTER TABLE homes ADD COLUMN team_id TEXT');
  }
}

function openSqlite(path: string): Database.Database {
  mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  return db;
}

function openPostgres(): Database.Database {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  return { exec: (sql: string) => pool.query(sql) } as unknown as Database.Database;
}

export function openDatabase(path: string): Database.Database {
  return getDeploymentMode() === 'postgres' ? openPostgres() : openSqlite(path);
}

export function defaultDbPath(): string {
  // src/db.ts (dev) and dist/db.js (compiled) both sit directly under homely/server/.
  return fileURLToPath(new URL('../data/homely.db', import.meta.url));
}
