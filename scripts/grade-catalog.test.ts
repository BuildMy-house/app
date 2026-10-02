import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import type { AssetQualityScoreRow, DbAdapter } from '../server/src/db.js'
import type { CatalogEntry } from '../src/services/asset-ingestion-service.js'
import {
  assetVersionOf,
  buildScoreRow,
  combineUvScore,
  computeComposite,
  createFixTicket,
  deriveFallbackMaterial,
  findRenderPath,
  mapsPresentFromSlots,
  resolveFlag,
  rowsNeedingTickets,
  textureMaxPxFromMetrics,
  upsertScore,
  type GlbMetrics,
} from './grade-catalog.js'

const metrics = (over: Partial<GlbMetrics> = {}): GlbMetrics => ({
  triangleCount: 600,
  meshCount: 1,
  textureCount: 0,
  textures: [],
  pbrMapSlots: { baseColor: false, normal: false, ao: false, metalnessRoughness: false, emissive: false },
  metallicFactorAuthored: false,
  roughnessFactorAuthored: false,
  ...over,
})

const entry = (over: Partial<CatalogEntry> = {}): CatalogEntry => ({
  catalogId: 'sh3d-full#Test#chair',
  name: 'Test Chair',
  category: 'Seating',
  width: 50,
  depth: 50,
  height: 90,
  elevation: 0,
  color: 0xcccccc,
  doorOrWindow: false,
  tags: [],
  modelPath: 'https://assets.buildmy.house/models/chair.glb?v=v7',
  renderModelPath: 'https://assets.buildmy.house/models/chair.obj',
  ...over,
})

const row = (over: Partial<AssetQualityScoreRow> = {}): AssetQualityScoreRow => ({
  id: 'row-1',
  catalog_id: 'sh3d-full#Test#chair',
  asset_version: 'v7',
  poly_count: 600,
  used_fallback_material: 0,
  has_base_color_texture: 1,
  has_pbr_maps: 1,
  texture_max_px: 1024,
  render_profile: 'luxcore',
  render_path: '/tmp/render.png',
  camera_preset: '{}',
  score_geometry: 100,
  score_uv_texture: 80,
  score_material: 75,
  score_render_fidelity: 70,
  score_composite: 79.75,
  judge_notes: 'fine',
  score_source: 'photoreal-vision',
  scored_at: '2026-10-02T00:00:00.000Z',
  flagged_for_fix: 0,
  fix_ticket_id: null,
  ...over,
})

/** In-memory asset_quality_scores: parses column lists out of the SQL we emit. */
function fakeDb(): DbAdapter {
  const byCatalog = new Map<string, AssetQualityScoreRow>()
  const db: DbAdapter = {
    _brand: 'DbAdapter',
    async get<T>(sql: string, ...params: unknown[]) {
      if (!sql.includes('FROM asset_quality_scores')) return undefined
      return (byCatalog.get(params[0] as string) ?? undefined) as T | undefined
    },
    async all<T>() {
      return [...byCatalog.values()] as T[]
    },
    async run(sql: string, ...params: unknown[]) {
      if (sql.startsWith('INSERT INTO asset_quality_scores')) {
        const cols = /\(([^)]+)\)/.exec(sql)![1].split(',').map((c) => c.trim())
        const r = Object.fromEntries(cols.map((c, i) => [c, params[i]])) as AssetQualityScoreRow
        byCatalog.set(r.catalog_id, r)
        return { changes: 1, lastInsertRowid: 1 }
      }
      if (sql.startsWith('UPDATE asset_quality_scores') && sql.includes('WHERE catalog_id = ?')) {
        const existing = byCatalog.get(params[1] as string)
        if (existing) existing.fix_ticket_id = params[0] as string
        return { changes: existing ? 1 : 0, lastInsertRowid: 0 }
      }
      if (sql.startsWith('UPDATE asset_quality_scores') && sql.includes('WHERE id = ?')) {
        const setPart = sql.slice(sql.indexOf('SET') + 3, sql.indexOf('WHERE'))
        const cols = setPart.split(',').map((c) => c.trim().split(' ')[0]!)
        const id = params[params.length - 1] as string
        const existing = [...byCatalog.values()].find((r) => r.id === id)
        if (!existing) return { changes: 0, lastInsertRowid: 0 }
        cols.forEach((c, i) => {
          ;(existing as unknown as Record<string, unknown>)[c] = params[i]
        })
        return { changes: 1, lastInsertRowid: 0 }
      }
      return { changes: 0, lastInsertRowid: 0 }
    },
    async exec() {},
    async transaction(fn) {
      return fn(db)
    },
    async initSchema() {},
  }
  return db
}

const jsonPost = (body: unknown, status = 200) => async (): Promise<Response> =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

describe('assetVersionOf', () => {
  it('uses the ?v= tag when present', () => {
    expect(assetVersionOf(entry({ modelPath: 'https://x/y.glb?v=orientation-90-v1' }))).toBe('orientation-90-v1')
  })

  it('falls back to a stable 12-char hash of the path', () => {
    const e = entry({ modelPath: 'https://x/y.glb' })
    expect(assetVersionOf(e)).toBe(assetVersionOf(e))
    expect(assetVersionOf(e)).toMatch(/^[0-9a-f]{12}$/)
  })
})

describe('deriveFallbackMaterial', () => {
  it('clears fallback when any factor is authored', () => {
    expect(deriveFallbackMaterial(metrics({ metallicFactorAuthored: true }))).toBe(false)
    expect(deriveFallbackMaterial(metrics({ roughnessFactorAuthored: true }))).toBe(false)
  })

  it('clears fallback when a base color texture exists', () => {
    expect(deriveFallbackMaterial(metrics({ pbrMapSlots: { baseColor: true, normal: false, ao: false, metalnessRoughness: false, emissive: false } }))).toBe(false)
  })

  it('flags fallback when nothing is authored and no base color map', () => {
    expect(deriveFallbackMaterial(metrics())).toBe(true)
  })
})

describe('mapsPresentFromSlots', () => {
  it('expands the merged metalnessRoughness slot and ignores emissive', () => {
    const m = mapsPresentFromSlots({ baseColor: true, normal: true, ao: false, metalnessRoughness: true, emissive: true })
    expect(m).toEqual({ normal: true, metalness: true, roughness: true, ao: false })
  })
})

describe('textureMaxPxFromMetrics', () => {
  it('returns null with no textures', () => {
    expect(textureMaxPxFromMetrics(metrics())).toBeNull()
  })

  it('ignores zero dims and takes the max', () => {
    expect(textureMaxPxFromMetrics(metrics({ textures: [
      { slot: 'baseColor', width: 0, height: 0 },
      { slot: 'normal', width: 512, height: 256 },
    ], textureCount: 2 }))).toBe(512)
  })
})

describe('combineUvScore', () => {
  it('passes metadata through when no vision score', () => {
    expect(combineUvScore(80, null)).toBe(80)
  })

  it('blends 40% metadata + 60% vision', () => {
    expect(combineUvScore(80, 50)).toBeCloseTo(62)
  })
})

describe('computeComposite', () => {
  it('delegates to the rubric when rendered', () => {
    expect(computeComposite(100, 80, 75, 70)).toBe(79.75)
  })

  it('renormalizes the 0.7 metadata weight when unjudged', () => {
    expect(computeComposite(100, 100, 100, null)).toBe(100)
    expect(computeComposite(70, 0, 0, null)).toBeCloseTo((70 * 0.2) / 0.7)
  })
})

describe('resolveFlag', () => {
  it('null render cannot trip the fidelity branch', () => {
    expect(resolveFlag(60, null)).toBe(false)
    expect(resolveFlag(49, null)).toBe(true)
  })

  it('low render fidelity flags regardless of composite', () => {
    expect(resolveFlag(90, 29)).toBe(true)
    expect(resolveFlag(90, 30)).toBe(false)
  })
})

describe('buildScoreRow', () => {
  it('wires rubric outputs, preset json, and metadata-only source', () => {
    const r = buildScoreRow(entry(), metrics(), { renderFidelity: null, uvVisionScore: null, notes: null, renderPath: null })
    expect(r.catalog_id).toBe('sh3d-full#Test#chair')
    expect(r.asset_version).toBe('v7')
    expect(r.camera_preset).toContain('studio')
    expect(r.score_source).toBe('metadata-only')
    expect(r.render_profile).toBeNull()
    expect(r.flagged_for_fix).toBe(1) // default fixture: no textures -> low composite
  })

  it('marks photoreal-vision source and renders judged scores', () => {
    const r = buildScoreRow(entry(), metrics(), { renderFidelity: 90, uvVisionScore: 90, notes: 'ok', renderPath: '/x.png' })
    expect(r.score_source).toBe('photoreal-vision')
    expect(r.render_profile).toBe('luxcore')
    expect(r.render_path).toBe('/x.png')
    expect(r.judge_notes).toBe('ok')
  })
})

describe('upsertScore idempotency', () => {
  it('inserts once, updates on re-grade, never duplicates', async () => {
    const db = fakeDb()
    const r1 = row()
    await upsertScore(db, r1)
    const r2 = row({ id: 'row-2', score_composite: 12.5, flagged_for_fix: 1 })
    await upsertScore(db, r2)
    const all = await db.all<AssetQualityScoreRow>("SELECT * FROM asset_quality_scores WHERE catalog_id = 'x'")
    expect(all).toHaveLength(1)
    expect(all[0]!.score_composite).toBe(12.5)
    expect(all[0]!.flagged_for_fix).toBe(1)
  })

  it('preserves an existing fix_ticket_id when the new row has none', async () => {
    const db = fakeDb()
    await upsertScore(db, row({ fix_ticket_id: 'fix-login-bug' }))
    await upsertScore(db, row({ id: 'row-3', fix_ticket_id: null }))
    const all = await db.all<AssetQualityScoreRow>("SELECT * FROM asset_quality_scores WHERE catalog_id = 'x'")
    expect(all[0]!.fix_ticket_id).toBe('fix-login-bug')
  })
})

describe('rowsNeedingTickets', () => {
  it('picks flagged rows without tickets only', () => {
    const rows = [
      row({ id: 'a', catalog_id: 'a', flagged_for_fix: 1, fix_ticket_id: null }),
      row({ id: 'b', catalog_id: 'b', flagged_for_fix: 1, fix_ticket_id: 'existing-slug' }),
      row({ id: 'c', catalog_id: 'c', flagged_for_fix: 0, fix_ticket_id: null }),
    ]
    expect(rowsNeedingTickets(rows).map((r) => r.catalog_id)).toEqual(['a'])
  })
})

describe('createFixTicket', () => {
  it('returns the slug from a steward create_work response', async () => {
    const slug = await createFixTicket('c#x', 'notes', jsonPost({
      result: { content: [{ text: '{"slug":"fix-flagged-asset-c-x","status":"todo"}' }] },
    }))
    expect(slug).toBe('fix-flagged-asset-c-x')
  })

  it('returns null on non-2xx and on unparseable responses', async () => {
    expect(await createFixTicket('c', 'n', jsonPost({}, 500))).toBeNull()
    expect(await createFixTicket('c', 'n', jsonPost({ result: { content: [{ text: 'no slug here' }] } }))).toBeNull()
  })
})

describe('findRenderPath', () => {
  let dir: string | undefined
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true })
    dir = undefined
  })

  it('finds plain and #-escaped render files', () => {
    dir = mkdtempSync(join(tmpdir(), 'grade-catalog-'))
    writeFileSync(join(dir, 'sh3d-full#Test#chair.png'), 'x')
    expect(findRenderPath(dir, 'sh3d-full#Test#chair')).toBe(join(dir, 'sh3d-full#Test#chair.png'))
    writeFileSync(join(dir, 'sh3d-full__Test__lamp.png'), 'x')
    expect(findRenderPath(dir, 'sh3d-full#Test#lamp')).toBe(join(dir, 'sh3d-full__Test__lamp.png'))
    expect(findRenderPath(dir, 'sh3d-full#Test#missing')).toBeNull()
  })
})
