import request from 'supertest';
import jwt from 'jsonwebtoken';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Express } from 'express';
import { Pool } from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { getJwtSecret } from '../src/config.js';
import { PgAdapter } from '../src/db.js';

process.env.JWT_SECRET = 'test-secret';

// Postgres integration suite: runs only when DATABASE_URL points at a live
// Postgres (CI postgres service, or docker-compose.postgres.yml locally).
// Plain `npm test` with DATABASE_URL unset (default SQLite mode) skips it.
const DATABASE_URL = process.env.DATABASE_URL ?? '';
const pgEnabled = DATABASE_URL.startsWith('postgres');

const b64 = (buf: Buffer) => buf.toString('base64');

/** Minimal structurally-valid GLB: magic "glTF" + version 2 + length (little-endian). */
function glbPayload(extra = 0): Buffer {
  const total = 12 + extra;
  const buf = Buffer.alloc(total);
  buf.writeUInt32LE(0x46546c67, 0);
  buf.writeUInt32LE(2, 4);
  buf.writeUInt32LE(total, 8);
  return buf;
}

const HOME_JSON = JSON.stringify({ schemaVersion: 1, walls: [] });

describe.runIf(pgEnabled)('Postgres backend (live DATABASE_URL)', () => {
  const pool = new Pool({ connectionString: DATABASE_URL });
  let adapter: PgAdapter;
  let app: Express;
  let assetRoot: string;

  async function register(email: string): Promise<string> {
    const res = await request(app).post('/api/auth/register').send({ email, password: 'password123' });
    expect(res.status).toBe(201);
    return res.body.token as string;
  }

  const userId = (token: string) => jwt.verify(token, getJwtSecret()).sub as string;

  beforeAll(async () => {
    adapter = new PgAdapter(pool);
    assetRoot = mkdtempSync(join(tmpdir(), 'homely-pg-assets-'));
    app = await createApp(adapter, assetRoot);
  });

  beforeEach(async () => {
    await pool.query('TRUNCATE users, assets, homes, teams, team_members');
  });

  afterEach(() => {
    rmSync(assetRoot, { recursive: true, force: true });
  });

  afterAll(async () => {
    // homes.ts flushes debounced saves (SAVE_FLUSH_MS = 500) on a timer;
    // let it drain before closing the pool or the flush rejects unhandled.
    await new Promise((resolve) => setTimeout(resolve, 600));
    await pool.end();
  });

  describe('auth', () => {
    it('registers and logs in', async () => {
      const token = await register('alice@example.com');
      expect(typeof token).toBe('string');
      const login = await request(app)
        .post('/api/auth/login')
        .send({ email: 'alice@example.com', password: 'password123' });
      expect(login.status).toBe(200);
      expect(typeof login.body.token).toBe('string');
    });

    it('rejects duplicate registration with 409', async () => {
      await register('dup@example.com');
      const res = await request(app)
        .post('/api/auth/register')
        .send({ email: 'dup@example.com', password: 'password123' });
      expect(res.status).toBe(409);
    });
  });

  describe('teams API', () => {
    it('creates a team with creator as owner, adds members, enforces membership on detail', async () => {
      const alice = await register('alice@example.com');
      const bob = await register('bob@example.com');
      const charlie = await register('charlie@example.com');

      const team = await request(app)
        .post('/api/teams')
        .set('Authorization', `Bearer ${alice}`)
        .send({ name: 'PG Team' });
      expect(team.status).toBe(201);
      expect(team.body.name).toBe('PG Team');

      const add = await request(app)
        .post(`/api/teams/${team.body.id}/members`)
        .set('Authorization', `Bearer ${alice}`)
        .send({ email: 'bob@example.com' });
      expect(add.status).toBe(201);

      const detail = await request(app)
        .get(`/api/teams/${team.body.id}`)
        .set('Authorization', `Bearer ${alice}`);
      expect(detail.status).toBe(200);
      const emails = detail.body.members.map((m: { email: string }) => m.email).sort();
      expect(emails).toEqual(['alice@example.com', 'bob@example.com']);
      expect(detail.body.members.find((m: { email: string }) => m.email === 'alice@example.com').role).toBe('owner');

      const aliceList = await request(app).get('/api/teams').set('Authorization', `Bearer ${alice}`);
      const bobList = await request(app).get('/api/teams').set('Authorization', `Bearer ${bob}`);
      expect(aliceList.body.items).toHaveLength(1);
      expect(bobList.body.items).toHaveLength(1);

      const forbidden = await request(app)
        .get(`/api/teams/${team.body.id}`)
        .set('Authorization', `Bearer ${charlie}`);
      expect(forbidden.status).toBe(403);
    });

    it('rejects duplicate membership with 409', async () => {
      const alice = await register('alice@example.com');
      const team = await request(app)
        .post('/api/teams')
        .set('Authorization', `Bearer ${alice}`)
        .send({ name: 'Dup Team' });
      await request(app)
        .post(`/api/teams/${team.body.id}/members`)
        .set('Authorization', `Bearer ${alice}`)
        .send({ email: 'alice@example.com' });
      const res = await request(app)
        .post(`/api/teams/${team.body.id}/members`)
        .set('Authorization', `Bearer ${alice}`)
        .send({ email: 'alice@example.com' });
      expect(res.status).toBe(409);
    });
  });

  describe('team-owned homes', () => {
    it('member can read and update; non-member gets 403', async () => {
      const alice = await register('alice@example.com');
      const bob = await register('bob@example.com');
      const charlie = await register('charlie@example.com');

      const team = await request(app)
        .post('/api/teams')
        .set('Authorization', `Bearer ${alice}`)
        .send({ name: 'Home Team' });
      await request(app)
        .post(`/api/teams/${team.body.id}/members`)
        .set('Authorization', `Bearer ${alice}`)
        .send({ email: 'bob@example.com' });

      const home = await request(app)
        .post('/api/homes')
        .set('Authorization', `Bearer ${alice}`)
        .send({ name: 'Team Home', json: HOME_JSON, teamId: team.body.id });
      expect(home.status).toBe(201);

      const bobRead = await request(app)
        .get(`/api/homes/${home.body.id}`)
        .set('Authorization', `Bearer ${bob}`);
      expect(bobRead.status).toBe(200);
      expect(bobRead.body.name).toBe('Team Home');

      const bobUpdate = await request(app)
        .put(`/api/homes/${home.body.id}`)
        .set('Authorization', `Bearer ${bob}`)
        .send({ name: 'Updated by Bob', json: HOME_JSON });
      expect(bobUpdate.status).toBe(200);
      expect(bobUpdate.body.name).toBe('Updated by Bob');

      const charlieRead = await request(app)
        .get(`/api/homes/${home.body.id}`)
        .set('Authorization', `Bearer ${charlie}`);
      expect(charlieRead.status).toBe(403);
    });
  });

  describe('personal homes API', () => {
    it('create → get → update → list', async () => {
      const token = await register('home@example.com');
      const auth = { Authorization: `Bearer ${token}` };

      const create = await request(app).post('/api/homes').set(auth).send({ name: 'PG Home', json: HOME_JSON });
      expect(create.status).toBe(201);

      const got = await request(app).get(`/api/homes/${create.body.id}`).set(auth);
      expect(got.status).toBe(200);
      expect(got.body.json).toBe(HOME_JSON);

      const put = await request(app)
        .put(`/api/homes/${create.body.id}`)
        .set(auth)
        .send({ name: 'PG Home v2', json: HOME_JSON });
      expect(put.status).toBe(200);
      expect(put.body.name).toBe('PG Home v2');

      const list = await request(app).get('/api/homes').set(auth);
      expect(list.status).toBe(200);
      expect(list.body.items).toHaveLength(1);
    });

    it('other users get 403 on a personal home', async () => {
      const tokenA = await register('owner@example.com');
      const tokenB = await register('intruder@example.com');
      const home = await request(app)
        .post('/api/homes')
        .set('Authorization', `Bearer ${tokenA}`)
        .send({ name: 'Private', json: HOME_JSON });

      const res = await request(app)
        .get(`/api/homes/${home.body.id}`)
        .set('Authorization', `Bearer ${tokenB}`);
      expect(res.status).toBe(403);
    });
  });

  describe('assets API', () => {
    it('uploads a GLB and lists it', async () => {
      const token = await register('assets@example.com');
      const myId = userId(token);

      const upload = await request(app)
        .post(`/api/assets/${myId}`)
        .set('Authorization', `Bearer ${token}`)
        .send({
          record: {
            id: 'asset-1',
            catalogId: 'cat-1',
            name: 'Table',
            category: 'furniture',
            width: 100,
            depth: 50,
            height: 75,
            color: 0xffffff,
            blobKey: 'blob:asset-1',
            createdAt: 1234,
          },
          glb: b64(glbPayload()),
        });
      expect(upload.status).toBe(201);
      expect(upload.body.id).toBe('asset-1');

      const list = await request(app).get(`/api/assets/${myId}`).set('Authorization', `Bearer ${token}`);
      expect(list.status).toBe(200);
      expect(list.body.items ?? list.body).toEqual(
        expect.arrayContaining([expect.objectContaining({ id: 'asset-1', name: 'Table' })]),
      );
    });
  });

  describe('transaction atomicity (PgAdapter)', () => {
    it('REGRESSION: rolls back ALL statements when one fails (duplicate PK)', async () => {
      const token = await register('tx@example.com');
      const uid = userId(token);
      const now = new Date().toISOString();

      // Pre-existing row outside the transaction must be untouched.
      await adapter.run('INSERT INTO teams (id, name, created_at) VALUES (?, ?, ?)', 't-setup', 'Setup', now);

      await expect(
        adapter.transaction(async (tx) => {
          await tx.run('INSERT INTO teams (id, name, created_at) VALUES (?, ?, ?)', 't-rollback', 'Doomed', now);
          await tx.run(
            'INSERT INTO team_members (team_id, user_id, role, joined_at) VALUES (?, ?, ?, ?)',
            't-rollback',
            uid,
            'owner',
            now,
          );
          // Duplicate PK (team_id, user_id) → this insert fails; the whole
          // transaction must roll back, including the first two statements.
          await tx.run(
            'INSERT INTO team_members (team_id, user_id, role, joined_at) VALUES (?, ?, ?, ?)',
            't-rollback',
            uid,
            'owner',
            now,
          );
        }),
      ).rejects.toThrow();

      // Before the fix, tx.run() went through pool connections that
      // auto-commit individually, so 't-rollback' survived the failure.
      expect(await adapter.get('SELECT * FROM teams WHERE id = ?', 't-rollback')).toBeUndefined();
      expect(await adapter.get('SELECT 1 AS x FROM team_members WHERE team_id = ?', 't-rollback')).toBeUndefined();
      expect(await adapter.get('SELECT * FROM teams WHERE id = ?', 't-setup')).toBeDefined();
    });

    it('commits all statements on success', async () => {
      const token = await register('tx2@example.com');
      const uid = userId(token);
      const now = new Date().toISOString();

      await adapter.transaction(async (tx) => {
        await tx.run('INSERT INTO teams (id, name, created_at) VALUES (?, ?, ?)', 't-commit', 'Committed', now);
        await tx.run(
          'INSERT INTO team_members (team_id, user_id, role, joined_at) VALUES (?, ?, ?, ?)',
          't-commit',
          uid,
          'owner',
          now,
        );
      });

      expect(await adapter.get('SELECT * FROM teams WHERE id = ?', 't-commit')).toBeDefined();
      expect(await adapter.get('SELECT * FROM team_members WHERE team_id = ?', 't-commit')).toBeDefined();
    });

    it('createTeam API persists team + owner membership via the transaction', async () => {
      const token = await register('api-tx@example.com');
      const uid = userId(token);
      const res = await request(app)
        .post('/api/teams')
        .set('Authorization', `Bearer ${token}`)
        .send({ name: 'API Team' });
      expect(res.status).toBe(201);

      expect(await adapter.get('SELECT * FROM teams WHERE id = ?', res.body.id)).toMatchObject({
        name: 'API Team',
      });
      expect(
        await adapter.get('SELECT * FROM team_members WHERE team_id = ? AND user_id = ?', res.body.id, uid),
      ).toMatchObject({ role: 'owner' });
    });
  });
});
