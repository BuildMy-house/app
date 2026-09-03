import { describe, expect, it } from 'vitest'
import { HomeStore } from './store'
import { HomeModel } from './model'
import { GROUND_TEXTURES } from './home'
import { serializeForSave, parseHomeFile } from '../services/adapters/home-persistence'

function makeStore() {
  const store = new HomeStore()
  const model = new HomeModel(store)
  return { store, model }
}

describe('ground texture schema', () => {
  it('GROUND_TEXTURES reuses the wall texture catalog', () => {
    expect(GROUND_TEXTURES).toHaveLength(6)
    expect(GROUND_TEXTURES.map((t) => t.id)).toContain('wood-oak')
  })

  it('setEnvironment accepts valid groundTextureId', () => {
    const { model } = makeStore()
    model.setEnvironment({ groundTextureId: 'carpet' })
    const home = (model as unknown as { store: HomeStore }).store.getHome()
    expect(home.environment.groundTextureId).toBe('carpet')
  })

  it('setEnvironment accepts null groundTextureId', () => {
    const { model } = makeStore()
    model.setEnvironment({ groundTextureId: 'wood-oak' })
    model.setEnvironment({ groundTextureId: null })
    const home = (model as unknown as { store: HomeStore }).store.getHome()
    expect(home.environment.groundTextureId).toBeNull()
  })

  it('setEnvironment preserves other fields when setting groundTextureId', () => {
    const { model } = makeStore()
    model.setEnvironment({ skyColor: 0xff0000 })
    model.setEnvironment({ groundTextureId: 'concrete' })
    const home = (model as unknown as { store: HomeStore }).store.getHome()
    expect(home.environment.skyColor).toBe(0xff0000)
    expect(home.environment.groundTextureId).toBe('concrete')
  })

  it('groundTextureId survives serialize round-trip', () => {
    const { store, model } = makeStore()
    model.setEnvironment({ groundTextureId: 'wood-oak' })
    const serialized = serializeForSave(store.getHome())
    const json = JSON.parse(serialized)
    expect(json.environment.groundTextureId).toBe('wood-oak')

    const parsed = parseHomeFile(serialized)
    expect(parsed.environment.groundTextureId).toBe('wood-oak')
  })

  it('groundTextureId null survives serialize round-trip', () => {
    const { store, model } = makeStore()
    model.setEnvironment({ groundTextureId: null })
    const serialized = serializeForSave(store.getHome())
    const parsed = parseHomeFile(serialized)
    expect(parsed.environment.groundTextureId).toBeNull()
  })

  it('backward compat: environment without groundTextureId parses fine', () => {
    const json = {
      schemaVersion: 1,
      levels: [],
      walls: [],
      rooms: [],
      furniture: [],
      dimensionLines: [],
      labels: [],
      selection: [],
      cameras: { top: { x: 0, y: 0, z: 1000, yawDeg: 0, pitchDeg: 45, fovDeg: 63, lens: 'PINHOLE' }, observer: { x: 0, y: 0, z: 170, yawDeg: 315, pitchDeg: 11.25, fovDeg: 63, lens: 'PINHOLE' } },
      compass: { x: 0, y: 0, diameter: 100, northDirectionDeg: 0, latitudeRad: 0, longitudeRad: 0, visible: true },
      environment: { skyColor: 0xcce4fc, groundColor: 0xa8a8a8, lightColor: 0xd0d0d0, wallsAlpha: 0 },
      activeTool: null,
      capabilities: { canUndo: false, canRedo: false },
    }
    const parsed = parseHomeFile(JSON.stringify(json))
    expect(parsed.environment.groundTextureId).toBeUndefined()
  })
})
