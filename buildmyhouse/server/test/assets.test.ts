import request from 'supertest';
import jwt from 'jsonwebtoken';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import type { Express } from 'express';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { getJwtSecret } from '../src/config.js';
import { AssetStorage } from '../src/storage.js';

process.env.JWT_SECRET = 'test-secret';

const b64 = (buf: Buffer) => buf.toString('base64');

/** Minimal structurally-valid GLB: magic "glTF" + version 2 + length (little-endian). */
function glbPayload(extra = 0): Buffer {
  const total = 12 + extra;
  const buf = Buffer.alloc(total);
  buf.writeUInt32LE(0x46546c67, 0);
  buf.writeUInt32LE(2, 4);
  buf.writeUInt32LE(total, 8);
  return buf;
}

let app: Express;
let db: Database.Database;
let assetRoot: string;
const openDbs: Database.Database[] = [];

beforeEach(async () => {
  assetRoot = mkdtempSync(join(tmpdir(), 'homely-assets-'));
  db = new Database(':memory:');
  openDbs.push(db);
  app = await createApp(db, assetRoot);
});

afterEach(() => {
  for (const d of openDbs.splice(0)) d.close();
  rmSync(assetRoot, { recursive: true, force: true });
});

async function register(email: string): Promise<string> {
  const res = await request(app).post('/api/auth/register').send({ email, password: 'password123' });
  expect(res.status).toBe(201);
  return res.body.token as string;
}

const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

const userIdOf = (token: string) => jwt.verify(token, getJwtSecret()).sub as string;

const record = (over: Record<string, unknown> = {}) => ({
  id: 'asset-1',
  catalogId: 'cat-1',
  name: 'Table',
  category: 'furniture',
  width: 100,
  depth: 50,
  height: 75,
  color: 0xffffff,
  blobKey: 'blob:asset-1',
  createdAt: 1234,
  ...over,
});

/** Every file under the assets root, as root-relative paths. */
function walkFiles(dir: string, prefix = ''): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walkFiles(join(dir, e.name), `${prefix}${e.name}/`) : [`${prefix}${e.name}`],
  );
}

describe('POST /api/assets/:userId', () => {
  it('uploads a GLB for a user acting on their own data', async () => {
    const token = await register('alice@example.com');
    const myId = userIdOf(token);

    const res = await request(app)
      .post(`/api/assets/${myId}`)
      .set(auth(token))
      .send({ record: record(), glb: b64(glbPayload()), source: b64(Buffer.from('src')) });

    expect(res.status).toBe(201);
    expect(res.body.id).toBe('asset-1');
    expect(res.body.name).toBe('Table');
    expect(existsSync(join(assetRoot, myId, 'asset-1.glb'))).toBe(true);
  });

  it('rejects a non-GLB upload server-side (bad magic number)', async () => {
    const token = await register('bob@example.com');
    const myId = userIdOf(token);

    const res = await request(app)
      .post(`/api/assets/${myId}`)
      .set(auth(token))
      .send({ record: record(), glb: b64(Buffer.from('this is not glb data at all...')) });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/not a GLB/i);
  });

  it('rejects with 403 when the JWT user does not match the path userId', async () => {
    const tokenA = await register('alice@example.com');

    const res = await request(app)
      .post('/api/assets/some-other-user-id')
      .set(auth(tokenA))
      .send({ record: record(), glb: b64(glbPayload()) });

    expect(res.status).toBe(403);
  });
});

describe('H17 path-traversal regression (POST /api/assets/:userId)', () => {
  it("rejects the exact exploit — record.id with ../ targeting another user's existing asset — with 400, writes nothing, leaves victim content byte-identical", async () => {
    const victimToken = await register('victim@example.com');
    const victimId = userIdOf(victimToken);
    const attackerToken = await register('attacker@example.com');
    const attackerId = userIdOf(attackerToken);

    // Victim owns a real, pre-existing asset on disk.
    const victimGlb = glbPayload(32);
    const victimUpload = await request(app)
      .post(`/api/assets/${victimId}`)
      .set(auth(victimToken))
      .send({ record: record({ id: 'victim-asset-1' }), glb: b64(victimGlb) });
    expect(victimUpload.status).toBe(201);
    const victimFile = join(assetRoot, victimId, 'victim-asset-1.glb');
    expect(existsSync(victimFile)).toBe(true);

    // The exploit: join(root, attackerId, "../<victimId>/victim-asset-1.glb")
    // resolves to the victim's actual file path.
    const res = await request(app)
      .post(`/api/assets/${attackerId}`)
      .set(auth(attackerToken))
      .send({ record: record({ id: `../${victimId}/victim-asset-1` }), glb: b64(glbPayload(64)) });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid asset id');

    // Direct filesystem proof: the ONLY file anywhere under the assets root
    // is the victim's original, with unchanged content. Nothing new was
    // created (the attacker's directory was never even mkdir'ed).
    expect(walkFiles(assetRoot)).toEqual([`${victimId}/victim-asset-1.glb`]);
    expect(readFileSync(victimFile)).toEqual(victimGlb);
    expect(existsSync(join(assetRoot, attackerId))).toBe(false);
  });

  it('rejects other traversal/hostile id variants with 400', async () => {
    const token = await register('dora@example.com');
    const myId = userIdOf(token);

    for (const badId of ['..', '../..', 'a/b', 'a\\b', '.', `${'x'.repeat(129)}`, 'id with spaces', 'id\ud83d\ude00']) {
      const res = await request(app)
        .post(`/api/assets/${myId}`)
        .set(auth(token))
        .send({ record: record({ id: badId }), glb: b64(glbPayload()) });
      expect(res.status, `id=${JSON.stringify(badId)}`).toBe(400);
      expect(res.body.error).toBe('invalid asset id');
    }

    // Nothing was written at all.
    expect(walkFiles(assetRoot)).toEqual([]);
  });

  it('still accepts safe client-supplied ids (dashes, underscores, uppercase) unchanged', async () => {
    const token = await register('erin@example.com');
    const myId = userIdOf(token);

    const res = await request(app)
      .post(`/api/assets/${myId}`)
      .set(auth(token))
      .send({ record: record({ id: 'My_Model-9' }), glb: b64(glbPayload()) });

    expect(res.status).toBe(201);
    expect(res.body.id).toBe('My_Model-9');
    expect(existsSync(join(assetRoot, myId, 'My_Model-9.glb'))).toBe(true);
  });
});

describe('GET /api/assets/:userId', () => {
  it("lists only the authenticated user's own assets", async () => {
    const tokenA = await register('alice@example.com');
    const idA = userIdOf(tokenA);
    const tokenB = await register('bob@example.com');
    const idB = userIdOf(tokenB);

    await request(app).post(`/api/assets/${idA}`).set(auth(tokenA)).send({ record: record({ id: 'a-1' }), glb: b64(glbPayload()) });
    await request(app).post(`/api/assets/${idB}`).set(auth(tokenB)).send({ record: record({ id: 'b-1' }), glb: b64(glbPayload()) });

    const mine = await request(app).get(`/api/assets/${idA}`).set(auth(tokenA));
    expect(mine.status).toBe(200);
    expect(mine.body.items.map((r: { id: string }) => r.id)).toEqual(['a-1']);
  });
});

describe('GET /api/assets/:userId/:id/model', () => {
  it('returns the raw GLB blob for the owner', async () => {
    const token = await register('alice@example.com');
    const myId = userIdOf(token);
    const glb = glbPayload(16);

    await request(app).post(`/api/assets/${myId}`).set(auth(token)).send({ record: record(), glb: b64(glb) });

    const res = await request(app)
      .get(`/api/assets/${myId}/asset-1/model`)
      .set(auth(token))
      .buffer()
      .parse((res2, callback) => {
        const chunks: Buffer[] = [];
        res2.on('data', (chunk: Buffer) => chunks.push(chunk));
        res2.on('end', () => callback(null, Buffer.concat(chunks)));
      });
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/gltf-binary/);
    expect(res.body).toEqual(glb);
  });
});

describe('DELETE /api/assets/:userId/:id', () => {
  it("deletes the owner's own asset and its files", async () => {
    const token = await register('alice@example.com');
    const myId = userIdOf(token);
    await request(app)
      .post(`/api/assets/${myId}`)
      .set(auth(token))
      .send({ record: record(), glb: b64(glbPayload()), source: b64(Buffer.from('src')) });

    expect(readdirSync(join(assetRoot, myId))).toContain('asset-1.glb');

    const del = await request(app).delete(`/api/assets/${myId}/asset-1`).set(auth(token));
    expect(del.status).toBe(204);

    const list = await request(app).get(`/api/assets/${myId}`).set(auth(token));
    expect(list.body.items).toEqual([]);
  });
});

describe('AssetStorage defense-in-depth (layer 2, independent of HTTP)', () => {
  it('throws on traversal fileName for save/read/remove', () => {
    const storage = new AssetStorage(assetRoot);

    expect(() => storage.save('user-1', '../victim/asset-1.glb', Buffer.from('x'))).toThrow(/unsafe fileName/);
    expect(() => storage.read('user-1', '../../../etc/passwd')).toThrow(/unsafe fileName/);
    expect(() => storage.remove('user-1', '..\\..\\evil.glb')).toThrow(/unsafe fileName/);
  });

  it('throws on traversal userId for save/read/remove', () => {
    const storage = new AssetStorage(assetRoot);

    expect(() => storage.save('../victim', 'ok.glb', Buffer.from('x'))).toThrow(/unsafe userId/);
    expect(() => storage.read('..', 'ok.glb')).toThrow(/unsafe userId/);
    expect(() => storage.remove('a/b', 'ok.glb')).toThrow(/unsafe userId/);
  });

  it('accepts legitimate ids, refuses the empty fileName, and never touches the disk when throwing', () => {
    const storage = new AssetStorage(assetRoot);

    expect(() => storage.save('user-1', 'asset-1.glb', Buffer.from('glb!'))).not.toThrow();
    expect(() => storage.save('user-1', 'asset-1.source', Buffer.from('src'))).not.toThrow();
    expect(storage.read('user-1', 'asset-1.glb')).toEqual(Buffer.from('glb!'));
    expect(() => storage.remove('user-1', '')).toThrow(/unsafe fileName/);

    // Only the two files above exist — no traversal target was created.
    expect(walkFiles(assetRoot).sort()).toEqual(['user-1/asset-1.glb', 'user-1/asset-1.source']);
  });
});

describe('H17 path-traversal regression (POST /api/assets/:userId)', () => {
  it('rejects a ../ record.id targeting another user\'s asset file, leaving the victim\'s file byte-identical', async () => {
    const victimToken = await register('victim@example.com');
    const victimId = jwt.verify(victimToken, getJwtSecret()).sub as string;
    const attackerToken = await register('attacker@example.com');
    const attackerId = jwt.verify(attackerToken, getJwtSecret()).sub as string;

    const victimGlb = glbPayload(32);
    await request(app)
      .post(`/api/assets/${victimId}`)
      .set('Authorization', `Bearer ${victimToken}`)
      .send({ record: record({ id: 'victim-asset' }), glb: b64(victimGlb) });

    const victimFile = join(assetRoot, victimId, 'victim-asset.glb');
    expect(readFileSync(victimFile)).toEqual(victimGlb);

    // Exact exploit shape: traversal id cancels the attacker's own directory
    // segment and resolves onto the victim's stored file path.
    const res = await request(app)
      .post(`/api/assets/${attackerId}`)
      .set('Authorization', `Bearer ${attackerToken}`)
      .send({
        record: record({ id: `../${victimId}/victim-asset` }),
        glb: b64(glbPayload(64)),
      });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid asset id');

    // Filesystem proof: victim's content unchanged, and the rejected upload
    // created nothing — not even the attacker's own directory.
    expect(readFileSync(victimFile)).toEqual(victimGlb);
    expect(readdirSync(assetRoot)).toEqual([victimId]);
    expect(existsSync(join(assetRoot, attackerId))).toBe(false);
  });

  it('rejects other traversal/unsafe id shapes with 400', async () => {
    const token = await register('dora@example.com');
    const myId = jwt.verify(token, getJwtSecret()).sub as string;

    for (const badId of ['..', 'a/b', 'a\\b', '.', 'id with space', 'id.dot', 'a'.repeat(129), '']) {
      const res = await request(app)
        .post(`/api/assets/${myId}`)
        .set('Authorization', `Bearer ${token}`)
        .send({ record: record({ id: badId }), glb: b64(glbPayload()) });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('invalid asset id');
    }
  });
});

describe('AssetStorage defense-in-depth (layer 2 works independently)', () => {
  it('save/read/remove throw on traversal fileName and write nothing', () => {
    const storage = new AssetStorage(assetRoot);
    for (const bad of ['../evil.glb', 'a/../b.glb', '/etc/passwd', '.glb', 'x.glb.source', 'x.txt', 'x'.repeat(129) + '.glb']) {
      expect(() => storage.save('u1', bad, Buffer.from('x')), bad).toThrow();
      expect(() => storage.read('u1', bad), bad).toThrow();
      expect(() => storage.remove('u1', bad), bad).toThrow();
    }
    expect(existsSync(join(assetRoot, 'u1'))).toBe(false);
  });

  it('throws on traversal userId', () => {
    const storage = new AssetStorage(assetRoot);
    expect(() => storage.save('../victim', 'x.glb', Buffer.from('x'))).toThrow();
    expect(() => storage.read('../victim', 'x.glb')).toThrow();
    expect(() => storage.remove('../victim', 'x.glb')).toThrow();
    expect(existsSync(join(assetRoot, 'victim'))).toBe(false);
  });

  it('accepts legitimate <id>.glb / <id>.source names (account-deletion path)', () => {
    const storage = new AssetStorage(assetRoot);
    const path = storage.save('u-1', 'asset-1.glb', Buffer.from('glbbytes'));
    expect(path).toBe(join(assetRoot, 'u-1', 'asset-1.glb'));
    storage.save('u-1', 'asset-1.source', Buffer.from('src'));
    expect(storage.read('u-1', 'asset-1.glb')).toEqual(Buffer.from('glbbytes'));
    storage.remove('u-1', 'asset-1.source');
    expect(existsSync(join(assetRoot, 'u-1', 'asset-1.source'))).toBe(false);
    expect(storage.read('u-1', 'asset-1.source')).toBeUndefined();
  });
});
