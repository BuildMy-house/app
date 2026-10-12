import { describe, expect, it } from 'vitest'
import { snapFurniturePlacement } from '../plan/furniture-snap'
import { wallsBlockingAt, wallTopCm } from '../plan/wall-height'
import { FurnitureTooLargeError } from './furniture-clearance'
import type { Furniture } from './home'
import { HomeModel } from './model'
import { HomeStore } from './store'

// 400x400 room, 10 cm walls of the default 250 cm height unless overridden.
function setup(wallHeight?: number) {
  const store = new HomeStore()
  const model = new HomeModel(store)
  for (const [xs, ys, xe, ye] of [[0, 0, 400, 0], [400, 0, 400, 400], [400, 400, 0, 400], [0, 400, 0, 0]] as const) {
    model.addWall({ xStart: xs, yStart: ys, xEnd: xe, yEnd: ye, thickness: 10, ...(wallHeight ? { height: wallHeight } : {}) })
  }
  return { store, model }
}

const piece = (over: Partial<Omit<Furniture, 'id'>> = {}): Omit<Furniture, 'id'> => ({
  name: 'Shelf', x: 200, y: 200, angleDeg: 0, width: 120, depth: 60, height: 80, elevation: 0, ...over,
})

describe('wall-height rule', () => {
  it('uses the default wall height and the higher end of a sloped wall', () => {
    expect(wallTopCm({})).toBe(250)
    expect(wallTopCm({ height: 300 })).toBe(300)
    expect(wallTopCm({ height: 100, heightAtEnd: 220 })).toBe(220)
    expect(wallsBlockingAt([{ height: 100 }, { height: 300 }], 100).map((w) => w.height)).toEqual([300])
    expect(wallsBlockingAt([{ height: 100 }], Number.NaN)).toHaveLength(1)
  })
})

describe('furniture clearance respects elevation', () => {
  it('a piece whose underside is at or above the wall top may overlap the wall in plan', () => {
    const { store, model } = setup()
    const above = model.addFurniture(piece({ x: 200, y: 0, elevation: 250 }))
    expect(store.peek().furniture.find((f) => f.id === above.id)!.y).toBe(0)
    const below = model.addFurniture(piece({ x: 200, y: 0, elevation: 249 }))
    expect(store.peek().furniture.find((f) => f.id === below.id)!.y).toBe(35)
  })

  it('a wall-mounted piece well below the wall top is still held flush against the wall', () => {
    const { store, model } = setup()
    const cabinet = model.addFurniture(piece({ name: 'Wall cabinet', x: 200, y: 0, elevation: 140, height: 70 }))
    expect(store.peek().furniture.find((f) => f.id === cabinet.id)!.y).toBe(35)
  })

  it('moving a piece up above the wall frees it, and lowering it back pushes it out', () => {
    const { store, model } = setup()
    const f = model.addFurniture(piece({ x: 200, y: 36 }))
    model.updateFurniture(f.id, { elevation: 260 })
    model.updateFurniture(f.id, { y: 0 })
    expect(store.peek().furniture[0]!.y).toBe(0)
    model.updateFurniture(f.id, { elevation: 0 })
    expect(store.peek().furniture[0]!.y).toBe(35)
  })

  it('raising a wall onto a hung piece pushes it out; lowering the wall under it does not', () => {
    const { store, model } = setup(200)
    const f = model.addFurniture(piece({ x: 200, y: 0, elevation: 220 }))
    expect(store.peek().furniture[0]!.y).toBe(0)
    model.updateWall(store.peek().walls[0]!.id, { height: 300 })
    expect(store.peek().furniture.find((i) => i.id === f.id)!.y).toBe(35)
  })

  it('a hung piece too big for the walls below it is not "too large" for the room', () => {
    const { model } = setup()
    model.addRoom([[0, 0], [400, 0], [400, 400], [0, 400]], { name: 'Hall' })
    expect(() => model.addFurniture(piece({ width: 600, depth: 500 }))).toThrow(FurnitureTooLargeError)
    expect(() => model.addFurniture(piece({ width: 600, depth: 500, elevation: 260 }))).not.toThrow()
  })

  it('snap placement agrees with the store: no push for a hung piece, push for a low one', () => {
    const { store } = setup()
    const walls = store.peek().walls
    const base = { walls, point: { x: 200, y: 0 }, widthCm: 120, depthCm: 60, magnetismEnabled: false, levelRef: null }
    expect(snapFurniturePlacement({ ...base, elevationCm: 260 }).y).toBe(0)
    expect(snapFurniturePlacement({ ...base, elevationCm: 0 }).y).toBe(35)
    expect(snapFurniturePlacement(base).y).toBe(35)
  })
})
