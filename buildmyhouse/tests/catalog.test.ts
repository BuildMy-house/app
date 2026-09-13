import { describe, expect, it } from 'vitest'
import { FurnitureCatalog } from '../src/core/catalog'
import type { CatalogItem, CatalogManifest } from '../src/core/catalog'
import { resolvePlacement, toWireItem, validateManifest } from '../src/core/catalog-service'
import { HomeStore } from '../src/core/store'
import { HomeModel } from '../src/core/model'
import { HomelyCommandHandler } from '../src/automation/homely-handler'
import catalogJsonRaw from '../assets/catalog/catalog.json'
const catalogJson = catalogJsonRaw as unknown as CatalogManifest

const fixture: CatalogItem[] = [
  {
    catalogId: 'sofa-3-seater',
    name: '3-Seater Sofa',
    category: 'Living',
    width: 210,
    depth: 90,
    height: 85,
    elevation: 0,
    color: 9144149,
    tags: ['sofa', 'couch'],
  },
  {
    catalogId: 'front-door',
    name: 'Front Door',
    category: 'Doors',
    width: 100,
    depth: 7,
    height: 210,
    elevation: 0,
    doorOrWindow: true,
    color: 6107674,
    tags: ['door'],
  },
  {
    catalogId: 'window-120',
    name: 'Window 120cm',
    category: 'Windows',
    width: 120,
    depth: 7,
    height: 130,
    elevation: 100,
    doorOrWindow: true,
    color: 12572149,
    tags: ['window'],
  },
]

describe('FurnitureCatalog', () => {
  it('indexes by id and category and lists all items', () => {
    const catalog = new FurnitureCatalog(fixture)
    expect(catalog.size).toBe(3)
    expect(catalog.get('sofa-3-seater')?.name).toBe('3-Seater Sofa')
    expect(catalog.get('missing')).toBeUndefined()
    expect(catalog.categories().sort()).toEqual(['Doors', 'Living', 'Windows'])
    expect(catalog.itemsIn('Doors')).toHaveLength(1)
    expect(catalog.list()).toHaveLength(3)
  })

  it('searches case-insensitively across name/category/tags', () => {
    const catalog = new FurnitureCatalog(fixture)
    expect(catalog.search('SOFA').map((i) => i.catalogId)).toEqual(['sofa-3-seater'])
    expect(catalog.search('door').map((i) => i.catalogId)).toEqual(['front-door'])
    expect(catalog.search('window').map((i) => i.catalogId)).toEqual(['window-120'])
    // empty query returns everything
    expect(catalog.search('')).toHaveLength(3)
    expect(catalog.search('  ')).toHaveLength(3)
    // no match
    expect(catalog.search('zzz')).toHaveLength(0)
  })

  it('rejects duplicate catalogIds', () => {
    const dup = [...fixture, { ...fixture[0]!, catalogId: 'sofa-3-seater' }]
    expect(() => new FurnitureCatalog(dup)).toThrow(/duplicate catalogId/)
  })

  it('returns defensive copies', () => {
    const catalog = new FurnitureCatalog(fixture)
    const item = catalog.get('sofa-3-seater')!
    item.name = 'Hacked'
    expect(catalog.get('sofa-3-seater')!.name).toBe('3-Seater Sofa')
  })
})

describe('catalog-service', () => {
  it('toWireItem emits exactly the ws-protocol.md:80 shape', () => {
    const catalog = new FurnitureCatalog(fixture)
    const wire = catalog.list().map(toWireItem)
    expect(wire[0]).toEqual({
      catalogId: 'sofa-3-seater',
      name: '3-Seater Sofa',
      width: 210,
      depth: 90,
      height: 85,
      doorOrWindow: false,
    })
    expect(wire[1]).toEqual({
      catalogId: 'front-door',
      name: 'Front Door',
      width: 100,
      depth: 7,
      height: 210,
      doorOrWindow: true,
    })
  })

  it('resolvePlacement returns placement fields, throwing on unknown id', () => {
    const catalog = new FurnitureCatalog(fixture)
    expect(resolvePlacement(catalog, 'sofa-3-seater')).toMatchObject({
      catalogId: 'sofa-3-seater',
      name: '3-Seater Sofa',
      width: 210,
      depth: 90,
      height: 85,
      elevation: 0,
      doorOrWindow: false,
    })
    expect(() => resolvePlacement(catalog, 'nope')).toThrow(/unknown catalogId: nope/)
  })

  it('validateManifest rejects bad manifests', () => {
    expect(() => validateManifest({ schemaVersion: 2 as 1, items: [] })).toThrow(/schemaVersion/)
    expect(() => validateManifest({ schemaVersion: 1, items: [] as CatalogItem[] })).not.toThrow()
    expect(() =>
      validateManifest({
        schemaVersion: 1,
        items: [{ catalogId: '', name: 'x', category: 'test', width: 1, depth: 1, height: 1 }],
      }),
    ).toThrow(/catalogId/)
    expect(() =>
      validateManifest({
        schemaVersion: 1,
        items: [{ catalogId: 'a', name: 'x', category: 'test', width: 0, depth: 1, height: 1 }],
      }),
    ).toThrow(/width/)
  })

  it('validateManifest allows an optional modelPath on an item', () => {
    expect(() =>
      validateManifest({
        schemaVersion: 1,
        items: [
          {
            catalogId: 'm',
            name: 'Modeled',
            category: 'Living',
            width: 100,
            depth: 50,
            height: 80,
            modelPath: 'models/sofa.glb',
          },
        ],
      }),
    ).not.toThrow()
  })
})

describe('bundled catalog manifest', () => {
  it('is structurally valid and has the expected categories', () => {
    expect(() => validateManifest(catalogJson)).not.toThrow()
    const catalog = new FurnitureCatalog(catalogJson.items)
    expect(catalog.size).toBeGreaterThanOrEqual(20)
    // Ported from SH3D's default catalog — these are the categories it defines.
    for (const category of ['Living', 'Bedroom', 'Kitchen', 'Bathroom', 'Doors', 'Other']) {
      expect(catalog.itemsIn(category).length).toBeGreaterThan(0)
    }
  })

  it('modelPath is optional (items without a model render as boxes)', () => {
    const catalog = new FurnitureCatalog(catalogJson.items)
    for (const item of catalog.list()) {
      if (item.modelPath !== undefined) {
        expect(item.modelPath, `item ${item.catalogId} modelPath`).toMatch(/^models\/.+\.glb$/)
      }
    }
  })
})

describe('automation catalog commands', () => {
  function handlerWithCatalog(): HomelyCommandHandler {
    const store = new HomeStore()
    const handler = new HomelyCommandHandler(store, { catalog: new FurnitureCatalog(fixture) })
    return handler
  }

  it('list_catalog returns wire-shaped items', () => {
    const handler = handlerWithCatalog()
    const result = handler.execute('list_catalog', {})
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.data).toEqual({
      items: fixture.map(toWireItem),
    })
  })

  it('catalog_add_furniture places a piece with manifest dims', () => {
    const store = new HomeStore()
    const handler = new HomelyCommandHandler(store, { catalog: new FurnitureCatalog(fixture) })

    const result = handler.execute('catalog_add_furniture', {
      catalogId: 'sofa-3-seater',
      x: 150,
      y: 200,
      angleDeg: 90,
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const id = (result.data as { id: string }).id
    const placed = store.getHome().furniture.find((f) => f.id === id)
    expect(placed).toMatchObject({
      catalogId: 'sofa-3-seater',
      name: '3-Seater Sofa',
      x: 150,
      y: 200,
      angleDeg: 90,
      width: 210,
      depth: 90,
      height: 85,
      color: 9144149,
      doorOrWindow: false,
    })
  })

  it('catalog_add_furniture rejects unknown catalogIds with INVALID_PARAMS', () => {
    const handler = handlerWithCatalog()
    const result = handler.execute('catalog_add_furniture', { catalogId: 'nope', x: 0, y: 0 })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe('INVALID_PARAMS')
  })

  it('add_furniture resolves dims from the catalog when catalogId is known', () => {
    const store = new HomeStore()
    const handler = new HomelyCommandHandler(store, { catalog: new FurnitureCatalog(fixture) })

    const result = handler.execute('add_furniture', { catalogId: 'window-120', x: 0, y: 0 })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const placed = store.getHome().furniture.at(-1)
    expect(placed).toMatchObject({
      catalogId: 'window-120',
      name: 'Window 120cm',
      width: 120,
      depth: 7,
      height: 130,
      elevation: 100, // manifest elevation used when not supplied
      doorOrWindow: true,
    })
  })

  it('add_furniture still accepts inline dims when catalogId is null (back-compat)', () => {
    const store = new HomeStore()
    const handler = new HomelyCommandHandler(store, { catalog: new FurnitureCatalog(fixture) })

    const result = handler.execute('add_furniture', {
      name: 'custom',
      x: 1,
      y: 2,
      width: 10,
      depth: 20,
      height: 30,
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const placed = store.getHome().furniture.at(-1)
    expect(placed).toMatchObject({ name: 'custom', catalogId: null, width: 10, depth: 20, height: 30 })
  })

  it('add_door attaches a door to the given wall (M5)', () => {
    const store = new HomeStore()
    const model = new HomeModel(store)
    const handler = new HomelyCommandHandler(store, { catalog: new FurnitureCatalog(fixture) })
    const wall = model.addWall({
      xStart: 0,
      yStart: 0,
      xEnd: 400,
      yEnd: 0,
      thickness: 10,
      height: 250,
      patternId: 'solid',
    })

    const result = handler.execute('add_door', { wallId: wall.id, x: 100, width: 90 })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const id = (result.data as { id: string }).id
    const placed = store.getHome().furniture.find((f) => f.id === id)
    expect(placed).toMatchObject({
      catalogId: 'front-door',
      name: 'Front Door',
      doorOrWindow: true,
      wallRef: wall.id,
      wallOffset: 100,
    })
    // Placed along the wall at the given offset, offset half the wall's
    // thickness to one side (on the wall face, not its centerline).
    expect(placed!.x).toBeCloseTo(100)
    expect(placed!.y).toBeCloseTo(5)
  })

  it('add_window attaches a window to the given wall (M5)', () => {
    const store = new HomeStore()
    const model = new HomeModel(store)
    const handler = new HomelyCommandHandler(store, { catalog: new FurnitureCatalog(fixture) })
    const wall = model.addWall({
      xStart: 0,
      yStart: 0,
      xEnd: 400,
      yEnd: 0,
      thickness: 10,
      height: 250,
      patternId: 'solid',
    })

    const result = handler.execute('add_window', { wallId: wall.id, x: 200, width: 120 })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const id = (result.data as { id: string }).id
    const placed = store.getHome().furniture.find((f) => f.id === id)
    expect(placed).toMatchObject({
      catalogId: 'window-120',
      name: 'Window 120cm',
      doorOrWindow: true,
      wallRef: wall.id,
      wallOffset: 200,
    })
  })

  it('add_door rejects an unknown wall id with INVALID_PARAMS', () => {
    const handler = handlerWithCatalog()
    const result = handler.execute('add_door', { wallId: 'nope', x: 0 })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe('INVALID_PARAMS')
  })

  it('list_catalog / catalog_add_furniture require a loaded catalog', () => {
    const handler = new HomelyCommandHandler(new HomeStore())
    const list = handler.execute('list_catalog', {})
    expect(list.ok).toBe(false)
    if (!list.ok) expect(list.code).toBe('INVALID_REQUEST')
    const add = handler.execute('catalog_add_furniture', { catalogId: 'x', x: 0, y: 0 })
    expect(add.ok).toBe(false)
    if (!add.ok) expect(add.code).toBe('INVALID_REQUEST')
  })

  it('get_capabilities advertises the new commands', () => {
    const handler = handlerWithCatalog()
    const result = handler.execute('get_capabilities', {})
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const commands = (result.data as { commands: string[] }).commands
    expect(commands).toContain('list_catalog')
    expect(commands).toContain('catalog_add_furniture')
  })
})
