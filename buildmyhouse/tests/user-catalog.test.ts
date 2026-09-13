import { describe, expect, it } from 'vitest'
import { FurnitureCatalog } from '../src/core/catalog'
import {
  InMemoryModelStore,
  MAX_IMPORT_BYTES,
  UserCatalog,
  slugify,
  toCatalogItem,
  validateGlbData,
} from '../src/core/user-catalog'
import { VIEWPORT_PRESETS, loadViewportQuality, saveViewportQuality } from '../src/view3d/viewport-quality'

const bundled = new FurnitureCatalog([
  {
    catalogId: 'sofa-3-seater',
    name: '3-Seater Sofa',
    category: 'Living',
    width: 210,
    depth: 90,
    height: 85,
    color: 9144149,
  },
])

function glbBytes(): ArrayBuffer {
  // Minimal valid-looking GLB header (not parsed by these tests).
  const buf = new ArrayBuffer(20)
  const view = new DataView(buf)
  view.setUint32(0, 0x46546c67, true) // glTF magic
  view.setUint32(4, 2, true) // version 2
  view.setUint32(8, 20, true) // total length
  return buf
}

describe('user-catalog', () => {
  it('slugify produces a clean slug from a file name', () => {
    expect(slugify('My Cool Sofa.glb')).toBe('my-cool-sofa')
    expect(slugify('  UPPER  Case .GLB')).toBe('upper-case')
    expect(slugify('!!!')).toBe('model')
    expect(slugify('a.b.c.glb')).toBe('a-b-c')
  })

  it('toCatalogItem derives name, dims and blob key from input', () => {
    const { item, record } = toCatalogItem(
      { fileName: 'chair.glb', name: 'Office Chair', width: 60, depth: 60, height: 110, data: glbBytes() },
      'user-abc',
    )
    expect(record).toMatchObject({
      id: 'user-abc',
      name: 'Office Chair',
      width: 60,
      depth: 60,
      height: 110,
      category: 'Other',
      blobKey: 'blob:user-abc',
    })
    expect(item).toMatchObject({
      catalogId: record.catalogId,
      name: 'Office Chair',
      width: 60,
      depth: 60,
      height: 110,
      modelPath: 'blob:user-abc',
    })
  })

  it('import merges user items into the catalog and persists them', async () => {
    const store = new InMemoryModelStore()
    const user = new UserCatalog(bundled, store)

    expect(user.merged.size).toBe(1)
    expect(user.userCount).toBe(0)

    const record = await user.import({
      fileName: 'my-chair.glb',
      name: 'My Chair',
      width: 50,
      depth: 50,
      height: 90,
      data: glbBytes(),
    })
    expect(user.userCount).toBe(1)
    expect(user.merged.size).toBe(2)
    expect(user.merged.get(record.catalogId)?.name).toBe('My Chair')

    // In-memory store retains the blob.
    expect(store.getBlob(record.blobKey)?.byteLength).toBe(20)

    // Removal drops it back to bundled-only.
    await user.remove(record.id)
    expect(user.userCount).toBe(0)
    expect(user.merged.size).toBe(1)
    expect(store.getBlob(record.blobKey)).toBeUndefined()
  })

  it('refresh rebuilds the merged catalog from the store', async () => {
    const store = new InMemoryModelStore()
    const user = new UserCatalog(bundled, store)
    await user.import({ fileName: 'table.glb', name: 'Table', data: glbBytes() })

    // A second instance reading the same store sees the imported item.
    const user2 = new UserCatalog(bundled, store)
    await user2.refresh()
    expect(user2.userCount).toBe(1)
    expect(user2.merged.size).toBe(2)
  })
})

describe('import validation', () => {
  it('accepts a buffer with a valid GLB header', () => {
    expect(() => validateGlbData(glbBytes(), 'ok.glb')).not.toThrow()
  })

  it('rejects non-GLB content (e.g. text renamed to .glb)', () => {
    const text = new TextEncoder().encode('hello, i am definitely not a glb file')
    expect(() => validateGlbData(text.buffer, 'fake.glb')).toThrow(/not a GLB/)
  })

  it('rejects buffers too small to be a GLB', () => {
    expect(() => validateGlbData(new ArrayBuffer(8), 'tiny.glb')).toThrow(/too small/)
  })

  it('rejects buffers over the size cap even with a valid magic number', () => {
    const huge = new ArrayBuffer(MAX_IMPORT_BYTES + 1)
    new DataView(huge).setUint32(0, 0x46546c67, true)
    expect(() => validateGlbData(huge, 'huge.glb')).toThrow(/import limit is 50 MB/)
  })

  it('import refuses invalid data without storing anything', async () => {
    const store = new InMemoryModelStore()
    const user = new UserCatalog(bundled, store)
    await expect(
      user.import({
        fileName: 'fake.glb',
        data: new TextEncoder().encode('definitely not a glb file').buffer,
      }),
    ).rejects.toThrow(/not a GLB/)
    expect(user.userCount).toBe(0)
    expect(store.list()).resolves.toHaveLength(0)
  })
})

describe('viewport quality presets', () => {
  it('has low/medium/high/ultra with increasing fidelity', () => {
    expect(VIEWPORT_PRESETS.low.pixelRatioCap).toBeLessThan(VIEWPORT_PRESETS.ultra.pixelRatioCap)
    expect(VIEWPORT_PRESETS.low.shadowMapSize).toBeLessThan(VIEWPORT_PRESETS.ultra.shadowMapSize)
    expect(VIEWPORT_PRESETS.low.maxAnisotropy).toBeLessThan(VIEWPORT_PRESETS.ultra.maxAnisotropy)
  })

  it('round-trips through storage and clamps bad values', () => {
    const store = new Map<string, string>()
    const storage = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
    }

    saveViewportQuality(VIEWPORT_PRESETS.high, storage)
    const loaded = loadViewportQuality(storage)
    expect(loaded.preset).toBe('high')
    expect(loaded.pixelRatioCap).toBe(2)

    // Corrupt stored values fall back to safe defaults, not garbage.
    store.set('homely-viewport-quality', JSON.stringify({ preset: 'ultra', pixelRatioCap: 999, shadowMapSize: -5 }))
    const clamped = loadViewportQuality(storage)
    expect(clamped.pixelRatioCap).toBeLessThanOrEqual(4)
    expect(clamped.shadowMapSize).toBeGreaterThanOrEqual(256)

    store.set('homely-viewport-quality', 'not json')
    expect(loadViewportQuality(storage).preset).toBe('medium')
  })
})
