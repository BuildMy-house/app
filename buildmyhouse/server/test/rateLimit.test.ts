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
import { ASSETS_RATE_LIMIT, HOMES_RATE_LIMIT, TEAMS_RATE_LIMIT } from '../src/rateLimit.js';

process.env.JWT_SECRET = 'test-secret';

let app: Express;
let db: Database.Database;
let assetRoot: string;
const openDbs: Database.Database[] = [];

beforeEach(async () => {
  assetRoot = mkdtempSync(join(tmpdir(), 'homely-ratelimit-'));
  db = new Database(':memory:');
  openDbs.push(db);
  app = await createApp(db, assetRoot);
});

afterEach(() => {
  for (const d of openDbs.splice(0)) d.close();
  rmSync(assetRoot, { recursive: true, force: true });
});

async function register(email: string): Promise<{ token: string; userId: string }> {
  const res = await request(app).post('/api/auth/register').send({ email, password: 'password123' });
  const token = res.body.token as string;
  return { token, userId: jwt.verify(token, getJwtSecret()).sub as string };
}

/**
 * Fire `count` requests, returning the responses. Chunked (not one giant
 * Promise.all) so hundreds of concurrent in-process sockets can't trip
 * ephemeral connection flakiness. Uses GET / (cheapest route) on each router;
 * the limiter counts every method on the router equally.
 */
async function hammer(
  fn: () => Promise<request.Response>,
  count: number,
): Promise<request.Response[]> {
  const responses: request.Response[] = [];
  for (let i = 0; i < count; i += 50) {
    const batch = Array.from({ length: Math.min(50, count - i) }, fn);
    responses.push(...(await Promise.all(batch)));
  }
  return responses;
}

describe('per-user rate limiting', () => {
  it(
    'homes: returns 429 once the per-user budget is exhausted',
    { timeout: 60_000 },
    async () => {
      const { token } = await register('rl-homes@example.com');
      const get = () => request(app).get('/api/homes').set('Authorization', `Bearer ${token}`);

      const responses = await hammer(get, HOMES_RATE_LIMIT.max);
      expect(responses.every((r) => r.status === 200)).toBe(true);

      const blocked = await get();
      expect(blocked.status).toBe(429);
      // Quota is per-user: nobody else's budget moved.
      const other = await register('rl-homes-other@example.com');
      const notBlocked = await request(app)
        .get('/api/homes')
        .set('Authorization', `Bearer ${other.token}`);
      expect(notBlocked.status).toBe(200);
    },
  );

  it(
    'assets: returns 429 once the per-user budget is exhausted',
    { timeout: 60_000 },
    async () => {
      const { token, userId } = await register('rl-assets@example.com');
      const get = () =>
        request(app).get(`/api/assets/${userId}`).set('Authorization', `Bearer ${token}`);

      const responses = await hammer(get, ASSETS_RATE_LIMIT.max);
      expect(responses.every((r) => r.status === 200)).toBe(true);

      const blocked = await get();
      expect(blocked.status).toBe(429);
    },
  );

  it(
    'teams: returns 429 once the per-user budget is exhausted',
    { timeout: 60_000 },
    async () => {
      const { token } = await register('rl-teams@example.com');
      const get = () => request(app).get('/api/teams').set('Authorization', `Bearer ${token}`);

      const responses = await hammer(get, TEAMS_RATE_LIMIT.max);
      expect(responses.every((r) => r.status === 200)).toBe(true);

      const blocked = await get();
      expect(blocked.status).toBe(429);
    },
  );

  it(
    'exhausting one router does not affect the others for the same user',
    { timeout: 60_000 },
    async () => {
      const { token, userId } = await register('rl-isolation@example.com');

      // Burn the assets budget (smallest of the three — fastest to exhaust).
      const assetsGet = () =>
        request(app).get(`/api/assets/${userId}`).set('Authorization', `Bearer ${token}`);
      const responses = await hammer(assetsGet, ASSETS_RATE_LIMIT.max);
      expect(responses.every((r) => r.status === 200)).toBe(true);
      expect((await assetsGet()).status).toBe(429);

      // Same user, other routers: untouched budgets, still 200.
      const homesRes = await request(app).get('/api/homes').set('Authorization', `Bearer ${token}`);
      expect(homesRes.status).toBe(200);
      const teamsRes = await request(app).get('/api/teams').set('Authorization', `Bearer ${token}`);
      expect(teamsRes.status).toBe(200);
    },
  );
});
