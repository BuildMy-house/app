#!/usr/bin/env node
/**
 * assets.ts — Repeatable asset pipeline (ticket U8).
 *
 *   npm run assets            # validate catalog + sync assets into public/
 *   npm run assets -- --check # validate only (fail if out of date)
 *
 * Steps:
 *   1. Validate the furniture catalog manifest against the catalog schema
 *      (duplicate ids, positive dims, known categories). If an item declares a
 *      `modelPath` (relative to public/assets/, e.g. "models/sofa.glb"), the
 *      referenced file must exist under assets/.
 *   2. Sync `assets/` (catalog.json, models/) into Vite's public dir so the
 *      bundle serves them at runtime (no network fetch).
 *
 * Wall/floor textures are NOT part of this pipeline: they are hosted on R2
 * under `materials/` (see scripts/upload-textures.ts) and resolved at runtime
 * via resolveTextureUrl() — same generate-once/upload-once pattern as the
 * furniture models. The committed sources in assets/textures/ are the upload
 * source of truth; regenerate art with `npm run textures:generate` and
 * re-upload with `npm run textures:upload`.
 */
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { copyFileSync, readdirSync, statSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const ASSETS = join(ROOT, 'assets')
const CATALOG_SRC = join(ASSETS, 'catalog', 'catalog.json')
const PUBLIC_DIR = join(ROOT, 'public')

const CATEGORIES = new Set([
  'Living',
  'Bedroom',
  'Kitchen',
  'Bathroom',
  'Dining',
  'Office',
  'Doors',
  'Windows',
  'Outdoor',
  'Other',
])

interface CatalogItem {
  catalogId: string
  name: string
  category: string
  width: number
  depth: number
  height: number
  modelPath?: string | null
}

interface CatalogManifest {
  schemaVersion: number
  items: CatalogItem[]
}

function fail(message: string): never {
  console.error(`[assets] ERROR: ${message}`)
  process.exit(1)
}

/** Externally-hosted model (e.g. Cloudflare R2): no local file to check/copy. */
function isExternalModel(modelPath: string): boolean {
  return /^https?:\/\//.test(modelPath)
}

/** Validate the catalog manifest structurally. */
function validateCatalog(): void {
  if (!existsSync(CATALOG_SRC)) fail(`missing catalog manifest: ${CATALOG_SRC}`)
  let manifest: CatalogManifest
  try {
    manifest = JSON.parse(readFileSync(CATALOG_SRC, 'utf8')) as CatalogManifest
  } catch (err) {
    fail(`catalog.json is not valid JSON: ${err instanceof Error ? err.message : String(err)}`)
  }
  if (manifest.schemaVersion !== 1) fail('catalog.json must have schemaVersion: 1')
  if (!Array.isArray(manifest.items)) fail('catalog.json must have an items array')
  const seen = new Set<string>()
  for (const item of manifest.items) {
    if (typeof item?.catalogId !== 'string' || item.catalogId.length === 0) {
      fail('catalog item missing non-empty catalogId')
    }
    if (seen.has(item.catalogId)) fail(`duplicate catalogId: ${item.catalogId}`)
    seen.add(item.catalogId)
    if (typeof item.name !== 'string' || item.name.length === 0) {
      fail(`item ${item.catalogId} missing name`)
    }
    if (!CATEGORIES.has(item.category)) {
      fail(`item ${item.catalogId} has unknown category ${JSON.stringify(item.category)}`)
    }
    for (const dim of ['width', 'depth', 'height'] as const) {
      const value = item[dim]
      if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
        fail(`item ${item.catalogId} needs positive ${dim}`)
      }
    }
    if (item.modelPath) {
      if (typeof item.modelPath !== 'string' || item.modelPath.length === 0) {
        fail(`item ${item.catalogId} has an empty modelPath`)
      }
      if (isExternalModel(item.modelPath)) continue
      // modelPath is relative to public/assets/; source lives under assets/.
      const modelFile = join(ASSETS, item.modelPath)
      if (!existsSync(modelFile)) {
        fail(`item ${item.catalogId} modelPath ${JSON.stringify(item.modelPath)} not found at ${modelFile}`)
      }
    }
  }
  console.log(`[assets] catalog ok (${manifest.items.length} items)`)
}

function copyDirContents(src: string, dest: string): void {
  if (!existsSync(src)) return
  mkdirSync(dest, { recursive: true })
  for (const entry of readdirSync(src)) {
    // Build-time tooling and texture sources (R2-hosted via
    // scripts/upload-textures.ts) are never runtime assets.
    if (entry === 'generate_pbr.py' || entry === 'sh3d' || entry === 'textures') continue
    const from = join(src, entry)
    const to = join(dest, entry)
    if (statSync(from).isDirectory()) {
      copyDirContents(from, to)
    } else {
      copyFileSync(from, to)
    }
  }
}

/** Mirror assets/ into Vite's public dir so the bundle serves them. */
function syncToPublic(): void {
  mkdirSync(PUBLIC_DIR, { recursive: true })
  copyDirContents(ASSETS, join(PUBLIC_DIR, 'assets'))
  console.log(`[assets] synced assets -> ${join(PUBLIC_DIR, 'assets')}`)
}

function main(): void {
  const checkOnly = process.argv.includes('--check')
  if (checkOnly) {
    validateCatalog()
    // Model files must exist for every catalog item that declares a local
    // modelPath; externally-hosted (http/https) items need no local file.
    const manifest = JSON.parse(readFileSync(CATALOG_SRC, 'utf8')) as CatalogManifest
    for (const item of manifest.items) {
      if (item.modelPath && !isExternalModel(item.modelPath) && !existsSync(join(ASSETS, item.modelPath))) {
        fail(`model missing for ${item.catalogId}: ${item.modelPath}`)
      }
    }
    console.log('[assets] check ok')
    return
  }
  validateCatalog()
  syncToPublic()
  console.log('[assets] done')
}

main()
