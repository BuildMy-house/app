#!/usr/bin/env node
/**
 * ingest-sh3d-library.ts — Batch ingest the 87 eTeks SH3D models from
 * assets/models/sh3d/ (OBJ+PNG) into GLBs uploaded to Cloudflare R2,
 * with thumbnails and catalog.json updates.
 *
 *   tsx scripts/ingest-sh3d-library.ts                 # convert + upload + verify
 *   tsx scripts/ingest-sh3d-library.ts --skip-upload   # convert only
 *   tsx scripts/ingest-sh3d-library.ts --upload-only   # upload existing GLBs
 *   tsx scripts/ingest-sh3d-library.ts --limit 5       # process at most 5 items
 *
 * R2 credentials come from env (R2_ACCESS_KEY_ID/R2_SECRET_ACCESS_KEY/
 * R2_S3_ENDPOINT/R2_BUCKET_NAME/R2_PUBLIC_URL) — never hardcoded.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

// Installs Node polyfills for canvas/Image (shared with convert-sh3d-models).
import './convert-sh3d-models.js'

// GLTFExporter uses FileReader (browser-only) for the binary GLB path.
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
import { OBJLoader } from 'three/examples/jsm/loaders/OBJLoader.js'
import { MTLLoader } from 'three/examples/jsm/loaders/MTLLoader.js'
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js'
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const SH3D_DIR = join(ROOT, 'assets', 'models', 'sh3d')
const MODELS_DIR = join(ROOT, 'assets', 'models')
const THUMBS_DIR = join(ROOT, 'assets', 'thumbs')
const CATALOG_PATH = join(ROOT, 'assets', 'catalog', 'catalog.json')
const R2_KEY_PREFIX = 'models'
const R2_PUBLIC_URL = process.env.R2_PUBLIC_URL ?? 'https://pub-fe765786711f4197a36aa5baabc8a3d6.r2.dev'

interface CatalogItem {
  catalogId: string
  name: string
  category: string
  width: number
  depth: number
  height: number
  elevation: number
  color?: number | null
  doorOrWindow: boolean
  tags: string[]
  modelPath?: string | null
}

interface CatalogManifest {
  schemaVersion: number
  items: CatalogItem[]
}

/** Detect real image bytes (PNG or JPEG magic). */
function sniffImageMime(image: unknown): 'image/png' | 'image/jpeg' | null {
  const buf = (image as { buffer?: Buffer } | null | undefined)?.buffer
  if (!buf || buf.length < 4) return null
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'image/png'
  if (buf[0] === 0xff && buf[1] === 0xd8) return 'image/jpeg'
  return null
}

function textureMapsOf(material: THREE.Material): THREE.Texture[] {
  const maps: THREE.Texture[] = []
  for (const [key, value] of Object.entries(material)) {
    if ((key === 'map' || key.endsWith('Map')) && value instanceof THREE.Texture) maps.push(value)
  }
  return maps
}

function textureKeyOf(material: THREE.Material, texture: THREE.Texture): string {
  for (const [key, value] of Object.entries(material)) {
    if (key.endsWith('Map') && value === texture) return key
  }
  return 'map'
}

const invertedGeometries = new Set<THREE.BufferGeometry>()

/** glTF uses a top-left UV origin; source OBJs use bottom-left. */
function invertUvV(geometry: THREE.BufferGeometry): void {
  if (invertedGeometries.has(geometry)) return
  invertedGeometries.add(geometry)
  const uv = geometry.attributes.uv
  for (let i = 0; i < uv.count; i++) uv.setY(i, 1 - uv.getY(i))
}

/** Prepare textures for glTF export: sniff mime, set flipY=false, fix UV. */
function sanitizeTextures(group: THREE.Group): void {
  group.traverse((child) => {
    const mesh = child as THREE.Mesh
    if (!mesh.isMesh) return
    const geometry = mesh.geometry as THREE.BufferGeometry
    const hasUv = geometry.attributes.uv !== undefined
    const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material]
    const fixed = mats.map((mat) => {
      const maps = textureMapsOf(mat)
      for (const tex of maps) {
        const mime = sniffImageMime(tex.image)
        if (mime === null) {
          (mat as unknown as Record<string, unknown>)[textureKeyOf(mat, tex)] = null
          continue
        }
        tex.flipY = false
        tex.userData.mimeType = mime
      }
      if (!hasUv && maps.some((t) => t.userData.mimeType)) {
        const clone = mat.clone()
        for (const key of Object.keys(clone)) {
          if (key.endsWith('Map')) (clone as unknown as Record<string, unknown>)[key] = null
        }
        return clone
      }
      return mat
    })
    mesh.material = Array.isArray(mesh.material) ? fixed : fixed[0]
    if (hasUv) invertUvV(geometry)
  })
}

/** Drop map_* lines that point at missing texture files. */
function sanitizeMtlText(mtlPath: string): string {
  const raw = readFileSync(mtlPath, 'utf8')
  return raw
    .split(/\r?\n/)
    .filter((line) => {
      const m = line.match(/^\s*(map_\w+)\s+(.+)$/)
      if (!m) return true
      const file = m[2].trim().split(/\s+/).pop() ?? ''
      return existsSync(join(dirname(mtlPath), file))
    })
    .join('\n')
}

/** Find the OBJ+PNG for a catalog item in assets/models/sh3d/. */
function resolveSh3dPaths(catalogId: string): { objPath: string; pngPath: string | null } | null {
  const name = catalogId.split('#')[1]
  if (!name) return null

  // Flat: sh3d/name.obj
  const flatObj = join(SH3D_DIR, `${name}.obj`)
  if (existsSync(flatObj)) {
    const png = join(SH3D_DIR, `${name}.png`)
    return { objPath: flatObj, pngPath: existsSync(png) ? png : null }
  }

  // Nested: sh3d/name/name.obj
  const nestedObj = join(SH3D_DIR, name, `${name}.obj`)
  if (existsSync(nestedObj)) {
    const png = join(SH3D_DIR, name, `${name}.png`)
    return { objPath: nestedObj, pngPath: existsSync(png) ? png : null }
  }

  return null
}

/** Convert an OBJ (+ optional MTL/PNG) into a Three.js Group. */
function convertToGroup(item: CatalogItem, objPath: string, pngPath: string | null): THREE.Group {
  const objText = readFileSync(objPath, 'utf8')
  const objDir = dirname(objPath)
  const name = item.catalogId.split('#')[1] ?? 'model'

  const objLoader = new OBJLoader()

  // Try MTL first
  const mtlPath = join(objDir, `${name}.mtl`)
  if (existsSync(mtlPath)) {
    const materialCreator = new MTLLoader().parse(sanitizeMtlText(mtlPath), objDir + '/')
    materialCreator.preload()
    objLoader.setMaterials(materialCreator)
  }

  const group = objLoader.parse(objText)

  // If no MTL, apply flat color + optional texture
  if (!existsSync(mtlPath)) {
    const flatMaterial = new THREE.MeshStandardMaterial({
      color: (item.color as number) ?? 0xc0c0c0,
      roughness: 0.8,
      metalness: 0.05,
    })

    let texturedMaterial: THREE.MeshStandardMaterial | null = null
    if (pngPath) {
      const facesWithUv = (objText.match(/^f\s.*\d+\/\d+/gm) ?? []).length
      if (facesWithUv > 0) {
        texturedMaterial = flatMaterial.clone()
        const loader = new THREE.TextureLoader()
        const texture = loader.load(pngPath)
        texture.colorSpace = THREE.SRGBColorSpace
        texturedMaterial.map = texture
        texturedMaterial.needsUpdate = true
      }
    }

    group.traverse((child) => {
      if ((child as THREE.Mesh).isMesh) {
        const mesh = child as THREE.Mesh
        mesh.material = (texturedMaterial && mesh.geometry.attributes.uv)
          ? texturedMaterial
          : flatMaterial
      }
    })
  }

  // Center on X/Z, rest on floor at Y=0
  const bbox = new THREE.Box3().setFromObject(group)
  const center = bbox.getCenter(new THREE.Vector3())
  group.position.set(-center.x, -bbox.min.y, -center.z)

  group.traverse((child) => {
    if ((child as THREE.Mesh).isMesh) {
      const mesh = child as THREE.Mesh
      mesh.castShadow = true
      mesh.receiveShadow = true
    }
  })

  sanitizeTextures(group)
  return group
}

/** Export a Three.js group to GLB buffer. */
function exportGlb(group: THREE.Object3D): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    new GLTFExporter().parse(
      group,
      (result) => resolve(Buffer.from(result as ArrayBuffer)),
      (err) => reject(err instanceof Error ? err : new Error(String(err))),
      { binary: true },
    )
  })
}

/** Filesystem-safe model file name from a catalogId. */
function modelFileName(catalogId: string): string {
  const slug = catalogId
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return `${slug || 'model'}.glb`
}

function getS3Client(): S3Client {
  const { R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_S3_ENDPOINT } = process.env
  if (!R2_ACCESS_KEY_ID || !R2_SECRET_ACCESS_KEY || !R2_S3_ENDPOINT) {
    throw new Error('R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY / R2_S3_ENDPOINT must be set in env')
  }
  return new S3Client({
    region: 'auto',
    endpoint: R2_S3_ENDPOINT,
    credentials: { accessKeyId: R2_ACCESS_KEY_ID, secretAccessKey: R2_SECRET_ACCESS_KEY },
  })
}

async function verifyUpload(publicUrl: string): Promise<boolean> {
  try {
    const res = await fetch(publicUrl, { method: 'HEAD' })
    return res.ok && (res.headers.get('content-type') ?? '').includes('model/gltf-binary')
  } catch {
    return false
  }
}

async function uploadOne(s3: S3Client, key: string, buffer: Buffer, contentType: string): Promise<boolean> {
  await s3.send(new PutObjectCommand({
    Bucket: process.env.R2_BUCKET_NAME,
    Key: key,
    Body: buffer,
    ContentType: contentType,
  }))
  const publicUrl = `${R2_PUBLIC_URL}/${key}`
  return verifyUpload(publicUrl)
}

interface IngestResult {
  modelId: string
  status: 'ok' | 'skip' | 'error'
  glbBytes?: number
  error?: string
}

async function main(): Promise<void> {
  const limit = Math.max(0, Number(process.argv.find((a) => a.startsWith('--limit='))?.split('=')[1] ?? 0))
  const skipUpload = process.argv.includes('--skip-upload')
  const uploadOnly = process.argv.includes('--upload-only')

  // Load catalog
  const manifest = JSON.parse(readFileSync(CATALOG_PATH, 'utf8')) as CatalogManifest

  // Find all OBJ files in sh3d/
  mkdirSync(SH3D_DIR, { recursive: true })
  const objFiles = readdirSync(SH3D_DIR).filter((f) => f.endsWith('.obj'))
  console.log(`[ingest] found ${objFiles.length} OBJ files in sh3d/`)

  // Map OBJ files to catalog items
  const items: { item: CatalogItem; objName: string }[] = []
  for (const objFile of objFiles) {
    const objName = objFile.replace(/\.obj$/, '')
    // Find matching catalog entry (e.g. bedsideTable -> eTeks#bedsideTable)
    const catalogItem = manifest.items.find((ci) => ci.catalogId.endsWith('#' + objName))
    if (catalogItem) {
      items.push({ item: catalogItem, objName })
    } else {
      console.warn(`[ingest] SKIP ${objName}: no catalog entry found`)
    }
  }

  const queue = limit > 0 ? items.slice(0, limit) : items
  console.log(`[ingest] processing ${queue.length} items` + (skipUpload ? ' (upload-only: no)' : ''))

  const s3 = skipUpload ? null : getS3Client()
  const results: IngestResult[] = []
  let done = 0

  for (const { item, objName } of queue) {
    const modelId = item.catalogId
    const glbName = modelFileName(modelId)
    const glbPath = join(MODELS_DIR, glbName)
    const result: IngestResult = { modelId, status: 'ok' }

    try {
      // Step 1: Convert to GLB (or reuse existing)
      if (uploadOnly && existsSync(glbPath)) {
        // Reuse existing GLB
      } else {
        const paths = resolveSh3dPaths(modelId)
        if (!paths) {
          result.status = 'skip'
          result.error = 'no OBJ found in sh3d/'
          results.push(result)
          done++
          continue
        }

        const group = convertToGroup(item, paths.objPath, paths.pngPath)
        const buffer = await exportGlb(group)
        writeFileSync(glbPath, buffer)
        result.glbBytes = buffer.length
      }

      // Step 2: Upload to R2
      if (s3) {
        const glbBuffer = readFileSync(glbPath)
        const key = `${R2_KEY_PREFIX}/${glbName}`
        const uploaded = await uploadOne(s3, key, glbBuffer, 'model/gltf-binary')
        if (!uploaded) {
          result.status = 'error'
          result.error = 'R2 upload/verify failed'
        }
      }

      // Step 3: Generate thumbnail (reuse existing if present)
      const thumbName = glbName.replace(/\.glb$/, '.webp')
      const thumbPath = join(THUMBS_DIR, 'models', thumbName)
      if (!existsSync(thumbPath)) {
        // Thumbnail generation requires Playwright — skip here, use `npm run thumbnails` instead
        console.warn(`[ingest] thumbnail missing: ${thumbName} (run npm run thumbnails)`)
      }

      // Step 4: Upload thumbnail to R2
      if (s3 && existsSync(thumbPath)) {
        const thumbBuffer = readFileSync(thumbPath)
        const key = `${R2_KEY_PREFIX}/${thumbName}`
        await uploadOne(s3, key, thumbBuffer, 'image/webp')
      }

      // Step 5: Verify catalog entry has correct modelPath
      if (!item.modelPath || !item.modelPath.startsWith(R2_PUBLIC_URL)) {
        const expectedUrl = `${R2_PUBLIC_URL}/${R2_KEY_PREFIX}/${glbName}`
        item.modelPath = expectedUrl
        // Write back to catalog
        writeFileSync(CATALOG_PATH, `${JSON.stringify(manifest, null, 2)}\n`)
        console.log(`[ingest] updated modelPath for ${modelId}`)
      }
    } catch (err) {
      result.status = 'error'
      result.error = err instanceof Error ? err.message : String(err)
      console.error(`[ingest] FAILED ${modelId}: ${result.error}`)
    }

    results.push(result)
    done++
    if (done % 10 === 0 || done === queue.length) {
      const ok = results.filter((r) => r.status === 'ok').length
      const errors = results.filter((r) => r.status === 'error').length
      console.log(`[ingest] progress ${done}/${queue.length} (ok=${ok} errors=${errors})`)
    }
  }

  // Summary
  const ok = results.filter((r) => r.status === 'ok').length
  const skipped = results.filter((r) => r.status === 'skip').length
  const errors = results.filter((r) => r.status === 'error').length
  console.log(`\n[ingest] done. ok=${ok} skip=${skipped} errors=${errors}`)
  if (errors > 0) {
    console.log('[ingest] errors:')
    for (const r of results.filter((r) => r.status === 'error')) {
      console.log(`  ${r.modelId}: ${r.error}`)
    }
  }
}

main().catch((err) => {
  console.error(`[ingest] FATAL: ${err instanceof Error ? err.message : String(err)}`)
  process.exit(1)
})
