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
}

/** Fetch a catalog manifest (browser fetch; also works under node with a base). */
export async function loadCatalogFromUrl(url: string): Promise<CatalogManifest> {
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
  return { catalog: new FurnitureCatalog(manifest.items), source }
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
): Pick<CatalogItem, 'catalogId' | 'name' | 'width' | 'depth' | 'height' | 'elevation' | 'color' | 'doorOrWindow' | 'modelPath'> {
  const item = catalog.get(catalogId)
  if (!item) {
    throw new ModelError(`unknown catalogId: ${catalogId}`)
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
  }
}
