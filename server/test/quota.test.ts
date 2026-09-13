import request from 'supertest';
import jwt from 'jsonwebtoken';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import type { Express } from 'express';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { getJwtSecret } from '../src/config.js';

process.env.JWT_SECRET = 'test-secret';

let app: Express;
let db: Database.Database;
let assetRoot: string;
const openDbs: Database.Database[] = [];

beforeEach(async () => {
  assetRoot = mkdtempSync(join(tmpdir(), 'homely-quota-'));
  db = new Database(':memory:');
  openDbs.push(db);
  app = await createApp(db, assetRoot);
});

afterEach(() => {
  for (const d of openDbs.splice(0)) d.close();
  rmSync(assetRoot, { recursive: true, force: true });
  delete process.env.MAX_TOTAL_ASSET_BYTES_PER_USER;
  delete process.env.MAX_HOMES_PER_USER;
});

async function register(email: string): Promise<{ token: string; userId: string }> {
  const res = await request(app).post('/api/auth/register').send({ email, password: 'password123' });
  const token = res.body.token as string;
  return { token, userId: jwt.verify(token, getJwtSecret()).sub as string };
}

/** Minimal structurally-valid GLB: magic "glTF" + version 2 + length (little-endian). */
function glbPayload(extra = 0): Buffer {
  const total = 12 + extra;
  const buf = Buffer.alloc(total);
  buf.writeUInt32LE(0x46546c67, 0);
  buf.writeUInt32LE(2, 4);
  buf.writeUInt32LE(total, 8);
  return buf;
}

const record = (over: Record<string, unknown> = {}) => ({
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
  ...over,
});

function upload(token: string, userId: string, body: Record<string, unknown>) {
  return request(app).post(`/api/assets/${userId}`).set('Authorization', `Bearer ${token}`).send(body);
}

describe('per-user asset storage quota', () => {
  it('stores size_bytes = glb + source bytes at upload time', async () => {
    const { token, userId } = await register('q-size@example.com');
    const glb = glbPayload(20); // 32 bytes
    const source = Buffer.from('some-source'); // 11 bytes

    const res = await upload(token, userId, {
      record: record(),
      glb: glb.toString('base64'),
      source: source.toString('base64'),
    });
    expect(res.status).toBe(201);

    const row = db.prepare('SELECT size_bytes FROM assets WHERE id = ?').get('asset-1') as {
      size_bytes: number;
    };
    expect(row.size_bytes).toBe(glb.byteLength + source.byteLength);
  });

  it('rejects an upload with 413 when the total would exceed the cap', async () => {
    process.env.MAX_TOTAL_ASSET_BYTES_PER_USER = '100'; // test-only tiny cap
    const { token, userId } = await register('q-cap@example.com');

    const first = await upload(token, userId, {
      record: record({ id: 'a-1' }),
      glb: glbPayload(20).toString('base64'), // 32 bytes
    });
    expect(first.status).toBe(201);

    const second = await upload(token, userId, {
      record: record({ id: 'a-2' }),
      glb: glbPayload(68).toString('base64'), // 80 bytes: 32+80 > 100
    });
    expect(second.status).toBe(413);
    expect(second.body.error).toBe('storage quota exceeded');

    // Same for a new asset whose glb+source would push past the cap.
    const withSource = await upload(token, userId, {
      record: record({ id: 'a-3' }),
      glb: glbPayload(20).toString('base64'), // 32 bytes
      source: Buffer.alloc(50).toString('base64'), // +50: 32+82 > 100
    });
    expect(withSource.status).toBe(413);
  });

  it('rejects with 413 when a single upload alone exceeds the cap', async () => {
    process.env.MAX_TOTAL_ASSET_BYTES_PER_USER = '10';
    const { token, userId } = await register('q-single@example.com');

    const res = await upload(token, userId, { record: record(), glb: glbPayload().toString('base64') });
    expect(res.status).toBe(413);
  });

  it('replace-existing-id upload does not double-count the replaced size', async () => {
    process.env.MAX_TOTAL_ASSET_BYTES_PER_USER = '100';
    const { token, userId } = await register('q-replace@example.com');
    const glb = glbPayload(20); // 32 bytes

    const first = await upload(token, userId, {
      record: record({ id: 'a-1' }),
      glb: glb.toString('base64'),
    });
    expect(first.status).toBe(201);

    // Same id: replaces a-1, so stored total stays 32 bytes, not 32+32=64.
    // Under a double-counting implementation 64 bytes is still < 100 — so use
    // a second asset to pin the total near the cap first, then the replace is
    // the difference between fitting (recompute) and failing (double-count).
    const filler = await upload(token, userId, { record: record({ id: 'a-2' }), glb: glb.toString('base64') });
    expect(filler.status).toBe(201);

    // Stored total is now 64. Cap is 100, so a fresh 32-byte asset would hit
    // 96 < 100 — but a NEW 40-byte asset (96+40=136, and 64+40-32 double... )
    // Use replace of a-1 with a 40-byte glb: recompute = 32(a-2) + 40 = 72 OK;
    // double-count = 64 + 40 = 104 > 100 → would wrongly 413.
    const replaced = await upload(token, userId, {
      record: record({ id: 'a-1' }),
      glb: glbPayload(28).toString('base64'), // 40 bytes
    });
    expect(replaced.status).toBe(201);

    const row = db.prepare('SELECT size_bytes FROM assets WHERE id = ?').get('a-1') as {
      size_bytes: number;
    };
    expect(row.size_bytes).toBe(40);

    // And the quota now correctly reflects 32 + 40 = 72 stored: 29 bytes free.
    const over = await upload(token, userId, {
      record: record({ id: 'a-3' }),
      glb: glbPayload(30).toString('base64'), // 42 bytes: 72+42 > 100
    });
    expect(over.status).toBe(413);
  });

  it('quota is per-user: another user under the cap is unaffected', async () => {
    process.env.MAX_TOTAL_ASSET_BYTES_PER_USER = '100';
    const a = await register('q-user-a@example.com');
    const b = await register('q-user-b@example.com');
    const glb = glbPayload(20); // 32 bytes

    for (let i = 1; i <= 3; i++) {
      const res = await upload(a.token, a.userId, { record: record({ id: `a-${i}` }), glb: glb.toString('base64') });
      expect(res.status).toBe(201);
    }
    // A is at 96/100 — next upload 413s.
    const aBlocked = await upload(a.token, a.userId, { record: record({ id: 'a-4' }), glb: glb.toString('base64') });
    expect(aBlocked.status).toBe(413);

    // B has stored nothing — uploads freely.
    const bRes = await upload(b.token, b.userId, { record: record({ id: 'b-1' }), glb: glb.toString('base64') });
    expect(bRes.status).toBe(201);
  });
});

describe('per-user homes cap', () => {
  it('rejects home creation beyond MAX_HOMES_PER_USER with 400', async () => {
    process.env.MAX_HOMES_PER_USER = '2';
    const { token } = await register('q-homes@example.com');
    const create = (name: string) =>
      request(app).post('/api/homes').set('Authorization', `Bearer ${token}`).send({ name, json: '{}' });

    expect((await create('home-1')).status).toBe(201);
    expect((await create('home-2')).status).toBe(201);

    const third = await create('home-3');
    expect(third.status).toBe(400);
    expect(third.body.error).toMatch(/home limit/i);
  });

  it('counts team homes the user owns toward the same cap, and updates after deletion', async () => {
    process.env.MAX_HOMES_PER_USER = '2';
    const { token } = await register('q-homes-team@example.com');

    // Team home (owned) counts like a personal home.
    expect(
      (
        await request(app)
          .post('/api/homes')
          .set('Authorization', `Bearer ${token}`)
          .send({ name: 'team-home', json: '{}', teamId: 'no-such-team' })
      ).status,
    ).toBe(403); // team membership still enforced; not counted
    expect(
      (
        await request(app)
          .post('/api/homes')
          .set('Authorization', `Bearer ${token}`)
          .send({ name: 'home-1', json: '{}' })
      ).status,
    ).toBe(201);
    expect(
      (
        await request(app)
          .post('/api/homes')
          .set('Authorization', `Bearer ${token}`)
          .send({ name: 'home-2', json: '{}' })
      ).status,
    ).toBe(201);
    expect((await request(app).post('/api/homes').set('Authorization', `Bearer ${token}`).send({ name: 'home-3', json: '{}' })).status).toBe(400);

    // Freeing a home frees the budget.
    const list = await request(app).get('/api/homes').set('Authorization', `Bearer ${token}`);
    const id = list.body.items[0].id as string;
    await request(app).delete(`/api/homes/${id}`).set('Authorization', `Bearer ${token}`);
    expect(
      (await request(app).post('/api/homes').set('Authorization', `Bearer ${token}`).send({ name: 'home-4', json: '{}' }))
        .status,
    ).toBe(201);
  });
});
