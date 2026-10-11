import request from 'supertest';
import jwt from 'jsonwebtoken';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Express } from 'express';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app.js';
import { getJwtSecret } from '../src/config.js';

process.env.JWT_SECRET = 'test-secret';

let app: Express;
let db: Database.Database;
let assetRoot: string;
let token: string;
let userId: string;
const fetchMock = vi.fn();

beforeEach(async () => {
  assetRoot = mkdtempSync(join(tmpdir(), 'homely-chat-'));
  db = new Database(':memory:');
  app = await createApp(db, assetRoot);
  const res = await request(app).post('/api/auth/register').send({ email: 'c@example.com', password: 'password123' });
  token = res.body.token as string;
  userId = jwt.verify(token, getJwtSecret()).sub as string;
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
  process.env.PM_AGENT_URL = 'http://pm-agent.test:4200/';
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.PM_AGENT_URL;
  delete process.env.PM_AGENT_AUTH_TOKEN;
  db.close();
  rmSync(assetRoot, { recursive: true, force: true });
});

const post = (body: unknown, auth = true) => {
  const r = request(app).post('/api/chat');
  return (auth ? r.set('Authorization', `Bearer ${token}`) : r).send(body as object);
};
const upstreamJson = (body: unknown, status = 200) =>
  Promise.resolve(new Response(JSON.stringify(body), { status }));

describe('POST /api/chat', () => {
  it('rejects unauthenticated requests without calling pm-agent', async () => {
    const res = await post({ message: 'hi' }, false);
    expect(res.status).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('relays the message with the JWT user id, ignoring a client-supplied id', async () => {
    fetchMock.mockReturnValue(upstreamJson({ reply: 'noted' }));
    const res = await post({ message: 'add a deck', userId: 'attacker', app_user_id: 'attacker' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ reply: 'noted' });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('http://pm-agent.test:4200/chat');
    expect(JSON.parse(init.body)).toEqual({ app_user_id: userId, message: 'add a deck' });
  });

  it('sends a bearer token to pm-agent only when PM_AGENT_AUTH_TOKEN is set', async () => {
    fetchMock.mockReturnValue(upstreamJson({ reply: 'ok' }));
    await post({ message: 'one' });
    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBeUndefined();

    process.env.PM_AGENT_AUTH_TOKEN = ' s3cret ';
    fetchMock.mockReturnValue(upstreamJson({ reply: 'ok' }));
    await post({ message: 'two' });
    expect(fetchMock.mock.calls[1][1].headers.Authorization).toBe('Bearer s3cret');
  });

  it('400s on missing/blank message', async () => {
    expect((await post({})).status).toBe(400);
    expect((await post({ message: '  ' })).status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('503s when PM_AGENT_URL is unset', async () => {
    delete process.env.PM_AGENT_URL;
    const res = await post({ message: 'hi' });
    expect(res.status).toBe(503);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('503s when pm-agent is unreachable', async () => {
    fetchMock.mockRejectedValue(new Error('ECONNREFUSED'));
    expect((await post({ message: 'hi' })).status).toBe(503);
  });

  it('maps upstream errors and malformed replies', async () => {
    fetchMock.mockReturnValueOnce(upstreamJson({ error: 'x' }, 500));
    expect((await post({ message: 'hi' })).status).toBe(503);
    fetchMock.mockReturnValueOnce(upstreamJson({ error: 'x' }, 400));
    expect((await post({ message: 'hi' })).status).toBe(502);
    fetchMock.mockReturnValueOnce(upstreamJson({ nope: 1 }));
    expect((await post({ message: 'hi' })).status).toBe(502);
  });
});
