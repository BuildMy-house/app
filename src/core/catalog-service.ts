/**
 * catalog-service.ts — Catalog service: loads the bundled manifest, exposes
 * typed queries, and resolves catalog entries to furniture placement inputs.
 *
 * This is the single bridge between catalog data and the rest of the app.
 * It is deliberately free of DOM/network/platform imports so it can be reused
 * by the automation layer (list_catalog), the GUI catalog panel, and any
 * future MCP server over the same stable query surface.
 */

import { FurnitureCatalog, type CatalogItem, type CatalogManifest } from './catalog'
import { ModelError } from './model'

export interface CatalogLoadResult {
  catalog: FurnitureCatalog
  /** Source the manifest was read from (e.g. "/catalog/catalog.json"). */
  source: string
  /** The validated manifest as fetched (used for cache-change detection). */
  manifest: CatalogManifest
}

/** Sort + wrap a validated manifest into a FurnitureCatalog. */
export function catalogFromManifest(manifest: CatalogManifest): FurnitureCatalog {
  // Keep ordinary furniture first so the default placement action is useful;
  // doors/windows still remain searchable and available in the catalog.
  const items = [...manifest.items].sort((a, b) => Number(a.doorOrWindow === true) - Number(b.doorOrWindow === true))
  return new FurnitureCatalog(items)
}

const CATALOG_CACHE_KEY = 'buildmyhouse.catalog-manifest.v1'

/**
 * Read the manifest cached by a previous session from localStorage.
 * Returns null when absent or corrupt — callers fall back to the network.
 */
export function readCachedManifest(): CatalogManifest | null {
  try {
    const raw = localStorage.getItem(CATALOG_CACHE_KEY)
    if (!raw) return null
    const manifest = JSON.parse(raw) as CatalogManifest
    validateManifest(manifest)
    return manifest
  } catch {
    return null
  }
}

/** Best-effort persist a freshly-fetched manifest for next-session instant load. */
export function cacheManifest(manifest: CatalogManifest): void {
  try {
    localStorage.setItem(CATALOG_CACHE_KEY, JSON.stringify(manifest))
  } catch {
    // ponytail: quota/private-mode failures just mean next session re-fetches
  }
}

/** Fetch a catalog manifest (browser fetch; also works under node with a base). */
async function loadCatalogFromUrl(url: string): Promise<CatalogManifest> {
  const response = await fetch(url)
  if (!response.ok) {
    throw new Error(`catalog fetch failed: ${response.status} ${response.statusText} (${url})`)
  }
  const manifest = (await response.json()) as CatalogManifest
  validateManifest(manifest)
  return manifest
}

/** Load the default bundled catalog (served from the Vite/Tauri bundle root). */
export async function loadDefaultCatalog(): Promise<CatalogLoadResult> {
  // Vite copies public/ to dist/ at the bundle root: /assets/catalog/catalog.json
  const source = 'assets/catalog/catalog.json'
  const manifest = await loadCatalogFromUrl(source)
  cacheManifest(manifest)
  return { catalog: catalogFromManifest(manifest), source, manifest }
}

/** Minimal structural validation; throws a descriptive Error on bad manifests. */
export function validateManifest(manifest: CatalogManifest): void {
  if (manifest?.schemaVersion !== 1) {
    throw new Error('catalog manifest must have schemaVersion: 1')
  }
  if (!Array.isArray(manifest.items)) {
    throw new Error('catalog manifest must have an items array')
  }
  for (const item of manifest.items) {
    if (typeof item?.catalogId !== 'string' || item.catalogId.length === 0) {
      throw new Error('catalog item missing non-empty catalogId')
    }
    if (typeof item?.name !== 'string' || item.name.length === 0) {
      throw new Error(`catalog item ${JSON.stringify(item.catalogId)} missing name`)
    }
    for (const dim of ['width', 'depth', 'height'] as const) {
      if (typeof item[dim] !== 'number' || !Number.isFinite(item[dim]) || item[dim] <= 0) {
        throw new Error(`catalog item ${JSON.stringify(item.catalogId)} needs positive ${dim}`)
      }
    }
  }
}

/** Wire shape of list_catalog (ws-protocol.md:80). */
export function toWireItem(item: CatalogItem): {
  catalogId: string
  name: string
  width: number
  depth: number
  height: number
  doorOrWindow: boolean
} {
  return {
    catalogId: item.catalogId,
    name: item.name,
    width: item.width,
    depth: item.depth,
    height: item.height,
    doorOrWindow: item.doorOrWindow === true,
  }
}

/**
 * Resolve a catalog entry to the fields needed by model.addFurniture.
 * Throws a descriptive Error when the catalogId is unknown.
 */
export function resolvePlacement(
  catalog: FurnitureCatalog,
  catalogId: string,
): Pick<CatalogItem, 'catalogId' | 'name' | 'width' | 'depth' | 'height' | 'elevation' | 'color' | 'doorOrWindow' | 'modelPath' | 'renderModelPath'> {
  const item = catalog.get(catalogId)
  if (!item) {
    // Close-match suggestions for typo'd ids: try the raw id first, then its
    // alphanumeric chunks (so "sofa-01" still finds "sofa-3-seater").
    const chunks = catalogId.split(/[^a-zA-Z0-9]+/).filter((c) => c.length > 0)
    let matches: CatalogItem[] = []
    for (const needle of [catalogId, ...chunks]) {
      matches = catalog.search(needle)
      if (matches.length > 0) break
    }
    const suggestions = matches.slice(0, 3).map((m) => m.catalogId)
    const hint = suggestions.length > 0 ? `. Did you mean: ${suggestions.join(', ')}?` : ''
    throw new ModelError(`unknown catalogId: ${catalogId}${hint}`)
  }
  return {
    catalogId: item.catalogId,
    name: item.name,
    width: item.width,
    depth: item.depth,
    height: item.height,
    elevation: item.elevation ?? 0,
    color: item.color ?? null,
    doorOrWindow: item.doorOrWindow ?? false,
    modelPath: item.modelPath ?? null,
    renderModelPath: item.renderModelPath ?? null,
  }
}
