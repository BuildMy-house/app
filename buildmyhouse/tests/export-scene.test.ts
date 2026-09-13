import { describe, it, expect } from 'vitest'
import { normalizeHome } from '../scripts/export-scene'
import { buildRenderableScene } from '../src/render/scene-builder'

describe('normalizeHome camera defaults', () => {
  it('fills in both cameras when none provided', () => {
    const home = normalizeHome({})
    expect(home.cameras.top).toBeDefined()
    expect(home.cameras.observer).toBeDefined()
    expect(home.cameras.observer.x).toBe(50)
    expect(home.cameras.top.z).toBe(1010)
  })

  it('preserves provided cameras.top while defaulting observer', () => {
    const home = normalizeHome({
      cameras: { top: { x: 99, y: 99, z: 99, yawDeg: 0, pitchDeg: 0, fovDeg: 63, lens: 'PINHOLE' } },
    })
    expect(home.cameras.top.x).toBe(99)
    expect(home.cameras.observer.x).toBe(50)
  })

  it('preserves provided cameras.observer while defaulting top', () => {
    const home = normalizeHome({
      cameras: { observer: { x: 200, y: 200, z: 200, yawDeg: 0, pitchDeg: 0, fovDeg: 50, lens: 'PINHOLE' } },
    })
    expect(home.cameras.observer.x).toBe(200)
    expect(home.cameras.top.x).toBe(50)
  })

  it('does not crash buildRenderableScene on a partial home JSON', () => {
    const home = normalizeHome({
      cameras: { top: { x: 0, y: 0, z: 0, yawDeg: 0, pitchDeg: 0, fovDeg: 63, lens: 'PINHOLE' } },
    })
    const { scene } = buildRenderableScene(home)
    expect(scene.version).toBe(1)
    expect(scene.camera).toBeDefined()
  })

  it('does not crash when cameras key is entirely missing', () => {
    const home = normalizeHome({ name: 'partial' })
    const { scene } = buildRenderableScene(home)
    expect(scene.version).toBe(1)
  })
})
