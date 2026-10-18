import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { initDb } from '../src/db.js';

describe('users google columns migration', () => {
  it('adds google_sub/picture to an old-schema users table, preserving existing rows', () => {
    const db = new Database(':memory:');
    db.exec(`
      CREATE TABLE users (
        id            TEXT PRIMARY KEY,
        email         TEXT NOT NULL UNIQUE,
        password_hash TEXT NOT NULL,
        created_at    TEXT NOT NULL
      );
      INSERT INTO users (id, email, password_hash, created_at)
        VALUES ('u1', 'old@example.com', 'hash', '2026-01-01T00:00:00.000Z');
    `);

    initDb(db);

    const cols = db.pragma('table_info(users)') as { name: string }[];
    expect(cols.map((c) => c.name)).toContain('google_sub');
    expect(cols.map((c) => c.name)).toContain('picture');

    const row = db.prepare('SELECT * FROM users WHERE id = ?').get('u1') as {
      email: string;
      google_sub: string | null;
      picture: string | null;
    };
    expect(row.email).toBe('old@example.com');
    expect(row.google_sub).toBeNull();
    expect(row.picture).toBeNull();
  });
});
