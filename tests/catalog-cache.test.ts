// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { CatalogManifest } from '../src/core/catalog'
import {
  cacheManifest,
  catalogFromManifest,
  loadDefaultCatalog,
  readCachedManifest,
} from '../src/core/catalog-service'

const KEY = 'buildmyhouse.catalog-manifest.v1'

// Door listed first on purpose: catalogFromManifest must sort furniture first.
const manifest: CatalogManifest = {
  schemaVersion: 1,
  items: [
    { catalogId: 'door', name: 'Door', category: 'Doors', width: 90, depth: 10, height: 210, doorOrWindow: true },
    { catalogId: 'sofa', name: 'Sofa', category: 'Living', width: 200, depth: 90, height: 80 },
  ],
}

afterEach(() => {
  vi.unstubAllGlobals()
  localStorage.clear()
})

describe('catalog manifest cache', () => {
  it('returns null when nothing is cached', () => {
    expect(readCachedManifest()).toBeNull()
  })

  it('round-trips a cached manifest', () => {
    cacheManifest(manifest)
    expect(readCachedManifest()).toEqual(manifest)
  })

  it('treats corrupt cache as absent', () => {
    localStorage.setItem(KEY, '{not json')
    expect(readCachedManifest()).toBeNull()
  })

  it('treats invalid (wrong schemaVersion) cache as absent', () => {
    localStorage.setItem(KEY, JSON.stringify({ schemaVersion: 2, items: manifest.items }))
    expect(readCachedManifest()).toBeNull()
  })

  it('survives localStorage being unavailable (node)', () => {
    vi.stubGlobal('localStorage', undefined)
    expect(readCachedManifest()).toBeNull()
    expect(() => cacheManifest(manifest)).not.toThrow()
  })

  it('catalogFromManifest keeps ordinary furniture before doors/windows', () => {
    const catalog = catalogFromManifest(manifest)
    expect(catalog.list().map((i) => i.catalogId)).toEqual(['sofa', 'door'])
    expect(catalog.get('door')?.doorOrWindow).toBe(true)
  })

  it('loadDefaultCatalog fetches, validates, and caches the manifest', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(manifest), { status: 200 })))
    const result = await loadDefaultCatalog()
    expect(result.catalog.size).toBe(2)
    expect(result.manifest).toEqual(manifest)
    expect(readCachedManifest()).toEqual(manifest)
  })
})
