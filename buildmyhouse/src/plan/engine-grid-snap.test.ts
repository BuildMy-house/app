import { describe, it, expect } from 'vitest'
import { HomeStore } from '../core/store'
import { HomeModel } from '../core/model'
import { PlanEngine } from './engine'

function setup() {
  const store = new HomeStore()
  const model = new HomeModel(store)
  const engine = new PlanEngine(model)
  return { model, engine, store }
}

describe('PlanEngine grid snap', () => {
  it('defaults to off', () => {
    const { engine } = setup()
    expect(engine.isGridSnapEnabled()).toBe(false)
    expect(engine.getGridSnapSize()).toBe(10)
  })

  it('toggle on/off via setGridSnap', () => {
    const { engine } = setup()
    engine.setGridSnap(true)
    expect(engine.isGridSnapEnabled()).toBe(true)
    engine.setGridSnap(false)
    expect(engine.isGridSnapEnabled()).toBe(false)
  })

  it('custom grid size', () => {
    const { engine } = setup()
    engine.setGridSnap(true, 25)
    expect(engine.getGridSnapSize()).toBe(25)
  })

  describe('snapToGrid', () => {
    it('snaps to nearest grid multiple', () => {
      const { engine } = setup()
      engine.setGridSnap(true, 10)
      expect(engine.snapToGrid(3, 7)).toEqual({ x: 0, y: 10 })
      expect(engine.snapToGrid(15, 25)).toEqual({ x: 20, y: 30 })
      expect(engine.snapToGrid(0, 0)).toEqual({ x: 0, y: 0 })
      expect(engine.snapToGrid(47, 53)).toEqual({ x: 50, y: 50 })
    })

    it('snaps with custom grid size', () => {
      const { engine } = setup()
      engine.setGridSnap(true, 25)
      expect(engine.snapToGrid(12, 37)).toEqual({ x: 0, y: 25 })
      expect(engine.snapToGrid(30, 60)).toEqual({ x: 25, y: 50 })
    })
  })

  describe('furniture drag with grid snap', () => {
    it('snaps furniture to grid when grid snap is on and magnetism is off', () => {
      const { engine, model, store } = setup()
      engine.setGridSnap(true, 10)
      engine.setMagnetism(false)
      model.addFurniture({ name: 'Sofa', x: 53, y: 47, width: 200, depth: 80, height: 80, elevation: 0, angleDeg: 0 })
      const home = store.getHome()
      const fid = home.furniture[0]!.id
      model.setSelection([fid])

      // drag by (2, 3) → naive = (55, 50), grid-snapped = (60, 50)
      engine.drag({ fromX: 53, fromY: 47, toX: 55, toY: 50, shift: false, altOrMeta: false })

      const h2 = store.getHome()
      const f = h2.furniture.find((fi) => fi.id === fid)!
      expect(f.x % 10).toBe(0)
      expect(f.y % 10).toBe(0)
    })

    it('does not snap when grid snap is off', () => {
      const { engine, model, store } = setup()
      engine.setGridSnap(false)
      engine.setMagnetism(false)
      model.addFurniture({ name: 'Chair', x: 53, y: 47, width: 60, depth: 60, height: 60, elevation: 0, angleDeg: 0 })
      const home = store.getHome()
      const fid = home.furniture[0]!.id
      model.setSelection([fid])

      engine.drag({ fromX: 53, fromY: 47, toX: 55, toY: 50, shift: false, altOrMeta: false })

      const h2 = store.getHome()
      const f = h2.furniture.find((fi) => fi.id === fid)!
      // naive = (55, 50), no grid snap, no magnetism → position unchanged
      expect(f.x).toBe(55)
      expect(f.y).toBe(50)
    })

    it('grid snap applies before magnetism', () => {
      const { engine, model, store } = setup()
      engine.setGridSnap(true, 10)
      engine.setMagnetism(true)
      // Place a wall so magnetism could snap, but grid-snap should apply first
      model.addWall({ xStart: 0, yStart: 0, xEnd: 1000, yEnd: 0, thickness: 7 })
      model.addFurniture({ name: 'Table', x: 0, y: 50, width: 80, depth: 80, height: 75, elevation: 0, angleDeg: 0 })
      const home = store.getHome()
      const fid = home.furniture[0]!.id
      model.setSelection([fid])

      // drag by (3, 2) → naive = (3, 52), grid-snapped to (0, 50), then magnetism applies
      engine.drag({ fromX: 0, fromY: 50, toX: 3, toY: 52, shift: false, altOrMeta: false })

      const h2 = store.getHome()
      const f = h2.furniture.find((fi) => fi.id === fid)!
      // Grid-snapped to (0, 50), then magnetism might offset, but the grid point
      // should be a grid multiple before magnetism kicks in
      expect(f.x % 10).toBe(0)
    })
  })
})
