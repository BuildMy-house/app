import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { Pool, type PoolClient } from 'pg';

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

export interface RunResult {
  changes: number;
  lastInsertRowid: number | string | bigint;
}

export interface DbAdapter {
  readonly _brand: 'DbAdapter';
  get<T = Record<string, unknown>>(sql: string, ...params: unknown[]): Promise<T | undefined>;
  all<T = Record<string, unknown>>(sql: string, ...params: unknown[]): Promise<T[]>;
  run(sql: string, ...params: unknown[]): Promise<RunResult>;
  exec(sql: string): Promise<void>;
  transaction<T>(fn: (tx: DbAdapter) => T | Promise<T>): Promise<T>;
  initSchema(): Promise<void>;
}

// ---------------------------------------------------------------------------
// SqliteAdapter — wraps better-sqlite3 in Promises
// ---------------------------------------------------------------------------

class SqliteAdapter implements DbAdapter {
  readonly _brand = 'DbAdapter' as const;
  constructor(private db: Database.Database) {}

  async get<T = Record<string, unknown>>(sql: string, ...params: unknown[]): Promise<T | undefined> {
    return this.db.prepare(sql).get(...params) as T | undefined;
  }

  async all<T = Record<string, unknown>>(sql: string, ...params: unknown[]): Promise<T[]> {
    return this.db.prepare(sql).all(...params) as T[];
  }

  async run(sql: string, ...params: unknown[]): Promise<RunResult> {
    const info = this.db.prepare(sql).run(...params);
    return { changes: info.changes, lastInsertRowid: info.lastInsertRowid };
  }

  async exec(sql: string): Promise<void> {
    this.db.exec(sql);
  }

  async transaction<T>(fn: (tx: DbAdapter) => T | Promise<T>): Promise<T> {
    // better-sqlite3 transactions are synchronous, but the caller's fn may be async.
    // Use manual BEGIN/COMMIT/ROLLBACK so the entire async body runs inside one transaction.
    // Single shared connection: pass `this` so statements inside fn() run on it.
    this.db.exec('BEGIN');
    try {
      const result = await fn(this);
      this.db.exec('COMMIT');
      return result;
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  async initSchema(): Promise<void> {
    initDb(this.db);
  }
}

// ---------------------------------------------------------------------------
// PgAdapter — wraps node-pg Pool
// ---------------------------------------------------------------------------

function convertNamedParams(sql: string, params: unknown[]): { text: string; values: unknown[] } {
  // If params is a single object with named keys, convert @key → $N
  if (params.length === 1 && params[0] !== null && typeof params[0] === 'object' && !Array.isArray(params[0])) {
    const obj = params[0] as Record<string, unknown>;
    const keys = Object.keys(obj);
    let idx = 0;
    const text = sql.replace(/@(\w+)/g, (_match, name: string) => {
      if (!(name in obj)) throw new Error(`Named param @${name} not found in values`);
      return `$${++idx}`;
    });
    return { text, values: keys.map((k) => obj[k]) };
  }
  // Positional params: replace ? → $N
  let idx = 0;
  const text = sql.replace(/\?/g, () => `$${++idx}`);
  return { text, values: params };
}

export class PgAdapter implements DbAdapter {
  readonly _brand = 'DbAdapter' as const;
  constructor(
    private pool: Pool,
    private client?: PoolClient,
  ) {}

  // All statements must go through the transaction's own checked-out client
  // when inside a transaction — pooled queries would run outside the tx and
  // auto-commit individually.
  private q(text: string, values?: unknown[]) {
    return this.client ? this.client.query(text, values) : this.pool.query(text, values);
  }

  async get<T = Record<string, unknown>>(sql: string, ...params: unknown[]): Promise<T | undefined> {
    const { text, values } = convertNamedParams(sql, params);
    const { rows } = await this.q(text, values);
    return (rows[0] as T) ?? undefined;
  }

  async all<T = Record<string, unknown>>(sql: string, ...params: unknown[]): Promise<T[]> {
    const { text, values } = convertNamedParams(sql, params);
    const { rows } = await this.q(text, values);
    return rows as T[];
  }

  async run(sql: string, ...params: unknown[]): Promise<RunResult> {
    // Handle INSERT OR REPLACE → PostgreSQL ON CONFLICT
    if (/INSERT\s+OR\s+REPLACE/i.test(sql)) {
      return this.runUpsert(sql, params);
    }
    const { text, values } = convertNamedParams(sql, params);
    const { rowCount } = await this.q(text, values);
    return { changes: rowCount ?? 0, lastInsertRowid: '' };
  }

  async exec(sql: string): Promise<void> {
    // Split on semicolons, filter empty, execute each statement
    const stmts = sql.split(';').map((s) => s.trim()).filter(Boolean);
    for (const stmt of stmts) {
      await this.q(stmt);
    }
  }

  async transaction<T>(fn: (tx: DbAdapter) => T | Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    // tx-scoped adapter: every get/all/run inside fn() executes on this same
    // client, so the BEGIN/COMMIT/ROLLBACK below actually wraps them.
    const tx = new PgAdapter(this.pool, client);
    try {
      await client.query('BEGIN');
      const result = await fn(tx);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  async initSchema(): Promise<void> {
    // Run the same SQL schema as SQLite — PostgreSQL supports IF NOT EXISTS
    const stmts = SCHEMA.split(';').map((s) => s.trim()).filter(Boolean);
    for (const stmt of stmts) {
      await this.q(stmt);
    }
    // Migration: add team_id to homes if missing
    const { rows } = await this.q(
      `SELECT column_name FROM information_schema.columns
       WHERE table_name = 'homes' AND column_name = 'team_id'`,
    );
    if (rows.length === 0) {
      await this.q('ALTER TABLE homes ADD COLUMN team_id TEXT');
    }
  }

  private async runUpsert(sql: string, params: unknown[]): Promise<RunResult> {
    // Convert INSERT OR REPLACE INTO t (cols) VALUES (vals)
    // → INSERT INTO t (cols) VALUES ($N) ON CONFLICT (pk) DO UPDATE SET col=EXCLUDED.col, ...
    const m = sql.match(
      /INSERT\s+OR\s+REPLACE\s+INTO\s+(\w+)\s*\(([^)]+)\)\s*VALUES\s*\(([^)]+)\)/i,
    );
    if (!m) throw new Error('Cannot parse INSERT OR REPLACE for PostgreSQL conversion');
    const [, table, colsRaw, valsRaw] = m;
    if (!table || !colsRaw || !valsRaw) throw new Error('Cannot parse INSERT OR REPLACE for PostgreSQL conversion');
    const cols = colsRaw.split(',').map((c) => c.trim());
    // We need the raw values to find the PK — assume first col is PK
    const pk = cols[0];
    const setClauses = cols.slice(1).map((c) => `${c}=EXCLUDED.${c}`).join(', ');
    // Use positional params for the INSERT — just pass through as-is; values already in params
    const { text: insertText, values } = convertNamedParams(
      `INSERT INTO ${table} (${colsRaw}) VALUES (${valsRaw}) ON CONFLICT (${pk}) DO UPDATE SET ${setClauses}`,
      params,
    );
    const { rowCount } = await this.q(insertText, values);
    return { changes: rowCount ?? 0, lastInsertRowid: '' };
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createAdapter(mode: DeploymentMode): DbAdapter {
  if (mode === 'postgres') {
    const pool = new Pool({ connectionString: process.env.DATABASE_URL });
    return new PgAdapter(pool);
  }
  return new SqliteAdapter(openSqlite(defaultDbPath()));
}

// ---------------------------------------------------------------------------
// Legacy helpers (kept for backward compat — prefer createAdapter)
// ---------------------------------------------------------------------------

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

  CREATE TABLE IF NOT EXISTS password_reset_tokens (
    id         TEXT PRIMARY KEY,
    user_id    TEXT NOT NULL,
    token      TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    used_at    TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_password_reset_tokens_token ON password_reset_tokens (token);

  CREATE TABLE IF NOT EXISTS magic_link_tokens (
    id         TEXT PRIMARY KEY,
    email      TEXT NOT NULL,
    token      TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    used_at    TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_magic_link_tokens_token ON magic_link_tokens (token);
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

export function defaultDbPath(): string {
  // src/db.ts (dev) and dist/db.js (compiled) both sit directly under homely/server/.
  return fileURLToPath(new URL('../data/homely.db', import.meta.url));
}

export function openDatabase(path: string): Database.Database {
  return openSqlite(path);
}

export function openAdapter(path?: string): DbAdapter {
  const mode = getDeploymentMode();
  if (mode === 'postgres') {
    const pool = new Pool({ connectionString: process.env.DATABASE_URL });
    return new PgAdapter(pool);
  }
  const dbPath = path ?? defaultDbPath();
  return new SqliteAdapter(openSqlite(dbPath));
}
