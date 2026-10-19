// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { HomeModel } from '../src/core/model'
import { HomeStore } from '../src/core/store'
import { PlanEngine, type PlanNotice } from '../src/plan/engine'

// Selection tool: double-clicking inside a closed (not-yet-a-room) wall loop
// creates its floor directly, no dialog. A single click keeps its normal
// meaning (select / clear selection).

function setup() {
  const store = new HomeStore()
  const model = new HomeModel(store)
  const engine = new PlanEngine(model)
  const notices: PlanNotice[] = []
  engine.setNotifier((n) => notices.push(n))
  return { store, model, engine, notices }
}

function addRectWalls(model: HomeModel): void {
  model.addWall({ xStart: 0, yStart: 0, xEnd: 100, yEnd: 0, thickness: 7 })
  model.addWall({ xStart: 100, yStart: 0, xEnd: 100, yEnd: 100, thickness: 7 })
  model.addWall({ xStart: 100, yStart: 100, xEnd: 0, yEnd: 100, thickness: 7 })
  model.addWall({ xStart: 0, yStart: 100, xEnd: 0, yEnd: 0, thickness: 7 })
}

describe('selection tool: enclosure to floor', () => {
  it('double-click inside a closed wall loop creates the floor, selects it, one undo step', () => {
    const { store, model, engine, notices } = setup()
    addRectWalls(model)
    engine.setTool('selection')

    engine.click({ x: 50, y: 50, dbl: true })

    const rooms = store.getHome().rooms
    expect(rooms).toHaveLength(1)
    const xs = rooms[0]!.points.map((p) => p[0]).sort((a, b) => a - b)
    const ys = rooms[0]!.points.map((p) => p[1]).sort((a, b) => a - b)
    expect(xs[0]).toBeCloseTo(0, 5)
    expect(xs[3]).toBeCloseTo(100, 5)
    expect(ys[0]).toBeCloseTo(0, 5)
    expect(ys[3]).toBeCloseTo(100, 5)
    expect(store.getHome().selection).toEqual([rooms[0]!.id])
    expect(notices.at(-1)).toMatchObject({ tone: 'success', undoable: true })
    expect(store.undo()).toBe(true)
    expect(store.getHome().rooms).toHaveLength(0)
    expect(store.getHome().walls).toHaveLength(4)
  })

  it('double-click inside a loop that already has a floor creates nothing', () => {
    const { store, model, engine } = setup()
    addRectWalls(model)
    model.addRoom([[0, 0], [100, 0], [100, 100], [0, 100]])
    engine.setTool('selection')
    engine.click({ x: 50, y: 50, dbl: true })
    expect(store.getHome().rooms).toHaveLength(1)
  })

  it('single click inside a closed wall loop does not create or pop anything', () => {
    const { store, model, engine, notices } = setup()
    addRectWalls(model)
    const wallId = store.getHome().walls[0]!.id
    model.setSelection([wallId])
    engine.setTool('selection')

    engine.click({ x: 50, y: 50 })

    expect(store.getHome().rooms).toHaveLength(0)
    expect(notices).toHaveLength(0)
    expect(store.getHome().selection).toEqual([])
  })

  it('click hitting an existing room selects it', () => {
    const { store, model, engine } = setup()
    const room = model.addRoom([[0, 0], [100, 0], [100, 100], [0, 100]])
    engine.setTool('selection')
    engine.click({ x: 50, y: 50 })
    expect(store.getHome().selection).toEqual([room.id])
  })
})
