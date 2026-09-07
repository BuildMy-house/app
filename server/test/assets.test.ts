import request from 'supertest';
import jwt from 'jsonwebtoken';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import type { Express } from 'express';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { getJwtSecret } from '../src/config.js';

process.env.JWT_SECRET = 'test-secret';

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

let app: Express;
let db: Database.Database;
let assetRoot: string;
const openDbs: Database.Database[] = [];

beforeEach(() => {
  assetRoot = mkdtempSync(join(tmpdir(), 'homely-assets-'));
  db = new Database(':memory:');
  openDbs.push(db);
  app = createApp(db, assetRoot);
});

afterEach(() => {
  for (const d of openDbs.splice(0)) d.close();
  rmSync(assetRoot, { recursive: true, force: true });
});

async function register(email: string) {
  const res = await request(app).post('/api/auth/register').send({ email, password: 'password123' });
  return res.body.token as string;
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

describe('POST /api/assets/:userId', () => {
  it('uploads a GLB for a user acting on their own data', async () => {
    const token = await register('alice@example.com');
    const myId = jwt.verify(token, getJwtSecret()).sub as string;

    const res = await request(app)
      .post(`/api/assets/${myId}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ record: record(), glb: b64(glbPayload()), source: b64(Buffer.from('src')) });

    expect(res.status).toBe(201);
    expect(res.body.id).toBe('asset-1');
    expect(res.body.name).toBe('Table');
  });

  it('rejects a non-GLB upload server-side (bad magic number)', async () => {
    const token = await register('bob@example.com');
    const myId = jwt.verify(token, getJwtSecret()).sub as string;

    const res = await request(app)
      .post(`/api/assets/${myId}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ record: record(), glb: b64(Buffer.from('this is not glb data at all...')) });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/not a GLB/i);
  });

  it('rejects a model over the size cap', async () => {
    const token = await register('carol@example.com');
    const myId = jwt.verify(token, getJwtSecret()).sub as string;
    const tooBig = Buffer.alloc(50 * 1024 * 1024 + 1);

    const res = await request(app)
      .post(`/api/assets/${myId}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ record: record(), glb: b64(tooBig) });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/import limit/i);
  });

  it('rejects with 403 when the JWT user does not match the path userId', async () => {
    const tokenA = await register('alice@example.com');
    const otherId = 'some-other-user-id';

    const res = await request(app)
      .post(`/api/assets/${otherId}`)
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ record: record(), glb: b64(glbPayload()) });

    expect(res.status).toBe(403);
  });
});

describe('GET /api/assets/:userId', () => {
  it('lists only the authenticated user\'s own assets', async () => {
    const tokenA = await register('alice@example.com');
    const idA = jwt.verify(tokenA, getJwtSecret()).sub as string;
    const tokenB = await register('bob@example.com');
    const idB = jwt.verify(tokenB, getJwtSecret()).sub as string;

    await request(app)
      .post(`/api/assets/${idA}`)
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ record: record({ id: 'a-1' }), glb: b64(glbPayload()) });
    await request(app)
      .post(`/api/assets/${idB}`)
      .set('Authorization', `Bearer ${tokenB}`)
      .send({ record: record({ id: 'b-1' }), glb: b64(glbPayload()) });

    const mine = await request(app).get(`/api/assets/${idA}`).set('Authorization', `Bearer ${tokenA}`);
    expect(mine.status).toBe(200);
    expect(mine.body.items.map((r: { id: string }) => r.id)).toEqual(['a-1']);
  });

  it('rejects with 403 when listing another user\'s path', async () => {
    const tokenA = await register('alice@example.com');
    const otherId = 'someone-else';

    const res = await request(app).get(`/api/assets/${otherId}`).set('Authorization', `Bearer ${tokenA}`);
    expect(res.status).toBe(403);
  });
});

describe('GET /api/assets/:userId/:id/model', () => {
  it('returns the raw GLB blob for the owner', async () => {
    const token = await register('alice@example.com');
    const myId = jwt.verify(token, getJwtSecret()).sub as string;
    const glb = glbPayload(16);

    await request(app)
      .post(`/api/assets/${myId}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ record: record(), glb: b64(glb) });

    const res = await request(app)
      .get(`/api/assets/${myId}/asset-1/model`)
      .set('Authorization', `Bearer ${token}`)
      .buffer()
      .parse((res2, callback) => {
        const chunks: Buffer[] = [];
        res2.on('data', (chunk: Buffer) => chunks.push(chunk));
        res2.on('end', () => callback(null, Buffer.concat(chunks)));
      });
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/gltf-binary/);
    expect(res.body).toEqual(glb);
  });

  it('refuses to read another user\'s model (403)', async () => {
    const tokenA = await register('alice@example.com');
    const myId = jwt.verify(tokenA, getJwtSecret()).sub as string;
    await request(app)
      .post(`/api/assets/${myId}`)
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ record: record(), glb: b64(glbPayload()) });

    const otherId = 'attacker-id';
    const res = await request(app)
      .get(`/api/assets/${otherId}/asset-1/model`)
      .set('Authorization', `Bearer ${tokenA}`);
    expect(res.status).toBe(403);
  });
});

describe('DELETE /api/assets/:userId/:id', () => {
  it('deletes the owner\'s own asset and its files', async () => {
    const token = await register('alice@example.com');
    const myId = jwt.verify(token, getJwtSecret()).sub as string;
    await request(app)
      .post(`/api/assets/${myId}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ record: record(), glb: b64(glbPayload()), source: b64(Buffer.from('src')) });

    expect(readdirSync(join(assetRoot, myId))).toContain('asset-1.glb');

    const del = await request(app).delete(`/api/assets/${myId}/asset-1`).set('Authorization', `Bearer ${token}`);
    expect(del.status).toBe(204);

    const list = await request(app).get(`/api/assets/${myId}`).set('Authorization', `Bearer ${token}`);
    expect(list.body.items).toEqual([]);
  });

  it('refuses to delete another user\'s asset (403)', async () => {
    const tokenA = await register('alice@example.com');
    const myId = jwt.verify(tokenA, getJwtSecret()).sub as string;
    await request(app)
      .post(`/api/assets/${myId}`)
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ record: record(), glb: b64(glbPayload()) });

    const attackerId = 'hacker';
    const res = await request(app)
      .delete(`/api/assets/${attackerId}/asset-1`)
      .set('Authorization', `Bearer ${tokenA}`);
    expect(res.status).toBe(403);
  });
});

describe('auth required on every asset route', () => {
  it('rejects unauthenticated requests with 401 on each endpoint', async () => {
    const list = await request(app).get('/api/assets/some-user');
    const upload = await request(app).post('/api/assets/some-user').send({ record: record(), glb: b64(glbPayload()) });
    const remove = await request(app).delete('/api/assets/some-user/asset-1');
    const model = await request(app).get('/api/assets/some-user/asset-1/model');

    expect(list.status).toBe(401);
    expect(upload.status).toBe(401);
    expect(remove.status).toBe(401);
    expect(model.status).toBe(401);
  });
});
