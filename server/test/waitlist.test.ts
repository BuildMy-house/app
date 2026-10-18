import request from 'supertest';
import jwt from 'jsonwebtoken';
import Database from 'better-sqlite3';
import type { Express } from 'express';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { getJwtSecret } from '../src/config.js';

process.env.JWT_SECRET = 'test-secret';

let app: Express;
let db: Database.Database;
const openDbs: Database.Database[] = [];

beforeEach(async () => {
  db = new Database(':memory:');
  openDbs.push(db);
  app = await createApp(db, 'data/assets');
});

afterEach(() => {
  for (const d of openDbs.splice(0)) d.close();
});

async function register(email: string) {
  const res = await request(app).post('/api/auth/register').send({ email, password: 'password123' });
  return res.body.token as string;
}

const userId = (token: string) => jwt.verify(token, getJwtSecret()).sub as string;

describe('POST /api/waitlist', () => {
  it('requires auth', async () => {
    const res = await request(app).post('/api/waitlist').send({ source: 'pricing' });
    expect(res.status).toBe(401);
  });

  it('joins with alreadyJoined false', async () => {
    const token = await register('alice@example.com');
    const res = await request(app)
      .post('/api/waitlist')
      .set('Authorization', `Bearer ${token}`)
      .send({ source: 'pricing' });

    expect(res.status).toBe(200);
    expect(res.body.joined).toBe(true);
    expect(res.body.alreadyJoined).toBe(false);
    expect(typeof res.body.createdAt).toBe('string');
  });

  it('is idempotent: second join returns alreadyJoined true and keeps exactly one row', async () => {
    const token = await register('alice@example.com');
    const first = await request(app)
      .post('/api/waitlist')
      .set('Authorization', `Bearer ${token}`)
      .send({});
    const second = await request(app)
      .post('/api/waitlist')
      .set('Authorization', `Bearer ${token}`)
      .send({ source: 'landing' });

    expect(first.body.alreadyJoined).toBe(false);
    expect(second.status).toBe(200);
    expect(second.body.alreadyJoined).toBe(true);
    expect(second.body.createdAt).toBe(first.body.createdAt);

    const count = db.prepare('SELECT COUNT(*) AS cnt FROM waitlist WHERE user_id = ?').get(userId(token)) as { cnt: number };
    expect(count.cnt).toBe(1);
  });

  it('rejects invalid source with 400', async () => {
    const token = await register('alice@example.com');
    for (const source of ['', 'a'.repeat(41), 'has space', 'UPPERCASE', 'no&special']) {
      const res = await request(app)
        .post('/api/waitlist')
        .set('Authorization', `Bearer ${token}`)
        .send({ source });
      expect(res.status).toBe(400);
    }
  });
});

describe('GET /api/waitlist/me', () => {
  it('requires auth', async () => {
    const res = await request(app).get('/api/waitlist/me');
    expect(res.status).toBe(401);
  });

  it('returns joined false before joining', async () => {
    const token = await register('alice@example.com');
    const res = await request(app).get('/api/waitlist/me').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ joined: false });
  });

  it('returns joined true with createdAt after joining', async () => {
    const token = await register('alice@example.com');
    const join = await request(app)
      .post('/api/waitlist')
      .set('Authorization', `Bearer ${token}`)
      .send({});
    const res = await request(app).get('/api/waitlist/me').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ joined: true, createdAt: join.body.createdAt });
  });
});
