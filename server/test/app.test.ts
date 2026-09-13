import request from 'supertest';
import express from 'express';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Express } from 'express';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp, errorHandler } from '../src/app.js';

process.env.JWT_SECRET = 'test-secret';

let app: Express;
let db: Database.Database;
let assetRoot: string;

const ENV_KEYS = ['CORS_ALLOWED_ORIGINS', 'NODE_ENV'] as const;
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
  delete process.env.CORS_ALLOWED_ORIGINS;
  assetRoot = mkdtempSync(join(tmpdir(), 'homely-app-'));
  db = new Database(':memory:');
});

afterEach(async () => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  vi.restoreAllMocks();
  db.close();
  rmSync(assetRoot, { recursive: true, force: true });
});

async function makeApp(): Promise<Express> {
  return createApp(db, assetRoot);
}

describe('helmet security headers', () => {
  it('sets helmet default headers on responses', async () => {
    app = await makeApp();
    const res = await request(app).get('/healthz');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['x-frame-options']).toBe('SAMEORIGIN');
    expect(res.headers['x-dns-prefetch-control']).toBe('off');
  });

  it('CSP is explicitly disabled (WebGL/3D SPA + textures), other headers stay on', async () => {
    app = await makeApp();
    const res = await request(app).get('/healthz');
    expect(res.headers['content-security-policy']).toBeUndefined();
    expect(res.headers['x-content-type-options']).toBe('nosniff');
  });
});

describe('GET /healthz', () => {
  it('returns 200 {ok: true} — pure liveness, no DB check', async () => {
    app = await makeApp();
    const res = await request(app).get('/healthz');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });
});

describe('CORS', () => {
  it('dev default (env unset, NODE_ENV != production) allows Vite/localhost origins', async () => {
    app = await makeApp();
    const res = await request(app).get('/healthz').set('Origin', 'http://localhost:5173');
    expect(res.headers['access-control-allow-origin']).toBe('http://localhost:5173');
    expect(res.headers['access-control-allow-credentials']).toBe('true');

    const res3000 = await request(app).get('/healthz').set('Origin', 'http://localhost:3000');
    expect(res3000.headers['access-control-allow-origin']).toBe('http://localhost:3000');
  });

  it('dev default rejects unknown origins (no ACAO header)', async () => {
    app = await makeApp();
    const res = await request(app).get('/healthz').set('Origin', 'http://evil.example.com');
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('explicit CORS_ALLOWED_ORIGINS takes priority over dev defaults', async () => {
    process.env.CORS_ALLOWED_ORIGINS = 'https://app.example.com, https://other.example.com';
    app = await makeApp();

    const allowed = await request(app).get('/healthz').set('Origin', 'https://other.example.com');
    expect(allowed.headers['access-control-allow-origin']).toBe('https://other.example.com');
    expect(allowed.headers['access-control-allow-credentials']).toBe('true');

    const notListed = await request(app).get('/healthz').set('Origin', 'http://localhost:5173');
    expect(notListed.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('production with env unset allows NO cross-origin requests', async () => {
    process.env.NODE_ENV = 'production';
    app = await makeApp();

    for (const origin of ['https://app.example.com', 'http://localhost:5173']) {
      const res = await request(app).get('/healthz').set('Origin', origin);
      expect(res.headers['access-control-allow-origin']).toBeUndefined();
    }
  });
});

describe('centralized error handler', () => {
  it('returns generic 500 and never leaks internal detail (forced thrown error)', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const probe = express();
    probe.get('/boom', () => {
      throw new Error('SECRET: db password hunter2, stack trace detail');
    });
    probe.use(errorHandler);

    const res = await request(probe).get('/boom');
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'internal server error' });
    expect(res.text).not.toContain('SECRET');
    expect(res.text).not.toContain('hunter2');
    // full error IS logged server-side
    expect(errSpy).toHaveBeenCalled();
    const logged = errSpy.mock.calls.flat()[1] as Error;
    expect(logged).toBeInstanceOf(Error);
    expect(logged.message).toContain('hunter2');
  });

  it('catches errors from the real app (malformed JSON body) with the same generic response', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    app = await makeApp();
    const res = await request(app)
      .post('/api/auth/login')
      .set('Content-Type', 'application/json')
      .send('{"broken json');
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'internal server error' });
  });
});
