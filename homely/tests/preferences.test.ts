import { describe, expect, it, beforeEach, vi } from 'vitest'
import { HomeModel } from '../src/core/model'
import { HomeStore } from '../src/core/store'
import { PlanEngine } from '../src/plan/engine'
import {
  loadPreferences,
  savePreferences,
  colorIntToHex,
  hexToIntColor,
  PREFS_KEY,
  type Preferences,
} from '../src/ui/preferences'
import { DEFAULT_WALL_HEIGHT_CM } from '../src/core/home'
import { NEW_WALL_THICKNESS_CM } from '../src/core/model'

function setup() {
  const store = new HomeStore()
  const model = new HomeModel(store)
  const engine = new PlanEngine(model)
  return { store, model, engine }
}

function makeLocalStorage() {
  const data: Record<string, string> = {}
  return {
    getItem: vi.fn((k: string) => data[k] ?? null),
    setItem: vi.fn((k: string, v: string) => { data[k] = v }),
    removeItem: vi.fn((k: string) => { delete data[k] }),
    clear: vi.fn(() => { for (const k of Object.keys(data)) delete data[k] }),
    data,
  }
}

describe('color helpers', () => {
  it('round-trips int ↔ hex', () => {
    const hex = colorIntToHex(0xa8a8a8)
    expect(hex).toBe('#a8a8a8')
    expect(hexToIntColor(hex)).toBe(0xa8a8a8)
  })

  it('handles null ground color', () => {
    expect(colorIntToHex(null)).toBe('#a8a8a8')
  })

  it('pads short hex values', () => {
    expect(colorIntToHex(0x00ff00)).toBe('#00ff00')
  })
})

describe('preference persistence (localStorage)', () => {
  let ls: ReturnType<typeof makeLocalStorage>

  beforeEach(() => {
    ls = makeLocalStorage()
    // Node env has no localStorage — install a per-test mock.
    Object.defineProperty(globalThis, 'localStorage', { value: ls, writable: true, configurable: true })
  })

  it('returns defaults when no stored prefs exist', () => {
    const prefs = loadPreferences()
    expect(prefs.wallHeightCm).toBe(DEFAULT_WALL_HEIGHT_CM)
    expect(prefs.wallThicknessCm).toBe(NEW_WALL_THICKNESS_CM)
    expect(prefs.unit).toBe('cm')
    expect(prefs.groundColor).toBe('#a8a8a8')
  })

  it('round-trips save → load', () => {
    const custom: Preferences = {
      unit: 'inch',
      wallHeightCm: 300,
      wallThicknessCm: 10,
      groundColor: '#ff0000',
    }
    savePreferences(custom)
    const loaded = loadPreferences()
    expect(loaded).toEqual(custom)
  })

  it('stored value persists across reloads (simulated)', () => {
    savePreferences({ ...loadPreferences(), wallHeightCm: 200 })
    expect(loadPreferences().wallHeightCm).toBe(200)
  })

  it('stored in localStorage under PREFS_KEY', () => {
    savePreferences({ ...loadPreferences(), wallHeightCm: 999 })
    expect(ls.setItem).toHaveBeenCalledWith(PREFS_KEY, expect.any(String))
    expect(ls.data[PREFS_KEY]).toBeTruthy()
    expect(JSON.parse(ls.data[PREFS_KEY]!).wallHeightCm).toBe(999)
  })

  it('returns defaults for malformed JSON', () => {
    ls.data[PREFS_KEY] = '{bad json!!!'
    const prefs = loadPreferences()
    expect(prefs.wallHeightCm).toBe(DEFAULT_WALL_HEIGHT_CM)
  })
})

describe('PlanEngine wall defaults', () => {
  it('uses defaults initially', () => {
    const { engine } = setup()
    expect(engine.getWallDefaults()).toEqual({
      heightCm: DEFAULT_WALL_HEIGHT_CM,
      thicknessCm: NEW_WALL_THICKNESS_CM,
    })
  })

  it('setWallDefaults changes the values', () => {
    const { engine } = setup()
    engine.setWallDefaults(300, 10)
    expect(engine.getWallDefaults()).toEqual({ heightCm: 300, thicknessCm: 10 })
  })

  it('new wall uses custom height and thickness', () => {
    const { engine, store } = setup()
    engine.setWallDefaults(300, 10)
    engine.setTool('wall')
    engine.click({ x: 0, y: 0 })
    engine.click({ x: 100, y: 0 })
    engine.key('escape')
    const walls = store.getHome().walls
    expect(walls.length).toBe(1)
    expect(walls[0]!.height).toBe(300)
    expect(walls[0]!.thickness).toBe(10)
  })

  it('new wall uses defaults when prefs not changed', () => {
    const { engine, store } = setup()
    engine.setTool('wall')
    engine.click({ x: 0, y: 0 })
    engine.click({ x: 100, y: 0 })
    engine.key('escape')
    const walls = store.getHome().walls
    expect(walls.length).toBe(1)
    expect(walls[0]!.height).toBe(DEFAULT_WALL_HEIGHT_CM)
    expect(walls[0]!.thickness).toBe(NEW_WALL_THICKNESS_CM)
  })
})
