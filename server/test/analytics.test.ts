import request from 'supertest';
import Database from 'better-sqlite3';
import type { Express } from 'express';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';

process.env.JWT_SECRET = 'test-secret';
process.env.ANALYTICS_ADMIN_TOKEN = 'admin-token-for-tests';

let app: Express;
let db: Database.Database;

beforeEach(async () => {
  db = new Database(':memory:');
  app = await createApp(db, 'data/assets');
});
afterEach(() => db.close());

const admin = { Authorization: 'Bearer admin-token-for-tests' };
const post = (sid: string, events: unknown[], aid = 'device-' + sid) =>
  request(app).post('/api/analytics/events').send({ sid, aid, events });

describe('analytics events', () => {
  it('accepts whitelisted events and drops unknown ones and bad props', async () => {
    const res = await post('session-aaaaaaaa', [
      { name: 'session_start' },
      { name: 'not_an_event' },
      { name: 'plan_exported', props: { kind: 'png_plan', nested: { x: 1 }, long: 'x'.repeat(500) } },
    ]);
    expect(res.status).toBe(202);
    expect(res.body.accepted).toBe(2);
    const row = db.prepare("SELECT props FROM analytics_events WHERE name='plan_exported'").get() as { props: string };
    const props = JSON.parse(row.props);
    expect(props.kind).toBe('png_plan');
    expect(props.nested).toBeUndefined();
    expect(props.long).toHaveLength(64);
  });

  it('rejects an invalid sid and oversized batches', async () => {
    expect((await post('x', [{ name: 'session_start' }])).status).toBe(400);
    const many = Array.from({ length: 21 }, () => ({ name: 'pageview' }));
    expect((await post('session-aaaaaaaa', many)).status).toBe(400);
  });
});

describe('feedback', () => {
  it('stores feedback with sid and state, no login needed', async () => {
    const res = await request(app)
      .post('/api/analytics/feedback')
      .send({ sid: 'session-aaaaaaaa', message: ' love it ', email: 'A@B.co', state: { walls: 4, furniture: 2 } });
    expect(res.status).toBe(201);
    const row = db.prepare('SELECT * FROM feedback').get() as any;
    expect(row.message).toBe('love it');
    expect(row.email).toBe('a@b.co');
    expect(JSON.parse(row.state)).toEqual({ walls: 4, furniture: 2 });
  });

  it('validates message and email', async () => {
    const base = { sid: 'session-aaaaaaaa' };
    expect((await request(app).post('/api/analytics/feedback').send({ ...base, message: '' })).status).toBe(400);
    expect((await request(app).post('/api/analytics/feedback').send({ ...base, message: 'hi', email: 'nope' })).status).toBe(400);
  });
});

describe('GET /api/analytics/kpis', () => {
  it('requires the admin token', async () => {
    expect((await request(app).get('/api/analytics/kpis')).status).toBe(401);
    expect((await request(app).get('/api/analytics/kpis').set('Authorization', 'Bearer wrong')).status).toBe(401);
  });

  it('computes activation, time-to-3D, DAU, top events and feedback', async () => {
    const t0 = Date.now() - 60_000;
    // s1: furnished 3D view after 10s. s2: 3D only after 30s. s3: bounced.
    await post('session-000001', [
      { name: 'session_start', ts: t0 },
      { name: 'first_furniture_placed', ts: t0 + 5_000 },
      { name: 'first_3d_view_opened', ts: t0 + 10_000 },
    ]);
    await post('session-000002', [
      { name: 'session_start', ts: t0 },
      { name: 'first_3d_view_opened', ts: t0 + 30_000 },
    ]);
    await post('session-000003', [{ name: 'session_start', ts: t0 }]);
    await request(app).post('/api/analytics/feedback').send({ sid: 'session-000001', message: 'nice' });

    const res = await request(app).get('/api/analytics/kpis?days=7').set(admin);
    expect(res.status).toBe(200);
    expect(res.body.activation.sessions_started).toBe(3);
    expect(res.body.activation.sessions_with_furnished_3d_view).toBe(1);
    expect(res.body.activation.activation_rate_furnished_3d).toBeCloseTo(1 / 3, 3);
    expect(res.body.activation.rate_3d_view_opened).toBeCloseTo(2 / 3, 3);
    expect(res.body.activation.time_to_first_3d_view_ms.median).toBe(20_000);
    expect(res.body.daily_active_users.reduce((n: number, d: { users: number }) => n + d.users, 0)).toBe(3);
    expect(res.body.top_events[0]).toMatchObject({ name: 'session_start', events: 3 });
    expect(res.body.recent_feedback[0].message).toBe('nice');
  });

  it('computes D1/D7 retention from device ids', async () => {
    const day = 86_400_000;
    const now = Date.now();
    const ins = db.prepare('INSERT INTO analytics_events (id, sid, aid, name, props, ts) VALUES (?, ?, ?, ?, NULL, ?)');
    let n = 0;
    const seen = (aid: string, daysAgo: number) => ins.run('id' + n++, 'session-' + n, aid, 'session_start', now - daysAgo * day);
    // A: first -9, back at -8 (D1) and -2 (D7)
    seen('device-A', 9); seen('device-A', 8); seen('device-A', 2);
    // B: only day -9 (D1 no, D7 no)
    seen('device-B', 9);
    // C: first seen today -> not eligible for D1 yet
    seen('device-C', 0);
    const res = await request(app).get('/api/analytics/kpis?days=30').set(admin);
    expect(res.body.retention.d1).toEqual({ eligible: 2, retained: 1, rate: 0.5 });
    expect(res.body.retention.d7).toEqual({ eligible: 2, retained: 1, rate: 0.5 });
  });
});
