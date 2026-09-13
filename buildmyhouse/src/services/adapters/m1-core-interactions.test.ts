import { describe, expect, it } from 'vitest'
import { HomeStore } from '../../core/store'
import { HomeModel } from '../../core/model'
import type { NormalizedHomeState } from '../../core/home'
import { PlanEngine } from '../../plan/engine'
import { ViewMapper, fitToBounds } from '../../plan/renderer'
import { serializeForSave, parseHomeFile } from './home-persistence'

const W = 800
const H = 600

function setup() {
  const store = new HomeStore()
  const model = new HomeModel(store)
  const engine = new PlanEngine(model)
  engine.setMagnetism(false)
  engine.setTool('wall')
  return { store, model, engine }
}

const isAxisAligned = (w: { xStart: number; yStart: number; xEnd: number; yEnd: number }) =>
  w.xStart === w.xEnd || w.yStart === w.yEnd

// ── (a) Plan view auto-refit ─────────────────────────────────────────────────

describe('M1 (a): plan view auto-refit', () => {
  // Screen click points (fixed pixels) tracing a 400x300 rectangle.
  const s0: [number, number] = [200, 150]
  const s1: [number, number] = [600, 150]
  const s2: [number, number] = [600, 450]
  const s3: [number, number] = [200, 450]

  it('stable view draws an axis-aligned rectangle (the fix)', () => {
    const { store, engine } = setup()
    // View fixed at the empty-home fit for the whole chain — no per-frame refit.
    const view = fitToBounds(store.getHome(), W, H)
    const m = new ViewMapper(view)
    const click = (s: [number, number]) => engine.click({ x: m.toModel(s[0], s[1]).x, y: m.toModel(s[0], s[1]).y })

    click(s0)
    click(s1)
    click(s2)
    click(s3)
    click(s0) // close
    engine.key('escape')

    const walls = store.getHome().walls
    expect(walls).toHaveLength(4)
    expect(walls.every(isAxisAligned)).toBe(true)
    const lens = walls.map((w) => Math.round(Math.hypot(w.xEnd - w.xStart, w.yEnd - w.yStart)))
    expect(lens).toEqual([400, 300, 400, 300])
    for (let i = 0; i < walls.length; i++) {
      const next = walls[(i + 1) % walls.length]!
      expect(walls[i]!.xEnd).toBe(next.xStart)
      expect(walls[i]!.yEnd).toBe(next.yStart)
    }
  })

  it('per-frame refit warps the chain into a diagonal wall (the bug)', () => {
    const { store, engine } = setup()
    let view = fitToBounds(store.getHome(), W, H)
    const recompute = () => {
      view = fitToBounds(store.getHome(), W, H)
    }

    const click = (s: [number, number]) => {
      const m = new ViewMapper(view)
      engine.click({ x: m.toModel(s[0], s[1]).x, y: m.toModel(s[0], s[1]).y })
    }

    click(s0)
    click(s1)
    recompute() // simulate the buggy per-frame refit after content changes
    click(s2) // this click is now mapped through the shifted view
    engine.key('escape')

    const walls = store.getHome().walls
    expect(walls).toHaveLength(2)
    expect(walls.some((w) => !isAxisAligned(w))).toBe(true)
  })
})

// ── (b) File save/open round-trip ────────────────────────────────────────────

describe('M1 (b): file save/open round-trip', () => {
  it('serializes, parses, and reloads into a fresh store preserving content', () => {
    const store = new HomeStore()
    const model = new HomeModel(store)
    model.addWall({ xStart: 0, yStart: 0, xEnd: 400.5, yEnd: 0, thickness: 7 })
    model.addWall({ xStart: 400, yStart: 0, xEnd: 400, yEnd: 300, thickness: 7 })
    model.addRoom(
      [
        [0, 0],
        [400, 0],
        [400, 300],
        [0, 300],
      ],
      { name: 'Living' },
    )
    model.addFurniture({
      name: 'sofa',
      x: 120,
      y: 60,
      angleDeg: 0,
      width: 200,
      depth: 90,
      height: 85,
      elevation: 0,
    })

    const json = serializeForSave(store.getHome())
    const home: NormalizedHomeState = parseHomeFile(json)

    const store2 = new HomeStore()
    store2.loadHome(home)

    const reloaded = store2.getHome()
    expect(reloaded.walls).toHaveLength(2)
    expect(reloaded.walls[0]!.xEnd).toBe(400.5)
    expect(reloaded.rooms).toHaveLength(1)
    expect(reloaded.rooms[0]!.name).toBe('Living')
    expect(reloaded.furniture).toHaveLength(1)
    expect(reloaded.furniture[0]!.name).toBe('sofa')
    expect(reloaded.furniture[0]!.width).toBe(200)
  })

  it('parseHomeFile rejects non-home JSON', () => {
    expect(() => parseHomeFile(JSON.stringify({ hello: 'world' }))).toThrow()
    expect(() => parseHomeFile('not json')).toThrow()
  })
})

// ── (c) Select all ───────────────────────────────────────────────────────────

describe('M1 (c): select all', () => {
  it('setSelection selects every object in the document', () => {
    const store = new HomeStore()
    const model = new HomeModel(store)
    const w1 = model.addWall({ xStart: 0, yStart: 0, xEnd: 100, yEnd: 0, thickness: 7 })
    const w2 = model.addWall({ xStart: 100, yStart: 0, xEnd: 100, yEnd: 80, thickness: 7 })
    const f1 = model.addFurniture({
      name: 'chair',
      x: 50,
      y: 40,
      angleDeg: 0,
      width: 45,
      depth: 45,
      height: 90,
      elevation: 0,
    })

    const home = store.getHome()
    // Mirror the automation handler select_all logic exactly.
    const allIds = [
      ...home.levels,
      ...home.walls,
      ...home.rooms,
      ...home.furniture,
      ...home.dimensionLines,
      ...home.labels,
    ].map((i) => i.id)

    model.setSelection(allIds)

    const selection = store.getHome().selection
    expect(selection).toHaveLength(3)
    expect(new Set(selection)).toEqual(new Set([w1.id, w2.id, f1.id]))
  })
})
