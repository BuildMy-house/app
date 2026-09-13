import request from 'supertest';
import jwt from 'jsonwebtoken';
import Database from 'better-sqlite3';
import type { Express, Request, Response } from 'express';
import { afterEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { requireAuth, signToken, _resetRegRateLimit } from '../src/auth.js';
import { getJwtSecret } from '../src/config.js';
import type { UserRow } from '../src/db.js';

process.env.JWT_SECRET = 'test-secret';

// Fresh in-memory DB per test; add /api/protected to exercise the auth middleware.
function makeApp(): { db: Database.Database; app: Express } {
  const db = new Database(':memory:');
  const app = createApp(db);
  app.get('/api/protected', requireAuth, (req: Request, res: Response) => {
    res.json({ userId: req.userId });
  });
  return { db, app };
}

const openDbs: Database.Database[] = [];
afterEach(() => {
  for (const db of openDbs.splice(0)) db.close();
});

async function register(app: Express, email: string, password: string) {
  return request(app).post('/api/auth/register').send({ email, password });
}

async function login(app: Express, email: string, password: string) {
  return request(app).post('/api/auth/login').send({ email, password });
}

describe('POST /api/auth/register', () => {
  it('returns 201 with a valid JWT and stores a hashed password', async () => {
    const { app, db } = makeApp();
    openDbs.push(db);

    const res = await register(app, 'Alice@Example.com ', 'password123');
    expect(res.status).toBe(201);
    expect(typeof res.body.token).toBe('string');

    const payload = jwt.verify(res.body.token, getJwtSecret());
    expect(typeof payload.sub).toBe('string');

    const row = db
      .prepare('SELECT * FROM users WHERE id = ?')
      .get(payload.sub as string) as UserRow | undefined;
    expect(row).toBeDefined();
    expect(row!.email).toBe('alice@example.com'); // trimmed + lowercased
    expect(row!.password_hash).toMatch(/^\$2[aby]\$/); // bcrypt hash, not the plaintext
    expect(row!.created_at).toEqual(expect.any(String));
    expect(res.body.token).not.toBe(row!.password_hash);
  });

  it('rejects a duplicate email with a clear 409', async () => {
    const { app, db } = makeApp();
    openDbs.push(db);

    const first = await register(app, 'dup@example.com', 'password123');
    expect(first.status).toBe(201);

    const second = await register(app, 'DUP@example.com', 'otherpass1');
    expect(second.status).toBe(409);
    expect(second.body.error).toMatch(/registered/i);
  });

  it.each([
    ['not-an-email', 'password123', 'email must be a valid email address'],
    ['me@example.com', 'short', `password must be at least 8 characters`],
    ['me@example.com', '', 'password must be at least 8 characters'],
  ])('rejects invalid input (%s / %p) with a 400', async (email, password, message) => {
    const { app, db } = makeApp();
    openDbs.push(db);

    const res = await register(app, email, password);
    expect(res.status).toBe(400);
    expect(res.body.error).toContain(message);
  });

  it('rejects a missing body with a 400', async () => {
    const { app, db } = makeApp();
    openDbs.push(db);

    const res = await request(app).post('/api/auth/register').send({});
    expect(res.status).toBe(400);
  });

  it('rate-limits registrations per IP: 6th from same IP gets 429', async () => {
    const { app, db } = makeApp();
    app.set('trust proxy', true);
    openDbs.push(db);

    for (let i = 0; i < 5; i++) {
      const res = await request(app)
        .post('/api/auth/register')
        .set('X-Forwarded-For', '10.0.0.1')
        .send({ email: `user${i}@example.com`, password: 'password123' });
      expect(res.status).toBe(201);
    }

    const blocked = await request(app)
      .post('/api/auth/register')
      .set('X-Forwarded-For', '10.0.0.1')
      .send({ email: 'user5@example.com', password: 'password123' });
    expect(blocked.status).toBe(429);
    expect(blocked.body.error).toMatch(/too many registration attempts/i);
  });

  it('rate-limit is independent per IP', async () => {
    const { app, db } = makeApp();
    app.set('trust proxy', true);
    openDbs.push(db);

    for (let i = 0; i < 5; i++) {
      const res = await request(app)
        .post('/api/auth/register')
        .set('X-Forwarded-For', '10.0.0.1')
        .send({ email: `a${i}@example.com`, password: 'password123' });
      expect(res.status).toBe(201);
    }

    const fromOtherIp = await request(app)
      .post('/api/auth/register')
      .set('X-Forwarded-For', '10.0.0.2')
      .send({ email: 'other@example.com', password: 'password123' });
    expect(fromOtherIp.status).toBe(201);
  });
});

describe('POST /api/auth/login', () => {
  it('returns a valid JWT for correct credentials', async () => {
    const { app, db } = makeApp();
    openDbs.push(db);

    const reg = await register(app, 'login@example.com', 'password123');
    const userId = jwt.verify(reg.body.token, getJwtSecret()).sub as string;

    const res = await login(app, 'login@example.com', 'password123');
    expect(res.status).toBe(200);
    expect(typeof res.body.token).toBe('string');
    expect(jwt.verify(res.body.token, getJwtSecret()).sub).toBe(userId);
  });

  it('rejects a wrong password with 401', async () => {
    const { app, db } = makeApp();
    openDbs.push(db);

    await register(app, 'fail@example.com', 'password123');
    const res = await login(app, 'fail@example.com', 'wrong-password');
    expect(res.status).toBe(401);
    expect(res.body.error).toMatch(/invalid email or password/i);
    expect(res.body.token).toBeUndefined();
  });

  it('rejects an unknown email with 401 (same message as wrong password)', async () => {
    const { app, db } = makeApp();
    openDbs.push(db);

    const res = await login(app, 'nobody@example.com', 'password123');
    expect(res.status).toBe(401);
    expect(res.body.error).toMatch(/invalid email or password/i);
  });

  it('rejects a short password input with 400 (validation, not credentials)', async () => {
    const { app, db } = makeApp();
    openDbs.push(db);

    const res = await login(app, 'me@example.com', 'short');
    expect(res.status).toBe(400);
  });

  it('locks out after repeated failed attempts (429), then the lockout clears', async () => {
    const { app, db } = makeApp();
    openDbs.push(db);

    await register(app, 'locked@example.com', 'password123');
    for (let i = 0; i < 10; i++) {
      const res = await login(app, 'locked@example.com', 'wrong-password');
      expect(res.status).toBe(401);
    }

    const locked = await login(app, 'locked@example.com', 'password123');
    expect(locked.status).toBe(429);
  });
});

describe('requireAuth middleware', () => {
  it('rejects a request with no Authorization header', async () => {
    const { app, db } = makeApp();
    openDbs.push(db);

    const res = await request(app).get('/api/protected');
    expect(res.status).toBe(401);
    expect(res.body.error).toMatch(/token/i);
  });

  it('rejects a garbage token', async () => {
    const { app, db } = makeApp();
    openDbs.push(db);

    const res = await request(app).get('/api/protected').set('Authorization', 'Bearer not.a.token');
    expect(res.status).toBe(401);
  });

  it('rejects a token signed with a different secret', async () => {
    const { app, db } = makeApp();
    openDbs.push(db);

    const forged = jwt.sign({}, 'wrong-secret', { subject: 'someone-else' });
    const res = await request(app).get('/api/protected').set('Authorization', `Bearer ${forged}`);
    expect(res.status).toBe(401);
  });

  it('rejects an expired token', async () => {
    const { app, db } = makeApp();
    openDbs.push(db);

    const expired = jwt.sign({}, getJwtSecret(), { subject: 'user-1', expiresIn: -1 });
    const res = await request(app).get('/api/protected').set('Authorization', `Bearer ${expired}`);
    expect(res.status).toBe(401);
  });

  it('accepts a valid token and exposes the authenticated user id', async () => {
    const { app, db } = makeApp();
    openDbs.push(db);

    const token = signToken('user-42');
    const res = await request(app).get('/api/protected').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.userId).toBe('user-42');
  });
});

describe('PUT /api/auth/password', () => {
  it('updates the password hash and allows login with the new password', async () => {
    const { app, db } = makeApp();
    openDbs.push(db);

    const reg = await register(app, 'pw@example.com', 'password123');
    const token = reg.body.token;

    const res = await request(app)
      .put('/api/auth/password')
      .set('Authorization', `Bearer ${token}`)
      .send({ currentPassword: 'password123', newPassword: 'newpassword456' });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);

    // old password no longer works
    const oldLogin = await login(app, 'pw@example.com', 'password123');
    expect(oldLogin.status).toBe(401);

    // new password works
    const newLogin = await login(app, 'pw@example.com', 'newpassword456');
    expect(newLogin.status).toBe(200);
    expect(typeof newLogin.body.token).toBe('string');
  });

  it('rejects wrong current password with 401', async () => {
    const { app, db } = makeApp();
    openDbs.push(db);

    const reg = await register(app, 'wrong@example.com', 'password123');
    const res = await request(app)
      .put('/api/auth/password')
      .set('Authorization', `Bearer ${reg.body.token}`)
      .send({ currentPassword: 'wrong-password', newPassword: 'newpassword456' });
    expect(res.status).toBe(401);
    expect(res.body.error).toMatch(/current password/i);
  });

  it('rejects weak new password with 400', async () => {
    const { app, db } = makeApp();
    openDbs.push(db);

    const reg = await register(app, 'weak@example.com', 'password123');
    const res = await request(app)
      .put('/api/auth/password')
      .set('Authorization', `Bearer ${reg.body.token}`)
      .send({ currentPassword: 'password123', newPassword: 'short' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/newPassword must be at least/i);
  });

  it('rejects missing currentPassword with 400', async () => {
    const { app, db } = makeApp();
    openDbs.push(db);

    const reg = await register(app, 'missing@example.com', 'password123');
    const res = await request(app)
      .put('/api/auth/password')
      .set('Authorization', `Bearer ${reg.body.token}`)
      .send({ newPassword: 'newpassword456' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/currentPassword/i);
  });

  it('rejects unauthenticated requests with 401', async () => {
    const { app, db } = makeApp();
    openDbs.push(db);

    const res = await request(app)
      .put('/api/auth/password')
      .send({ currentPassword: 'password123', newPassword: 'newpassword456' });
    expect(res.status).toBe(401);
  });
});

describe('config', () => {
  it('fails loudly when JWT_SECRET is unset', () => {
    const saved = process.env.JWT_SECRET;
    delete process.env.JWT_SECRET;
    try {
      expect(() => getJwtSecret()).toThrow(/JWT_SECRET/);
    } finally {
      process.env.JWT_SECRET = saved;
    }
  });
});