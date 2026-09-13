#!/usr/bin/env node
/**
 * import-sh3d-library.ts — MAT-T8: bulk-import the SourceForge SweetHome3D
 * model libraries (release 3DModels-1.9.3, 8 archives, 1510 models) into
 * GLBs uploaded to Cloudflare R2, with a checkpoint file so the batch is
 * fully resumable.
 *
 * Requires the 3DModels-*.zip releases pre-extracted to
 *   <repoRoot>/.sh3d-scratch/extracted/sh3f/<sub>/PluginFurnitureCatalog.properties
 *
 *   tsx scripts/import-sh3d-library.ts                 # convert + upload + verify
 *   tsx scripts/import-sh3d-library.ts --skip-upload   # convert only
 *   tsx scripts/import-sh3d-library.ts --upload-only   # upload+verify already-converted GLBs
 *   tsx scripts/import-sh3d-library.ts --merge-catalog # merge completed entries into assets/catalog/catalog.json
 *   tsx scripts/import-sh3d-library.ts --limit 5       # process at most 5 uncompleted items
 *
 * R2 credentials come from env (R2_ACCOUNT_ID/R2_ACCESS_KEY_ID/R2_SECRET_ACCESS_KEY/
 * R2_S3_ENDPOINT/R2_BUCKET_NAME/R2_PUBLIC_URL) — never hardcoded.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { dirname } from 'node:path'

// Installs the Node canvas/Image polyfills this script shares with the
// bundled-model converter (module side effect).
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
import type { MaterialCreator } from 'three/examples/jsm/loaders/MTLLoader.js'
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3'

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const SH3F_ROOT = join(REPO_ROOT, '.sh3d-scratch', 'extracted', 'sh3f')
const OUTPUT_DIR = join(REPO_ROOT, '.sh3d-scratch', 'output')
const MODELS_OUT = join(OUTPUT_DIR, 'models')
const CHECKPOINT_PATH = join(OUTPUT_DIR, 'checkpoint.json')
const CATALOG_PATH = join(REPO_ROOT, 'buildmyhouse', 'assets', 'catalog', 'catalog.json')
const R2_KEY_PREFIX = 'models'

/** sub-directory -> license tier, read from each archive's own LICENSE.TXT. */
const SUB_LICENSES: Record<string, string> = {
  'blendswap-cc-0': 'CC0 1.0',
  'blendswap-cc-by': 'CC-BY 3.0',
  'contributions': 'FAL 1.3',
  'katorlegaz': 'CC-BY 3.0 US',
  'lucapresidente': 'FAL 1.3',
  'reallusion': 'CC-BY 3.0 US',
  'scopia': 'CC-BY 3.0',
  'trees': 'FAL 1.3',
}

/** SH3D creator/license string -> canonical tier (per-archive LICENSE.TXT is authoritative). */
const SH3D_LICENSE_MAP: Record<string, string> = {
  'CC-0': 'CC0 1.0',
  'CC-BY': 'CC-BY 3.0',
  'Free Art': 'FAL 1.3',
  'Free Art / CC-BY': 'FAL 1.3 (dual FAL/CC-BY)',
}

interface LibraryItem {
  catalogId: string
  slug: string
  name: string
  category: string
  width: number
  depth: number
  height: number
  elevation: number
  doorOrWindow: boolean
  tags: string[]
  license: string
  objPath: string
  mtlPath: string | null
  rotation: number[] | null
}

interface CheckpointEntry {
  converted: boolean
  uploaded: boolean
  verified: boolean
  bytes?: number
  error?: string
  entry?: CatalogEntry
}

interface Checkpoint {
  items: Record<string, CheckpointEntry>
}

interface CatalogEntry {
  catalogId: string
  name: string
  category: string
  width: number
  depth: number
  height: number
  elevation: number
  color: number
  doorOrWindow: boolean
  tags: string[]
  modelPath: string
}

interface CatalogManifest {
  schemaVersion: number
  items: CatalogEntry[]
}

function slugify(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
}

/** Map an SH3D source category onto the app's fixed category set. */
function mapCategory(item: { category: string; name: string }): string {
  switch (item.category) {
    case 'Living room': return 'Living'
    case 'Bedroom': return 'Bedroom'
    case 'Kitchen': return 'Kitchen'
    case 'Bathroom': return 'Bathroom'
    case 'Office': return 'Office'
    case 'Exterior': return 'Outdoor'
    case 'Doors and windows': return /window/i.test(item.name) ? 'Windows' : 'Doors'
    default: return 'Other' // Lights, Miscellaneous, Characters, Vehicles, Staircases
  }
}

function parsePropertiesFile(sub: string): LibraryItem[] {
  const propsPath = join(SH3F_ROOT, sub, 'PluginFurnitureCatalog.properties')
  const text = readFileSync(propsPath, 'utf8')
  const byIndex: Record<string, Record<string, string>> = {}
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^([^#\s]+)#(\d+)=(.*)$/)
    if (m) (byIndex[m[2]] ??= {})[m[1]] = m[3]
  }
  const items: LibraryItem[] = []
  for (const fields of Object.values(byIndex)) {
    const sourceId = fields.id ?? ''
    if (!sourceId) continue
    const license = SH3D_LICENSE_MAP[fields.license ?? ''] ?? SUB_LICENSES[sub] ?? 'Unknown'
    const objRel = (fields.model ?? '').replace(/^\//, '')
    const objPath = join(SH3F_ROOT, sub, objRel)
    const mtlPath = objPath.replace(/\.obj$/i, '.mtl')
    const rotation = fields.modelRotation
      ? fields.modelRotation.trim().split(/\s+/).map(Number)
      : null
    items.push({
      catalogId: `sh3d-full#${sourceId}`,
      slug: slugify(sourceId),
      name: (fields.name ?? '').trim(),
      category: mapCategory({ category: fields.category ?? '', name: fields.name ?? '' }),
      width: Number(fields.width),
      depth: Number(fields.depth),
      height: Number(fields.height),
      elevation: fields.elevation ? Number(fields.elevation) : 0,
      doorOrWindow: fields.doorOrWindow === 'true',
      tags: (fields.tags ?? '').split(',').map((t) => t.trim().toLowerCase()).filter(Boolean),
      license,
      objPath,
      mtlPath: existsSync(mtlPath) ? mtlPath : null,
      rotation: rotation && rotation.length === 9 && rotation.every((n) => Number.isFinite(n)) ? rotation : null,
    })
  }
  return items
}

function loadCheckpoint(): Checkpoint {
  try {
    return JSON.parse(readFileSync(CHECKPOINT_PATH, 'utf8')) as Checkpoint
  } catch {
    return { items: {} }
  }
}

function saveCheckpoint(cp: Checkpoint): void {
  const tmp = `${CHECKPOINT_PATH}.tmp`
  writeFileSync(tmp, JSON.stringify(cp, null, 1))
  renameSync(tmp, CHECKPOINT_PATH)
}

/** Detect real image bytes on the polyfill NodeImage (PNG or JPEG magic). */
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
    // 'map' is the diffuse texture; lowercase 'm' means endsWith('Map') misses it.
    if ((key === 'map' || key.endsWith('Map')) && value instanceof THREE.Texture) maps.push(value)
  }
  return maps
}

/**
 * Prepare every texture for glTF export: sniff real bytes to set the correct
 * mimeType, and switch to flipY=false (images are exported unflipped), which
 * requires inverting the V coordinate of the consuming geometry.
 */
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
          // Missing/undecodable texture file: fall back to flat material color.
          (mat as unknown as Record<string, unknown>)[textureKeyOf(mat, tex)] = null
          continue
        }
        tex.flipY = false
        tex.userData.mimeType = mime
      }
      if (!hasUv && maps.some((t) => t.userData.mimeType)) {
        // TEXCOORD_0 invariant: textured material on uv-less geometry -> strip maps.
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

const invertedGeometries = new Set<THREE.BufferGeometry>()

/** glTF uses a top-left UV origin; source OBJs use bottom-left. */
function invertUvV(geometry: THREE.BufferGeometry): void {
  if (invertedGeometries.has(geometry)) return
  invertedGeometries.add(geometry)
  const uv = geometry.attributes.uv
  for (let i = 0; i < uv.count; i++) uv.setY(i, 1 - uv.getY(i))
}

function textureKeyOf(material: THREE.Material, texture: THREE.Texture): string {
  for (const [key, value] of Object.entries(material)) {
    if (key.endsWith('Map') && value === texture) return key
  }
  return 'map'
}

/** Drop map_* lines that point at missing texture files (they'd break export). */
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

function convertToGroup(item: LibraryItem): THREE.Group {
  const objText = readFileSync(item.objPath, 'utf8')
  const objLoader = new OBJLoader()
  if (item.mtlPath) {
    const materialCreator: MaterialCreator = new MTLLoader().parse(sanitizeMtlText(item.mtlPath), dirname(item.mtlPath) + '/')
    materialCreator.preload()
    objLoader.setMaterials(materialCreator)
  }
  const group = objLoader.parse(objText)
  if (!item.mtlPath) {
    const flatMaterial = new THREE.MeshStandardMaterial({ color: 0xc0c0c0, roughness: 0.8, metalness: 0.05 })
    group.traverse((child) => {
      if ((child as THREE.Mesh).isMesh) (child as THREE.Mesh).material = flatMaterial
    })
  }
  if (item.rotation) {
    const [m00, m01, m02, m10, m11, m12, m20, m21, m22] = item.rotation
    group.applyMatrix4(new THREE.Matrix4().set(
      m00, m01, m02, 0,
      m10, m11, m12, 0,
      m20, m21, m22, 0,
      0, 0, 0, 1,
    ))
  }
  // Center on X/Z, rest on floor at Y=0.
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

function buildEntry(item: LibraryItem): CatalogEntry {
  return {
    catalogId: item.catalogId,
    name: item.name,
    category: item.category,
    width: item.width,
    depth: item.depth,
    height: item.height,
    elevation: item.elevation,
    color: 12632256,
    doorOrWindow: item.doorOrWindow,
    tags: item.tags,
    modelPath: `${process.env.R2_PUBLIC_URL ?? 'https://pub-fe765786711f4197a36aa5baabc8a3d6.r2.dev'}/${R2_KEY_PREFIX}/${item.slug}.glb`,
  }
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

async function uploadOne(s3: S3Client, slug: string, buffer: Buffer): Promise<boolean> {
  const key = `${R2_KEY_PREFIX}/${slug}.glb`
  await s3.send(new PutObjectCommand({
    Bucket: process.env.R2_BUCKET_NAME,
    Key: key,
    Body: buffer,
    ContentType: 'model/gltf-binary',
  }))
  const publicUrl = `${process.env.R2_PUBLIC_URL}/${key}`
  return verifyUpload(publicUrl)
}

async function runConvertAndUpload(limit: number, skipUpload: boolean, uploadOnly: boolean): Promise<void> {
  mkdirSync(MODELS_OUT, { recursive: true })
  const checkpoint = loadCheckpoint()
  const items: LibraryItem[] = []
  for (const sub of Object.keys(SUB_LICENSES)) items.push(...parsePropertiesFile(sub))

  const pending = items.filter((item) => {
    const state = checkpoint.items[item.catalogId]
    if (uploadOnly) return state?.converted === true && state?.verified !== true
    return !(state?.converted && (skipUpload || state.verified))
  })
  const queue = limit > 0 ? pending.slice(0, limit) : pending
  console.log(`[import] ${items.length} catalog items; ${pending.length} pending; processing ${queue.length}`)

  const s3 = skipUpload ? null : getS3Client()
  let done = 0
  for (const item of queue) {
    const state = (checkpoint.items[item.catalogId] ??= { converted: false, uploaded: false, verified: false })
    try {
      const glbPath = join(MODELS_OUT, `${item.slug}.glb`)
      let buffer: Buffer
      if (state.converted && existsSync(glbPath)) {
        buffer = readFileSync(glbPath)
      } else {
        const group = convertToGroup(item)
        buffer = await exportGlb(group)
        writeFileSync(glbPath, buffer)
        state.converted = true
        state.bytes = buffer.length
      }
      if (s3 && !state.verified) {
        state.uploaded = await uploadOne(s3, item.slug, buffer)
        state.verified = state.uploaded
        if (!state.uploaded) state.error = 'upload/verify failed'
      }
      if (state.verified || skipUpload) {
        state.entry = buildEntry(item)
        delete state.error
      }
    } catch (err) {
      state.error = err instanceof Error ? err.message : String(err)
      console.error(`[import] FAILED ${item.catalogId}: ${state.error}`)
      if (err instanceof Error && err.stack) console.error(err.stack.split('\n').slice(1, 5).join('\n'))
    }
    done++
    if (done % 5 === 0 || done === queue.length) {
      saveCheckpoint(checkpoint)
      const ok = Object.values(checkpoint.items).filter((s) => s.verified).length
      console.log(`[import] progress ${done}/${queue.length} (verified total: ${ok})`)
    }
  }
  saveCheckpoint(checkpoint)
  const verified = Object.values(checkpoint.items).filter((s) => s.verified).length
  const failed = Object.values(checkpoint.items).filter((s) => s.error)
  console.log(`[import] done. verified=${verified} failed=${failed.length} checkpoint=${CHECKPOINT_PATH}`)
}

function mergeCatalog(): void {
  const checkpoint = loadCheckpoint()
  const manifest = JSON.parse(readFileSync(CATALOG_PATH, 'utf8')) as CatalogManifest
  const existing = new Set(manifest.items.map((i) => i.catalogId))
  let added = 0
  for (const [catalogId, state] of Object.entries(checkpoint.items)) {
    if (!state.verified || !state.entry) continue
    if (existing.has(catalogId)) continue
    manifest.items.push(state.entry)
    existing.add(catalogId)
    added++
  }
  writeFileSync(CATALOG_PATH, `${JSON.stringify(manifest, null, 2)}\n`)
  console.log(`[import] merged ${added} entries into ${CATALOG_PATH} (total ${manifest.items.length} items)`)
}

async function main(): Promise<void> {
  const limit = Math.max(0, Number(process.argv.find((a) => a.startsWith('--limit='))?.split('=')[1] ?? 0))
  const skipUpload = process.argv.includes('--skip-upload')
  const uploadOnly = process.argv.includes('--upload-only')
  if (process.argv.includes('--merge-catalog')) {
    mergeCatalog()
    return
  }
  await runConvertAndUpload(limit, skipUpload, uploadOnly)
}

void main()
