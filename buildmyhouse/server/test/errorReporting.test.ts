import request from 'supertest';
import express from 'express';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { reportError } from '../src/errorReporting.js';
import { errorHandler } from '../src/app.js';

const ENV_KEYS = ['AXIOM_TOKEN', 'AXIOM_DATASET', 'AXIOM_ENDPOINT'] as const;
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
  delete process.env.AXIOM_TOKEN;
  delete process.env.AXIOM_DATASET;
  delete process.env.AXIOM_ENDPOINT;
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function stubFetch(impl?: typeof fetch) {
  const fn = vi.fn(impl ?? (async () => new Response('{}', { status: 200 })));
  vi.stubGlobal('fetch', fn);
  return fn;
}

async function flushMicrotasks() {
  await new Promise((r) => setTimeout(r, 0));
}

describe('reportError', () => {
  it('POSTs one event with the ingest URL, Bearer auth, and the documented shape', async () => {
    process.env.AXIOM_TOKEN = 'tok-123';
    process.env.AXIOM_DATASET = 'homely-server-errors';
    process.env.AXIOM_ENDPOINT = 'https://axiom.example.com';
    const fetchMock = stubFetch();
    vi.spyOn(console, 'error').mockImplementation(() => {});

    const before = Date.now();
    reportError(new Error('boom'), { path: '/api/x', method: 'POST', userId: 'u1' });
    await flushMicrotasks();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://axiom.example.com/api/v1/datasets/homely-server-errors/ingest');
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>)['Authorization']).toBe('Bearer tok-123');
    expect((init.headers as Record<string, string>)['Content-Type']).toBe('application/json');

    const batch = JSON.parse(init.body as string);
    expect(Array.isArray(batch)).toBe(true);
    expect(batch).toHaveLength(1);
    const event = batch[0];
    expect(event.level).toBe('error');
    expect(event.message).toBe('boom');
    expect(event.stack).toContain('boom');
    expect(event.path).toBe('/api/x');
    expect(event.method).toBe('POST');
    expect(event.userId).toBe('u1');
    // _time is a fresh ISO timestamp
    expect(new Date(event._time).getTime()).toBeGreaterThanOrEqual(before);
    expect(Number.isNaN(new Date(event._time).getTime())).toBe(false);
  });

  it('uses default endpoint/dataset when unset', async () => {
    process.env.AXIOM_TOKEN = 'tok-123';
    const fetchMock = stubFetch();

    reportError(new Error('boom'));
    await flushMicrotasks();

    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.axiom.co/api/v1/datasets/homely-server-errors/ingest');
  });

  it('is a true no-op with no AXIOM_TOKEN — fetch is never called', async () => {
    const fetchMock = stubFetch();

    reportError(new Error('boom'), { path: '/x' });
    await flushMicrotasks();

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('never throws when fetch rejects (rejection silently swallowed)', async () => {
    process.env.AXIOM_TOKEN = 'tok-123';
    stubFetch(async () => {
      throw new Error('network down');
    });

    expect(() => reportError(new Error('boom'))).not.toThrow();
    await flushMicrotasks();
  });

  it('handles non-Error values (string) without throwing', async () => {
    process.env.AXIOM_TOKEN = 'tok-123';
    const fetchMock = stubFetch();

    expect(() => reportError('a plain string failure')).not.toThrow();
    await flushMicrotasks();

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const event = JSON.parse(init.body as string)[0];
    expect(event.message).toBe('a plain string failure');
    expect(event.stack).toBeUndefined();
  });
});

describe('centralized error handler + reportError wiring', () => {
  it('responds 500 immediately even when the Axiom fetch hangs forever', async () => {
    process.env.AXIOM_TOKEN = 'tok-123';
    vi.spyOn(console, 'error').mockImplementation(() => {});
    // Never resolves — if the handler awaited it, the response would hang.
    const fetchMock = stubFetch(() => new Promise(() => {}));

    const probe = express();
    probe.get('/boom', () => {
      throw new Error('kaboom');
    });
    probe.use(errorHandler);

    const start = Date.now();
    const res = await request(probe).get('/boom');
    const elapsed = Date.now() - start;

    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'internal server error' });
    // fetch was kicked off (not awaited) and did not delay the response
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(elapsed).toBeLessThan(1000);
  });

  it('sends {path, method, userId} context from the request', async () => {
    process.env.AXIOM_TOKEN = 'tok-123';
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const fetchMock = stubFetch();

    const probe = express();
    probe.get('/api/flaky', (req, _res, next) => {
      (req as any).userId = 'user-42';
      next(new Error('kaboom'));
    });
    probe.use(errorHandler);

    await request(probe).get('/api/flaky');
    await flushMicrotasks();

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const event = JSON.parse(init.body as string)[0];
    expect(event.path).toBe('/api/flaky');
    expect(event.method).toBe('GET');
    expect(event.userId).toBe('user-42');
  });
});
