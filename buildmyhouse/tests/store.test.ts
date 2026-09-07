import { describe, expect, it } from 'vitest'
import { HomeStore } from '../src/core/store'
import { HomeModel, ModelError } from '../src/core/model'
import { serializeHome } from '../src/core/export'
import { nextLevelElevation, DEFAULT_WALL_HEIGHT_CM, type Level } from '../src/core/home'

function wallInput() {
  return { xStart: 0, yStart: 0, xEnd: 400, yEnd: 0, thickness: 10 }
}

describe('HomeStore undo/redo', () => {
  it('add → undo restores previous state, redo reapplies it', () => {
    const store = new HomeStore()
    const model = new HomeModel(store)
    const wall = model.addWall(wallInput())
    expect(store.getHome().walls).toHaveLength(1)
    expect(store.canUndo()).toBe(true)
    expect(store.canRedo()).toBe(false)

    expect(store.undo()).toBe(true)
    const undone = store.getHome()
    expect(undone.walls).toHaveLength(0)
    expect(store.canUndo()).toBe(false)
    expect(store.canRedo()).toBe(true)

    expect(store.redo()).toBe(true)
    expect(store.getHome().walls).toEqual([wall])
    expect(store.canUndo()).toBe(true)
    expect(store.canRedo()).toBe(false)
  })

  it('undo/redo round-trip is byte-identical through the serializer', () => {
    const store = new HomeStore()
    const model = new HomeModel(store)
    model.addFurniture({
      name: 'table',
      x: 120.123456,
      y: 80.987654,
      angleDeg: 45.5,
      width: 100,
      depth: 60,
      height: 75,
      elevation: 2.5,
    })
    const exported = JSON.stringify(serializeHome(store.getHome()))
    store.undo()
    store.redo()
    expect(JSON.stringify(serializeHome(store.getHome()))).toBe(exported)
  })

  it('divergent mutation clears the redo stack', () => {
    const store = new HomeStore()
    const model = new HomeModel(store)
    model.addWall(wallInput())
    store.undo()
    expect(store.canRedo()).toBe(true)
    model.addWall({ ...wallInput(), xEnd: 500 })
    expect(store.canRedo()).toBe(false)
    expect(store.undo()).toBe(true)
    expect(store.getHome().walls).toHaveLength(0)
  })

  it('undo at bottom of stack is a no-op returning false', () => {
    const store = new HomeStore()
    expect(store.undo()).toBe(false)
    expect(store.canUndo()).toBe(false)
  })

  it('resetToEmpty clears history and the id counter', () => {
    const store = new HomeStore()
    const model = new HomeModel(store)
    model.addWall(wallInput())
    model.addWall(wallInput())
    store.resetToEmpty()
    expect(store.canUndo()).toBe(false)
    expect(store.canRedo()).toBe(false)
    const id = model.addWall(wallInput()).id
    expect(id).toBe('wall-1')
  })

  it('capabilities flags are live in exported state', () => {
    const store = new HomeStore()
    const model = new HomeModel(store)
    model.setActiveTool('wall')
    let state = store.getHome()
    expect(state.capabilities).toEqual({ canUndo: true, canRedo: false })
    store.undo()
    state = store.getHome()
    expect(state.capabilities).toEqual({ canUndo: false, canRedo: true })
  })

  it('id counter issues opaque creation-ordered ids per collection', () => {
    const store = new HomeStore()
    const model = new HomeModel(store)
    const w1 = model.addWall(wallInput()).id
    const f1 = model
      .addFurniture({ name: 'a', x: 0, y: 0, angleDeg: 0, width: 1, depth: 1, height: 1, elevation: 0 })
      .id
    const w2 = model.addWall(wallInput()).id
    expect([w1, f1, w2]).toEqual(['wall-1', 'furniture-2', 'wall-3'])
  })
})

describe('undo history depth cap', () => {
  it('drops the OLDEST entries beyond MAX_UNDO_DEPTH; recent history still works', () => {
    const store = new HomeStore()
    const model = new HomeModel(store)
    // MAX_UNDO_DEPTH + 5 distinct cheap edits isolate the cap from geometry cost.
    for (let i = 1; i <= HomeStore.MAX_UNDO_DEPTH + 5; i++) model.setName(`home-${i}`)
    expect(store.getHome().name).toBe(`home-${HomeStore.MAX_UNDO_DEPTH + 5}`)

    // Only the newest 100 undo steps survive: undoing to the bottom lands on
    // edit #6 — the empty home and the first five edits are gone for good.
    let undos = 0
    while (store.undo()) undos++
    expect(undos).toBe(HomeStore.MAX_UNDO_DEPTH)
    expect(store.getHome().name).toBe('home-5')
    expect(store.canUndo()).toBe(false)

    // Recent history round-trips cleanly through redo.
    expect(store.canRedo()).toBe(true)
    let redos = 0
    while (store.redo()) redos++
    expect(redos).toBe(HomeStore.MAX_UNDO_DEPTH)
    expect(store.getHome().name).toBe(`home-${HomeStore.MAX_UNDO_DEPTH + 5}`)
    expect(store.canRedo()).toBe(false)
    expect(store.canUndo()).toBe(true)
  })

  it('caps compound edits the same way (endCompoundEdit trims the oldest entry)', () => {
    const store = new HomeStore()
    const model = new HomeModel(store)
    for (let i = 0; i < HomeStore.MAX_UNDO_DEPTH + 3; i++) {
      store.beginCompoundEdit()
      model.addWall(wallInput())
      store.endCompoundEdit()
    }
    let undos = 0
    while (store.undo()) undos++
    expect(undos).toBe(HomeStore.MAX_UNDO_DEPTH)
    // 3 oldest compound steps dropped: the bottom state has 3 walls, not 0.
    expect(store.getHome().walls).toHaveLength(3)
    expect(store.canUndo()).toBe(false)
    expect(store.canRedo()).toBe(true)
    expect(store.redo()).toBe(true)
    expect(store.getHome().walls).toHaveLength(4)
  })
})

describe('store scale benchmark (M18)', () => {
  it('200 walls + 500 furniture: select-all, move wall, undo, redo, add furniture < 500ms', () => {
    const store = new HomeStore()
    const model = new HomeModel(store)

    // 200 walls as 10 rows of 20 chained segments (adjacent walls share
    // endpoints, so the top-camera join scan sees a realistically joined
    // plan), plus 500 furniture pieces spread across it.
    const wallIds: string[] = []
    for (let row = 0; row < 10; row++) {
      for (let col = 0; col < 20; col++) {
        const x = col * 100
        const y = row * 200
        wallIds.push(
          model.addWall({ xStart: x, yStart: y, xEnd: x + 100, yEnd: y, thickness: 7 }).id,
        )
      }
    }
    for (let i = 0; i < 500; i++) {
      model.addFurniture({
        name: 'chair',
        x: (i % 25) * 80,
        y: Math.floor(i / 25) * 80,
        angleDeg: 0,
        width: 45,
        depth: 45,
        height: 90,
        elevation: 0,
      })
    }
    expect(store.getHome().walls).toHaveLength(200)
    expect(store.getHome().furniture).toHaveLength(500)

    const timings: Record<string, number> = {}
    const phase = (label: string, fn: () => void): void => {
      const t0 = performance.now()
      fn()
      timings[label] = performance.now() - t0
    }

    const state = store.getHome()
    const allIds = [...state.walls.map((w) => w.id), ...state.furniture.map((f) => f.id)]
    phase('select-all (700 ids)', () => model.setSelection(allIds))
    phase('move a wall', () => model.updateWall(wallIds[0]!, { xStart: 10, yStart: 10 }))
    phase('undo', () => store.undo())
    phase('redo', () => store.redo())
    phase('add furniture', () =>
      model.addFurniture({
        name: 'one more',
        x: 0,
        y: 0,
        angleDeg: 0,
        width: 10,
        depth: 10,
        height: 10,
        elevation: 0,
      }),
    )
    phase('getHome()', () => store.getHome())

    const total = Object.values(timings).reduce((a, b) => a + b, 0)
    const report = Object.fromEntries(
      Object.entries(timings).map(([k, v]) => [k, Number(v.toFixed(1))]),
    )
    console.log(
      `[M18 benchmark] 200 walls + 500 furniture, per-phase ms: ${JSON.stringify(report)} total=${total.toFixed(1)}ms`,
    )
    expect(total).toBeLessThan(500)
  })
})

describe('HomeModel validation', () => {
  it('rejects rooms with fewer than 3 points', () => {
    const model = new HomeModel(new HomeStore())
    expect(() => model.addRoom([[0, 0], [1, 1]])).toThrow(ModelError)
    expect(() => model.addRoom([])).toThrow(ModelError)
  })

  it('rejects non-positive wall thickness and furniture dimensions', () => {
    const model = new HomeModel(new HomeStore())
    expect(() => model.addWall({ ...wallInput(), thickness: 0 })).toThrow(ModelError)
    expect(() =>
      model.addFurniture({
        name: 'x',
        x: 0,
        y: 0,
        angleDeg: 0,
        width: -5,
        depth: 1,
        height: 1,
        elevation: 0,
      }),
    ).toThrow(ModelError)
  })

  it('update/remove on unknown ids throw with a clear message', () => {
    const model = new HomeModel(new HomeStore())
    expect(() => model.updateWall('wall-99', { thickness: 12 })).toThrow(/unknown walls id/)
    expect(() => model.removeFurniture('furniture-99')).toThrow(/unknown furniture/)
    expect(() => model.removeLevel('level-99')).toThrow(/unknown level/)
  })

  it('selection must reference existing ids; removing an object drops it from selection', () => {
    const store = new HomeStore()
    const model = new HomeModel(store)
    const wall = model.addWall(wallInput())
    expect(model.setSelection([wall.id])).toEqual([wall.id])
    expect(() => model.setSelection(['nope'])).toThrow(/unknown id/)
    model.removeWall(wall.id)
    expect(store.getHome().selection).toEqual([])
  })

  it('removeWall cascades to furniture with matching wallRef', () => {
    const store = new HomeStore()
    const model = new HomeModel(store)
    const wall = model.addWall(wallInput())
    model.addFurniture({
      name: 'door',
      x: 0,
      y: 0,
      angleDeg: 0,
      width: 10,
      depth: 10,
      height: 10,
      elevation: 0,
      wallRef: wall.id,
      wallOffset: 0.5,
    })
    model.removeWall(wall.id)
    const home = store.getHome()
    expect(home.walls).toHaveLength(0)
    expect(home.furniture).toHaveLength(0)
  })

  it('removeWall only cascades furniture referencing the deleted wall', () => {
    const store = new HomeStore()
    const model = new HomeModel(store)
    const wall1 = model.addWall(wallInput())
    const wall2 = model.addWall({ ...wallInput(), xStart: 100, yStart: 100, xEnd: 200, yEnd: 100 })
    model.addFurniture({
      name: 'door1',
      x: 0,
      y: 0,
      angleDeg: 0,
      width: 10,
      depth: 10,
      height: 10,
      elevation: 0,
      wallRef: wall1.id,
      wallOffset: 0.5,
    })
    const sofa = model.addFurniture({
      name: 'sofa',
      x: 150,
      y: 150,
      angleDeg: 0,
      width: 200,
      depth: 80,
      height: 80,
      elevation: 0,
    })
    model.removeWall(wall1.id)
    const home = store.getHome()
    expect(home.walls).toHaveLength(1)
    expect(home.walls[0]!.id).toBe(wall2.id)
    expect(home.furniture).toHaveLength(1)
    expect(home.furniture[0]!.id).toBe(sofa.id)
  })

  it('undo restores both wall and cascade-deleted furniture', () => {
    const store = new HomeStore()
    const model = new HomeModel(store)
    const wall = model.addWall(wallInput())
    model.addFurniture({
      name: 'door',
      x: 0,
      y: 0,
      angleDeg: 0,
      width: 10,
      depth: 10,
      height: 10,
      elevation: 0,
      wallRef: wall.id,
      wallOffset: 0.5,
    })
    model.removeWall(wall.id)
    expect(store.getHome().furniture).toHaveLength(0)
    store.undo()
    const restored = store.getHome()
    expect(restored.walls).toHaveLength(1)
    expect(restored.walls[0]!.id).toBe(wall.id)
    expect(restored.furniture).toHaveLength(1)
    expect(restored.furniture[0]!.wallRef).toBe(wall.id)
  })

  it('removeItems cascades furniture with matching wallRef', () => {
    const store = new HomeStore()
    const model = new HomeModel(store)
    const wall = model.addWall(wallInput())
    model.addFurniture({
      name: 'door',
      x: 0,
      y: 0,
      angleDeg: 0,
      width: 10,
      depth: 10,
      height: 10,
      elevation: 0,
      wallRef: wall.id,
      wallOffset: 0.5,
    })
    model.removeItems([wall.id])
    const home = store.getHome()
    expect(home.walls).toHaveLength(0)
    expect(home.furniture).toHaveLength(0)
  })

  it('removeLevel cascade-deletes all content scoped to the level', () => {
    const store = new HomeStore()
    const model = new HomeModel(store)
    const level = model.addLevel({
      name: 'L0',
      elevation: 0,
      floorThickness: 10,
      height: 250,
      visible: true,
      viewable: true,
    })
    model.addWall({ ...wallInput(), levelRef: level.id })
    model.addRoom([[0, 0], [100, 0], [100, 100]], { levelRef: level.id })
    model.addFurniture({
      name: 'sofa',
      x: 10,
      y: 10,
      angleDeg: 0,
      width: 200,
      depth: 80,
      height: 80,
      elevation: 0,
      levelRef: level.id,
    })
    model.addDimensionLine({ xStart: 0, yStart: 0, xEnd: 100, yEnd: 0, offset: 50, levelRef: level.id })
    model.addLabel({ text: 'L0', x: 0, y: 0, levelRef: level.id })
    model.removeLevel(level.id)
    const home = store.getHome()
    expect(home.levels).toHaveLength(0)
    expect(home.walls).toHaveLength(0)
    expect(home.rooms).toHaveLength(0)
    expect(home.furniture).toHaveLength(0)
    expect(home.dimensionLines).toHaveLength(0)
    expect(home.labels).toHaveLength(0)
  })

  it('removeLevel leaves content on the default level and other levels intact', () => {
    const store = new HomeStore()
    const model = new HomeModel(store)
    const level = model.addLevel({
      name: 'L0',
      elevation: 0,
      floorThickness: 10,
      height: 250,
      visible: true,
      viewable: true,
    })
    const other = model.addLevel({
      name: 'L1',
      elevation: 250,
      floorThickness: 10,
      height: 250,
      visible: true,
      viewable: true,
    })
    const defaultWall = model.addWall({ ...wallInput(), xEnd: 400 })
    const otherWall = model.addWall({ ...wallInput(), xStart: 500, xEnd: 900, levelRef: other.id })
    const levelWall = model.addWall({ ...wallInput(), xStart: 1000, xEnd: 1400, levelRef: level.id })
    model.removeLevel(level.id)
    const home = store.getHome()
    expect(home.levels).toHaveLength(1)
    expect(home.levels[0]!.id).toBe(other.id)
    expect(home.walls.map((w) => w.id).sort()).toEqual([defaultWall.id, otherWall.id].sort())
    expect(home.walls.some((w) => w.id === levelWall.id)).toBe(false)
    expect(home.walls.some((w) => w.levelRef === level.id)).toBe(false)
  })

  it('undo restores the level and all cascade-deleted content in one step', () => {
    const store = new HomeStore()
    const model = new HomeModel(store)
    const level = model.addLevel({
      name: 'L0',
      elevation: 0,
      floorThickness: 10,
      height: 250,
      visible: true,
      viewable: true,
    })
    model.addWall({ ...wallInput(), levelRef: level.id })
    model.addFurniture({
      name: 'door',
      x: 0,
      y: 0,
      angleDeg: 0,
      width: 10,
      depth: 10,
      height: 10,
      elevation: 0,
      levelRef: level.id,
    })
    const before = store.getHome()
    model.removeLevel(level.id)
    expect(store.getHome().levels).toHaveLength(0)
    expect(store.getHome().walls).toHaveLength(0)
    expect(store.getHome().furniture).toHaveLength(0)
    expect(store.undo()).toBe(true)
    const restored = store.getHome()
    expect(restored.levels).toEqual(before.levels)
    expect(restored.walls).toEqual(before.walls)
    expect(restored.furniture).toEqual(before.furniture)
    expect(restored.selection).toEqual(before.selection)
  })

  it('removeItems cascades content when a level id is in the delete set', () => {
    const store = new HomeStore()
    const model = new HomeModel(store)
    const level = model.addLevel({
      name: 'L0',
      elevation: 0,
      floorThickness: 10,
      height: 250,
      visible: true,
      viewable: true,
    })
    model.addWall({ ...wallInput(), levelRef: level.id })
    model.addFurniture({
      name: 'sofa',
      x: 10,
      y: 10,
      angleDeg: 0,
      width: 200,
      depth: 80,
      height: 80,
      elevation: 0,
      levelRef: level.id,
    })
    model.removeItems([level.id])
    const home = store.getHome()
    expect(home.levels).toHaveLength(0)
    expect(home.walls).toHaveLength(0)
    expect(home.furniture).toHaveLength(0)
  })

  it('environment wallsAlpha clamps to [0,1] domain via validation error', () => {
    const model = new HomeModel(new HomeStore())
    expect(() => model.setEnvironment({ wallsAlpha: 1.5 })).toThrow(ModelError)
    expect(() => model.setEnvironment({ wallsAlpha: null })).not.toThrow()
  })

  it('a failed remove pushes no undo step and preserves redo history', () => {
    const store = new HomeStore()
    const model = new HomeModel(store)
    model.addWall(wallInput())
    store.undo()
    expect(store.canRedo()).toBe(true)
    const stateBeforeFailure = JSON.stringify(serializeHome(store.getHome()))
    expect(() => model.removeWall('wall-999')).toThrow(ModelError)
    expect(store.canRedo()).toBe(true)
    expect(JSON.stringify(serializeHome(store.getHome()))).toBe(stateBeforeFailure)
    expect(store.redo()).toBe(true)
    expect(store.getHome().walls).toHaveLength(1)
  })

  it('a failed op on a fresh store leaves capabilities untouched', () => {
    const store = new HomeStore()
    const model = new HomeModel(store)
    expect(() => model.removeWall('wall-1')).toThrow(ModelError)
    expect(store.getHome().capabilities).toEqual({ canUndo: false, canRedo: false })
  })

  it('update paths re-validate schema invariants and reject bad patches', () => {
    const store = new HomeStore()
    const model = new HomeModel(store)
    const wall = model.addWall(wallInput())
    const furniture = model.addFurniture({
      name: 'x',
      x: 0,
      y: 0,
      angleDeg: 0,
      width: 10,
      depth: 10,
      height: 10,
      elevation: 0,
    })
    const label = model.addLabel({ text: 't', x: 0, y: 0 })
    expect(() => model.updateWall(wall.id, { thickness: 0 })).toThrow(/thickness/)
    expect(() => model.updateFurniture(furniture.id, { width: -3 })).toThrow(/width/)
    expect(() =>
      model.updateRoom(model.addRoom([[0, 0], [4, 0], [4, 3]]).id, {
        points: [[NaN, 0], [1]] as unknown as Array<[number, number]>,
      }),
    ).toThrow(ModelError)
    expect(() => model.updateLabel(label.id, { x: 'boom' as unknown as number })).toThrow(/x must be/)
    // failed updates leave state + history untouched
    const snapshotBefore = JSON.stringify(serializeHome(store.getHome()))
    expect(() => model.updateWall(wall.id, { thickness: -1 })).toThrow(ModelError)
    expect(JSON.stringify(serializeHome(store.getHome()))).toBe(snapshotBefore)
  })

  it('patches cannot reassign object ids', () => {
    const store = new HomeStore()
    const model = new HomeModel(store)
    const wall = model.addWall(wallInput())
    model.updateWall(wall.id, { id: 'hacked' } as unknown as Partial<typeof wall>)
    expect(store.getHome().walls[0]?.id).toBe(wall.id)
  })
})

describe('nextLevelElevation', () => {
  it('returns DEFAULT_WALL_HEIGHT_CM for empty levels (first added level)', () => {
    expect(nextLevelElevation([])).toBe(DEFAULT_WALL_HEIGHT_CM)
  })

  it('stacks above the highest existing level', () => {
    const levels: Level[] = [
      { id: 'l1', name: 'Ground+1', elevation: 250, floorThickness: 20, height: 250, visible: true, viewable: true },
    ]
    expect(nextLevelElevation(levels)).toBe(500) // 250 + 250
  })

  it('handles non-uniform level heights', () => {
    const levels: Level[] = [
      { id: 'l1', name: 'Mezzanine', elevation: 125, floorThickness: 10, height: 200, visible: true, viewable: true },
      { id: 'l2', name: 'Upper', elevation: 500, floorThickness: 15, height: 180, visible: true, viewable: true },
    ]
    expect(nextLevelElevation(levels)).toBe(680) // max(125+200, 500+180) = 680
  })
})
