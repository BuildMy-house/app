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
import { PM_AGENT_TIMEOUT_MS } from '../src/chat.js';

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
  delete process.env.PM_AGENT_TIMEOUT_MS;
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

  it('waits up to 60s for pm-agent by default (reasoning models take 15-30s)', async () => {
    expect(PM_AGENT_TIMEOUT_MS).toBe(60_000);
    const timeoutSpy = vi.spyOn(AbortSignal, 'timeout');
    fetchMock.mockReturnValue(upstreamJson({ reply: 'ok' }));
    await post({ message: 'hi' });
    expect(timeoutSpy).toHaveBeenCalledWith(60_000);
    timeoutSpy.mockRestore();
  });

  it('honours a valid PM_AGENT_TIMEOUT_MS override and ignores garbage', async () => {
    const timeoutSpy = vi.spyOn(AbortSignal, 'timeout');
    fetchMock.mockImplementation(() => upstreamJson({ reply: 'ok' }));
    process.env.PM_AGENT_TIMEOUT_MS = '90000';
    await post({ message: 'hi' });
    expect(timeoutSpy).toHaveBeenLastCalledWith(90_000);
    process.env.PM_AGENT_TIMEOUT_MS = 'abc';
    await post({ message: 'hi' });
    expect(timeoutSpy).toHaveBeenLastCalledWith(60_000);
    timeoutSpy.mockRestore();
  });

  it('503s when the upstream call times out', async () => {
    fetchMock.mockRejectedValue(new DOMException('timed out', 'TimeoutError'));
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

describe('POST /api/chat when pm-agent is busy', () => {
  it('passes a queue ticket through to the client', async () => {
    fetchMock.mockReturnValue(
      upstreamJson({ status: 'queued', ticket: 'tkt', position: 2, reply: "You're number 2 in the queue", extra: 'x' }),
    );
    const res = await post({ message: 'hi' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'queued', ticket: 'tkt', position: 2, reply: "You're number 2 in the queue" });
  });

  it('passes processing tickets through', async () => {
    fetchMock.mockReturnValue(upstreamJson({ status: 'processing', ticket: 'tkt' }));
    const res = await post({ message: 'hi' });
    expect(res.body).toEqual({ status: 'processing', ticket: 'tkt' });
  });

  it('relays a busy reply as a plain reply', async () => {
    fetchMock.mockReturnValue(upstreamJson({ status: 'busy', reply: 'Very busy, try later' }));
    const res = await post({ message: 'hi' });
    expect(res.body).toEqual({ reply: 'Very busy, try later' });
  });
});

describe('GET /api/chat/status', () => {
  const get = (query: string, auth = true) => {
    const r = request(app).get(`/api/chat/status${query}`);
    return auth ? r.set('Authorization', `Bearer ${token}`) : r;
  };

  it('rejects unauthenticated requests without calling pm-agent', async () => {
    const res = await get('?ticket=t', false);
    expect(res.status).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('400s without a ticket', async () => {
    expect((await get('')).status).toBe(400);
    expect((await get(`?ticket=${'x'.repeat(300)}`)).status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('asks pm-agent with the JWT user id, ignoring a client-supplied one', async () => {
    process.env.PM_AGENT_AUTH_TOKEN = 's3cret';
    fetchMock.mockReturnValue(upstreamJson({ status: 'queued', position: 1 }));
    const res = await get('?ticket=abc&app_user_id=attacker&userId=attacker');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'queued', position: 1 });
    const [url, init] = fetchMock.mock.calls[0];
    const parsed = new URL(url as string);
    expect(parsed.origin + parsed.pathname).toBe('http://pm-agent.test:4200/chat/status');
    expect(parsed.searchParams.get('ticket')).toBe('abc');
    expect(parsed.searchParams.get('app_user_id')).toBe(userId);
    expect(init.headers.Authorization).toBe('Bearer s3cret');
  });

  it("another user's ticket reads as expired (pm-agent checks ownership)", async () => {
    fetchMock.mockReturnValue(upstreamJson({ status: 'expired' }));
    const res = await get('?ticket=someone-elses');
    expect(res.body).toEqual({ status: 'expired' });
  });

  it('relays done and processing states', async () => {
    fetchMock.mockReturnValueOnce(upstreamJson({ status: 'done', reply: 'all set', leak: 1 }));
    expect((await get('?ticket=t')).body).toEqual({ status: 'done', reply: 'all set' });
    fetchMock.mockReturnValueOnce(upstreamJson({ status: 'processing' }));
    expect((await get('?ticket=t')).body).toEqual({ status: 'processing' });
  });

  it('503s when PM_AGENT_URL is unset or pm-agent is unreachable', async () => {
    fetchMock.mockRejectedValue(new Error('ECONNREFUSED'));
    expect((await get('?ticket=t')).status).toBe(503);
    delete process.env.PM_AGENT_URL;
    expect((await get('?ticket=t')).status).toBe(503);
  });

  it('maps upstream errors and malformed bodies', async () => {
    fetchMock.mockReturnValueOnce(upstreamJson({}, 500));
    expect((await get('?ticket=t')).status).toBe(503);
    fetchMock.mockReturnValueOnce(upstreamJson({}, 400));
    expect((await get('?ticket=t')).status).toBe(502);
    fetchMock.mockReturnValueOnce(upstreamJson({ status: 'weird' }));
    expect((await get('?ticket=t')).status).toBe(502);
  });
});
