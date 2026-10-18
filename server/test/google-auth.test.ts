import request from 'supertest';
import jwt from 'jsonwebtoken';
import Database from 'better-sqlite3';
import { generateKeyPairSync } from 'node:crypto';
import type { Express } from 'express';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { googleHttp, _resetGoogleJwksCache } from '../src/googleAuth.js';

process.env.JWT_SECRET = 'test-secret';
process.env.GOOGLE_CLIENT_ID = 'cid.apps.googleusercontent.com';
process.env.GOOGLE_CLIENT_SECRET = 'csecret';
process.env.APP_BASE_URL = 'https://app.example.test';

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'k1', alg: 'RS256', use: 'sig' };
const realFetch = googleHttp.fetch;

let app: Express;
let db: Database.Database;
let idClaims: Record<string, unknown>;

function mockGoogle() {
  googleHttp.fetch = (async (url: string | URL | Request) => {
    const u = String(url);
    if (u.includes('/token')) {
      const idToken = jwt.sign(idClaims, privateKey, { algorithm: 'RS256', keyid: 'k1' });
      return new Response(JSON.stringify({ id_token: idToken }), { status: 200 });
    }
    return new Response(JSON.stringify({ keys: [jwk] }), { status: 200 });
  }) as typeof fetch;
}

beforeEach(async () => {
  db = new Database(':memory:');
  app = await createApp(db, 'data/assets');
  _resetGoogleJwksCache();
  mockGoogle();
  idClaims = {
    iss: 'https://accounts.google.com',
    aud: process.env.GOOGLE_CLIENT_ID,
    sub: 'g-123',
    email: 'Gina@Example.com',
    email_verified: true,
    name: 'Gina',
    picture: 'http://pic/x',
    nonce: '',
  };
});
afterEach(() => {
  googleHttp.fetch = realFetch;
  db.close();
});

async function start(returnTo?: string) {
  const res = await request(app).get('/auth/google/start').query(returnTo ? { returnTo } : {});
  const loc = new URL(res.headers.location);
  const cookie = (res.headers['set-cookie'] as unknown as string[]).find((c) => c.startsWith('bmh_oauth='))!;
  idClaims.nonce = loc.searchParams.get('nonce');
  return { res, loc, cookie: cookie.split(';')[0] };
}

describe('google oauth', () => {
  it('start redirects to Google with PKCE S256, state, nonce and a secure httpOnly cookie', async () => {
    const { res, loc } = await start('/?waitlist=1');
    expect(res.status).toBe(302);
    expect(loc.origin + loc.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    expect(loc.searchParams.get('code_challenge_method')).toBe('S256');
    expect(loc.searchParams.get('redirect_uri')).toBe('https://app.example.test/auth/google/callback');
    expect(loc.searchParams.get('client_id')).toBe(process.env.GOOGLE_CLIENT_ID);
    const set = (res.headers['set-cookie'] as unknown as string[]).join(';');
    expect(set).toMatch(/HttpOnly/);
    expect(set).toMatch(/Secure/);
    expect(set).toMatch(/SameSite=Lax/);
  });

  it('callback creates a user, sets session cookie, and cookie authenticates /me', async () => {
    const { loc, cookie } = await start('/?waitlist=1');
    const res = await request(app)
      .get('/auth/google/callback')
      .query({ code: 'c', state: loc.searchParams.get('state') })
      .set('Cookie', cookie);
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/?waitlist=1');
    const sess = (res.headers['set-cookie'] as unknown as string[]).find((c) => c.startsWith('bmh_session='))!;
    expect(sess).toMatch(/HttpOnly/);
    expect(sess).toMatch(/Secure/);
    const me = await request(app).get('/api/auth/me').set('Cookie', sess.split(';')[0]);
    expect(me.status).toBe(200);
    expect(me.body.email).toBe('gina@example.com');
    expect(me.body.picture).toBe('http://pic/x');
    const ex = await request(app).post('/api/auth/session').set('Cookie', sess.split(';')[0]);
    expect(ex.status).toBe(200);
    expect(typeof ex.body.token).toBe('string');
  });

  it('links an existing password account by verified email (same user id)', async () => {
    const reg = await request(app).post('/api/auth/register').send({ email: 'gina@example.com', password: 'password123' });
    const before = jwt.decode(reg.body.token) as { sub: string };
    const { loc, cookie } = await start();
    const res = await request(app).get('/auth/google/callback').query({ code: 'c', state: loc.searchParams.get('state') }).set('Cookie', cookie);
    const sess = (res.headers['set-cookie'] as unknown as string[]).find((c) => c.startsWith('bmh_session='))!;
    const me = await request(app).get('/api/auth/me').set('Cookie', sess.split(';')[0]);
    expect(me.body.id).toBe(before.sub);
    expect((db.prepare('SELECT COUNT(*) n FROM users').get() as { n: number }).n).toBe(1);
  });

  it('rejects state mismatch, missing cookie, wrong nonce, unverified email, wrong audience', async () => {
    const a = await start();
    let res = await request(app).get('/auth/google/callback').query({ code: 'c', state: 'bad' }).set('Cookie', a.cookie);
    expect(res.headers.location).toBe('/?signin=error');
    res = await request(app).get('/auth/google/callback').query({ code: 'c', state: a.loc.searchParams.get('state') });
    expect(res.headers.location).toBe('/?signin=error');
    for (const bad of [{ nonce: 'x' }, { email_verified: false }, { aud: 'other' }]) {
      const s = await start();
      Object.assign(idClaims, bad);
      res = await request(app).get('/auth/google/callback').query({ code: 'c', state: s.loc.searchParams.get('state') }).set('Cookie', s.cookie);
      expect(res.headers.location).toBe('/?signin=error');
      expect(String(res.headers['set-cookie'])).not.toContain('bmh_session=ey');
    }
  });

  it('sanitizes returnTo against open redirects', async () => {
    for (const evil of ['//evil.com', 'https://evil.com', '/\\evil.com']) {
      const { loc, cookie } = await start(evil);
      const res = await request(app).get('/auth/google/callback').query({ code: 'c', state: loc.searchParams.get('state') }).set('Cookie', cookie);
      expect(res.headers.location).toBe('/');
    }
  });

  it('providers, logout, and google-only delete-account confirm', async () => {
    expect((await request(app).get('/api/auth/providers')).body).toEqual({ google: true });
    const { loc, cookie } = await start();
    const cb = await request(app).get('/auth/google/callback').query({ code: 'c', state: loc.searchParams.get('state') }).set('Cookie', cookie);
    const sess = (cb.headers['set-cookie'] as unknown as string[]).find((c) => c.startsWith('bmh_session='))!.split(';')[0];
    expect((await request(app).post('/api/auth/login').send({ email: 'gina@example.com', password: '!google-only' })).status).toBe(401);
    expect((await request(app).delete('/api/auth/me').set('Cookie', sess).send({})).status).toBe(400);
    expect((await request(app).delete('/api/auth/me').set('Cookie', sess).send({ confirmEmail: 'gina@example.com' })).status).toBeLessThan(300);
    expect((await request(app).post('/api/auth/logout')).status).toBe(204);
  });
});
