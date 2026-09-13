import request from 'supertest';
import jwt from 'jsonwebtoken';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import type { Express } from 'express';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { getJwtSecret } from '../src/config.js';

process.env.JWT_SECRET = 'test-secret';

function glbPayload(): Buffer {
  const buf = Buffer.alloc(12);
  buf.writeUInt32LE(0x46546c67, 0);
  buf.writeUInt32LE(2, 4);
  buf.writeUInt32LE(12, 8);
  return buf;
}

let app: Express;
let db: Database.Database;
let assetRoot: string;
const openDbs: Database.Database[] = [];

beforeEach(async () => {
  assetRoot = mkdtempSync(join(tmpdir(), 'homely-account-'));
  db = new Database(':memory:');
  openDbs.push(db);
  app = await createApp(db, assetRoot);
});

afterEach(() => {
  for (const d of openDbs.splice(0)) d.close();
  rmSync(assetRoot, { recursive: true, force: true });
});

async function register(email: string, password = 'password123'): Promise<string> {
  const res = await request(app).post('/api/auth/register').send({ email, password });
  expect(res.status).toBe(201);
  return res.body.token as string;
}

const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

const userIdOf = (token: string) => jwt.verify(token, getJwtSecret()).sub as string;

function insertHome(id: string, ownerUserId: string, teamId: string | null): void {
  const now = new Date().toISOString();
  db.prepare(
    'INSERT INTO homes (id, owner_user_id, name, json, team_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
  ).run(id, ownerUserId, `Home-${id}`, '{}', teamId, now, now);
}

function insertTeam(teamId: string, members: { userId: string; role: 'owner' | 'member' }[]): void {
  const now = new Date().toISOString();
  db.prepare('INSERT INTO teams (id, name, created_at) VALUES (?, ?, ?)').run(teamId, `Team-${teamId}`, now);
  for (const m of members) {
    db.prepare('INSERT INTO team_members (team_id, user_id, role, joined_at) VALUES (?, ?, ?, ?)').run(
      teamId,
      m.userId,
      m.role,
      now,
    );
  }
}

async function uploadAsset(userId: string, token: string, assetId: string): Promise<void> {
  const res = await request(app)
    .post(`/api/assets/${userId}`)
    .set(auth(token))
    .send({ record: { id: assetId, name: 'Chair' }, glb: glbPayload().toString('base64') });
  expect(res.status).toBe(201);
}

describe('display name (PATCH /api/auth/me)', () => {
  it('GET /me returns name: null when unset, then the set name', async () => {
    const token = await register('name@example.com');
    expect((await request(app).get('/api/auth/me').set(auth(token))).body.name).toBeNull();

    const res = await request(app).patch('/api/auth/me').set(auth(token)).send({ name: '  Ada Lovelace  ' });
    expect(res.status).toBe(200);
    expect(res.body.name).toBe('Ada Lovelace'); // trimmed

    expect((await request(app).get('/api/auth/me').set(auth(token))).body.name).toBe('Ada Lovelace');
  });

  it('clears the name with null and with empty string', async () => {
    const token = await register('clear@example.com');
    await request(app).patch('/api/auth/me').set(auth(token)).send({ name: 'Grace' });

    const viaNull = await request(app).patch('/api/auth/me').set(auth(token)).send({ name: null });
    expect(viaNull.status).toBe(200);
    expect(viaNull.body.name).toBeNull();
    expect((await request(app).get('/api/auth/me').set(auth(token))).body.name).toBeNull();

    await request(app).patch('/api/auth/me').set(auth(token)).send({ name: 'Grace' });
    const viaEmpty = await request(app).patch('/api/auth/me').set(auth(token)).send({ name: '' });
    expect(viaEmpty.status).toBe(200);
    expect(viaEmpty.body.name).toBeNull();
  });

  it('rejects invalid input with 400: too long, non-string, missing', async () => {
    const token = await register('invalidname@example.com');

    const tooLong = await request(app).patch('/api/auth/me').set(auth(token)).send({ name: 'x'.repeat(101) });
    expect(tooLong.status).toBe(400);

    const notString = await request(app).patch('/api/auth/me').set(auth(token)).send({ name: 42 });
    expect(notString.status).toBe(400);

    const missing = await request(app).patch('/api/auth/me').set(auth(token)).send({});
    expect(missing.status).toBe(400);

    const unauthed = await request(app).patch('/api/auth/me').send({ name: 'Nope' });
    expect(unauthed.status).toBe(401);
  });
});

describe('PUT /api/auth/email', () => {
  it('changes the email after password verification; old email stops working', async () => {
    const token = await register('old@example.com');

    const res = await request(app)
      .put('/api/auth/email')
      .set(auth(token))
      .send({ currentPassword: 'password123', newEmail: 'New@Example.COM ' });
    expect(res.status).toBe(200);
    expect(res.body.email).toBe('new@example.com'); // normalized

    // new email logs in, old one is gone
    expect((await request(app).post('/api/auth/login').send({ email: 'new@example.com', password: 'password123' })).status).toBe(200);
    expect((await request(app).post('/api/auth/login').send({ email: 'old@example.com', password: 'password123' })).status).toBe(401);

    expect((await request(app).get('/api/auth/me').set(auth(token))).body.email).toBe('new@example.com');
  });

  it('rejects a wrong current password with 401 and leaves the email unchanged', async () => {
    const token = await register('wrongpw@example.com');
    const res = await request(app)
      .put('/api/auth/email')
      .set(auth(token))
      .send({ currentPassword: 'wrong-password', newEmail: 'changed@example.com' });
    expect(res.status).toBe(401);
    expect(res.body.error).toMatch(/password/i);

    expect((await request(app).get('/api/auth/me').set(auth(token))).body.email).toBe('wrongpw@example.com');
  });

  it('rejects a duplicate email with 409 (registered to a different user)', async () => {
    await register('taken@example.com');
    const token = await register('changer@example.com');
    const res = await request(app)
      .put('/api/auth/email')
      .set(auth(token))
      .send({ currentPassword: 'password123', newEmail: 'taken@example.com' });
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/registered/i);
  });

  it('allows re-setting the same email (no self-collision 409) and rejects invalid formats', async () => {
    const token = await register('same@example.com');
    const same = await request(app)
      .put('/api/auth/email')
      .set(auth(token))
      .send({ currentPassword: 'password123', newEmail: 'same@example.com' });
    expect(same.status).toBe(200);

    const bad = await request(app)
      .put('/api/auth/email')
      .set(auth(token))
      .send({ currentPassword: 'password123', newEmail: 'not-an-email' });
    expect(bad.status).toBe(400);
  });
});

describe('DELETE /api/auth/me', () => {
  it('happy path: removes the user, personal homes, and assets from DB AND disk', async () => {
    const token = await register('bye@example.com');
    const userId = userIdOf(token);
    insertHome('home-1', userId, null);
    insertHome('home-2', userId, null);
    await uploadAsset(userId, token, 'asset-1');

    const glbFile = join(assetRoot, userId, 'asset-1.glb');
    expect(existsSync(glbFile)).toBe(true);

    const res = await request(app).delete('/api/auth/me').set(auth(token)).send({ password: 'password123' });
    expect(res.status).toBe(200);

    expect(db.prepare('SELECT COUNT(*) AS n FROM users WHERE id = ?').get(userId)!.n).toBe(0);
    expect(db.prepare('SELECT COUNT(*) AS n FROM homes WHERE owner_user_id = ?').get(userId)!.n).toBe(0);
    expect(db.prepare('SELECT COUNT(*) AS n FROM assets WHERE user_id = ?').get(userId)!.n).toBe(0);
    expect(existsSync(glbFile)).toBe(false);

    // account is really gone: login fails, /me 404s
    expect((await request(app).post('/api/auth/login').send({ email: 'bye@example.com', password: 'password123' })).status).toBe(401);
    expect((await request(app).get('/api/auth/me').set(auth(token))).status).toBe(404);
  });

  it('rejects a wrong password with 401 and deletes nothing', async () => {
    const token = await register('keep@example.com');
    const userId = userIdOf(token);
    insertHome('home-1', userId, null);

    const res = await request(app).delete('/api/auth/me').set(auth(token)).send({ password: 'wrong-password' });
    expect(res.status).toBe(401);

    expect(db.prepare('SELECT COUNT(*) AS n FROM users WHERE id = ?').get(userId)).toBeDefined();
    expect(db.prepare('SELECT COUNT(*) AS n FROM homes WHERE owner_user_id = ?').get(userId)!.n).toBe(1);
  });

  it('blocks with 400 when the user is sole owner of a team with other members — nothing deleted', async () => {
    const token = await register('soleowner@example.com');
    const userId = userIdOf(token);
    const otherToken = await register('member@example.com');
    const otherId = userIdOf(otherToken);
    insertTeam('team-1', [
      { userId, role: 'owner' },
      { userId: otherId, role: 'member' },
    ]);
    insertHome('team-home', userId, 'team-1');
    insertHome('personal-home', userId, null);

    const res = await request(app).delete('/api/auth/me').set(auth(token)).send({ password: 'password123' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/sole owner of team/i);

    // Nothing was deleted: login still works, all rows still present.
    expect((await request(app).post('/api/auth/login').send({ email: 'soleowner@example.com', password: 'password123' })).status).toBe(200);
    expect(db.prepare('SELECT COUNT(*) AS n FROM users WHERE id = ?').get(userId)).toBeDefined();
    expect(db.prepare('SELECT COUNT(*) AS n FROM team_members WHERE team_id = ?').get('team-1')!.n).toBe(2);
    expect(db.prepare('SELECT COUNT(*) AS n FROM homes WHERE id IN (?, ?)').get('team-home', 'personal-home')!.n).toBe(2);
  });

  it('sole owner AND sole member: team, its invites, and its team homes are deleted', async () => {
    const token = await register('lonewner@example.com');
    const userId = userIdOf(token);
    insertTeam('team-solo', [{ userId, role: 'owner' }]);
    insertHome('team-home', userId, 'team-solo');
    insertHome('personal-home', userId, null);
    const now = new Date().toISOString();
    db.prepare(
      'INSERT INTO team_invites (id, team_id, email, role, invited_by_user_id, token, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    ).run('inv-1', 'team-solo', 'pending@example.com', 'member', userId, 'tok-1', now, now);

    const res = await request(app).delete('/api/auth/me').set(auth(token)).send({ password: 'password123' });
    expect(res.status).toBe(200);

    expect(db.prepare('SELECT COUNT(*) AS n FROM teams WHERE id = ?').get('team-solo')!.n).toBe(0);
    expect(db.prepare('SELECT COUNT(*) AS n FROM team_members WHERE team_id = ?').get('team-solo')!.n).toBe(0);
    expect(db.prepare('SELECT COUNT(*) AS n FROM team_invites WHERE team_id = ?').get('team-solo')!.n).toBe(0);
    expect(db.prepare('SELECT COUNT(*) AS n FROM homes WHERE id = ?').get('team-home')!.n).toBe(0);
    // personal home is gone too, and the user with it
    expect(db.prepare('SELECT COUNT(*) AS n FROM homes WHERE owner_user_id = ?').get(userId)!.n).toBe(0);
    expect(db.prepare('SELECT COUNT(*) AS n FROM users WHERE id = ?').get(userId)!.n).toBe(0);
  });

  it('co-owner exists: only membership is removed; team and the other owner survive', async () => {
    const token = await register('coowner@example.com');
    const userId = userIdOf(token);
    const otherToken = await register('partner@example.com');
    const otherId = userIdOf(otherToken);
    insertTeam('team-duo', [
      { userId, role: 'owner' },
      { userId: otherId, role: 'owner' },
    ]);
    insertHome('team-home', userId, 'team-duo');
    insertHome('personal-home', userId, null);

    const res = await request(app).delete('/api/auth/me').set(auth(token)).send({ password: 'password123' });
    expect(res.status).toBe(200);

    expect(db.prepare('SELECT COUNT(*) AS n FROM teams WHERE id = ?').get('team-duo')).toBeDefined();
    expect(db.prepare('SELECT COUNT(*) AS n FROM team_members WHERE team_id = ? AND user_id = ?').get('team-duo', userId)!.n).toBe(0);
    expect(db.prepare('SELECT COUNT(*) AS n FROM team_members WHERE team_id = ? AND user_id = ?').get('team-duo', otherId)).toBeDefined();
    // team-owned home survives (team still exists), personal home is gone
    expect(db.prepare('SELECT COUNT(*) AS n FROM homes WHERE id = ?').get('team-home')).toBeDefined();
    expect(db.prepare('SELECT COUNT(*) AS n FROM homes WHERE id = ?').get('personal-home')!.n).toBe(0);
  });

  it('plain member: only membership is removed; team and owner survive', async () => {
    const token = await register('plainmember@example.com');
    const userId = userIdOf(token);
    const ownerToken = await register('teamowner@example.com');
    const ownerId = userIdOf(ownerToken);
    insertTeam('team-x', [
      { userId: ownerId, role: 'owner' },
      { userId, role: 'member' },
    ]);

    const res = await request(app).delete('/api/auth/me').set(auth(token)).send({ password: 'password123' });
    expect(res.status).toBe(200);

    expect(db.prepare('SELECT COUNT(*) AS n FROM teams WHERE id = ?').get('team-x')).toBeDefined();
    expect(db.prepare('SELECT COUNT(*) AS n FROM team_members WHERE team_id = ? AND user_id = ?').get('team-x', userId)!.n).toBe(0);
    expect(db.prepare('SELECT COUNT(*) AS n FROM team_members WHERE team_id = ? AND user_id = ?').get('team-x', ownerId)).toBeDefined();
    expect(db.prepare('SELECT COUNT(*) AS n FROM users WHERE id = ?').get(userId)!.n).toBe(0);
  });

  it('cleans up password reset tokens, magic link tokens, and invites sent by the user', async () => {
    const token = await register('hygiene@example.com');
    const userId = userIdOf(token);
    const now = new Date().toISOString();
    db.prepare(
      'INSERT INTO password_reset_tokens (id, user_id, token, created_at, expires_at) VALUES (?, ?, ?, ?, ?)',
    ).run('prt-1', userId, 'prt-tok', now, now);
    db.prepare(
      'INSERT INTO magic_link_tokens (id, email, token, created_at, expires_at) VALUES (?, ?, ?, ?, ?)',
    ).run('mlt-1', 'hygiene@example.com', 'mlt-tok', now, now);
    const otherToken = await register('inviter@example.com');
    insertTeam('team-y', [{ userId: userIdOf(otherToken), role: 'owner' }]);
    db.prepare(
      'INSERT INTO team_invites (id, team_id, email, role, invited_by_user_id, token, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    ).run('inv-2', 'team-y', 'pending@example.com', 'member', userId, 'inv-tok', now, now);

    const res = await request(app).delete('/api/auth/me').set(auth(token)).send({ password: 'password123' });
    expect(res.status).toBe(200);

    expect(db.prepare('SELECT COUNT(*) AS n FROM password_reset_tokens WHERE user_id = ?').get(userId)!.n).toBe(0);
    expect(db.prepare('SELECT COUNT(*) AS n FROM magic_link_tokens WHERE email = ?').get('hygiene@example.com')!.n).toBe(0);
    expect(db.prepare('SELECT COUNT(*) AS n FROM team_invites WHERE invited_by_user_id = ?').get(userId)!.n).toBe(0);
  });

  it('rejects an unauthenticated request with 401', async () => {
    const res = await request(app).delete('/api/auth/me').send({ password: 'password123' });
    expect(res.status).toBe(401);
  });
});
