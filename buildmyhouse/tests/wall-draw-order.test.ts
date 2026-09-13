import { describe, expect, it } from 'vitest'
import { HomeModel } from '../src/core/model'
import { HomeStore } from '../src/core/store'
import { serializeHome } from '../src/core/export'
import { PlanEngine, type ClickInput } from '../src/plan/engine'

/**
 * B9 regression: replays the EXACT live E2E slice script
 * (results/20260826-130527-suite → create_room) through the engine/store and
 * asserts the exported state matches
 * equivalence/scenarios/slice/goldens/create_room.expected-state.json:
 * wall ids in DRAW order (wall-1..wall-4), same selection, rooms=0, and the
 * validate double-click undoing as ONE compound step.
 */
describe('create_room slice replay (golden id parity)', () => {
  function setup() {
    const store = new HomeStore()
    const model = new HomeModel(store)
    const engine = new PlanEngine(model)
    const click = (x: number, y: number, rest: Omit<ClickInput, 'x' | 'y'> = {}) =>
      engine.click({ x, y, ...rest })
    return { store, engine, click }
  }

  it('assigns ids wall-1..wall-4 in draw order with SH3D per-click commits', () => {
    const { store, engine, click } = setup()

    // new_home → select_tool wall → magnetism off
    store.resetToEmpty()
    engine.setTool('wall')
    engine.setMagnetism(false)

    // clicks (100,100),(600,100),(600,400),(100,400),(100,100) → dbl(100,100)
    click(100, 100)
    expect(store.getHome().walls).toHaveLength(0) // chain start only
    click(600, 100)
    // SH3D contract §1: first wall committed at click 2 — camera follows.
    // Raw store values carry float noise; the round3 export is exact.
    expect(store.getHome().walls).toHaveLength(1)
    expect(serializeHome(store.getHome()).cameras.top).toMatchObject({
      x: 350,
      y: 1100,
      z: 1125,
    })
    click(600, 400)
    expect(serializeHome(store.getHome()).cameras.top).toMatchObject({
      x: 351.75,
      y: 1248.25,
      z: 1125,
    })
    click(100, 400)
    click(100, 100) // commits the closing wall
    expect(store.getHome().walls).toHaveLength(4)
    click(100, 100, { dbl: true }) // bare second press joins + validates

    const exported = serializeHome(store.getHome())
    expect(exported.walls.map((w) => w.id)).toEqual(['wall-1', 'wall-2', 'wall-3', 'wall-4'])
    expect(exported.walls).toEqual([
      {
        id: 'wall-1',
        xStart: 100,
        yStart: 100,
        xEnd: 600,
        yEnd: 100,
        thickness: 7,
        height: 250,
        patternId: 'hatchUp',
      },
      {
        id: 'wall-2',
        xStart: 600,
        yStart: 100,
        xEnd: 600,
        yEnd: 400,
        thickness: 7,
        height: 250,
        patternId: 'hatchUp',
      },
      {
        id: 'wall-3',
        xStart: 600,
        yStart: 400,
        xEnd: 100,
        yEnd: 400,
        thickness: 7,
        height: 250,
        patternId: 'hatchUp',
      },
      {
        id: 'wall-4',
        xStart: 100,
        yStart: 400,
        xEnd: 100,
        yEnd: 100,
        thickness: 7,
        height: 250,
        patternId: 'hatchUp',
      },
    ])
    // Selection mirrors the golden: all four drawn walls, draw order.
    expect(exported.selection).toEqual(['wall-1', 'wall-2', 'wall-3', 'wall-4'])
    // SH3D validateDrawnWalls parity (B6): no auto-room on loop close.
    expect(exported.rooms).toEqual([])
    expect(exported.capabilities).toEqual({ canUndo: true, canRedo: false })
    // Final top camera matches the golden row (whole-home bounds).
    expect(exported.cameras.top).toMatchObject({ x: 350, y: 1250, z: 1125 })
  })

  it('undo of the validate removes all four walls as ONE step (then redo)', () => {
    const { store, engine, click } = setup()
    store.resetToEmpty()
    engine.setTool('wall')
    engine.setMagnetism(false)

    click(100, 100)
    click(600, 100)
    click(600, 400)
    click(100, 400)
    click(100, 100)
    click(100, 100, { dbl: true })

    expect(store.undo()).toBe(true)
    let home = store.getHome()
    expect(home.walls).toHaveLength(0)
    expect(home.selection).toEqual([])
    expect(home.rooms).toHaveLength(0)
    expect(home.capabilities).toEqual({ canUndo: false, canRedo: true })

    expect(store.redo()).toBe(true)
    home = store.getHome()
    expect(home.walls.map((w) => w.id)).toEqual(['wall-1', 'wall-2', 'wall-3', 'wall-4'])
    expect(home.selection).toEqual(['wall-1', 'wall-2', 'wall-3', 'wall-4'])
  })

  it('a second chain continues the id sequence and undoes as its own step', () => {
    const { store, engine, click } = setup()
    store.resetToEmpty()
    engine.setTool('wall')
    engine.setMagnetism(false)

    click(100, 100)
    click(600, 100)
    engine.key('escape') // validates chain one

    click(700, 100)
    click(900, 100)
    engine.key('escape') // validates chain two

    expect(store.getHome().walls.map((w) => w.id)).toEqual(['wall-1', 'wall-2'])
    expect(store.getHome().selection).toEqual(['wall-2'])
    // Each session is its own compound step; undo restores the oldSelection
    // (WallsCreationUndoableEdit parity), i.e. chain one's validated walls.
    expect(store.undo()).toBe(true)
    expect(store.getHome().walls.map((w) => w.id)).toEqual(['wall-1'])
    expect(store.getHome().selection).toEqual(['wall-1'])
  })
})
