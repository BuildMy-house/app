import request from 'supertest';
import jwt from 'jsonwebtoken';
import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import type { Express, Request, Response } from 'express';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app.js';
import { requireAuth, _resetEmailRateLimits } from '../src/auth.js';
import { sendEmail, getAppBaseUrl } from '../src/email.js';
import { getJwtSecret } from '../src/config.js';

process.env.JWT_SECRET = 'test-secret';

// The /request endpoints respond first and deliver email in the background, so
// tests poll for the DB row / console output with vi.waitFor.
async function makeApp(): Promise<{ db: Database.Database; app: Express }> {
  const db = new Database(':memory:');
  const app = await createApp(db);
  app.get('/api/protected', requireAuth, (req: Request, res: Response) => {
    res.json({ userId: req.userId });
  });
  return { db, app };
}

const openDbs: Database.Database[] = [];
afterEach(() => {
  for (const db of openDbs.splice(0)) db.close();
});

beforeEach(() => {
  _resetEmailRateLimits();
});

async function register(app: Express, email: string, password: string) {
  return request(app).post('/api/auth/register').send({ email, password });
}

function waitForTokenRow(db: Database.Database, table: string): Promise<Record<string, unknown>> {
  return vi.waitFor(() => {
    const row = db.prepare(`SELECT * FROM ${table} LIMIT 1`).get() as Record<string, unknown> | undefined;
    expect(row).toBeDefined();
    return row as Record<string, unknown>;
  });
}

describe('sendEmail', () => {
  it('logs full content with [email:dev-fallback] when RESEND_API_KEY is unset', async () => {
    delete process.env.RESEND_API_KEY;
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      await sendEmail({ to: 'a@b.com', subject: 'Hi', html: '<p>link here</p>' });
      expect(logSpy).toHaveBeenCalledTimes(1);
      const logged = logSpy.mock.calls[0]![0] as string;
      expect(logged).toContain('[email:dev-fallback]');
      expect(logged).toContain('a@b.com');
      expect(logged).toContain('Hi');
      expect(logged).toContain('link here');
    } finally {
      logSpy.mockRestore();
    }
  });

  it('throws explicitly when RESEND_API_KEY is set but RESEND_FROM_EMAIL is missing', async () => {
    process.env.RESEND_API_KEY = 're_test_key';
    delete process.env.RESEND_FROM_EMAIL;
    try {
      await expect(sendEmail({ to: 'a@b.com', subject: 'Hi', html: '<p>x</p>' })).rejects.toThrow(
        /RESEND_FROM_EMAIL/,
      );
    } finally {
      delete process.env.RESEND_API_KEY;
    }
  });

  it('getAppBaseUrl defaults to http://localhost:3000', () => {
    const saved = process.env.APP_BASE_URL;
    delete process.env.APP_BASE_URL;
    try {
      expect(getAppBaseUrl()).toBe('http://localhost:3000');
    } finally {
      if (saved !== undefined) process.env.APP_BASE_URL = saved;
    }
  });
});

describe('POST /api/auth/password-reset/request', () => {
  it('responds 202 identically for existing and non-existing emails (enumeration resistance)', async () => {
    const { app, db } = await makeApp();
    openDbs.push(db);
    await register(app, 'exists@example.com', 'password123');

    const existing = await request(app)
      .post('/api/auth/password-reset/request')
      .send({ email: 'exists@example.com' });
    const missing = await request(app)
      .post('/api/auth/password-reset/request')
      .send({ email: 'nobody@example.com' });

    expect(existing.status).toBe(202);
    expect(missing.status).toBe(202);
    expect(missing.body).toEqual(existing.body);
    expect(existing.body.ok).toBe(true);
  });

  it('rejects a malformed email with 400', async () => {
    const { app, db } = await makeApp();
    openDbs.push(db);
    const res = await request(app).post('/api/auth/password-reset/request').send({ email: 'not-an-email' });
    expect(res.status).toBe(400);
  });

  it('creates a 1h token and emails the reset link (dev fallback logs it)', async () => {
    const { app, db } = await makeApp();
    openDbs.push(db);
    await register(app, 'resetme@example.com', 'password123');
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const res = await request(app)
      .post('/api/auth/password-reset/request')
      .send({ email: 'RESETme@Example.com' });
    expect(res.status).toBe(202);

    const row = await waitForTokenRow(db, 'password_reset_tokens');
    expect(row.user_id).toBeDefined();
    expect(String(row.token)).toMatch(/^[0-9a-f]{64}$/); // 256-bit hex, not guessable
    const createdMs = new Date(row.created_at as string).getTime();
    const expiresMs = new Date(row.expires_at as string).getTime();
    expect(expiresMs - createdMs).toBe(60 * 60 * 1000);
    expect(row.used_at).toBeNull();

    await vi.waitFor(() => expect(logSpy).toHaveBeenCalled());
    const logged = logSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(logged).toContain('[email:dev-fallback]');
    expect(logged).toContain(`/reset-password?token=${row.token}`);
    logSpy.mockRestore();
  });

  it('rate-limits per IP: 6th request gets 429, other IPs unaffected', async () => {
    const { app, db } = await makeApp();
    app.set('trust proxy', true);
    openDbs.push(db);

    for (let i = 0; i < 5; i++) {
      const res = await request(app)
        .post('/api/auth/password-reset/request')
        .set('X-Forwarded-For', '10.9.0.1')
        .send({ email: `user${i}@example.com` });
      expect(res.status).toBe(202);
    }
    const blocked = await request(app)
      .post('/api/auth/password-reset/request')
      .set('X-Forwarded-For', '10.9.0.1')
      .send({ email: 'user5@example.com' });
    expect(blocked.status).toBe(429);

    const otherIp = await request(app)
      .post('/api/auth/password-reset/request')
      .set('X-Forwarded-For', '10.9.0.2')
      .send({ email: 'other@example.com' });
    expect(otherIp.status).toBe(202);
  });
});

describe('POST /api/auth/password-reset/confirm', () => {
  async function requestReset(app: Express, db: Database.Database, email: string): Promise<string> {
    await request(app).post('/api/auth/password-reset/request').send({ email });
    const row = await waitForTokenRow(db, 'password_reset_tokens');
    return row.token as string;
  }

  it('resets the password: new password logs in, old one does not', async () => {
    const { app, db } = await makeApp();
    openDbs.push(db);
    await register(app, 'flow@example.com', 'password123');
    const token = await requestReset(app, db, 'flow@example.com');

    const confirm = await request(app)
      .post('/api/auth/password-reset/confirm')
      .send({ token, newPassword: 'brandnewpass1' });
    expect(confirm.status).toBe(200);
    expect(confirm.body.ok).toBe(true);

    const oldLogin = await request(app)
      .post('/api/auth/login')
      .send({ email: 'flow@example.com', password: 'password123' });
    expect(oldLogin.status).toBe(401);

    const newLogin = await request(app)
      .post('/api/auth/login')
      .send({ email: 'flow@example.com', password: 'brandnewpass1' });
    expect(newLogin.status).toBe(200);
    expect(typeof newLogin.body.token).toBe('string');
  });

  it('rejects token reuse after a successful reset', async () => {
    const { app, db } = await makeApp();
    openDbs.push(db);
    await register(app, 'reuse@example.com', 'password123');
    const token = await requestReset(app, db, 'reuse@example.com');

    const first = await request(app)
      .post('/api/auth/password-reset/confirm')
      .send({ token, newPassword: 'brandnewpass1' });
    expect(first.status).toBe(200);

    const second = await request(app)
      .post('/api/auth/password-reset/confirm')
      .send({ token, newPassword: 'anotherpass99' });
    expect(second.status).toBe(400);
  });

  it('rejects an expired token', async () => {
    const { app, db } = await makeApp();
    openDbs.push(db);
    const reg = await register(app, 'expired@example.com', 'password123');
    const userId = jwt.verify(reg.body.token, getJwtSecret()).sub as string;
    db.prepare(
      `INSERT INTO password_reset_tokens (id, user_id, token, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(
      randomUUID(),
      userId,
      'a'.repeat(64),
      new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
      new Date(Date.now() - 60 * 60 * 1000).toISOString(),
    );

    const res = await request(app)
      .post('/api/auth/password-reset/confirm')
      .send({ token: 'a'.repeat(64), newPassword: 'brandnewpass1' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/invalid|expired|used/i);
  });

  it('rejects an unknown token and a short newPassword with 400', async () => {
    const { app, db } = await makeApp();
    openDbs.push(db);

    const unknown = await request(app)
      .post('/api/auth/password-reset/confirm')
      .send({ token: 'f'.repeat(64), newPassword: 'brandnewpass1' });
    expect(unknown.status).toBe(400);

    await register(app, 'short@example.com', 'password123');
    const token = await requestReset(app, db, 'short@example.com');
    const weak = await request(app)
      .post('/api/auth/password-reset/confirm')
      .send({ token, newPassword: 'short' });
    expect(weak.status).toBe(400);
    // token not consumed by the failed attempt
    const afterWeak = await request(app)
      .post('/api/auth/password-reset/confirm')
      .send({ token, newPassword: 'brandnewpass1' });
    expect(afterWeak.status).toBe(200);
  });
});

describe('POST /api/auth/magic-link/request + consume', () => {
  it('responds 202 identically for existing and non-existing emails (enumeration resistance)', async () => {
    const { app, db } = await makeApp();
    openDbs.push(db);
    await register(app, 'magic@example.com', 'password123');

    const existing = await request(app).post('/api/auth/magic-link/request').send({ email: 'magic@example.com' });
    const missing = await request(app).post('/api/auth/magic-link/request').send({ email: 'ghost@example.com' });

    expect(existing.status).toBe(202);
    expect(missing.status).toBe(202);
    expect(missing.body).toEqual(existing.body);
  });

  it('emails a login link; consume returns a JWT that works on a protected route', async () => {
    const { app, db } = await makeApp();
    openDbs.push(db);
    const reg = await register(app, 'magiclogin@example.com', 'password123');
    const userId = jwt.verify(reg.body.token, getJwtSecret()).sub as string;

    const res = await request(app).post('/api/auth/magic-link/request').send({ email: 'magiclogin@example.com' });
    expect(res.status).toBe(202);

    const row = await waitForTokenRow(db, 'magic_link_tokens');
    expect(row.email).toBe('magiclogin@example.com');
    const createdMs = new Date(row.created_at as string).getTime();
    expect(new Date(row.expires_at as string).getTime() - createdMs).toBe(15 * 60 * 1000);

    const consume = await request(app).post('/api/auth/magic-link/consume').send({ token: row.token });
    expect(consume.status).toBe(200);
    expect(jwt.verify(consume.body.token, getJwtSecret()).sub).toBe(userId);

    // The JWT behaves exactly like a login-issued one.
    const me = await request(app).get('/api/auth/me').set('Authorization', `Bearer ${consume.body.token}`);
    expect(me.status).toBe(200);
    expect(me.body.email).toBe('magiclogin@example.com');
  });

  it('rejects reuse of a consumed token', async () => {
    const { app, db } = await makeApp();
    openDbs.push(db);
    await register(app, 'onetime@example.com', 'password123');
    await request(app).post('/api/auth/magic-link/request').send({ email: 'onetime@example.com' });
    const row = await waitForTokenRow(db, 'magic_link_tokens');

    const first = await request(app).post('/api/auth/magic-link/consume').send({ token: row.token });
    expect(first.status).toBe(200);

    const second = await request(app).post('/api/auth/magic-link/consume').send({ token: row.token });
    expect(second.status).toBe(400);
  });

  it('rejects an expired token and an unknown token', async () => {
    const { app, db } = await makeApp();
    openDbs.push(db);
    db.prepare(
      `INSERT INTO magic_link_tokens (id, email, token, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(
      randomUUID(),
      'stale@example.com',
      'b'.repeat(64),
      new Date(Date.now() - 30 * 60 * 1000).toISOString(),
      new Date(Date.now() - 15 * 60 * 1000).toISOString(),
    );

    const expired = await request(app).post('/api/auth/magic-link/consume').send({ token: 'b'.repeat(64) });
    expect(expired.status).toBe(400);

    const unknown = await request(app).post('/api/auth/magic-link/consume').send({ token: 'c'.repeat(64) });
    expect(unknown.status).toBe(400);
  });

  it('rate-limits magic-link requests per IP', async () => {
    const { app, db } = await makeApp();
    app.set('trust proxy', true);
    openDbs.push(db);

    for (let i = 0; i < 5; i++) {
      const res = await request(app)
        .post('/api/auth/magic-link/request')
        .set('X-Forwarded-For', '10.9.1.1')
        .send({ email: `m${i}@example.com` });
      expect(res.status).toBe(202);
    }
    const blocked = await request(app)
      .post('/api/auth/magic-link/request')
      .set('X-Forwarded-For', '10.9.1.1')
      .send({ email: 'm5@example.com' });
    expect(blocked.status).toBe(429);
  });
});

describe('GET /api/auth/me', () => {
  it('returns id, email, createdAt for the authenticated user', async () => {
    const { app, db } = await makeApp();
    openDbs.push(db);
    const reg = await register(app, 'Me@Example.com', 'password123');
    const userId = jwt.verify(reg.body.token, getJwtSecret()).sub as string;

    const res = await request(app).get('/api/auth/me').set('Authorization', `Bearer ${reg.body.token}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ id: userId, email: 'me@example.com', name: null, createdAt: expect.any(String) });
  });

  it('rejects unauthenticated requests with 401', async () => {
    const { app, db } = await makeApp();
    openDbs.push(db);
    const res = await request(app).get('/api/auth/me');
    expect(res.status).toBe(401);
  });
});
