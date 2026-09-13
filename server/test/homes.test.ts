import request from 'supertest';
import jwt from 'jsonwebtoken';
import Database from 'better-sqlite3';
import type { Express } from 'express';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { getJwtSecret } from '../src/config.js';

process.env.JWT_SECRET = 'test-secret';

const HOME_JSON = JSON.stringify({ schemaVersion: 1, walls: [] });

let app: Express;
let db: Database.Database;
const openDbs: Database.Database[] = [];

beforeEach(() => {
  db = new Database(':memory:');
  openDbs.push(db);
  app = createApp(db, 'data/assets');
});

afterEach(() => {
  for (const d of openDbs.splice(0)) d.close();
});

async function register(email: string) {
  const res = await request(app).post('/api/auth/register').send({ email, password: 'password123' });
  return res.body.token as string;
}

const userId = (token: string) => jwt.verify(token, getJwtSecret()).sub as string;

describe('POST /api/homes', () => {
  it('creates a home owned by the authenticated user', async () => {
    const token = await register('alice@example.com');

    const res = await request(app)
      .post('/api/homes')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'My House', json: HOME_JSON });

    expect(res.status).toBe(201);
    expect(res.body.name).toBe('My House');
    expect(res.body.json).toBe(HOME_JSON);
    expect(res.body.ownerUserId).toBeUndefined();
    expect(res.body.id).toBeTruthy();
  });

  it('requires json and returns 400 when missing', async () => {
    const token = await register('bob@example.com');

    const res = await request(app).post('/api/homes').set('Authorization', `Bearer ${token}`).send({ name: 'No json' });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/json/i);
  });
});

describe('GET /api/homes (list)', () => {
  it('lists only the authenticated user\'s own homes', async () => {
    const tokenA = await register('alice@example.com');
    const tokenB = await register('bob@example.com');

    await request(app)
      .post('/api/homes')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ name: 'A house', json: HOME_JSON });
    await request(app)
      .post('/api/homes')
      .set('Authorization', `Bearer ${tokenB}`)
      .send({ name: 'B house', json: HOME_JSON });

    const mine = await request(app).get('/api/homes').set('Authorization', `Bearer ${tokenA}`);
    expect(mine.status).toBe(200);
    expect(mine.body.items.map((h: { name: string }) => h.name)).toEqual(['A house']);
  });
});

describe('GET /api/homes/:id', () => {
  it('loads a home the user owns', async () => {
    const token = await register('alice@example.com');
    const created = await request(app)
      .post('/api/homes')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Home', json: HOME_JSON });

    const res = await request(app)
      .get(`/api/homes/${created.body.id}`)
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.json).toBe(HOME_JSON);
    expect(res.body.name).toBe('Home');
  });

  it('returns 403 for a home owned by another user', async () => {
    const tokenA = await register('alice@example.com');
    const tokenB = await register('bob@example.com');
    const created = await request(app)
      .post('/api/homes')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ name: 'A secret', json: HOME_JSON });

    const res = await request(app)
      .get(`/api/homes/${created.body.id}`)
      .set('Authorization', `Bearer ${tokenB}`);
    expect(res.status).toBe(403);
  });
});

describe('PUT /api/homes/:id', () => {
  it('updates a home the user owns', async () => {
    const token = await register('alice@example.com');
    const created = await request(app)
      .post('/api/homes')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Before', json: HOME_JSON });

    const updatedJson = JSON.stringify({ schemaVersion: 1, walls: [{ id: 'w1' }] });
    const res = await request(app)
      .put(`/api/homes/${created.body.id}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'After', json: updatedJson });

    expect(res.status).toBe(200);
    expect(res.body.name).toBe('After');
    expect(res.body.json).toBe(updatedJson);
  });

  it('returns 403 when updating another user\'s home', async () => {
    const tokenA = await register('alice@example.com');
    const tokenB = await register('bob@example.com');
    const created = await request(app)
      .post('/api/homes')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ name: 'A secret', json: HOME_JSON });

    const res = await request(app)
      .put(`/api/homes/${created.body.id}`)
      .set('Authorization', `Bearer ${tokenB}`)
      .send({ name: 'hacked', json: HOME_JSON });
    expect(res.status).toBe(403);
  });
});

describe('DELETE /api/homes/:id', () => {
  it('deletes a home the user owns', async () => {
    const token = await register('alice@example.com');
    const created = await request(app)
      .post('/api/homes')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Home', json: HOME_JSON });

    const del = await request(app)
      .delete(`/api/homes/${created.body.id}`)
      .set('Authorization', `Bearer ${token}`);
    expect(del.status).toBe(204);

    const list = await request(app).get('/api/homes').set('Authorization', `Bearer ${token}`);
    expect(list.body.items).toEqual([]);
  });

  it('returns 403 when deleting another user\'s home', async () => {
    const tokenA = await register('alice@example.com');
    const tokenB = await register('bob@example.com');
    const created = await request(app)
      .post('/api/homes')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ name: 'A secret', json: HOME_JSON });

    const res = await request(app)
      .delete(`/api/homes/${created.body.id}`)
      .set('Authorization', `Bearer ${tokenB}`);
    expect(res.status).toBe(403);
  });
});

describe('auth required on every home route', () => {
  it('rejects unauthenticated requests with 401 on each endpoint', async () => {
    const list = await request(app).get('/api/homes');
    const get = await request(app).get('/api/homes/abc');
    const create = await request(app).post('/api/homes').send({ name: 'X', json: HOME_JSON });
    const update = await request(app).put('/api/homes/abc').send({ name: 'X', json: HOME_JSON });
    const remove = await request(app).delete('/api/homes/abc');

    expect(list.status).toBe(401);
    expect(get.status).toBe(401);
    expect(create.status).toBe(401);
    expect(update.status).toBe(401);
    expect(remove.status).toBe(401);
  });
});
