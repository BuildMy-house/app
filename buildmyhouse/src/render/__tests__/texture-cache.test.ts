import { describe, it, expect } from 'vitest'
import { TextureCache } from '../texture-cache'

describe('TextureCache', () => {
  it('registers and retrieves', () => {
    const cache = new TextureCache()
    const def = TextureCache.createDef('tex1', 'textures/wood.png', 512, 512, 100, 100)
    cache.register(def, 'abc123', '/abs/path/wood.png')
    expect(cache.get('tex1')).toBeDefined()
    expect(cache.get('tex1')?.hash).toBe('abc123')
  })

  it('deduplicates by hash', () => {
    const cache = new TextureCache()
    const d1 = TextureCache.createDef('t1', 'a.png', 512, 512, 100, 100)
    const d2 = TextureCache.createDef('t2', 'b.png', 512, 512, 100, 100)
    cache.register(d1, 'same', '/a.png')
    cache.register(d2, 'same', '/b.png')
    expect(cache.size).toBe(1)
  })

  it('default UV params', () => {
    const def = TextureCache.createDef('t', 'p.png', 256, 256, 50, 50)
    expect(def.scale).toBe(1)
    expect(def.wrap).toBe('repeat')
  })

  it('custom UV params', () => {
    const def = TextureCache.createDef('t', 'p.png', 256, 256, 50, 50, {
      scale: 2, rotation: Math.PI / 4,
    })
    expect(def.scale).toBe(2)
    expect(def.rotation).toBe(Math.PI / 4)
  })
})
