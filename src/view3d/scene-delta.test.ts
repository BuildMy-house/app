import { describe, it, expect, beforeEach } from 'vitest'
import {
  applySceneUpdate,
  computeSceneUpdates,
  recordSceneDelta,
  recordFullRebuild,
  snapshotDeltaMetrics,
  type SceneUpdate,
} from './scene-delta'
import { buildScene } from './scene'
import { createEmptyHome, type Furniture, type Wall, type Room } from '../core/home'

/** Fresh 60s window for every test — snapshotDeltaMetrics resets accumulators. */
beforeEach(() => {
  snapshotDeltaMetrics()
})

describe('snapshotDeltaMetrics', () => {
  it('returns zeros for an empty window', () => {
    const m = snapshotDeltaMetrics()
    expect(m.deltaUpdatesCount).toBe(0)
    expect(m.fullRebuildsCount).toBe(0)
    expect(m.deltaRatio).toBe(0)
    expect(m.avgDeltaDurationMs).toBe(0)
    expect(m.avgRebuildDurationMs).toBe(0)
    expect(m.windowDurationMs).toBe(60_000)
  })

  it('computes deltaRatio as deltas / (deltas + rebuilds)', () => {
    recordSceneDelta('furniture-update', 1)
    recordSceneDelta('wall-update', 1)
    recordSceneDelta('room-update', 1)
    recordSceneDelta('furniture-update', 1)
    recordFullRebuild(1)
    const m = snapshotDeltaMetrics()
    expect(m.deltaUpdatesCount).toBe(4)
    expect(m.fullRebuildsCount).toBe(1)
    expect(m.deltaRatio).toBeCloseTo(0.8)
  })

  it('reports pure-delta windows as ratio 1', () => {
    recordSceneDelta('furniture-update', 2)
    recordSceneDelta('furniture-update', 4)
    const m = snapshotDeltaMetrics()
    expect(m.deltaRatio).toBe(1)
    expect(m.avgDeltaDurationMs).toBe(3)
    expect(m.avgRebuildDurationMs).toBe(0)
  })

  it('averages durations independently per outcome', () => {
    recordSceneDelta('wall-update', 10)
    recordSceneDelta('wall-update', 20)
    recordFullRebuild(100)
    recordFullRebuild(200)
    const m = snapshotDeltaMetrics()
    expect(m.avgDeltaDurationMs).toBe(15)
    expect(m.avgRebuildDurationMs).toBe(150)
  })

  it('tracks delta counts per operation type', () => {
    recordSceneDelta('furniture-update', 1)
    recordSceneDelta('furniture-update', 1)
    recordSceneDelta('wall-update', 1)
    const m = snapshotDeltaMetrics()
    expect(m.deltaCountByType).toEqual({ 'furniture-update': 2, 'wall-update': 1 })
  })

  it('resets all accumulators after a snapshot', () => {
    recordSceneDelta('furniture-update', 5)
    recordFullRebuild(50)
    snapshotDeltaMetrics()
    const m = snapshotDeltaMetrics()
    expect(m.deltaUpdatesCount).toBe(0)
    expect(m.fullRebuildsCount).toBe(0)
    expect(m.deltaCountByType).toEqual({})
  })
})

// ── Delete/add delta handlers ────────────────────────────────────────────────

const WA: Wall = { id: 'wA', xStart: 0, yStart: 0, xEnd: 100, yEnd: 0, thickness: 15 }
const WB: Wall = { id: 'wB', xStart: 100, yStart: 0, xEnd: 100, yEnd: 100, thickness: 15 }

function chair(id: string, overrides: Partial<Furniture> = {}): Furniture {
  return {
    id, name: 'Chair', x: 10, y: 10, angleDeg: 0,
    width: 40, depth: 40, height: 80, elevation: 0,
    ...overrides,
  }
}

describe('computeSceneUpdates furniture batch add', () => {
  it('falls back to full-rebuild for 2+ new furniture items in one change', () => {
    // Regression: applyFurnitureAdd renders each new item as a standalone
    // mesh and never (re)groups into an InstancedMesh (that grouping is a
    // whole-scene decision made by buildScene/addFurnitureMeshes). Adding 25
    // identical chairs at once via the per-item furniture-add delta path
    // left them as 25 ungrouped meshes forever, since nothing else ever
    // triggered a rebuild afterward -- silently breaking T1 instancing for
    // any bulk add (paste/import/scripted placement).
    const old = createEmptyHome()
    const next = createEmptyHome()
    next.furniture.push(chair('c1'), chair('c2'))
    const updates = computeSceneUpdates(old, next)
    expect(updates).toEqual([{ type: 'full-rebuild', reason: 'batch furniture add' }])
  })

  it('still takes the per-item furniture-add delta path for a single new item', () => {
    const old = createEmptyHome()
    old.furniture.push(chair('c1'))
    const next = createEmptyHome()
    next.furniture.push(chair('c1'), chair('c2'))
    const updates = computeSceneUpdates(old, next)
    expect(updates).toEqual([{ type: 'furniture-add', furnitureId: 'c2', furniture: chair('c2') }])
  })
})

describe('applySceneUpdate wall-delete', () => {
  it('removes the wall and re-meshes the joined neighbor', () => {
    const old = createEmptyHome()
    old.walls.push(WA, WB)
    const next = createEmptyHome()
    next.walls.push(WB)
    const scene = buildScene(old)

    const ok = applySceneUpdate(scene, { type: 'wall-delete', wallId: 'wA' }, next, old)

    expect(ok).toBe(true)
    expect(scene.getObjectByName('wall:wA')).toBeUndefined()
    expect(scene.getObjectByName('wall-edge:wA')).toBeUndefined()
    // Neighbor shared the deleted wall's endpoint → its miter changed, so it
    // must have been removed and rebuilt, not left untouched.
    expect(scene.getObjectByName('wall:wB')).toBeDefined()
    // Wall edge wireframes are gone entirely (double-wall regression fix) —
    // the rebuilt neighbor must not resurrect one.
    expect(scene.getObjectByName('wall-edge:wB')).toBeUndefined()
  })

  it('returns false without oldHome (cannot find miter-affected neighbors)', () => {
    const home = createEmptyHome()
    home.walls.push(WB)
    const scene = buildScene(home)
    const update: SceneUpdate = { type: 'wall-delete', wallId: 'wA' }
    expect(applySceneUpdate(scene, update, home, null)).toBe(false)
  })
})

describe('applySceneUpdate room-delete', () => {
  it('removes the room floor and ceiling meshes', () => {
    const room: Room = { id: 'r1', points: [[0, 0], [100, 0], [100, 100]] }
    const old = createEmptyHome()
    old.rooms.push(room)
    const next = createEmptyHome()
    const scene = buildScene(old)
    expect(scene.getObjectByName('room:r1')).toBeDefined()

    const ok = applySceneUpdate(scene, { type: 'room-delete', roomId: 'r1' }, next, old)

    expect(ok).toBe(true)
    expect(scene.getObjectByName('room:r1')).toBeUndefined()
    expect(scene.getObjectByName('ceiling:r1')).toBeUndefined()
  })
})

describe('applySceneUpdate furniture-delete', () => {
  it('removes the standalone mesh', () => {
    const old = createEmptyHome()
    old.furniture.push(chair('f1'))
    const next = createEmptyHome()
    const scene = buildScene(old)
    expect(scene.getObjectByName('furniture:f1')).toBeDefined()

    const ok = applySceneUpdate(scene, { type: 'furniture-delete', furnitureId: 'f1' }, next, old)

    expect(ok).toBe(true)
    expect(scene.getObjectByName('furniture:f1')).toBeUndefined()
  })

  it('returns false when no standalone mesh exists (instanced/invisible member)', () => {
    const old = createEmptyHome()
    old.furniture.push(chair('f1', { visible: false }))
    const next = createEmptyHome()
    const scene = buildScene(old)
    const ok = applySceneUpdate(scene, { type: 'furniture-delete', furnitureId: 'f1' }, next, old)
    expect(ok).toBe(false)
  })
})

describe('applySceneUpdate furniture-add', () => {
  it('adds a standalone mesh via the buildScene furniture builder', () => {
    const old = createEmptyHome()
    const next = createEmptyHome()
    next.furniture.push(chair('f2'))
    const scene = buildScene(old)
    expect(scene.getObjectByName('furniture:f2')).toBeUndefined()

    const ok = applySceneUpdate(scene, { type: 'furniture-add', furnitureId: 'f2', furniture: next.furniture[0] }, next, old)

    expect(ok).toBe(true)
    expect(scene.getObjectByName('furniture:f2')).toBeDefined()
  })

  it('is a no-op true for items outside the active level filter', () => {
    const old = createEmptyHome()
    old.levels.push({
      id: 'level-1', name: 'Ground', elevation: 0, floorThickness: 5,
      height: 250, visible: true, viewable: true,
    })
    const next = createEmptyHome()
    next.levels.push(old.levels[0]!)
    next.furniture.push(chair('f3', { levelRef: 'level-1' }))
    const scene = buildScene(old)

    const ok = applySceneUpdate(
      scene,
      { type: 'furniture-add', furnitureId: 'f3', furniture: next.furniture[0] },
      next,
      old,
      { activeLevel: 'some-other-level' },
    )

    expect(ok).toBe(true)
    expect(scene.getObjectByName('furniture:f3')).toBeUndefined()
  })
})
