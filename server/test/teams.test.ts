import request from 'supertest';
import jwt from 'jsonwebtoken';
import Database from 'better-sqlite3';
import type { Express } from 'express';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { getJwtSecret } from '../src/config.js';

process.env.JWT_SECRET = 'test-secret';

const HOME_JSON = JSON.stringify({ schemaVersion: 1, walls: [] });

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

describe('POST /api/teams', () => {
  it('creates a team with the creator as owner', async () => {
    const token = await register('alice@example.com');
    const res = await request(app)
      .post('/api/teams')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'My Team' });

    expect(res.status).toBe(201);
    expect(res.body.name).toBe('My Team');
    expect(res.body.id).toBeTruthy();
  });

  it('rejects empty name', async () => {
    const token = await register('alice@example.com');
    const res = await request(app)
      .post('/api/teams')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: '' });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/name/i);
  });
});

describe('GET /api/teams', () => {
  it('lists teams the user belongs to', async () => {
    const tokenA = await register('alice@example.com');
    const tokenB = await register('bob@example.com');

    // Alice creates two teams
    const t1 = await request(app)
      .post('/api/teams')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ name: 'Team 1' });
    const t2 = await request(app)
      .post('/api/teams')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ name: 'Team 2' });

    // Alice adds Bob to Team 1
    await request(app)
      .post(`/api/teams/${t1.body.id}/members`)
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ email: 'bob@example.com' });

    const aliceList = await request(app).get('/api/teams').set('Authorization', `Bearer ${tokenA}`);
    expect(aliceList.status).toBe(200);
    expect(aliceList.body.items.map((t: { name: string }) => t.name)).toEqual(['Team 2', 'Team 1']);

    const bobList = await request(app).get('/api/teams').set('Authorization', `Bearer ${tokenB}`);
    expect(bobList.status).toBe(200);
    expect(bobList.body.items.map((t: { name: string }) => t.name)).toEqual(['Team 1']);
  });
});

describe('GET /api/teams/:id', () => {
  it('returns team detail with member list', async () => {
    const tokenA = await register('alice@example.com');
    const tokenB = await register('bob@example.com');

    const team = await request(app)
      .post('/api/teams')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ name: 'Detail Team' });

    await request(app)
      .post(`/api/teams/${team.body.id}/members`)
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ email: 'bob@example.com' });

    const res = await request(app)
      .get(`/api/teams/${team.body.id}`)
      .set('Authorization', `Bearer ${tokenA}`);

    expect(res.status).toBe(200);
    expect(res.body.name).toBe('Detail Team');
    expect(res.body.members).toHaveLength(2);
    expect(res.body.members.map((m: { email: string }) => m.email).sort()).toEqual([
      'alice@example.com',
      'bob@example.com',
    ]);
  });

  it('returns 403 for non-members', async () => {
    const tokenA = await register('alice@example.com');
    const tokenB = await register('bob@example.com');

    const team = await request(app)
      .post('/api/teams')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ name: 'Private Team' });

    const res = await request(app)
      .get(`/api/teams/${team.body.id}`)
      .set('Authorization', `Bearer ${tokenB}`);
    expect(res.status).toBe(403);
  });

  it('returns 404 for nonexistent team', async () => {
    const token = await register('alice@example.com');
    const res = await request(app)
      .get('/api/teams/nonexistent')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(404);
  });
});

describe('POST /api/teams/:id/members', () => {
  it('owner can add a member', async () => {
    const tokenA = await register('alice@example.com');
    const tokenB = await register('bob@example.com');

    const team = await request(app)
      .post('/api/teams')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ name: 'Add Team' });

    const res = await request(app)
      .post(`/api/teams/${team.body.id}/members`)
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ email: 'bob@example.com' });
    expect(res.status).toBe(201);
  });

  it('non-owner cannot add members', async () => {
    const tokenA = await register('alice@example.com');
    const tokenB = await register('bob@example.com');

    const team = await request(app)
      .post('/api/teams')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ name: 'Add Team' });

    await request(app)
      .post(`/api/teams/${team.body.id}/members`)
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ email: 'bob@example.com' });

    const res = await request(app)
      .post(`/api/teams/${team.body.id}/members`)
      .set('Authorization', `Bearer ${tokenB}`)
      .send({ email: 'alice@example.com' });
    expect(res.status).toBe(403);
  });

  it('returns 404 for nonexistent email', async () => {
    const token = await register('alice@example.com');
    const team = await request(app)
      .post('/api/teams')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Team' });

    const res = await request(app)
      .post(`/api/teams/${team.body.id}/members`)
      .set('Authorization', `Bearer ${token}`)
      .send({ email: 'nobody@example.com' });
    expect(res.status).toBe(404);
  });

  it('returns 409 for duplicate membership', async () => {
    const tokenA = await register('alice@example.com');
    const tokenB = await register('bob@example.com');

    const team = await request(app)
      .post('/api/teams')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ name: 'Team' });

    await request(app)
      .post(`/api/teams/${team.body.id}/members`)
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ email: 'bob@example.com' });

    const res = await request(app)
      .post(`/api/teams/${team.body.id}/members`)
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ email: 'bob@example.com' });
    expect(res.status).toBe(409);
  });
});

describe('DELETE /api/teams/:id/members/:memberId', () => {
  it('owner can remove a member', async () => {
    const tokenA = await register('alice@example.com');
    const tokenB = await register('bob@example.com');

    const team = await request(app)
      .post('/api/teams')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ name: 'Remove Team' });

    await request(app)
      .post(`/api/teams/${team.body.id}/members`)
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ email: 'bob@example.com' });

    const bobId = userId(tokenB);
    const res = await request(app)
      .delete(`/api/teams/${team.body.id}/members/${bobId}`)
      .set('Authorization', `Bearer ${tokenA}`);
    expect(res.status).toBe(204);
  });

  it('member can remove themselves (leave)', async () => {
    const tokenA = await register('alice@example.com');
    const tokenB = await register('bob@example.com');

    const team = await request(app)
      .post('/api/teams')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ name: 'Leave Team' });

    await request(app)
      .post(`/api/teams/${team.body.id}/members`)
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ email: 'bob@example.com' });

    const bobId = userId(tokenB);
    const res = await request(app)
      .delete(`/api/teams/${team.body.id}/members/${bobId}`)
      .set('Authorization', `Bearer ${tokenB}`);
    expect(res.status).toBe(204);
  });

  it('cannot remove the last owner', async () => {
    const token = await register('alice@example.com');
    const team = await request(app)
      .post('/api/teams')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Solo Owner' });

    const aliceId = userId(token);
    const res = await request(app)
      .delete(`/api/teams/${team.body.id}/members/${aliceId}`)
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/last owner/i);
  });
});

describe('team-based home access', () => {
  it('team member can access a team-owned home', async () => {
    const tokenA = await register('alice@example.com');
    const tokenB = await register('bob@example.com');

    const team = await request(app)
      .post('/api/teams')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ name: 'Home Team' });

    await request(app)
      .post(`/api/teams/${team.body.id}/members`)
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ email: 'bob@example.com' });

    // Alice creates a team home
    const home = await request(app)
      .post('/api/homes')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ name: 'Team Home', json: HOME_JSON, teamId: team.body.id });
    expect(home.status).toBe(201);

    // Bob can read it
    const bobRead = await request(app)
      .get(`/api/homes/${home.body.id}`)
      .set('Authorization', `Bearer ${tokenB}`);
    expect(bobRead.status).toBe(200);
    expect(bobRead.body.name).toBe('Team Home');

    // Bob can update it
    const bobUpdate = await request(app)
      .put(`/api/homes/${home.body.id}`)
      .set('Authorization', `Bearer ${tokenB}`)
      .send({ name: 'Updated by Bob', json: HOME_JSON });
    expect(bobUpdate.status).toBe(200);
    expect(bobUpdate.body.name).toBe('Updated by Bob');
  });

  it('team member edit persists after debounce flush', async () => {
    const tokenA = await register('alice@example.com');
    const tokenB = await register('bob@example.com');

    const team = await request(app)
      .post('/api/teams')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ name: 'Edit Team' });

    await request(app)
      .post(`/api/teams/${team.body.id}/members`)
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ email: 'bob@example.com' });

    // Alice creates a team home
    const home = await request(app)
      .post('/api/homes')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ name: 'Original Name', json: HOME_JSON, teamId: team.body.id });
    expect(home.status).toBe(201);

    // Bob (non-owner team member) updates the home
    const updatedJson = JSON.stringify({ schemaVersion: 1, walls: [{ id: 'w1' }] });
    const bobUpdate = await request(app)
      .put(`/api/homes/${home.body.id}`)
      .set('Authorization', `Bearer ${tokenB}`)
      .send({ name: 'Updated by Bob', json: updatedJson });
    expect(bobUpdate.status).toBe(200);
    expect(bobUpdate.body.name).toBe('Updated by Bob');

    // Wait for the save queue to flush (SAVE_FLUSH_MS = 500)
    await new Promise((resolve) => setTimeout(resolve, 600));

    // Fresh GET as Alice (owner) confirms persistence
    const freshGet = await request(app)
      .get(`/api/homes/${home.body.id}`)
      .set('Authorization', `Bearer ${tokenA}`);
    expect(freshGet.status).toBe(200);
    expect(freshGet.body.name).toBe('Updated by Bob');
    expect(freshGet.body.json).toBe(updatedJson);
  });

  it('non-member cannot access team-owned home', async () => {
    const tokenA = await register('alice@example.com');
    const tokenB = await register('bob@example.com');
    const tokenC = await register('charlie@example.com');

    const team = await request(app)
      .post('/api/teams')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ name: 'Private Team' });

    await request(app)
      .post(`/api/teams/${team.body.id}/members`)
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ email: 'bob@example.com' });

    const home = await request(app)
      .post('/api/homes')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ name: 'Team Home', json: HOME_JSON, teamId: team.body.id });

    // Charlie (not a member) gets 403
    const res = await request(app)
      .get(`/api/homes/${home.body.id}`)
      .set('Authorization', `Bearer ${tokenC}`);
    expect(res.status).toBe(403);
  });

  it('team home appears in member listing', async () => {
    const tokenA = await register('alice@example.com');
    const tokenB = await register('bob@example.com');

    const team = await request(app)
      .post('/api/teams')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ name: 'List Team' });

    await request(app)
      .post(`/api/teams/${team.body.id}/members`)
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ email: 'bob@example.com' });

    await request(app)
      .post('/api/homes')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ name: 'Team Home', json: HOME_JSON, teamId: team.body.id });

    // Alice sees both her personal and team homes
    const aliceList = await request(app).get('/api/homes').set('Authorization', `Bearer ${tokenA}`);
    expect(aliceList.body.items).toHaveLength(1); // team home only (no personal homes created)

    // Bob sees the team home too
    const bobList = await request(app).get('/api/homes').set('Authorization', `Bearer ${tokenB}`);
    expect(bobList.body.items).toHaveLength(1);
    expect(bobList.body.items[0].name).toBe('Team Home');
  });
});

describe('multi-team membership', () => {
  it('user can belong to multiple teams with independent roles', async () => {
    const tokenA = await register('alice@example.com');
    const tokenB = await register('bob@example.com');

    // Alice creates Team 1 (owner), Bob creates Team 2 (owner)
    const team1 = await request(app)
      .post('/api/teams')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ name: 'Team 1' });
    const team2 = await request(app)
      .post('/api/teams')
      .set('Authorization', `Bearer ${tokenB}`)
      .send({ name: 'Team 2' });

    // Alice adds Bob as member to Team 1; Bob adds Alice as member to Team 2
    await request(app)
      .post(`/api/teams/${team1.body.id}/members`)
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ email: 'bob@example.com' });
    await request(app)
      .post(`/api/teams/${team2.body.id}/members`)
      .set('Authorization', `Bearer ${tokenB}`)
      .send({ email: 'alice@example.com' });

    // Verify: Alice is owner of Team 1, member of Team 2
    const aliceList = await request(app).get('/api/teams').set('Authorization', `Bearer ${tokenA}`);
    expect(aliceList.body.items).toHaveLength(2);
    const aliceRoles = aliceList.body.items.map((t: { name: string; role: string }) => ({
      name: t.name,
      role: t.role,
    }));
    expect(aliceRoles).toContainEqual({ name: 'Team 1', role: 'owner' });
    expect(aliceRoles).toContainEqual({ name: 'Team 2', role: 'member' });

    // Verify: Bob is member of Team 1, owner of Team 2
    const bobList = await request(app).get('/api/teams').set('Authorization', `Bearer ${tokenB}`);
    expect(bobList.body.items).toHaveLength(2);
    const bobRoles = bobList.body.items.map((t: { name: string; role: string }) => ({
      name: t.name,
      role: t.role,
    }));
    expect(bobRoles).toContainEqual({ name: 'Team 1', role: 'member' });
    expect(bobRoles).toContainEqual({ name: 'Team 2', role: 'owner' });

    // Team 1: Alice can add members (owner), Bob cannot
    const charlieToken = await register('charlie@example.com');
    const addAsAlice = await request(app)
      .post(`/api/teams/${team1.body.id}/members`)
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ email: 'charlie@example.com' });
    expect(addAsAlice.status).toBe(201);

    const addAsBob = await request(app)
      .post(`/api/teams/${team1.body.id}/members`)
      .set('Authorization', `Bearer ${tokenB}`)
      .send({ email: 'charlie@example.com' });
    expect(addAsBob.status).toBe(403);

    // Both teams have homes that their members can access
    const team1Home = await request(app)
      .post('/api/homes')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ name: 'Team 1 Home', json: HOME_JSON, teamId: team1.body.id });
    const team2Home = await request(app)
      .post('/api/homes')
      .set('Authorization', `Bearer ${tokenB}`)
      .send({ name: 'Team 2 Home', json: HOME_JSON, teamId: team2.body.id });

    // Bob can read Team 1 home (he's a member) but not update as owner
    const bobReadT1 = await request(app)
      .get(`/api/homes/${team1Home.body.id}`)
      .set('Authorization', `Bearer ${tokenB}`);
    expect(bobReadT1.status).toBe(200);

    // Alice can read Team 2 home (she's a member)
    const aliceReadT2 = await request(app)
      .get(`/api/homes/${team2Home.body.id}`)
      .set('Authorization', `Bearer ${tokenA}`);
    expect(aliceReadT2.status).toBe(200);
  });
});

describe('auth required on team routes', () => {
  it('rejects unauthenticated requests with 401', async () => {
    const list = await request(app).get('/api/teams');
    const get = await request(app).get('/api/teams/abc');
    const create = await request(app).post('/api/teams').send({ name: 'X' });
    const addMember = await request(app).post('/api/teams/abc/members').send({ email: 'x@y.com' });

    expect(list.status).toBe(401);
    expect(get.status).toBe(401);
    expect(create.status).toBe(401);
    expect(addMember.status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// Email invites (H11)
// ---------------------------------------------------------------------------

/** The invite token only leaves the server via the (logged) email, so tests
 * pull it straight from the in-memory db the app was built with. */
const inviteToken = (email: string) =>
  (db.prepare('SELECT token FROM team_invites WHERE email = ?').get(email) as { token: string })
    .token;

async function createTeamWithOwner(name: string, email: string) {
  const token = await register(email);
  const team = await request(app)
    .post('/api/teams')
    .set('Authorization', `Bearer ${token}`)
    .send({ name });
  return { token, teamId: team.body.id as string };
}

describe('POST /api/teams/:id/invites', () => {
  it('owner can invite an email that has no account; token is not in the response', async () => {
    const { token, teamId } = await createTeamWithOwner('Invite Team', 'alice@example.com');

    const res = await request(app)
      .post(`/api/teams/${teamId}/invites`)
      .set('Authorization', `Bearer ${token}`)
      .send({ email: 'carol@example.com' });

    expect(res.status).toBe(201);
    expect(res.body.email).toBe('carol@example.com');
    expect(res.body.role).toBe('member');
    expect(res.body.token).toBeUndefined();
    expect(JSON.stringify(res.body)).not.toContain(inviteToken('carol@example.com'));
  });

  it('non-owner cannot create an invite', async () => {
    const { token: tokenA, teamId } = await createTeamWithOwner('Owner Team', 'alice@example.com');
    const tokenB = await register('bob@example.com');
    await request(app)
      .post(`/api/teams/${teamId}/members`)
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ email: 'bob@example.com' });

    const res = await request(app)
      .post(`/api/teams/${teamId}/invites`)
      .set('Authorization', `Bearer ${tokenB}`)
      .send({ email: 'carol@example.com' });

    expect(res.status).toBe(403);
  });

  it('returns 409 when inviting an email that is already a member', async () => {
    const { token, teamId } = await createTeamWithOwner('Dup Team', 'alice@example.com');
    await register('bob@example.com');
    await request(app)
      .post(`/api/teams/${teamId}/members`)
      .set('Authorization', `Bearer ${token}`)
      .send({ email: 'bob@example.com' });

    const res = await request(app)
      .post(`/api/teams/${teamId}/invites`)
      .set('Authorization', `Bearer ${token}`)
      .send({ email: 'BOB@example.com' });

    expect(res.status).toBe(409);
  });
});

describe('GET /api/teams/invites/:token', () => {
  it('returns the invite preview without auth', async () => {
    const { token, teamId } = await createTeamWithOwner('Preview Team', 'alice@example.com');
    await request(app)
      .post(`/api/teams/${teamId}/invites`)
      .set('Authorization', `Bearer ${token}`)
      .send({ email: 'carol@example.com' });

    const res = await request(app).get(`/api/teams/invites/${inviteToken('carol@example.com')}`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      teamName: 'Preview Team',
      invitedEmail: 'carol@example.com',
      role: 'member',
    });
  });

  it('returns 404 for an unknown token', async () => {
    const res = await request(app).get('/api/teams/invites/not-a-real-token');
    expect(res.status).toBe(404);
  });

  it('returns 410 for an expired invite', async () => {
    const { token, teamId } = await createTeamWithOwner('Old Team', 'alice@example.com');
    await request(app)
      .post(`/api/teams/${teamId}/invites`)
      .set('Authorization', `Bearer ${token}`)
      .send({ email: 'carol@example.com' });
    db.prepare('UPDATE team_invites SET expires_at = ?').run(
      new Date(Date.now() - 1000).toISOString(),
    );

    const res = await request(app).get(`/api/teams/invites/${inviteToken('carol@example.com')}`);
    expect(res.status).toBe(410);
  });
});

describe('POST /api/teams/invites/:token/accept', () => {
  it('full lifecycle: invite by email, preview logged out, register, accept, become member', async () => {
    const { token: tokenA, teamId } = await createTeamWithOwner('Life Team', 'alice@example.com');

    // Alice invites carol@example.com, who has no account yet
    const created = await request(app)
      .post(`/api/teams/${teamId}/invites`)
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ email: 'carol@example.com' });
    expect(created.status).toBe(201);

    // Logged-out preview
    const preview = await request(app).get(`/api/teams/invites/${inviteToken('carol@example.com')}`);
    expect(preview.status).toBe(200);
    expect(preview.body.teamName).toBe('Life Team');

    // Carol registers and accepts
    const tokenC = await register('carol@example.com');
    const accept = await request(app)
      .post(`/api/teams/invites/${inviteToken('carol@example.com')}/accept`)
      .set('Authorization', `Bearer ${tokenC}`);
    expect(accept.status).toBe(200);

    // Carol is now a member of the team
    const detail = await request(app)
      .get(`/api/teams/${teamId}`)
      .set('Authorization', `Bearer ${tokenA}`);
    expect(detail.status).toBe(200);
    expect(detail.body.members.map((m: { email: string }) => m.email)).toContain(
      'carol@example.com',
    );

    // Carol sees the team in her own list
    const carolList = await request(app).get('/api/teams').set('Authorization', `Bearer ${tokenC}`);
    expect(carolList.status).toBe(200);
    expect(carolList.body.items.map((t: { id: string }) => t.id)).toContain(teamId);
  });

  it('returns 403 when a different user accepts someone else\'s invite', async () => {
    const { token, teamId } = await createTeamWithOwner('Not Yours', 'alice@example.com');
    await request(app)
      .post(`/api/teams/${teamId}/invites`)
      .set('Authorization', `Bearer ${token}`)
      .send({ email: 'carol@example.com' });

    const tokenD = await register('dave@example.com');
    const res = await request(app)
      .post(`/api/teams/invites/${inviteToken('carol@example.com')}/accept`)
      .set('Authorization', `Bearer ${tokenD}`);

    expect(res.status).toBe(403);
  });

  it('returns 409 on double accept', async () => {
    const { token, teamId } = await createTeamWithOwner('Once Only', 'alice@example.com');
    await request(app)
      .post(`/api/teams/${teamId}/invites`)
      .set('Authorization', `Bearer ${token}`)
      .send({ email: 'carol@example.com' });

    const tokenC = await register('carol@example.com');
    const url = `/api/teams/invites/${inviteToken('carol@example.com')}/accept`;
    const first = await request(app).post(url).set('Authorization', `Bearer ${tokenC}`);
    const second = await request(app).post(url).set('Authorization', `Bearer ${tokenC}`);

    expect(first.status).toBe(200);
    expect(second.status).toBe(409);
  });

  it('returns 410 for an expired invite', async () => {
    const { token, teamId } = await createTeamWithOwner('Stale Team', 'alice@example.com');
    await request(app)
      .post(`/api/teams/${teamId}/invites`)
      .set('Authorization', `Bearer ${token}`)
      .send({ email: 'carol@example.com' });
    db.prepare('UPDATE team_invites SET expires_at = ?').run(
      new Date(Date.now() - 1000).toISOString(),
    );

    const tokenC = await register('carol@example.com');
    const res = await request(app)
      .post(`/api/teams/invites/${inviteToken('carol@example.com')}/accept`)
      .set('Authorization', `Bearer ${tokenC}`);

    expect(res.status).toBe(410);
  });

  it('requires auth', async () => {
    const { token, teamId } = await createTeamWithOwner('Auth Team', 'alice@example.com');
    await request(app)
      .post(`/api/teams/${teamId}/invites`)
      .set('Authorization', `Bearer ${token}`)
      .send({ email: 'carol@example.com' });

    const res = await request(app).post(
      `/api/teams/invites/${inviteToken('carol@example.com')}/accept`,
    );
    expect(res.status).toBe(401);
  });
});
