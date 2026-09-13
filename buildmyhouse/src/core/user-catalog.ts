/**
 * user-catalog.ts — User-imported furniture models (runtime asset pipeline).
 *
 * SH3D parity: users import their own 3D models and they join the catalog
 * alongside the bundled defaults. This service:
 *   - accepts a model file (.glb) + metadata (name, dims, category)
 *   - stores it via a pluggable ModelStore (IndexedDB in the browser, Tauri
 *     fs later) so imports persist across sessions
 *   - exposes a merged view: bundled catalog + user items, all queryable
 *     through the same FurnitureCatalog surface used by the UI and the
 *     automation/MCP layer.
 */

import type { CatalogItem } from './catalog'
import { FurnitureCatalog } from './catalog'

/**
 * Hard cap on imported model bytes. All bundled models are ≤ 12 KB and
 * furniture GLBs are typically well under 20 MB; 50 MB leaves generous
 * headroom for detailed scans while blocking accidental multi-hundred-MB
 * memory bombs (an import buffers the bytes ~3×: read, store, blob URL).
 */
export const MAX_IMPORT_BYTES = 50 * 1024 * 1024

/** glTF binary magic number: ASCII "glTF", little-endian (glTF 2.0 spec). */
const GLB_MAGIC = 0x46546c67

/**
 * Fail fast on structurally invalid imports: size cap + GLB magic number.
 * Throws an Error whose message is safe to surface in the UI as-is.
 */
export function validateGlbData(data: ArrayBuffer, fileName = 'file'): void {
  if (data.byteLength > MAX_IMPORT_BYTES) {
    throw new Error(
      `${fileName} is ${(data.byteLength / 1024 / 1024).toFixed(1)} MB — the import limit is ${MAX_IMPORT_BYTES / 1024 / 1024} MB`,
    )
  }
  if (data.byteLength < 12) {
    throw new Error(`${fileName} is too small to be a GLB model`)
  }
  if (new DataView(data).getUint32(0, true) !== GLB_MAGIC) {
    throw new Error(`${fileName} is not a GLB model — missing glTF magic number`)
  }
}

export interface UserModelInput {
  /** Original file name (used as a default display name). */
  fileName: string
  /** Display name; falls back to fileName without extension. */
  name?: string
  category?: string
  width?: number
  depth?: number
  height?: number
  color?: number | null
  /** GLB bytes. */
  data: ArrayBuffer
}

/** Persistence seam — swap in IndexedDB, Tauri fs, or in-memory (tests). */
export interface ModelStore {
  list(): Promise<UserModelRecord[]>
  /** Persist a record plus its binary model data (when the store keeps blobs). */
  put(record: UserModelRecord, data?: ArrayBuffer): Promise<void>
  remove(id: string): Promise<void>
}

export interface UserModelRecord {
  /** Stable id like "user-<timestamp>-<slug>". */
  id: string
  catalogId: string
  name: string
  category: string
  width: number
  depth: number
  height: number
  color: number | null
  /** Storage key for the binary blob (object URL in memory, file path in fs). */
  blobKey: string
  createdAt: number
}

/** In-memory store — deterministic, testable; no persistence across reloads. */
export class InMemoryModelStore implements ModelStore {
  private readonly records: UserModelRecord[] = []
  private readonly blobs = new Map<string, ArrayBuffer>()

  async list(): Promise<UserModelRecord[]> {
    return this.records.map((r) => ({ ...r }))
  }

  async put(record: UserModelRecord, data?: ArrayBuffer): Promise<void> {
    const existing = this.records.findIndex((r) => r.id === record.id)
    if (existing >= 0) this.records[existing] = { ...record }
    else this.records.push({ ...record })
    if (data) this.blobs.set(record.blobKey, data.slice(0))
  }

  async remove(id: string): Promise<void> {
    const index = this.records.findIndex((r) => r.id === id)
    if (index >= 0) {
      const [removed] = this.records.splice(index, 1)
      if (removed) this.blobs.delete(removed.blobKey)
    }
  }

  getBlob(blobKey: string): ArrayBuffer | undefined {
    return this.blobs.get(blobKey)?.slice(0)
  }

  clear(): void {
    this.records.length = 0
    this.blobs.clear()
  }
}

/** Build a catalogId from a file name (slugified, dedup-safe). */
export function slugify(fileName: string): string {
  const base = fileName.replace(/\.[^.]+$/, '').toLowerCase()
  const slug = base
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
  return slug || 'model'
}

const DEFAULT_CATEGORY = 'Other'

/** Convert a user model input into a catalog item + storage record. */
export function toCatalogItem(input: UserModelInput, id: string): { item: CatalogItem; record: UserModelRecord } {
  const name = (input.name ?? input.fileName.replace(/\.[^.]+$/, '')).trim() || input.fileName
  const catalogId = slugify(`${id}-${input.fileName}`)
  const record: UserModelRecord = {
    id,
    catalogId,
    name,
    category: input.category ?? DEFAULT_CATEGORY,
    width: input.width ?? 100,
    depth: input.depth ?? 50,
    height: input.height ?? 80,
    color: input.color ?? 0x9e9e9e,
    blobKey: `blob:${id}`,
    createdAt: Date.now(),
  }
  const item: CatalogItem = {
    catalogId: record.catalogId,
    name: record.name,
    category: record.category,
    width: record.width,
    depth: record.depth,
    height: record.height,
    color: record.color,
    modelPath: record.blobKey,
  }
  return { item, record }
}

/**
 * Merged catalog: bundled items + user-imported items, with a refresh() that
 * re-reads the model store. `toItem(item)` maps a catalog item to a furniture
 * placement — user items keep modelPath pointing at their blob/fetch URL.
 */
export class UserCatalog {
  private bundled: FurnitureCatalog
  private userItems: CatalogItem[] = []
  private _user: FurnitureCatalog | null = null

  constructor(
    bundled: FurnitureCatalog,
    private readonly store: ModelStore,
  ) {
    this.bundled = bundled
  }

  /** Bundled (built-in) catalog. */
  get bundledCatalog(): FurnitureCatalog {
    return this.bundled
  }

  /** Merged catalog: bundled + user items. */
  get merged(): FurnitureCatalog {
    const all = [...this.bundled.list(), ...this.userItems]
    return new FurnitureCatalog(all)
  }

  get userCount(): number {
    return this.userItems.length
  }

  /** Re-read the model store and rebuild the user item list. */
  async refresh(): Promise<void> {
    const records = await this.store.list()
    this.userItems = records.map((record) => ({
      catalogId: record.catalogId,
      name: record.name,
      category: record.category,
      width: record.width,
      depth: record.depth,
      height: record.height,
      color: record.color,
      modelPath: record.blobKey,
    }))
    this._user = new FurnitureCatalog(this.userItems)
  }

  /** Import a model file into the store; returns the new record. */
  async import(input: UserModelInput): Promise<UserModelRecord> {
    validateGlbData(input.data, input.fileName)
    const id = `user-${Date.now().toString(36)}`
    const { record } = toCatalogItem(input, id)
    await this.store.put(record, input.data)
    await this.refresh()
    return record
  }

  async remove(id: string): Promise<void> {
    await this.store.remove(id)
    await this.refresh()
  }
}
