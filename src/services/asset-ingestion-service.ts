/**
 * asset-ingestion-service.ts — unified SH3D asset ingestion pipeline.
 *
 * One call to AssetIngestionService.processBatch() takes the next N pending
 * SourceForge SweetHome3D models from "not yet ingested" to "fully ingested":
 *
 *   parse properties -> OBJ+MTL -> GLB conversion -> R2 upload + verify
 *   -> catalog.json merge -> thumbnail render + R2 upload
 *
 * for exactly that batch, checkpointed (resumable, never redoes
 * already-verified work). The CLI wrappers are:
 *
 *   scripts/import-sh3d-library.ts   (convert/upload/merge-catalog modes)
 *   scripts/render-thumbnails.ts     (whole-catalog thumbnail backfill)
 *
 * Scratch layout (override the root with SH3D_SCRATCH_ROOT, e.g. when the
 * extracted 3DModels-*.zip trees and the existing checkpoint live in another
 * checkout):
 *   <scratchRoot>/extracted/sh3f/<sub>/PluginFurnitureCatalog.properties
 *   <scratchRoot>/output/checkpoint.json
 *   <scratchRoot>/output/models/<slug>.glb
 *
 * R2 credentials come from env (R2_ACCESS_KEY_ID/R2_SECRET_ACCESS_KEY/
 * R2_S3_ENDPOINT/R2_BUCKET_NAME/R2_PUBLIC_URL) — never hardcoded.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import * as THREE from 'three'
import { OBJLoader } from 'three/examples/jsm/loaders/OBJLoader.js'
import { MTLLoader } from 'three/examples/jsm/loaders/MTLLoader.js'
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js'
import type { S3Client } from '@aws-sdk/client-s3'
import { getR2S3Client, r2PublicUrl, uploadR2Object } from './r2-client'
import { THUMBNAIL_RENDER_SIZE } from '../view3d/thumbnail-camera'
import { chromium } from '@playwright/test'
import { build } from 'esbuild'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

/** Not a named export of the three types — derive it from MTLLoader.parse. */
type MaterialCreator = ReturnType<MTLLoader['parse']>

const DEFAULT_SCRATCH_ROOT = join(ROOT, '.sh3d-scratch')
const CATALOG_PATH = join(ROOT, 'assets', 'catalog', 'catalog.json')
const THUMBS_DIR = join(ROOT, 'assets', 'thumbs')
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

export interface LibraryItem {
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
  rotationError?: string
}

export interface TransformCheck {
  status: 'pass' | 'pass-scale' | 'axis-swap' | 'ambiguous'
  extents: [number, number, number]
  scale: number | null
  error: number | null
  swapError: number | null
  rawError?: number | null
  reason?: string
}

interface CheckpointEntry {
  converted: boolean
  uploaded: boolean
  verified: boolean
  bytes?: number
  transformCheck?: TransformCheck
  error?: string
  entry?: CatalogEntry
}

export interface Checkpoint {
  items: Record<string, CheckpointEntry>
}

export interface CatalogEntry {
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
  renderModelPath: string
}

export interface CatalogManifest {
  schemaVersion: number
  items: CatalogEntry[]
}

export interface ProgressInfo {
  stage: 'convert' | 'upload' | 'catalog' | 'thumbnails'
  done: number
  total: number
  current?: string
  message?: string
}

export interface ProcessBatchOptions {
  /** Max pending items to process this call (0 / undefined = all pending). */
  limit?: number
  /** Progress callback; the service also logs to console. */
  onProgress?: (progress: ProgressInfo) => void
}

export interface BatchResult {
  /** Items found across all parsed properties files. */
  scanned: number
  /** Items not yet converted+verified when the batch started. */
  pending: number
  /** Items actually attempted this call. */
  processed: number
  /** Newly converted GLBs this call. */
  converted: number
  /** Newly uploaded + verified this call. */
  uploaded: number
  /** Failures this call. */
  failed: number
  /** Entries merged into catalog.json this call. */
  catalogAdded: number
  /** Thumbnails rendered + uploaded this call. */
  thumbnailsWritten: number
  thumbnailsSkipped: number
  errors: string[]
}

export interface ThumbJob {
  catalogId: string
  modelPath: string
}

export interface ThumbResult {
  written: number
  skipped: number
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

/** Externally-hosted model (e.g. Cloudflare R2) — mirrors scripts/assets.ts. */
function isExternalModel(modelPath: string): boolean {
  return /^https?:\/\//i.test(modelPath)
}

/** R2 object key for an external model's thumbnail: .../models/x.glb -> thumbs/x.webp. */
function externalThumbKey(modelPath: string): string {
  const base = new URL(modelPath).pathname.split('/').pop() ?? ''
  return `thumbs/${base.replace(/\.[^.]+$/, '')}.webp`
}

/** Local thumbnail path for a modelPath, mirroring the CatalogPanel convention. */
function localThumbPath(modelPath: string): string {
  return join(THUMBS_DIR, modelPath.replace(/\.[^.]+$/, '') + '.webp')
}

// ---------------------------------------------------------------------------
// Minimal browser-ish globals so GLTFExporter + MTL texture loading run under
// Node (extracted from the old scripts/convert-sh3d-models.ts polyfill).
// ---------------------------------------------------------------------------

/** GLTFExporter reads exported binaries through FileReader (browser-only). */
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

/** Installs every global GLTFExporter/ImageLoader need; no-op in a real DOM. */
function installNodeGlbPolyfills(): void {
  if (typeof globalThis.FileReader === 'undefined') {
    ;(globalThis as { FileReader?: unknown }).FileReader = NodeFileReader
  }
  if (typeof globalThis.document !== 'undefined') return

  function setGlobal(name: string, value: unknown): void {
    try {
      ;(globalThis as unknown as Record<string, unknown>)[name] = value
    } catch {
      // ignore read-only globals
    }
  }

  function parsePngDimensions(buffer: Buffer): { width: number; height: number } {
    if (buffer.length < 24 || buffer[0] !== 0x89 || buffer[1] !== 0x50 || buffer[2] !== 0x4e || buffer[3] !== 0x47) {
      return { width: 1, height: 1 }
    }
    return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) }
  }

  function readImageFile(url: string): Buffer {
    const path = url.startsWith('file:') ? fileURLToPath(url) : url
    return readFileSync(path)
  }

  class NodeEventTarget {
    private listeners: Record<string, Array<(event: Event) => void>> = {}

    addEventListener(type: string, listener: (event: Event) => void): void {
      ;(this.listeners[type] ??= []).push(listener)
    }

    removeEventListener(type: string, listener: (event: Event) => void): void {
      const arr = this.listeners[type]
      if (!arr) return
      const index = arr.indexOf(listener)
      if (index >= 0) arr.splice(index, 1)
    }

    dispatchEvent(event: Event): void {
      // DOM semantics: event listeners run with `this` set to the event target.
      // three's ImageLoader relies on this (`onLoad(this)` inside its handler).
      this.listeners[event.type]?.forEach((listener) => listener.call(this, event))
    }
  }

  class NodeImage extends NodeEventTarget {
    complete = false
    crossOrigin: string | null = null
    private _src = ''
    width = 0
    height = 0
    buffer: Buffer = Buffer.alloc(0)

    constructor(widthOrUrl?: number | string, height?: number) {
      super()
      if (typeof widthOrUrl === 'string') {
        this.src = widthOrUrl
      } else if (typeof widthOrUrl === 'number' && typeof height === 'number') {
        this.width = widthOrUrl
        this.height = height
      }
    }

    get src(): string { return this._src }
    set src(url: string) {
      this._src = url
      if (url) this.load(url)
    }

    private load(url: string): void {
      try {
        this.buffer = readImageFile(url)
        const dims = parsePngDimensions(this.buffer)
        this.width = dims.width
        this.height = dims.height
        this.complete = true
        this.dispatchEvent(new Event('load'))
      } catch {
        this.dispatchEvent(new Event('error'))
      }
    }
  }

  class NodeImageData {
    data: Uint8ClampedArray
    width: number
    height: number

    constructor(data: Uint8ClampedArray, width: number, height?: number)
    constructor(width: number, height: number)
    constructor(dataOrWidth: Uint8ClampedArray | number, widthOrHeight?: number, height?: number) {
      if (dataOrWidth instanceof Uint8ClampedArray) {
        this.data = dataOrWidth
        this.width = widthOrHeight ?? 0
        this.height = height ?? 0
      } else {
        this.width = dataOrWidth
        this.height = widthOrHeight ?? 0
        this.data = new Uint8ClampedArray(this.width * this.height * 4)
      }
    }
  }

  class NodeCanvas {
    width = 0
    height = 0
    style: Record<string, string> = {}
    private image: NodeImage | NodeImageData | null = null

    constructor(width = 0, height = 0) {
      this.width = width
      this.height = height
    }

    getContext(_type: string, _options?: unknown) {
      return {
        drawImage: (img: NodeImage | NodeImageData, _x: number, _y: number, _w?: number, _h?: number) => {
          this.image = img
        },
        getImageData: (_x: number, _y: number, w: number, h: number) => new NodeImageData(w, h),
        putImageData: (imgData: NodeImageData, _x: number, _y: number) => {
          this.image = imgData
        },
        translate: (_x: number, _y: number) => {},
        scale: (_x: number, _y: number) => {},
      }
    }

    toBlob(callback: (blob: Blob | null) => void, type = 'image/png'): void {
      if (this.image instanceof NodeImage && this.image.buffer.length > 0) {
        callback(new Blob([new Uint8Array(this.image.buffer)], { type }))
        return
      }
      callback(null)
    }

    toDataURL(type = 'image/png'): string {
      if (this.image instanceof NodeImage && this.image.buffer.length > 0) {
        return `data:${type};base64,${this.image.buffer.toString('base64')}`
      }
      return ''
    }
  }

  class NodeDocument {
    createElement(tagName: string): NodeCanvas | NodeImage {
      if (tagName === 'canvas') return new NodeCanvas()
      if (tagName === 'img') return new NodeImage()
      return new NodeCanvas()
    }

    createElementNS(_ns: string, tagName: string): NodeCanvas | NodeImage {
      return this.createElement(tagName)
    }
  }

  setGlobal('HTMLImageElement', NodeImage)
  setGlobal('HTMLCanvasElement', NodeCanvas)
  setGlobal('Image', NodeImage)
  setGlobal('ImageData', NodeImageData)
  setGlobal('document', new NodeDocument())
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
          ;(mat as unknown as Record<string, unknown>)[textureKeyOf(mat, tex)] = null
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
    mesh.material = Array.isArray(mesh.material) ? fixed : (fixed[0] ?? mesh.material)
    if (hasUv) invertUvV(geometry)
  })
}

const invertedGeometries = new Set<THREE.BufferGeometry>()

/** glTF uses a top-left UV origin; source OBJs use bottom-left. */
function invertUvV(geometry: THREE.BufferGeometry): void {
  if (invertedGeometries.has(geometry)) return
  invertedGeometries.add(geometry)
  const uv = geometry.attributes.uv
  if (!uv) return
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
      const file = (m[2] ?? '').trim().split(/\s+/).pop() ?? ''
      return existsSync(join(dirname(mtlPath), file))
    })
    .join('\n')
}

/**
 * In-browser thumbnail renderer. Bundled with esbuild and injected via
 * addScriptTag so three.js + GLTFLoader run inside headless Chromium without a
 * dev server. Framing/lighting mirror src/ui/model-thumbnail.ts (ortho, 3/4
 * view, ambient 0.6 + key 0.8) so prebaked and fallback thumbnails match.
 */
const RENDERER_SOURCE = `
import * as THREE from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { frameOrthographicCamera } from './src/view3d/thumbnail-camera'

const SIZE = ${THUMBNAIL_RENDER_SIZE}
let renderer = null
let scene = null
let camera = null

function init() {
  if (renderer) return true
  renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true })
  renderer.setSize(SIZE, SIZE)
  renderer.setPixelRatio(1)
  renderer.setClearColor(0x000000, 0)
  scene = new THREE.Scene()
  scene.add(new THREE.AmbientLight(0xffffff, 0.6))
  const key = new THREE.DirectionalLight(0xffffff, 0.8)
  key.position.set(2, 3, 2)
  scene.add(key)
  camera = new THREE.OrthographicCamera(-2, 2, 2, -2, 0.1, 100)
  return true
}

window.__renderThumb = async (dataUrl) => {
  if (!init()) return null
  const gltf = await new GLTFLoader().loadAsync(dataUrl)
  const model = gltf.scene
  const box = new THREE.Box3().setFromObject(model)
  const size = box.getSize(new THREE.Vector3())
  const maxDim = Math.max(size.x, size.y, size.z)
  if (!(maxDim > 0)) return null
  const scale = 1.6 / maxDim
  model.scale.setScalar(scale)
  const center = box.getCenter(new THREE.Vector3()).multiplyScalar(scale)
  model.position.sub(center)
  model.rotation.y = -0.6
  scene.add(model)
  frameOrthographicCamera(camera, model)
  renderer.render(scene, camera)
  const data = renderer.domElement.toDataURL('image/webp', 0.85)
  scene.remove(model)
  model.traverse((child) => {
    const mesh = child
    if (mesh.geometry) mesh.geometry.dispose()
    const material = mesh.material
    if (Array.isArray(material)) material.forEach((m) => m.dispose())
    else if (material) material.dispose()
  })
  return data
}
`

/** The unified ingestion pipeline: convert -> upload -> verify -> catalog -> thumbnails. */
export class AssetIngestionService {
  readonly scratchRoot: string
  private readonly sh3fRoot: string
  private readonly modelsOut: string
  private readonly checkpointPath: string

  constructor(options: { scratchRoot?: string } = {}) {
    this.scratchRoot = options.scratchRoot ?? process.env.SH3D_SCRATCH_ROOT ?? DEFAULT_SCRATCH_ROOT
    this.sh3fRoot = join(this.scratchRoot, 'extracted', 'sh3f')
    this.modelsOut = join(this.scratchRoot, 'output', 'models')
    this.checkpointPath = join(this.scratchRoot, 'output', 'checkpoint.json')
  }

  /** Parse every archive's PluginFurnitureCatalog.properties into library items. */
  parseLibrary(): LibraryItem[] {
    const items: LibraryItem[] = []
    for (const sub of Object.keys(SUB_LICENSES)) items.push(...this.parsePropertiesFile(sub))
    return items
  }

  /** Check source geometry after the exact catalog rotation used by conversion. */
  checkTransform(item: LibraryItem): TransformCheck {
    if (item.rotationError) return { status: 'ambiguous', extents: [0, 0, 0], scale: null, error: null, swapError: null, reason: item.rotationError }
    const group = new OBJLoader().parse(readFileSync(item.objPath, 'utf8'))
    const rawBox = new THREE.Box3().setFromObject(group)
    const rawSize = rawBox.getSize(new THREE.Vector3())
    applyModelRotation(group, item.rotation)
    const size = new THREE.Box3().setFromObject(group).getSize(new THREE.Vector3())
    const check = classifyTransform([size.x, size.y, size.z], [item.width, item.depth])
    check.rawError = footprintError(rawSize.x, rawSize.z, item.width, item.depth)
    return check
  }

  private parsePropertiesFile(sub: string): LibraryItem[] {
    const propsPath = join(this.sh3fRoot, sub, 'PluginFurnitureCatalog.properties')
    if (!existsSync(propsPath)) return []
    const text = readFileSync(propsPath, 'utf8')
    const byIndex: Record<string, Record<string, string>> = {}
    for (const line of text.split(/\r?\n/)) {
      const m = line.match(/^([^#\s]+)#(\d+)=(.*)$/)
      if (m && m[1] && m[2] && m[3]) (byIndex[m[2]] ??= {})[m[1]] = m[3]
    }
    const items: LibraryItem[] = []
    for (const fields of Object.values(byIndex)) {
      const sourceId = fields.id ?? ''
      if (!sourceId) continue
      const license = SH3D_LICENSE_MAP[fields.license ?? ''] ?? SUB_LICENSES[sub] ?? 'Unknown'
      const objRel = (fields.model ?? '').replace(/^\//, '')
      const objPath = join(this.sh3fRoot, sub, objRel)
      const mtlPath = objPath.replace(/\.obj$/i, '.mtl')
      const rotationValues = fields.modelRotation?.trim().split(/\s+/).map(Number) ?? null
      const validRotation = isRotationMatrix(rotationValues)
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
        rotation: validRotation ? rotationValues : null,
        rotationError: fields.modelRotation !== undefined && !validRotation ? 'expected a proper 3×3 rotation matrix' : undefined,
      })
    }
    return items
  }

  loadCheckpoint(): Checkpoint {
    try {
      return JSON.parse(readFileSync(this.checkpointPath, 'utf8')) as Checkpoint
    } catch {
      return { items: {} }
    }
  }

  private saveCheckpoint(cp: Checkpoint): void {
    mkdirSync(dirname(this.checkpointPath), { recursive: true })
    const tmp = `${this.checkpointPath}.tmp`
    writeFileSync(tmp, JSON.stringify(cp, null, 1))
    renameSync(tmp, this.checkpointPath)
  }

  /**
   * The full pipeline for one batch: convert + upload + verify every pending
   * item (up to `limit`), merge the new entries into catalog.json, then render
   * + upload thumbnails for exactly those new items. Resumable: the checkpoint
   * means already-verified work is never redone.
   */
  async processBatch(options: ProcessBatchOptions = {}): Promise<BatchResult> {
    const added = await this.runBatch(options, { skipUpload: false, uploadOnly: false })
    return added
  }

  /** Convert only, no upload (--skip-upload CLI mode). */
  async convertBatch(options: ProcessBatchOptions = {}): Promise<BatchResult> {
    return this.runBatch(options, { skipUpload: true, uploadOnly: false })
  }

  /** Upload + verify already-converted GLBs (--upload-only CLI mode). */
  async uploadBatch(options: ProcessBatchOptions = {}): Promise<BatchResult> {
    return this.runBatch(options, { skipUpload: false, uploadOnly: true })
  }

  private async runBatch(
    options: ProcessBatchOptions,
    mode: { skipUpload: boolean; uploadOnly: boolean },
  ): Promise<BatchResult> {
    const { limit = 0, onProgress } = options
    const report = (stage: ProgressInfo['stage'], done: number, total: number, current?: string, message?: string) => {
      onProgress?.({ stage, done, total, current, message })
    }

    mkdirSync(this.modelsOut, { recursive: true })
    const checkpoint = this.loadCheckpoint()
    const items = this.parseLibrary()

    const pending = items.filter((item) => {
      const state = checkpoint.items[item.catalogId]
      if (mode.uploadOnly) return state?.converted === true && state?.verified !== true
      return !(state?.converted && (mode.skipUpload || state.verified))
    })
    const queue = limit > 0 ? pending.slice(0, limit) : pending
    console.log(`[import] ${items.length} catalog items; ${pending.length} pending; processing ${queue.length}`)

    const s3 = mode.skipUpload ? null : getR2S3Client()
    const errors: string[] = []
    let converted = 0
    let uploaded = 0
    let done = 0
    for (const item of queue) {
      const state = (checkpoint.items[item.catalogId] ??= { converted: false, uploaded: false, verified: false })
      try {
        const glbPath = join(this.modelsOut, `${item.slug}.glb`)
        let buffer: Buffer
        if (state.converted && existsSync(glbPath)) {
          buffer = readFileSync(glbPath)
        } else {
          installNodeGlbPolyfills()
          const { group, transformCheck } = this.convertToGroup(item)
          state.transformCheck = transformCheck
          if (state.transformCheck.status === 'axis-swap') {
            throw new Error(`transform audit flagged likely X/Z swap (error ${state.transformCheck.error?.toFixed(3)}, swapped ${state.transformCheck.swapError?.toFixed(3)})`)
          }
          if (state.transformCheck.status === 'ambiguous') {
            console.warn(`[import] transform ambiguous ${item.catalogId}: ${state.transformCheck.reason ?? `error ${state.transformCheck.error?.toFixed(3)}`}`)
          }
          buffer = await exportGlb(group)
          writeFileSync(glbPath, buffer)
          state.converted = true
          state.bytes = buffer.length
          converted++
        }
        if (s3 && !state.verified) {
          report('upload', done, queue.length, item.catalogId)
          state.uploaded = await uploadGlb(s3, item, buffer)
          state.verified = state.uploaded
          if (!state.uploaded) state.error = 'upload/verify failed'
          else uploaded++
        }
        if (state.verified || mode.skipUpload) {
          state.entry = buildEntry(item)
          delete state.error
        }
      } catch (err) {
        state.error = err instanceof Error ? err.message : String(err)
        errors.push(`${item.catalogId}: ${state.error}`)
        console.error(`[import] FAILED ${item.catalogId}: ${state.error}`)
        if (err instanceof Error && err.stack) console.error(err.stack.split('\n').slice(1, 5).join('\n'))
      }
      done++
      report('convert', done, queue.length, item.catalogId)
      if (done % 5 === 0 || done === queue.length) {
        this.saveCheckpoint(checkpoint)
        const ok = Object.values(checkpoint.items).filter((s) => s.verified).length
        console.log(`[import] progress ${done}/${queue.length} (verified total: ${ok})`)
      }
    }
    this.saveCheckpoint(checkpoint)
    const failed = Object.values(checkpoint.items).filter((s) => s.error)
    console.log(`[import] done. verified=${Object.values(checkpoint.items).filter((s) => s.verified).length} failed=${failed.length} checkpoint=${this.checkpointPath}`)

    // Merge only this batch's newly-verified entries into the catalog.
    let catalogAdded = 0
    if (!mode.skipUpload) {
      catalogAdded = this.mergeEntries((entry) =>
        queue.some((item) => item.catalogId === entry.catalogId),
      )
      report('catalog', catalogAdded, catalogAdded, undefined, `${catalogAdded} entries merged into catalog.json`)
    }

    // Thumbnails for exactly the items this batch added.
    let thumbnailsWritten = 0
    let thumbnailsSkipped = 0
    if (catalogAdded > 0) {
      const manifest = this.readCatalog()
      const addedIds = new Set(queue.map((item) => item.catalogId))
      const jobs = manifest.items
        .filter((entry) => addedIds.has(entry.catalogId) && entry.modelPath)
        .map((entry) => ({ catalogId: entry.catalogId, modelPath: entry.modelPath! }))
      const thumbs = await this.renderThumbnails(jobs, (p) => report('thumbnails', p.done, p.total, p.current))
      thumbnailsWritten = thumbs.written
      thumbnailsSkipped = thumbs.skipped
    }

    return {
      scanned: items.length,
      pending: pending.length,
      processed: queue.length,
      converted,
      uploaded,
      failed: errors.length,
      catalogAdded,
      thumbnailsWritten,
      thumbnailsSkipped,
      errors,
    }
  }

  /**
   * Merge verified checkpoint entries into catalog.json. `only` restricts the
   * merge to a subset (used by processBatch for just-this-batch entries);
   * without it, every verified entry missing from the catalog is merged
   * (legacy --merge-catalog behavior).
   */
  mergeCatalog(only?: (entry: CatalogEntry) => boolean): { added: number; total: number } {
    const added = this.mergeEntries(only)
    const total = this.readCatalog().items.length
    return { added, total }
  }

  private mergeEntries(only?: (entry: CatalogEntry) => boolean): number {
    const checkpoint = this.loadCheckpoint()
    const manifest = this.readCatalog()
    const existing = new Set(manifest.items.map((i) => i.catalogId))
    let added = 0
    for (const [catalogId, state] of Object.entries(checkpoint.items)) {
      if (!state.verified || !state.entry) continue
      if (existing.has(catalogId)) continue
      if (only && !only(state.entry)) continue
      manifest.items.push(state.entry)
      existing.add(catalogId)
      added++
    }
    if (added > 0) this.writeCatalog(manifest)
    console.log(`[import] merged ${added} entries into ${CATALOG_PATH} (total ${manifest.items.length} items)`)
    return added
  }

  readCatalog(): CatalogManifest {
    return JSON.parse(readFileSync(CATALOG_PATH, 'utf8')) as CatalogManifest
  }

  private writeCatalog(manifest: CatalogManifest): void {
    writeFileSync(CATALOG_PATH, `${JSON.stringify(manifest, null, 2)}\n`)
  }

  /**
   * Thumbnail backfill for the WHOLE catalog (npm run thumbnails): renders
   * every item that has a usable modelPath — external R2 models upload to
   * thumbs/<slug>.webp in the same bucket, local models write under
   * assets/thumbs/.
   */
  async renderCatalogThumbnails(onProgress?: (p: ProgressInfo) => void): Promise<ThumbResult & { total: number }> {
    const manifest = this.readCatalog()
    const jobs = manifest.items
      .filter((item) =>
        item.modelPath &&
        (isExternalModel(item.modelPath) || existsSync(join(ROOT, item.modelPath))),
      )
      .map((item) => ({ catalogId: item.catalogId, modelPath: item.modelPath! }))
    console.log(`[thumbs] rendering ${jobs.length} thumbnails (${manifest.items.length} catalog items)`)
    const result = await this.renderThumbnails(jobs, onProgress)
    return { ...result, total: manifest.items.length }
  }

  /** Render + upload/write thumbnails for the given jobs. One browser session. */
  async renderThumbnails(jobs: ThumbJob[], onProgress?: (p: ProgressInfo) => void): Promise<ThumbResult> {
    if (jobs.length === 0) return { written: 0, skipped: 0 }

    const s3 = jobs.some((job) => isExternalModel(job.modelPath)) ? getR2S3Client() : null

    const tmp = mkdtempSync(join(tmpdir(), 'thumbs-'))
    const bundle = join(tmp, 'renderer.js')
    await build({
      stdin: { contents: RENDERER_SOURCE, loader: 'ts', resolveDir: ROOT },
      bundle: true,
      format: 'iife',
      outfile: bundle,
      minify: false,
      logLevel: 'silent',
    })

    const browser = await chromium.launch()
    const page = await browser.newPage({ viewport: { width: THUMBNAIL_RENDER_SIZE, height: THUMBNAIL_RENDER_SIZE } })
    await page.goto('about:blank')
    await page.addScriptTag({ path: bundle })

    let written = 0
    let skipped = 0
    try {
      for (const job of jobs) {
        const external = isExternalModel(job.modelPath)
        try {
          let glb: Buffer
          if (external) {
            const res = await fetch(job.modelPath)
            if (!res.ok) throw new Error(`fetch failed: HTTP ${res.status}`)
            glb = Buffer.from(await res.arrayBuffer())
          } else {
            glb = readFileSync(join(ROOT, job.modelPath))
          }
          const dataUrl = `data:model/gltf-binary;base64,${glb.toString('base64')}`
          const result = (await page.evaluate(async (url) => {
            return await (window as unknown as { __renderThumb: (u: string) => Promise<string | null> }).__renderThumb(url)
          }, dataUrl)) as string | null
          if (!result || !result.startsWith('data:image/webp;base64,')) {
            skipped++
            console.warn(`[thumbs] skip ${job.catalogId}: renderer returned no image`)
            continue
          }
          const webp = Buffer.from(result.slice('data:image/webp;base64,'.length), 'base64')
          if (external) {
            await uploadR2Object(s3!, externalThumbKey(job.modelPath), webp, 'image/webp')
          } else {
            const out = localThumbPath(job.modelPath)
            mkdirSync(dirname(out), { recursive: true })
            writeFileSync(out, webp)
          }
          written++
        } catch (err) {
          skipped++
          console.warn(`[thumbs] skip ${job.catalogId}: ${err instanceof Error ? err.message : String(err)}`)
        }
        onProgress?.({ stage: 'thumbnails', done: written + skipped, total: jobs.length, current: job.catalogId })
      }
    } finally {
      await browser.close()
    }

    console.log(`[thumbs] done: ${written} written, ${skipped} skipped -> ${THUMBS_DIR}`)
    return { written, skipped }
  }

  private convertToGroup(item: LibraryItem): { group: THREE.Group; transformCheck: TransformCheck } {
    const objText = readFileSync(item.objPath, 'utf8')
    const objLoader = new OBJLoader()
    if (item.mtlPath) {
      const materialCreator: MaterialCreator = new MTLLoader().parse(sanitizeMtlText(item.mtlPath), dirname(item.mtlPath) + '/')
      materialCreator.preload()
      objLoader.setMaterials(materialCreator)
    }
    const group = objLoader.parse(objText)
    const rawSize = new THREE.Box3().setFromObject(group).getSize(new THREE.Vector3())
    if (!item.mtlPath) {
      const flatMaterial = new THREE.MeshStandardMaterial({ color: 0xc0c0c0, roughness: 0.8, metalness: 0.05 })
      group.traverse((child) => {
        if ((child as THREE.Mesh).isMesh) (child as THREE.Mesh).material = flatMaterial
      })
    }
    applyModelRotation(group, item.rotation)
    const size = new THREE.Box3().setFromObject(group).getSize(new THREE.Vector3())
    const transformCheck = item.rotationError
      ? { status: 'ambiguous' as const, extents: [0, 0, 0] as [number, number, number], scale: null, error: null, swapError: null, reason: item.rotationError }
      : classifyTransform([size.x, size.y, size.z], [item.width, item.depth])
    transformCheck.rawError = footprintError(rawSize.x, rawSize.z, item.width, item.depth)
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
    return { group, transformCheck }
  }
}

function applyModelRotation(group: THREE.Object3D, rotation: number[] | null): void {
  if (!rotation) return
  group.applyMatrix4(new THREE.Matrix4().set(
    rotation[0]!, rotation[1]!, rotation[2]!, 0,
    rotation[3]!, rotation[4]!, rotation[5]!, 0,
    rotation[6]!, rotation[7]!, rotation[8]!, 0,
    0, 0, 0, 1,
  ))
}

function isRotationMatrix(values: number[] | null): values is number[] {
  if (!values || values.length !== 9 || !values.every(Number.isFinite)) return false
  const rows = [values.slice(0, 3), values.slice(3, 6), values.slice(6, 9)]
  const dot = (a: number[], b: number[]) => a.reduce((sum, value, i) => sum + value * b[i]!, 0)
  if (rows.some((row) => Math.abs(dot(row, row) - 1) > 0.02)) return false
  if (Math.abs(dot(rows[0]!, rows[1]!)) > 0.02 || Math.abs(dot(rows[0]!, rows[2]!)) > 0.02 || Math.abs(dot(rows[1]!, rows[2]!)) > 0.02) return false
  const [a, b, c, d, e, f, g, h, i] = values
  const determinant = a! * (e! * i! - f! * h!) - b! * (d! * i! - f! * g!) + c! * (d! * h! - e! * g!)
  return Math.abs(determinant - 1) <= 0.02
}

export function classifyTransform(
  extents: [number, number, number],
  dimensions: [number, number],
): TransformCheck {
  const base = { extents, scale: null as number | null, error: null as number | null, swapError: null as number | null }
  if (![...extents, ...dimensions].every(Number.isFinite) || extents[0] <= 0 || extents[2] <= 0 || dimensions.some((n) => n <= 0)) {
    return { ...base, status: 'ambiguous', reason: 'missing or invalid geometry dimensions' }
  }
  const scale = Math.sqrt((extents[0] / dimensions[0]) * (extents[2] / dimensions[1]))
  const error = footprintError(extents[0], extents[2], dimensions[0], dimensions[1])
  const swapError = footprintError(extents[2], extents[0], dimensions[0], dimensions[1])
  if (error <= 0.05) {
    return { ...base, scale, error, swapError, status: Math.abs(scale - 1) > 0.15 ? 'pass-scale' : 'pass' }
  }
  const footprintDiff = Math.abs(dimensions[0] - dimensions[1]) / Math.max(dimensions[0], dimensions[1])
  if (swapError <= 0.05 && footprintDiff > 0.05) {
    return { ...base, scale, error, swapError, status: 'axis-swap' }
  }
  return { ...base, scale, error, swapError, status: 'ambiguous', reason: footprintDiff <= 0.05 ? 'near-square footprint cannot distinguish X/Z' : 'footprint does not match catalog proportions' }
}

function footprintError(x: number, z: number, width: number, depth: number): number {
  if (![x, z, width, depth].every(Number.isFinite) || x <= 0 || z <= 0 || width <= 0 || depth <= 0) return Infinity
  return Math.abs(Math.log((x / z) / (width / depth)))
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
    modelPath: `${r2PublicUrl()}/${R2_KEY_PREFIX}/${item.slug}.glb`,
    renderModelPath: `${r2PublicUrl()}/${R2_KEY_PREFIX}/${item.slug}/model.obj`,
  }
}

async function uploadGlb(s3: S3Client, item: LibraryItem, buffer: Buffer): Promise<boolean> {
  const key = `${R2_KEY_PREFIX}/${item.slug}.glb`
  await uploadR2Object(s3, key, buffer, 'model/gltf-binary')
  const publicUrl = `${r2PublicUrl()}/${key}`
  if (!await verifyUpload(publicUrl, 'model/gltf-binary')) return false
  const materials = extractGlbMaterials(buffer)
  if (materials) await uploadR2Object(s3, `models/${item.slug}/model.materials.json`, Buffer.from(JSON.stringify(materials)), 'application/json')
  return uploadRenderBundle(s3, item)
}

function extractGlbMaterials(buffer: Buffer): { materials: unknown[] } | null {
  if (buffer.toString('ascii', 0, 4) !== 'glTF') return null
  const jsonLength = buffer.readUInt32LE(12)
  try {
    const json = JSON.parse(buffer.subarray(20, 20 + jsonLength).toString('utf8'))
    return { materials: json.materials ?? [] }
  } catch {
    return null
  }
}

async function uploadRenderBundle(s3: S3Client, item: LibraryItem): Promise<boolean> {
  const prefix = `${R2_KEY_PREFIX}/${item.slug}`
  const objKey = `${prefix}/model.obj`
  let obj = readFileSync(item.objPath, 'utf8')
  let mtl: string | null = null
  if (item.mtlPath) {
    mtl = readFileSync(item.mtlPath, 'utf8')
    obj = obj.replace(/^mtllib\s+.*$/m, 'mtllib model.mtl')
    mtl = mtl.replace(/^(map_Kd|map_Ks|map_Ns|map_d|map_Bump|bump|disp)\s+(.+)$/gm, (_, key, value) => `${key} ${basename(value.trim())}`)
  }
  await uploadR2Object(s3, objKey, Buffer.from(obj), 'text/plain')
  if (mtl && item.mtlPath) {
    await uploadR2Object(s3, `${prefix}/model.mtl`, Buffer.from(mtl), 'text/plain')
    for (const line of mtl.split('\n')) {
      const match = /^(?:map_Kd|map_Ks|map_Ns|map_d|map_Bump|bump|disp)\s+(.+)$/i.exec(line.trim())
      if (!match) continue
      const source = join(dirname(item.mtlPath), basename(match[1]!.trim()))
      if (existsSync(source)) await uploadR2Object(s3, `${prefix}/${basename(source)}`, readFileSync(source), 'application/octet-stream')
    }
  }
  return verifyUpload(`${r2PublicUrl()}/${objKey}`, 'text/plain')
}

async function verifyUpload(publicUrl: string, contentType: string): Promise<boolean> {
  try {
    const res = await fetch(publicUrl, { method: 'HEAD' })
    return res.ok && (res.headers.get('content-type') ?? '').includes(contentType)
  } catch {
    return false
  }
}

installNodeGlbPolyfills()
