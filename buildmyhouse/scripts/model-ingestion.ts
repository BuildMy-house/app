/**
 * model-ingestion.ts — Model ingestion pipeline
 *
 * Automates adding new models to the catalog with rich tag generation for search.
 * Scans for new GLB files and updates catalog.json with proper metadata.
 *
 * Usage:
 *  npm run ingest:models [--source <dir>] [--auto-tag]
 *  npm run ingest:models --add <model-spec.json>
 */

import { execSync } from 'node:child_process'
import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs'
import { join, basename } from 'node:path'
import * as fs from 'node:fs/promises'

const CATALOG_FILE = join(process.cwd(), 'assets', 'catalog', 'catalog.json')
const MODELS_DIR = join(process.cwd(), 'public', 'assets', 'models')

interface CatalogItem {
  catalogId: string
  name: string
  category: string
  width: number
  depth: number
  height: number
  color?: number | null
  doorOrWindow?: boolean
  elevation?: number
  tags?: string[]
  modelPath?: string | null
}

interface CatalogManifest {
  schemaVersion: number
  items: CatalogItem[]
}

interface ModelSpec {
  name: string
  category: string
  width: number
  depth: number
  height: number
  color?: number | null
  elevation?: number
  doorOrWindow?: boolean
  tags?: string[]
}

/**
 * Parse a catalogId to extract semantic parts for tag generation.
 * Examples:
 *  eTeks#bed140x190 -> ['bed', '140x190', 'bedroom']
 *  sofa-sectional -> ['sofa', 'sectional']
 */
function parseCatalogId(catalogId: string): string[] {
  return catalogId
    .toLowerCase()
    .replace(/[#-_]/g, ' ')
    .split(/\s+/)
    .filter(p => p.length > 0 && !/^\d/.test(p))
}

/**
 * Generate comprehensive tags from model name, category, and catalog ID.
 * Includes:
 *  - Category and subcategory
 *  - Material/style hints from name
 *  - Functional purpose
 *  - Size/configuration hints
 */
function generateTags(item: CatalogItem, existingTags?: string[]): string[] {
  const tags = new Set<string>()

  // Preserve existing tags
  if (existingTags) {
    existingTags.forEach(t => tags.add(t.toLowerCase()))
  }

  // Category-based tags
  tags.add(item.category.toLowerCase())

  // Name-based tags (split and filter)
  const nameParts = item.name
    .toLowerCase()
    .replace(/[&\-_]/g, ' ')
    .split(/\s+/)
    .filter(p => p.length > 1 && !/^\d+$/.test(p))

  nameParts.forEach(part => tags.add(part))

  // catalogId-based tags
  if (item.catalogId) {
    parseCatalogId(item.catalogId).forEach(part => {
      if (part.length > 1) tags.add(part)
    })
  }

  // Contextual tags based on category
  switch (item.category) {
    case 'Living':
      tags.add('seating')
      tags.add('furniture')
      if (item.name.toLowerCase().includes('table')) tags.add('surface')
      break
    case 'Bedroom':
      tags.add('bed-furniture')
      if (item.name.toLowerCase().includes('bed')) tags.add('bed')
      if (item.name.toLowerCase().includes('table')) tags.add('nightstand')
      break
    case 'Kitchen':
      tags.add('appliance')
      tags.add('kitchen-fixture')
      if (item.name.toLowerCase().includes('table')) tags.add('counter')
      break
    case 'Bathroom':
      tags.add('bathroom-fixture')
      tags.add('plumbing')
      break
    case 'Dining':
      tags.add('dining')
      if (item.name.toLowerCase().includes('table')) tags.add('table')
      if (item.name.toLowerCase().includes('chair')) tags.add('seating')
      break
    case 'Office':
      tags.add('work-furniture')
      tags.add('professional')
      break
    case 'Doors':
      tags.add('entryway')
      tags.add('access')
      break
    case 'Windows':
      tags.add('natural-light')
      tags.add('view')
      break
    case 'Outdoor':
      tags.add('exterior')
      tags.add('landscaping')
      break
  }

  // Size-related tags
  if (item.width && item.depth && item.height) {
    const volume = item.width * item.depth * item.height
    if (volume < 5000) tags.add('compact')
    if (volume > 50000) tags.add('large')
    if (item.width > 150) tags.add('wide')
    if (item.height > 150) tags.add('tall')
  }

  // Door/window specific
  if (item.doorOrWindow) {
    tags.add('opening')
    tags.add('structural')
  }

  return Array.from(tags).sort()
}

/**
 * Load the current catalog manifest.
 */
function loadCatalog(): CatalogManifest {
  try {
    return JSON.parse(readFileSync(CATALOG_FILE, 'utf8')) as CatalogManifest
  } catch (err) {
    console.error(`[ingestion] Failed to load catalog from ${CATALOG_FILE}:`, err)
    throw err
  }
}

/**
 * Save the catalog manifest.
 */
function saveCatalog(manifest: CatalogManifest): void {
  writeFileSync(
    CATALOG_FILE,
    JSON.stringify(manifest, null, 2) + '\n',
    'utf8',
  )
  console.log(`[ingestion] Saved catalog with ${manifest.items.length} items`)
}

/**
 * Generate a catalog ID slug from a model name.
 * Examples: "Sofa Red" -> "sofa-red", "Chair 2 Seater" -> "chair-2-seater"
 */
function generateCatalogId(name: string, existing: Set<string>): string {
  const base = name
    .toLowerCase()
    .trim()
    .replace(/[^\w\s]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')

  if (!existing.has(base)) return base

  // If slug already exists, append a number
  let i = 2
  while (existing.has(`${base}-${i}`)) i++
  return `${base}-${i}`
}

/**
 * Add or update a model in the catalog.
 */
function addModelToCatalog(
  manifest: CatalogManifest,
  spec: ModelSpec,
  modelPath: string,
): void {
  const existingIds = new Set(manifest.items.map(i => i.catalogId))
  const catalogId = generateCatalogId(spec.name, existingIds)

  // Find and update if exists, otherwise create new
  let item = manifest.items.find(i => i.catalogId === catalogId)
  if (!item) {
    item = {
      catalogId,
      name: spec.name,
      category: spec.category,
      width: spec.width,
      depth: spec.depth,
      height: spec.height,
      modelPath,
    }
    manifest.items.push(item)
    console.log(`[ingestion] Added new model: ${catalogId}`)
  } else {
    console.log(`[ingestion] Updated existing model: ${catalogId}`)
  }

  // Set optional fields
  if (spec.color !== undefined) item.color = spec.color
  if (spec.elevation !== undefined) item.elevation = spec.elevation
  if (spec.doorOrWindow !== undefined) item.doorOrWindow = spec.doorOrWindow

  // Generate tags
  item.tags = generateTags(item, spec.tags)
}

/**
 * Scan models directory and sync with catalog.
 * Updates modelPath for existing items or creates new entries for orphaned GLBs.
 */
async function syncModelsDirectory(manifest: CatalogManifest): Promise<number> {
  if (!existsSync(MODELS_DIR)) {
    console.log(`[ingestion] Models directory not found: ${MODELS_DIR}`)
    return 0
  }

  const files = readdirSync(MODELS_DIR).filter(f => f.endsWith('.glb'))
  let synced = 0

  for (const file of files) {
    const modelPath = `models/${file}`
    const fileName = basename(file, '.glb')

    // Check if this model is already in the catalog
    let item = manifest.items.find(i => i.modelPath === modelPath)

    if (!item) {
      // Create new entry for orphaned model
      // Infer name from filename (eteks-bed140x190.glb -> "Bed 140x190")
      const displayName = fileName
        .split('-')
        .map(word => word.charAt(0).toUpperCase() + word.slice(1))
        .join(' ')

      const catalogId = generateCatalogId(displayName, new Set(manifest.items.map(i => i.catalogId)))

      item = {
        catalogId,
        name: displayName,
        category: 'Other', // Default category for orphaned models
        width: 100,
        depth: 100,
        height: 100,
        modelPath,
      }

      manifest.items.push(item)
      console.log(`[ingestion] Created entry for orphaned model: ${catalogId} (${modelPath})`)
      synced++
    }
  }

  return synced
}

/**
 * Add a single model from a JSON spec file.
 */
async function addModelFromSpec(specPath: string): Promise<void> {
  if (!existsSync(specPath)) {
    console.error(`[ingestion] Spec file not found: ${specPath}`)
    process.exit(1)
  }

  const spec = JSON.parse(readFileSync(specPath, 'utf8')) as ModelSpec & { modelPath: string }

  const manifest = loadCatalog()
  addModelToCatalog(manifest, spec, spec.modelPath)
  saveCatalog(manifest)

  console.log(`[ingestion] Model added successfully: ${spec.name}`)
}

/**
 * Regenerate tags for all existing models.
 * Useful after making tag generation improvements.
 */
function regenerateAllTags(manifest: CatalogManifest): void {
  let updated = 0

  for (const item of manifest.items) {
    const oldTags = item.tags?.join(',')
    item.tags = generateTags(item)
    const newTags = item.tags.join(',')

    if (oldTags !== newTags) {
      console.log(`[ingestion] Updated tags for ${item.catalogId}`)
      updated++
    }
  }

  console.log(`[ingestion] Regenerated tags for ${updated} models`)
}

/**
 * List models with their tags for verification.
 */
function listModels(manifest: CatalogManifest, filter?: string): void {
  const items = filter
    ? manifest.items.filter(
        i =>
          i.catalogId.includes(filter) ||
          i.name.toLowerCase().includes(filter.toLowerCase()) ||
          i.category.toLowerCase().includes(filter.toLowerCase()),
      )
    : manifest.items

  console.log(`\nFound ${items.length} models:\n`)

  for (const item of items.slice(0, 20)) {
    console.log(`${item.catalogId}`)
    console.log(`  Name: ${item.name}`)
    console.log(`  Category: ${item.category}`)
    console.log(`  Dims: ${item.width}x${item.depth}x${item.height} cm`)
    if (item.tags?.length) {
      console.log(`  Tags: ${item.tags.join(', ')}`)
    }
    console.log()
  }

  if (items.length > 20) {
    console.log(`... and ${items.length - 20} more`)
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2)

  const manifest = loadCatalog()

  if (args.includes('--sync')) {
    console.log(`[ingestion] Syncing models directory...`)
    const synced = await syncModelsDirectory(manifest)
    saveCatalog(manifest)
    console.log(`[ingestion] Synced ${synced} models`)
  } else if (args.includes('--regenerate-tags')) {
    regenerateAllTags(manifest)
    saveCatalog(manifest)
  } else if (args.includes('--list')) {
    const filter = args[args.indexOf('--list') + 1]
    listModels(manifest, filter)
  } else if (args.includes('--add-from-spec')) {
    const specPath = args[args.indexOf('--add-from-spec') + 1]
    if (!specPath) {
      console.error('[ingestion] --add-from-spec requires a spec file path')
      process.exit(1)
    }
    await addModelFromSpec(specPath)
  } else {
    console.log(`Model Ingestion Pipeline

Usage:
  npm run ingest:models --sync                          # Sync models directory
  npm run ingest:models --regenerate-tags               # Regenerate all tags
  npm run ingest:models --list [filter]                 # List models
  npm run ingest:models --add-from-spec <spec.json>    # Add model from spec

A model spec file should contain:
{
  "name": "Sofa Sectional",
  "category": "Living",
  "width": 250,
  "depth": 150,
  "height": 85,
  "modelPath": "models/sofa-sectional.glb",
  "tags": ["fabric", "modern"],
  "color": 0x808080
}
`)
  }
}

main().catch(err => {
  console.error('[ingestion] Fatal error:', err)
  process.exit(1)
})
