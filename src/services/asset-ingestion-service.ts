/**
 * AssetIngestionService — Phase 1 unified converter registry + batch pipeline.
 *
 * Orchestrates the real work previously living in
 * scripts/import-sh3d-library.ts (kept untouched as the reference): parse the
 * SH3D PluginFurnitureCatalog.properties files, convert via the registered
 * AssetConverter for 'model', upload to R2, verify, and merge into the catalog
 * — with the same checkpoint file (.sh3d-scratch/output/checkpoint.json) so
 * existing checkpoint state stays resumable.
 *
 * R2 credentials come either from the manual env workflow
 * (R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY / R2_S3_ENDPOINT / R2_BUCKET_NAME /
 * R2_PUBLIC_URL, takes priority) or are fetched from Infisical
 * (secret names R2_ENDPOINT / R2_BUCKET there) — the Infisical-name → upload
 * options mapping happens once in credentialsToR2Options().
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Buffer } from 'node:buffer'
import { S3Client, PutObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3'
import { ObjToGlbConverter } from './converters/obj-to-glb.js'
import { synthesizeEteksMtl } from './converters/eteks-material-palette.js'

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const SH3D_ROOT = join(REPO_ROOT, '.sh3d-scratch', 'source', 'eteks-default')
const OUTPUT_DIR = join(REPO_ROOT, '.sh3d-scratch', 'output')
const SYNTHETIC_MTL_DIR = join(OUTPUT_DIR, 'mtl')
const MODELS_OUT = join(OUTPUT_DIR, 'models')
const CHECKPOINT_PATH = join(OUTPUT_DIR, 'checkpoint.json')
const CATALOG_PATH = join(REPO_ROOT, 'assets', 'catalog', 'catalog.json')
const R2_KEY_PREFIX = 'models'

export type AssetType = 'model' | 'material' | 'hdri' | 'background'

export interface ConversionOptions {
  /** Resolved path to the companion .mtl file, or null when the model has none. */
  mtlPath: string | null
  /** Model-space rotation matrix (row-major 3x3) from the SH3D catalog, or null. */
  rotation?: Rotation9 | null
}

export interface ConvertedAsset {
  buffer: Buffer
  byteSize: number
  format: string
}

export interface AssetConverter {
  canHandle(format: string): boolean
  convert(input: Buffer, options: ConversionOptions): Promise<ConvertedAsset>
}

export interface AssetBatch {
  limit: number
  category?: string
  uploadToR2: boolean
  mergeIntoCatalog: boolean
}

export interface IngestionProgress {
  phase: 'downloading' | 'extracting' | 'converting' | 'uploading' | 'merging' | 'complete'
  processed: number
  total: number
  currentItem?: string
  error?: string
}

export interface IngestionResult {
  processed: number
  converted: number
  uploaded: number
  failed: number
  /** Total verified items across all runs, per the shared checkpoint. */
  verified: number
  merged: number
  errors: string[]
}

export interface InfisicalCredentials {
  R2_ACCESS_KEY_ID: string
  R2_SECRET_ACCESS_KEY: string
  R2_BUCKET: string
  R2_ENDPOINT: string
  R2_ACCOUNT_ID?: string
  R2_PUBLIC_URL?: string
}

export interface R2UploadOptions {
  accessKeyId: string
  secretAccessKey: string
  endpoint: string
  bucket: string
  publicUrl: string
}

/** Row-major 3x3 rotation, retained for converter compatibility. */
export type Rotation9 = [number, number, number, number, number, number, number, number, number]

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
  rotation: Rotation9 | null
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

function resolveObjPath(name: string): string | null {
  const flat = join(SH3D_ROOT, `${name}.obj`)
  if (existsSync(flat)) return flat
  const nested = join(SH3D_ROOT, name, `${name}.obj`)
  return existsSync(nested) ? nested : null
}

function loadCatalogItems(): LibraryItem[] {
  const manifest = JSON.parse(readFileSync(CATALOG_PATH, 'utf8')) as CatalogManifest
  const items: LibraryItem[] = []
  for (const entry of manifest.items) {
    const name = entry.catalogId.split('#')[1]
    const objPath = name ? resolveObjPath(name) : null
    if (!name || !objPath) {
      console.warn(`[import] SKIP ${entry.catalogId}: source OBJ not found`)
      continue
    }
    const mtlPath = objPath.replace(/\.obj$/i, '.mtl')
    items.push({ ...entry, slug: slugify(name), license: 'Unknown', objPath, mtlPath: existsSync(mtlPath) ? mtlPath : null, rotation: null })
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

function buildEntry(item: LibraryItem, publicUrl: string): CatalogEntry {
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
    modelPath: `${publicUrl || 'https://pub-fe765786711f4197a36aa5baabc8a3d6.r2.dev'}/${R2_KEY_PREFIX}/${item.slug}.glb`,
  }
}

function getS3Client(r2: R2UploadOptions): S3Client {
  return new S3Client({
    region: 'auto',
    endpoint: r2.endpoint,
    credentials: { accessKeyId: r2.accessKeyId, secretAccessKey: r2.secretAccessKey },
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

// ponytail: public-URL verify first; S3 fallback because some sandboxes'
// egress gets TLS-rejected by Cloudflare on *.r2.dev (alert 40) while the
// S3 API endpoint works — drop the fallback once that's not our reality.
async function verifyUploadViaS3(s3: S3Client, r2: R2UploadOptions, key: string): Promise<boolean> {
  try {
    const head = await s3.send(new HeadObjectCommand({ Bucket: r2.bucket, Key: key }))
    return head.ContentType === 'model/gltf-binary'
  } catch {
    return false
  }
}

async function uploadOne(s3: S3Client, r2: R2UploadOptions, slug: string, buffer: Buffer): Promise<boolean> {
  const key = `${R2_KEY_PREFIX}/${slug}.glb`
  await s3.send(new PutObjectCommand({
    Bucket: r2.bucket,
    Key: key,
    Body: buffer,
    ContentType: 'model/gltf-binary',
  }))
  return (await verifyUpload(`${r2.publicUrl}/${key}`)) || (await verifyUploadViaS3(s3, r2, key))
}

/**
 * Core asset ingestion service: converter registry + batch pipeline.
 * Used by CLI scripts (npm run import:batch) and reusable from server code.
 */
export class AssetIngestionService {
  private converters: Map<string, AssetConverter[]> = new Map()
  private progressCallbacks: Array<(progress: IngestionProgress) => void> = []
  private infisicalCredentials: InfisicalCredentials | null = null
  private r2Options: R2UploadOptions | null = null

  constructor() {
    // Phase 1 ships only the model converter; Phase 2+ registers
    // material/hdri/background converters via registerConverter().
    this.registerConverter('model', new ObjToGlbConverter())
  }

  registerConverter(type: AssetType, converter: AssetConverter): void {
    const list = this.converters.get(type) ?? []
    list.push(converter)
    this.converters.set(type, list)
  }

  private converterFor(type: AssetType, format: string): AssetConverter | null {
    return this.converters.get(type)?.find((c) => c.canHandle(format)) ?? null
  }

  onProgress(callback: (progress: IngestionProgress) => void): void {
    this.progressCallbacks.push(callback)
  }

  private emitProgress(progress: IngestionProgress): void {
    for (const callback of this.progressCallbacks) {
      try {
        callback(progress)
      } catch (err) {
        console.error('Progress callback error:', err)
      }
    }
  }

  /**
   * Fetch R2 credentials from Infisical.
   *
   * Secrets live at Project "Build My house"
   * (8806c2b0-73d2-4bea-8537-5b874c5ff592), environment dev, path /infra.
   * The raw-secret route only exists under /api/v3 and requires
   * workspaceId/environment/secretPath query params (the old /api/v1 call
   * 404'd with "Route not Found").
   */
  async fetchCredentialsFromInfisical(): Promise<InfisicalCredentials | null> {
    if (this.infisicalCredentials) return this.infisicalCredentials
    const token = process.env.INFISICAL_TOKEN
    if (!token) {
      console.warn('Infisical token not configured')
      return null
    }
    try {
      const projectId = process.env.INFISICAL_PROJECT_ID || '8806c2b0-73d2-4bea-8537-5b874c5ff592'
      const environment = process.env.INFISICAL_ENV || 'dev'
      const secretPath = process.env.INFISICAL_SECRET_PATH || '/infra'
      // INFISICAL_API_URL historically holds the v1 base; normalize to v3.
      const base = (process.env.INFISICAL_API_URL || 'https://eu.infisical.com/api/v1')
        .replace(/\/api\/v\d+\/?$/, '')
      const urlFor = (key: string) =>
        `${base}/api/v3/secrets/raw/${key}?workspaceId=${projectId}&environment=${environment}&secretPath=${encodeURIComponent(secretPath)}`

      const keys = [
        'R2_ACCESS_KEY_ID',
        'R2_SECRET_ACCESS_KEY',
        'R2_BUCKET',
        'R2_ENDPOINT',
        'R2_ACCOUNT_ID',
        'R2_PUBLIC_URL',
      ] as const

      const values: Record<string, string> = {}
      for (const key of keys) {
        const response = await fetch(urlFor(key), {
          headers: { Authorization: `Bearer ${token}` },
          signal: AbortSignal.timeout(10000),
        })
        if (!response.ok) continue
        const data = await response.json() as { secret?: { secretValue?: string }; secretValue?: string }
        const value = data.secret?.secretValue ?? data.secretValue
        if (value) values[key] = value
      }

      if (!values.R2_ACCESS_KEY_ID || !values.R2_ENDPOINT) {
        console.warn('Incomplete R2 credentials in Infisical')
        return null
      }

      // R2_ACCOUNT_ID / R2_PUBLIC_URL are genuinely absent from Infisical;
      // derive them (account ID from the endpoint, public URL from bucket+account).
      if (!values.R2_ACCOUNT_ID) {
        const match = values.R2_ENDPOINT.match(/https:\/\/([a-f0-9]+)\.r2/)
        if (match?.[1]) values.R2_ACCOUNT_ID = match[1]
      }
      if (!values.R2_PUBLIC_URL && values.R2_BUCKET && values.R2_ACCOUNT_ID) {
        values.R2_PUBLIC_URL = `https://${values.R2_BUCKET}.${values.R2_ACCOUNT_ID}.r2.dev`
      }

      const credentials: InfisicalCredentials = {
        R2_ACCESS_KEY_ID: values.R2_ACCESS_KEY_ID,
        R2_SECRET_ACCESS_KEY: values.R2_SECRET_ACCESS_KEY ?? '',
        R2_BUCKET: values.R2_BUCKET ?? '',
        R2_ENDPOINT: values.R2_ENDPOINT,
        R2_ACCOUNT_ID: values.R2_ACCOUNT_ID,
        R2_PUBLIC_URL: values.R2_PUBLIC_URL,
      }
      this.infisicalCredentials = credentials
      console.log('✓ R2 credentials loaded from Infisical')
      return credentials
    } catch (err) {
      console.warn('Failed to fetch credentials from Infisical:', err instanceof Error ? err.message : err)
      return null
    }
  }

  /** The one place Infisical secret names are mapped onto upload options. */
  private credentialsToR2Options(c: InfisicalCredentials): R2UploadOptions | null {
    if (!c.R2_ACCOUNT_ID || !c.R2_PUBLIC_URL) return null
    return {
      accessKeyId: c.R2_ACCESS_KEY_ID,
      secretAccessKey: c.R2_SECRET_ACCESS_KEY,
      endpoint: c.R2_ENDPOINT,
      bucket: c.R2_BUCKET,
      publicUrl: c.R2_PUBLIC_URL,
    }
  }

  /** Manual env workflow first (same var names the reference script reads). */
  private r2OptionsFromEnv(): R2UploadOptions | null {
    const { R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_S3_ENDPOINT, R2_BUCKET_NAME } = process.env
    if (!R2_ACCESS_KEY_ID || !R2_SECRET_ACCESS_KEY || !R2_S3_ENDPOINT || !R2_BUCKET_NAME) return null
    return {
      accessKeyId: R2_ACCESS_KEY_ID,
      secretAccessKey: R2_SECRET_ACCESS_KEY,
      endpoint: R2_S3_ENDPOINT,
      bucket: R2_BUCKET_NAME,
      publicUrl: process.env.R2_PUBLIC_URL ?? '',
    }
  }

  private async resolveR2Options(): Promise<R2UploadOptions | null> {
    if (this.r2Options) return this.r2Options
    const fromEnv = this.r2OptionsFromEnv()
    if (fromEnv) {
      this.r2Options = fromEnv
      return fromEnv
    }
    const creds = await this.fetchCredentialsFromInfisical()
    if (!creds) return null
    const mapped = this.credentialsToR2Options(creds)
    if (!mapped) {
      console.warn('Infisical credentials incomplete (missing account ID / public URL)')
      return null
    }
    this.r2Options = mapped
    return mapped
  }

  /**
   * Convert (and optionally upload/verify) a batch of SH3D models, walking the
   * shared checkpoint so runs are resumable. limit <= 0 means "no limit".
   */
  async processBatch(batch: AssetBatch): Promise<IngestionResult> {
    const result: IngestionResult = { processed: 0, converted: 0, uploaded: 0, failed: 0, verified: 0, merged: 0, errors: [] }
    this.emitProgress({ phase: 'downloading', processed: 0, total: 0 })

    const converter = this.converterFor('model', 'obj')
    if (!converter) throw new Error("No converter registered for 'model'")

    mkdirSync(MODELS_OUT, { recursive: true })
    mkdirSync(SYNTHETIC_MTL_DIR, { recursive: true })
    const checkpoint = loadCheckpoint()
    const items = loadCatalogItems()
    const firstMtl = items.findIndex((item) => item.mtlPath !== null)
    if (firstMtl > 0) items.unshift(...items.splice(firstMtl, 1))
    this.emitProgress({ phase: 'extracting', processed: 0, total: items.length })

    let pending = items.filter((item) => {
      const state = checkpoint.items[item.catalogId]
      return !(state?.converted && (!batch.uploadToR2 || state.verified))
    })
    // The reference script accepted --category but ignored it; actually filter here.
    if (batch.category) {
      pending = pending.filter((item) => item.category.toLowerCase() === batch.category!.toLowerCase())
    }
    const queue = batch.limit > 0 ? pending.slice(0, batch.limit) : pending
    console.log(`[import] ${items.length} catalog items; ${pending.length} pending; processing ${queue.length}`)

    const r2 = batch.uploadToR2 ? await this.resolveR2Options() : null
    if (batch.uploadToR2 && !r2) {
      throw new Error('R2 upload requested but no credentials available (env or Infisical)')
    }
    const s3 = r2 ? getS3Client(r2) : null

    let done = 0
    for (const item of queue) {
      const state = (checkpoint.items[item.catalogId] ??= { converted: false, uploaded: false, verified: false })
      try {
        const glbPath = join(MODELS_OUT, `${item.slug}.glb`)
        let buffer: Buffer
        if (state.converted && existsSync(glbPath)) {
          buffer = readFileSync(glbPath)
        } else {
          this.emitProgress({ phase: 'converting', processed: done, total: queue.length, currentItem: item.catalogId })
          const objText = readFileSync(item.objPath, 'utf8')
          const mtlPath = item.mtlPath ?? synthesizeEteksMtl(objText, join(SYNTHETIC_MTL_DIR, `${item.slug}.mtl`))
          const asset = await converter.convert(Buffer.from(objText), { mtlPath, rotation: item.rotation })
          buffer = asset.buffer
          writeFileSync(glbPath, buffer)
          state.converted = true
          state.bytes = buffer.length
          result.converted++
        }
        if (s3 && r2 && !state.verified) {
          this.emitProgress({ phase: 'uploading', processed: done, total: queue.length, currentItem: item.catalogId })
          state.uploaded = await uploadOne(s3, r2, item.slug, buffer)
          state.verified = state.uploaded
          if (!state.uploaded) {
            state.error = 'upload/verify failed'
          } else {
            result.uploaded++
          }
        }
        if (state.verified || !batch.uploadToR2) {
          state.entry = buildEntry(item, r2?.publicUrl ?? '')
          delete state.error
        }
      } catch (err) {
        state.error = err instanceof Error ? err.message : String(err)
        result.errors.push(`${item.catalogId}: ${state.error}`)
        console.error(`[import] FAILED ${item.catalogId}: ${state.error}`)
        if (err instanceof Error && err.stack) console.error(err.stack.split('\n').slice(1, 5).join('\n'))
      }
      done++
      result.processed = done
      if (done % 5 === 0 || done === queue.length) {
        saveCheckpoint(checkpoint)
        const ok = Object.values(checkpoint.items).filter((st) => st.verified).length
        console.log(`[import] progress ${done}/${queue.length} (verified total: ${ok})`)
      }
    }
    saveCheckpoint(checkpoint)

    if (batch.mergeIntoCatalog) {
      this.emitProgress({ phase: 'merging', processed: queue.length, total: queue.length })
      result.merged = this.mergeCatalog()
    }

    result.verified = Object.values(checkpoint.items).filter((st) => st.verified).length
    result.failed = Object.values(checkpoint.items).filter((st) => st.error).length
    console.log(`[import] done. verified=${result.verified} failed=${result.failed} checkpoint=${CHECKPOINT_PATH}`)
    this.emitProgress({ phase: 'complete', processed: result.processed, total: queue.length })
    return result
  }

  /** Merge all verified checkpoint entries into assets/catalog/catalog.json (idempotent by catalogId). */
  mergeCatalog(): number {
    const checkpoint = loadCheckpoint()
    const manifest = JSON.parse(readFileSync(CATALOG_PATH, 'utf8')) as CatalogManifest
    let replaced = 0
    for (const [catalogId, state] of Object.entries(checkpoint.items)) {
      if (!state.verified || !state.entry) continue
      const index = manifest.items.findIndex((item) => item.catalogId === catalogId)
      if (index === -1) manifest.items.push(state.entry)
      else manifest.items[index] = state.entry
      replaced++
    }
    writeFileSync(CATALOG_PATH, `${JSON.stringify(manifest, null, 2)}\n`)
    console.log(`[import] merged ${replaced} entries into ${CATALOG_PATH} (total ${manifest.items.length} items)`)
    return replaced
  }
}
