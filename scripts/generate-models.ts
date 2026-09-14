#!/usr/bin/env node
/**
 * generate-models.ts — Generate low-poly GLB furniture models (ticket U8, M32).
 *
 *   npm run models          # regenerate all GLBs from the catalog manifest
 *   npm run models -- --check
 *
 * Uses three's GLTFExporter (no new deps) to build a recognizable low-poly
 * mesh per catalog item, sized in centimeters to its manifest dims, then
 * exports a `.glb` per catalogId into assets/models/.
 *
 * For catalog items that have a matching Sweet Home 3D OBJ in
 * ../assets/models/sh3d/,
 * the real SH3D geometry is loaded, uniformly scaled to the catalog bounds,
 * centered on the floor, and exported. Missing or failing items fall back to
 * the procedural low-poly shapes.
 *
 * The 3D view loads these via GLTFLoader (view3d/scene.ts swapInModel); the
 * catalog panel shows the same assets as thumbnails. Run `npm run assets`
 * (or build) to mirror them into the bundle.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import { hasSh3dModel, convertSh3dModel } from './convert-sh3d-models.js'

// GLTFExporter uses FileReader (browser-only) for the binary GLB path.
// Provide a minimal Node polyfill before the exporter is imported.
if (typeof globalThis.FileReader === 'undefined') {
  class NodeFileReader {
    result: ArrayBuffer | null = null
    onloadend: (() => void) | null = null
    readAsArrayBuffer(blob: Blob): void {
      void blob.arrayBuffer().then((buffer) => {
        this.result = buffer
        this.onloadend?.()
      })
    }
  }
  ;(globalThis as { FileReader?: unknown }).FileReader = NodeFileReader
}

import * as THREE from 'three'
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const CATALOG_SRC = join(ROOT, 'assets', 'catalog', 'catalog.json')
const MODELS_DIR = join(ROOT, 'assets', 'models')

interface CatalogItem {
  catalogId: string
  name: string
  category: string
  width: number
  depth: number
  height: number
  color?: number | null
  modelPath?: string | null
}

interface CatalogManifest {
  schemaVersion: number
  items: CatalogItem[]
}

/** Filesystem-safe model file name from a catalogId ("eTeks#bed140x190" -> "eteks-bed140x190"). */
function modelFileName(catalogId: string): string {
  const slug = catalogId
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return `${slug || 'model'}.glb`
}

function fail(message: string): never {
  console.error(`[models] ERROR: ${message}`)
  process.exit(1)
}

function loadManifest(): CatalogManifest {
  let manifest: CatalogManifest
  try {
    manifest = JSON.parse(readFileSync(CATALOG_SRC, 'utf8')) as CatalogManifest
  } catch (err) {
    fail(`catalog.json not readable: ${err instanceof Error ? err.message : String(err)}`)
  }
  if (manifest.schemaVersion !== 1 || !Array.isArray(manifest.items)) {
    fail('catalog.json must be a valid manifest')
  }
  return manifest
}

/** Centered box helper: a mesh from (0,0,0) to (w,h,d) in cm. */
function box(
  w: number,
  h: number,
  d: number,
  x: number,
  y: number,
  z: number,
  color: number,
): THREE.Mesh {
  const geometry = new THREE.BoxGeometry(w, h, d)
  const material = new THREE.MeshStandardMaterial({ color, roughness: 0.8, metalness: 0.05 })
  const mesh = new THREE.Mesh(geometry, material)
  mesh.position.set(x, y, z)
  mesh.castShadow = true
  mesh.receiveShadow = true
  return mesh
}

/** Clamp a dimension to a sane minimum so tiny items don't vanish. */
const clampDim = (v: number): number => Math.max(v, 2)

/**
 * Build a recognizable low-poly model for an item based on its category.
 * All coordinates are centimeters, origin at the floor center of the piece.
 * The model's +Y is up; +Z is the item depth (matches SH3D/three scene).
 */
function buildModel(item: CatalogItem): THREE.Group {
  const color = item.color ?? 0x9e9e9e
  const group = new THREE.Group()
  const w = item.width
  const d = item.depth
  const h = item.height

  const category = item.category
  switch (category) {
    case 'Living': {
      // Sofa-ish: seat block + backrest + two armrests.
      const seatH = Math.min(h * 0.45, 45)
      group.add(box(w, seatH, d, 0, seatH / 2, 0, color))
      group.add(box(w, h - seatH, clampDim(d * 0.25), 0, seatH + (h - seatH) / 2, d / 2 - clampDim(d * 0.25) / 2, shade(color, 0.85)))
      const armH = Math.min(h * 0.55, 60)
      const armW = Math.max(12, w * 0.08)
      group.add(box(armW, armH, d, -w / 2 + armW / 2, armH / 2, 0, shade(color, 0.75)))
      group.add(box(armW, armH, d, w / 2 - armW / 2, armH / 2, 0, shade(color, 0.75)))
      break
    }
    case 'Bedroom': {
      if (item.catalogId.includes('bed')) {
        // Bed: base + headboard + pillow.
        const baseH = Math.min(h * 0.35, 25)
        group.add(box(w, baseH, d, 0, baseH / 2, 0, color))
        const headH = Math.min(h, 60)
        group.add(box(clampDim(d * 0.08), headH, clampDim(w * 0.05), 0, headH / 2, d / 2, shade(color, 0.8)))
        group.add(box(w * 0.9, 14, d * 0.6, 0, baseH + 8, -d * 0.15, shade(0xffffff, 1)))
      } else if (item.catalogId.includes('wardrobe')) {
        // Wardrobe: body + two doors + handle hint.
        group.add(box(w, h, d, 0, h / 2, 0, color))
        group.add(box(clampDim(w / 2 - 1), h - 4, 1.5, -w / 4, h / 2, d / 2, shade(color, 0.7)))
        group.add(box(clampDim(w / 2 - 1), h - 4, 1.5, w / 4, h / 2, d / 2, shade(color, 0.7)))
      } else {
        // Bedside table: cube + drawer line.
        group.add(box(w, h, d, 0, h / 2, 0, color))
        group.add(box(w - 2, 2, d - 2, 0, h * 0.6, 0, shade(color, 0.7)))
      }
      break
    }
    case 'Kitchen': {
      if (item.catalogId.includes('fridge')) {
        // Fridge: tall body + freezer divider + handle.
        group.add(box(w, h, d, 0, h / 2, 0, color))
        group.add(box(w - 2, 2, d - 2, 0, h * 0.62, 0, shade(color, 0.85)))
        group.add(box(2, h * 0.3, 3, w / 2, h * 0.8, d / 2, shade(color, 0.6)))
      } else {
        // Counter/sink: base + top slab.
        group.add(box(w, h * 0.9, d, 0, h * 0.45, 0, color))
        group.add(box(w + 2, 4, d + 2, 0, h, 0, shade(color, 1.15)))
      }
      break
    }
    case 'Bathroom': {
      // Toilet-ish / shower: simple two-tier form.
      group.add(box(w, h * 0.5, d, 0, h * 0.25, 0, color))
      group.add(box(w * 0.6, h * 0.5, d * 0.6, 0, h * 0.75, 0, shade(color, 0.9)))
      break
    }
    case 'Dining': {
      // Table: top slab + legs; chair: seat + back.
      if (item.catalogId.includes('table')) {
        group.add(box(w, 5, d, 0, h, 0, color))
        const leg = 5
        for (const lx of [-w / 2 + leg, w / 2 - leg]) {
          for (const lz of [-d / 2 + leg, d / 2 - leg]) {
            group.add(box(leg, h, leg, lx, h / 2, lz, shade(color, 0.8)))
          }
        }
      } else {
        group.add(box(w * 0.9, 4, d * 0.9, 0, h * 0.55, 0, color))
        group.add(box(w * 0.9, h * 0.45, clampDim(d * 0.15), 0, h * 0.78, d / 2 - clampDim(d * 0.15) / 2, shade(color, 0.85)))
        for (const lx of [-w / 2 + 4, w / 2 - 4]) {
          group.add(box(4, h * 0.55, 4, lx, h * 0.27, -d / 2 + 4, shade(color, 0.8)))
        }
      }
      break
    }
    case 'Office': {
      if (item.catalogId.includes('desk')) {
        group.add(box(w, 4, d, 0, h, 0, color))
        for (const lx of [-w / 2 + 5, w / 2 - 5]) {
          group.add(box(5, h, 5, lx, h / 2, -d / 2 + 5, shade(color, 0.8)))
          group.add(box(5, h, 5, lx, h / 2, d / 2 - 5, shade(color, 0.8)))
        }
      } else if (item.catalogId.includes('bookshelf')) {
        group.add(box(w, h, d, 0, h / 2, 0, color))
        for (let i = 1; i < 4; i++) {
          group.add(box(w - 2, 2, d - 2, 0, (h / 4) * i, 0, shade(color, 0.75)))
        }
      } else {
        // Office chair: seat + back + stem + base.
        group.add(box(w * 0.8, 6, d * 0.8, 0, h * 0.45, 0, color))
        group.add(box(w * 0.8, h * 0.4, 8, 0, h * 0.8, d / 2 - 4, shade(color, 0.85)))
        group.add(box(6, h * 0.45, 6, 0, h * 0.22, 0, shade(color, 0.6)))
        group.add(box(w, 3, d, 0, 1.5, 0, shade(color, 0.5)))
      }
      break
    }
    case 'Doors': {
      // Door: thin slab + handle.
      group.add(box(clampDim(d), h, w, 0, h / 2, 0, color))
      group.add(box(3, 12, 3, 0, h * 0.5, clampDim(d) / 2, shade(0xd4af37, 1)))
      break
    }
    case 'Windows': {
      // Window: frame + glass panes.
      group.add(box(clampDim(d), h, w, 0, h / 2, 0, shade(color, 0.85)))
      group.add(box(clampDim(d) - 2, h - 2, w - 4, 0, h / 2, 0, shade(0xbfe3f5, 1)))
      group.add(box(clampDim(d), 4, w, 0, h / 2, 0, shade(color, 0.7)))
      group.add(box(clampDim(d), 4, w, 0, h / 2, 0, shade(color, 0.7)))
      break
    }
    default: {
      // Plant / bench / generic: simple solid.
      if (item.catalogId.includes('plant')) {
        const potH = Math.min(h * 0.25, 30)
        group.add(box(w * 0.7, potH, d * 0.7, 0, potH / 2, 0, shade(0x8b5a2b, 1)))
        group.add(box(w * 0.9, h - potH, d * 0.9, 0, potH + (h - potH) / 2, 0, shade(color, 1)))
      } else {
        group.add(box(w, h, d, 0, h / 2, 0, color))
      }
      break
    }
  }
  return group
}

/** Multiply a 0xRRGGBB color by a factor, clamped to [0, 255]. */
function shade(color: number, factor: number): number {
  const r = Math.min(255, Math.round(((color >> 16) & 0xff) * factor))
  const g = Math.min(255, Math.round(((color >> 8) & 0xff) * factor))
  const b = Math.min(255, Math.round((color & 0xff) * factor))
  return (r << 16) | (g << 8) | b
}

function exportGlb(group: THREE.Group, outPath: string): void {
  const exporter = new GLTFExporter()
  exporter.parse(
    group,
    (result) => {
      const buffer = result as ArrayBuffer
      writeFileSync(outPath, Buffer.from(buffer))
      console.log(`[models] wrote ${outPath.split('/').pop()}`)
    },
    (err) => fail(`GLTF export failed for ${outPath}: ${err instanceof Error ? err.message : String(err)}`),
    { binary: true },
  )
}

async function buildOrConvertModel(item: CatalogItem): Promise<THREE.Group> {
  if (hasSh3dModel(item.catalogId)) {
    const converted = await convertSh3dModel(item)
    if (converted) return converted
    console.warn(`[models] SH3D conversion failed for ${item.catalogId}, using procedural fallback`)
  }
  return buildModel(item)
}

/** Externally-hosted model (e.g. Cloudflare R2): never generate locally. */
function isExternalModel(item: CatalogItem): boolean {
  return typeof item.modelPath === 'string' && /^https?:\/\//.test(item.modelPath)
}

async function main(): Promise<void> {
  const checkOnly = process.argv.includes('--check')
  const manifest = loadManifest()
  mkdirSync(MODELS_DIR, { recursive: true })

  // Externally-hosted items don't need a locally-generated GLB.
  const localItems = manifest.items.filter((item) => !isExternalModel(item))
  const expected = localItems.map((item) => modelFileName(item.catalogId))
  if (checkOnly) {
    const missing = expected.filter((name) => !exists(join(MODELS_DIR, name)))
    if (missing.length > 0) {
      fail(`missing model files: ${missing.join(', ')} (run npm run models)`)
    }
    console.log(`[models] check ok (${expected.length} models)`)
    return
  }

  for (const item of localItems) {
    const model = await buildOrConvertModel(item)
    exportGlb(model, join(MODELS_DIR, modelFileName(item.catalogId)))
  }
  console.log(`[models] done (${localItems.length} models, ${manifest.items.length - localItems.length} externally hosted)`)
}

function exists(path: string): boolean {
  try {
    readFileSync(path)
    return true
  } catch {
    return false
  }
}

await main()
