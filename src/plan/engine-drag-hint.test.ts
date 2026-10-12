import { describe, expect, it, vi } from 'vitest'
import { FurnitureTooLargeError } from '../core/furniture-clearance'
import { HomeModel } from '../core/model'
import { HomeStore } from '../core/store'
import { PlanEngine } from './engine'

function setup() {
  const store = new HomeStore()
  const model = new HomeModel(store)
  const engine = new PlanEngine(model)
  engine.setGridSnap(false)
  const room = (l: number, t: number, r: number, b: number, name: string) => {
    const pts: Array<[number, number]> = [[l, t], [r, t], [r, b], [l, b]]
    pts.forEach(([xs, ys], i) => {
      const [xe, ye] = pts[(i + 1) % 4]!
      model.addWall({ xStart: xs, yStart: ys, xEnd: xe, yEnd: ye, thickness: 10 })
    })
    model.addRoom(pts, { name })
  }
  room(-500, -100, -100, 100, 'Hall')
  room(100, -30, 400, 30, 'Closet')
  const crate = model.addFurniture({ name: 'Crate', x: -300, y: 0, angleDeg: 0, width: 100, depth: 100, height: 100, elevation: 0 })
  return { store, model, engine, crate }
}

describe('live furniture drag feedback', () => {
  it('is empty for a free move and cleared on drag end', () => {
    const { engine, crate } = setup()
    engine.beginFurnitureMove(crate.id, { x: -300, y: 0 })
    engine.moveFurnitureTo({ x: -280, y: 10 })
    expect(engine.getPreview().furnitureDragHint).toBeNull()
    engine.endFurnitureMove()
  })

  it('shows a pushed ghost at the cursor when a wall holds the piece back', () => {
    const { engine, crate } = setup()
    engine.beginFurnitureMove(crate.id, { x: -300, y: 0 })
    engine.moveFurnitureTo({ x: -80, y: 0 }) // wants x=-80, the hall's east wall stops it
    const hint = engine.getPreview().furnitureDragHint
    expect(hint?.kind).toBe('pushed')
    expect(hint?.x).toBeCloseTo(-80)
    engine.endFurnitureMove()
    expect(engine.getPreview().furnitureDragHint).toBeNull()
  })

  it('shows a blocked ghost at the refused spot and rethrows when the store refuses the move', () => {
    const { engine, model, crate } = setup()
    engine.beginFurnitureMove(crate.id, { x: -300, y: 0 })
    const refuse = vi.spyOn(model, 'updateFurniture').mockImplementation(() => {
      throw new FurnitureTooLargeError('c', 'Crate', 100, 100, 0, 'r', 'Hall', 50, 50)
    })
    expect(() => engine.moveFurnitureTo({ x: -250, y: 0 })).toThrow(FurnitureTooLargeError)
    const hint = engine.getPreview().furnitureDragHint
    expect(hint).toMatchObject({ kind: 'blocked', x: -250, y: 0, width: 100, depth: 100 })
    refuse.mockRestore()
    engine.moveFurnitureTo({ x: -240, y: 0 })
    expect(engine.getPreview().furnitureDragHint).toBeNull()
    engine.endFurnitureMove()
  })
})
