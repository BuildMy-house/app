#!/usr/bin/env node
/**
 * grade-catalog.ts — AQS-4 catalog grading orchestrator (proposal Part F a–e).
 *
 * Grades every catalog asset by combining deterministic metadata scoring
 * (scripts/grading/rubric.ts) with optional photoreal render vision-judging
 * (scripts/grading/vision-judge-photoreal.ts), persists one row per asset to
 * the `asset_quality_scores` table (upsert on catalog_id — idempotent), and
 * files a Steward fix ticket for flagged rows that don't have one yet.
 *
 * Usage:
 *   npx tsx scripts/grade-catalog.ts                        # grade whole catalog
 *   npx tsx scripts/grade-catalog.ts --catalog-id=<id>      # one asset
 *   npx tsx scripts/grade-catalog.ts --ids=a,b,c            # subset
 *   npx tsx scripts/grade-catalog.ts --render-dir=<dir>     # pick up aqs-5 LuxCore renders
 *   npx tsx scripts/grade-catalog.ts --dry-run              # print, write nothing
 *
 * Semantics:
 * - Renders are NOT produced here. The photoreal render path is the aqs-5
 *   pipeline (quality-rating/ driver + luxcore/); this script accepts
 *   already-captured renders from --render-dir named `<catalogId>.png`
 *   (or `<catalogId with '#' → '__'>.png`) and vision-judges them in one
 *   batch. Assets without a render are graded metadata-only: the composite
 *   renormalizes the three metadata weights over 0.7, and an unjudged render
 *   can never trip the render-fidelity flag branch.
 * - The judge returns -1 scores when it could not judge; -1 is never folded
 *   into math — that asset falls back to metadata-only.
 * - usedFallbackMaterial is not stored in the GLB and has no existing
 *   derivation in the codebase, so it is derived conservatively: an asset
 *   counts as fallback material when NO material authored metallic/roughness
 *   factors AND there is no base-color texture slot (i.e. the runtime shows
 *   nothing but spec-default gray). Authored factors or any base-color map
 *   clear it.
 * - Upsert: asset_quality_scores.catalog_id has no UNIQUE constraint (and
 *   server/src/db.ts schema must not change), so this is a manual
 *   SELECT→UPDATE/INSERT, valid on both sqlite and postgres. A non-null
 *   fix_ticket_id already in the DB is never overwritten with null.
 * - Fix tickets go through the Steward ACS MCP endpoint (env
 *   STEWARD_MCP_URL, default http://localhost:4001/mcp/v1/messages) via
 *   create_work with the catalogId in the title; the returned slug is
 *   written back to fix_ticket_id so items are never double-ticketed. If
 *   ticket creation fails the row is left with fix_ticket_id NULL and is
 *   retried on the next run.
 */
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

import {
  compositeScore,
  isFlaggedForFix,
  scoreGeometry,
  scoreMaterialCompleteness,
  scoreUvTextureMetadata,
  type MapsPresent,
} from './grading/rubric.js'
import { judgePhotorealBatch } from './grading/vision-judge-photoreal.js'
import {
  collectIngestionMetrics,
  type CatalogEntry,
  type CatalogManifest,
} from '../src/services/asset-ingestion-service.js'
import type { AssetQualityScoreRow, DbAdapter } from '../server/src/db.js'
import { STANDARD_CAMERA_PRESET } from '../quality-rating/photoreal-fixtures/known-bad-scene.js'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const CATALOG_PATH = join(ROOT, 'assets', 'catalog', 'catalog.json')

export type GlbMetrics = NonNullable<ReturnType<typeof collectIngestionMetrics>>

const boolToInt = (b: boolean): number => (b ? 1 : 0)

/** `?v=` query param on modelPath is the asset version tag; fall back to a stable hash of the path. */
export function assetVersionOf(entry: Pick<CatalogEntry, 'modelPath'>): string {
  const tagged = /[?&]v=([^&]+)/.exec(entry.modelPath)
  if (tagged?.[1]) return decodeURIComponent(tagged[1])
  return createHash('sha256').update(entry.modelPath).digest('hex').slice(0, 12)
}

/** Conservative fallback-material derivation — see header docblock. */
export function deriveFallbackMaterial(metrics: GlbMetrics): boolean {
  if (metrics.metallicFactorAuthored || metrics.roughnessFactorAuthored) return false
  return !metrics.pbrMapSlots.baseColor
}

/** glTF packs metalness+roughness into one slot; the rubric scores them separately. */
export function mapsPresentFromSlots(slots: GlbMetrics['pbrMapSlots']): MapsPresent {
  return {
    normal: slots.normal,
    metalness: slots.metalnessRoughness,
    roughness: slots.metalnessRoughness,
    ao: slots.ao,
  }
}

export function textureMaxPxFromMetrics(metrics: GlbMetrics): number | null {
  let max = 0
  for (const t of metrics.textures) max = Math.max(max, t.width, t.height)
  return max > 0 ? max : null
}

/**
 * The UV dimension is 40% metadata + 60% vision when a render was judged
 * (per vision-judge-photoreal.ts's contract, the blend is the caller's job);
 * metadata alone otherwise.
 */
export function combineUvScore(metadataScore: number, uvVisionScore: number | null): number {
  if (uvVisionScore == null) return metadataScore
  return 0.4 * metadataScore + 0.6 * uvVisionScore
}

/** Full composite when rendered; metadata-only renormalizes the remaining 0.7 weight. */
export function computeComposite(
  geometry: number,
  uvTexture: number,
  material: number,
  renderFidelity: number | null,
): number {
  if (renderFidelity != null) return compositeScore({ geometry, uvTexture, material, renderFidelity })
  return Math.min(100, Math.max(0, ((geometry * 0.2 + uvTexture * 0.25 + material * 0.25) / 0.7)))
}

/** An unjudged render (null) cannot fail the render-fidelity branch. */
export function resolveFlag(composite: number, renderFidelity: number | null): boolean {
  return isFlaggedForFix(composite, renderFidelity ?? 100)
}

export function findRenderPath(renderDir: string, catalogId: string): string | null {
  const flat = join(renderDir, `${catalogId}.png`)
  if (existsSync(flat)) return flat
  const safe = join(renderDir, `${catalogId.split('#').join('__')}.png`)
  if (existsSync(safe)) return safe
  return null
}

export interface JudgedScores {
  renderFidelity: number | null
  uvVisionScore: number | null
  notes: string | null
  renderPath: string | null
}

export function buildScoreRow(entry: CatalogEntry, metrics: GlbMetrics, judged: JudgedScores): AssetQualityScoreRow {
  const polyCount = Math.round(metrics.triangleCount)
  const usedFallback = deriveFallbackMaterial(metrics)
  const mapsPresent = mapsPresentFromSlots(metrics.pbrMapSlots)
  const textureMaxPx = textureMaxPxFromMetrics(metrics)
  const hasPbrMaps = mapsPresent.normal || mapsPresent.metalness || mapsPresent.roughness || mapsPresent.ao

  const geometry = scoreGeometry(polyCount, entry.category)
  const uvTexture = combineUvScore(
    scoreUvTextureMetadata(metrics.pbrMapSlots.baseColor, hasPbrMaps, textureMaxPx),
    judged.uvVisionScore,
  )
  const material = scoreMaterialCompleteness(usedFallback, mapsPresent)
  const composite = computeComposite(geometry, uvTexture, material, judged.renderFidelity)

  return {
    id: randomUUID(),
    catalog_id: entry.catalogId,
    asset_version: assetVersionOf(entry),
    poly_count: polyCount,
    used_fallback_material: boolToInt(usedFallback),
    has_base_color_texture: boolToInt(metrics.pbrMapSlots.baseColor),
    has_pbr_maps: boolToInt(hasPbrMaps),
    texture_max_px: textureMaxPx,
    render_profile: judged.renderPath ? 'luxcore' : null,
    render_path: judged.renderPath,
    camera_preset: JSON.stringify(STANDARD_CAMERA_PRESET),
    score_geometry: geometry,
    score_uv_texture: uvTexture,
    score_material: material,
    score_render_fidelity: judged.renderFidelity,
    score_composite: composite,
    judge_notes: judged.notes,
    score_source: judged.renderFidelity != null ? 'photoreal-vision' : 'metadata-only',
    scored_at: new Date().toISOString(),
    flagged_for_fix: boolToInt(resolveFlag(composite, judged.renderFidelity)),
    fix_ticket_id: null,
  }
}

/** Manual upsert — catalog_id has no UNIQUE constraint (works on sqlite and postgres alike). */
export async function upsertScore(db: DbAdapter, row: AssetQualityScoreRow): Promise<void> {
  const existing = await db.get<Pick<AssetQualityScoreRow, 'id' | 'fix_ticket_id'>>(
    'SELECT id, fix_ticket_id FROM asset_quality_scores WHERE catalog_id = ?',
    row.catalog_id,
  )
  // Never clobber an existing ticket reference with null — that would re-ticket the asset.
  const fixTicketId = row.fix_ticket_id ?? existing?.fix_ticket_id ?? null

  if (existing) {
    await db.run(
      `UPDATE asset_quality_scores SET
        asset_version = ?, poly_count = ?, used_fallback_material = ?, has_base_color_texture = ?,
        has_pbr_maps = ?, texture_max_px = ?, render_profile = ?, render_path = ?, camera_preset = ?,
        score_geometry = ?, score_uv_texture = ?, score_material = ?, score_render_fidelity = ?,
        score_composite = ?, judge_notes = ?, score_source = ?, scored_at = ?, flagged_for_fix = ?,
        fix_ticket_id = ?
       WHERE id = ?`,
      row.asset_version, row.poly_count, row.used_fallback_material, row.has_base_color_texture,
      row.has_pbr_maps, row.texture_max_px, row.render_profile, row.render_path, row.camera_preset,
      row.score_geometry, row.score_uv_texture, row.score_material, row.score_render_fidelity,
      row.score_composite, row.judge_notes, row.score_source, row.scored_at, row.flagged_for_fix,
      fixTicketId,
      existing.id,
    )
    row.fix_ticket_id = fixTicketId
    return
  }

  await db.run(
    `INSERT INTO asset_quality_scores (
      id, catalog_id, asset_version, poly_count, used_fallback_material, has_base_color_texture,
      has_pbr_maps, texture_max_px, render_profile, render_path, camera_preset, score_geometry,
      score_uv_texture, score_material, score_render_fidelity, score_composite, judge_notes,
      score_source, scored_at, flagged_for_fix, fix_ticket_id
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    row.id, row.catalog_id, row.asset_version, row.poly_count, row.used_fallback_material,
    row.has_base_color_texture, row.has_pbr_maps, row.texture_max_px, row.render_profile,
    row.render_path, row.camera_preset, row.score_geometry, row.score_uv_texture, row.score_material,
    row.score_render_fidelity, row.score_composite, row.judge_notes, row.score_source, row.scored_at,
    row.flagged_for_fix, fixTicketId,
  )
  row.fix_ticket_id = fixTicketId
}

/** Only flagged rows without a ticket get one — this is the double-ticket guard. */
export function rowsNeedingTickets(rows: AssetQualityScoreRow[]): AssetQualityScoreRow[] {
  return rows.filter((r) => r.flagged_for_fix === 1 && !r.fix_ticket_id)
}

type PostFn = (url: string, init: RequestInit) => Promise<Response>

/**
 * Files a Steward ACS fix ticket for one flagged asset via the MCP endpoint
 * (JSON-RPC tools/call create_work). Returns the task slug on success, null
 * on any failure (caller leaves fix_ticket_id NULL and retries next run).
 * Equivalent direct call if the endpoint is unreachable:
 *   steward_create_work(agent_id: "aqs4-worker",
 *     title: "Fix flagged asset: <catalogId>", description: <judgeNotes + composite>)
 */
export async function createFixTicket(
  catalogId: string,
  judgeNotes: string,
  post: PostFn = fetch,
): Promise<string | null> {
  const url = process.env.STEWARD_MCP_URL ?? 'http://localhost:4001/mcp/v1/messages'
  const agentId = process.env.STEWARD_AGENT_ID ?? 'aqs4-worker'
  const body = {
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: {
      name: 'create_work',
      arguments: {
        agent_id: agentId,
        title: `Fix flagged asset: ${catalogId}`,
        description: judgeNotes || 'Flagged by asset quality scorecard (AQS-4).',
      },
    },
  }
  try {
    const res = await post(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    if (!res.ok) {
      console.warn(`[grade-catalog] ticket creation for ${catalogId} failed: HTTP ${res.status}`)
      return null
    }
    const payload = (await res.json()) as { result?: { content?: { text?: string }[] } }
    const text = payload.result?.content?.map((c) => c.text ?? '').join(' ') ?? ''
    const slug = /"slug"\s*:\s*"([a-z0-9][a-z0-9-]+)"/i.exec(text)?.[1]
    if (!slug) {
      console.warn(`[grade-catalog] could not parse slug from steward response for ${catalogId}: ${text.slice(0, 300)}`)
      return null
    }
    return slug
  } catch (err) {
    console.warn(`[grade-catalog] ticket creation for ${catalogId} failed: ${String(err)}`)
    return null
  }
}

async function loadGlbBuffer(modelPath: string): Promise<Buffer | null> {
  if (/^https?:\/\//.test(modelPath)) {
    const res = await fetch(modelPath)
    if (!res.ok) return null
    return Buffer.from(await res.arrayBuffer())
  }
  const local = join(ROOT, modelPath)
  const path = existsSync(local) ? local : modelPath
  if (!existsSync(path)) return null
  return readFileSync(path)
}

interface CliFlags {
  catalogId?: string
  ids?: string[]
  renderDir?: string
  dryRun: boolean
}

function parseFlags(argv: string[]): CliFlags {
  const flags: CliFlags = { dryRun: false }
  for (const arg of argv) {
    if (arg.startsWith('--catalog-id=')) flags.catalogId = arg.slice('--catalog-id='.length)
    else if (arg.startsWith('--ids=')) flags.ids = arg.slice('--ids='.length).split(',').map((s) => s.trim()).filter(Boolean)
    else if (arg.startsWith('--render-dir=')) flags.renderDir = arg.slice('--render-dir='.length)
    else if (arg === '--dry-run') flags.dryRun = true
  }
  return flags
}

async function main(): Promise<void> {
  const flags = parseFlags(process.argv.slice(2))
  const manifest = JSON.parse(readFileSync(CATALOG_PATH, 'utf8')) as CatalogManifest
  let entries = manifest.items
  if (flags.catalogId) entries = entries.filter((e) => e.catalogId === flags.catalogId)
  if (flags.ids?.length) entries = entries.filter((e) => flags.ids!.includes(e.catalogId))
  if (entries.length === 0) {
    console.warn('[grade-catalog] no catalog entries matched the given filters')
    return
  }

  // (a) metadata: reuse the real ingestion loaders per asset
  const graded: { entry: CatalogEntry; metrics: GlbMetrics }[] = []
  for (const entry of entries) {
    const buffer = await loadGlbBuffer(entry.modelPath)
    if (!buffer) {
      console.warn(`[grade-catalog] skip ${entry.catalogId}: GLB not loadable (${entry.modelPath})`)
      continue
    }
    const metrics = collectIngestionMetrics(buffer)
    if (!metrics) {
      console.warn(`[grade-catalog] skip ${entry.catalogId}: not a parseable GLB`)
      continue
    }
    graded.push({ entry, metrics })
  }

  // (c) render fidelity: pick up existing renders, vision-judge in one batch
  const renderPaths = new Map<string, string>()
  if (flags.renderDir) {
    for (const { entry } of graded) {
      const renderPath = findRenderPath(flags.renderDir, entry.catalogId)
      if (renderPath) renderPaths.set(entry.catalogId, renderPath)
    }
  }
  const judgeResults = new Map<string, { renderFidelity: number; uvVisionScore: number; notes: string }>()
  if (renderPaths.size > 0) {
    const results = await judgePhotorealBatch(
      [...renderPaths].map(([catalogId, screenshotPath]) => ({ catalogId, screenshotPath })),
    )
    for (const r of results) {
      if (r.renderFidelity === -1 || r.uvVisionScore === -1) {
        console.warn(`[grade-catalog] vision-judge unavailable for ${r.catalogId}, grading metadata-only`)
        continue
      }
      judgeResults.set(r.catalogId, r)
    }
  }

  // (b/d) rubric scores + composite + flag
  const rows = graded.map(({ entry, metrics }) => {
    const judged = judgeResults.get(entry.catalogId)
    return buildScoreRow(entry, metrics, {
      renderFidelity: judged?.renderFidelity ?? null,
      uvVisionScore: judged?.uvVisionScore ?? null,
      notes: judged?.notes ?? null,
      renderPath: renderPaths.get(entry.catalogId) ?? null,
    })
  })

  if (flags.dryRun) {
    console.table(
      rows.map((r) => ({
        catalog_id: r.catalog_id,
        composite: r.score_composite?.toFixed(1),
        render: r.score_render_fidelity?.toFixed(1) ?? '—',
        flagged: r.flagged_for_fix,
        source: r.score_source,
      })),
    )
    return
  }

  // (e) persist idempotently
  const db = (await import('../server/src/db.js')).openAdapter()
  await db.initSchema()
  for (const row of rows) await upsertScore(db, row)

  // (f) fix tickets for flagged rows without one
  const pending = rowsNeedingTickets(rows)
  let ticketed = 0
  for (const row of pending) {
    const notes = row.judge_notes
      ? `${row.judge_notes} (composite ${row.score_composite?.toFixed(1)}, render fidelity ${row.score_render_fidelity?.toFixed(1) ?? 'n/a'})`
      : `Flagged by asset quality scorecard: composite ${row.score_composite?.toFixed(1)}, render fidelity ${row.score_render_fidelity?.toFixed(1) ?? 'n/a'}`
    const ticketId = await createFixTicket(row.catalog_id, notes)
    if (!ticketId) continue
    await db.run('UPDATE asset_quality_scores SET fix_ticket_id = ? WHERE catalog_id = ?', ticketId, row.catalog_id)
    row.fix_ticket_id = ticketId
    ticketed += 1
  }

  const flagged = rows.filter((r) => r.flagged_for_fix === 1).length
  console.log(
    `[grade-catalog] graded ${rows.length}/${entries.length} assets ` +
      `(${judgeResults.size} vision-judged, ${flagged} flagged, ${ticketed} fix tickets filed)`,
  )
}

main().catch((err) => {
  console.error('[grade-catalog] fatal:', err)
  process.exit(1)
})
