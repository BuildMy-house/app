import * as THREE from 'three'
import { describe, it, expect, beforeEach } from 'vitest'
import {
  applySceneUpdate,
  computeSceneUpdates,
  recordSceneDelta,
  recordFullRebuild,
  snapshotDeltaMetrics,
  type SceneUpdate,
} from './scene-delta'
import { buildScene, SELECTION_EMISSIVE_COLOR } from './scene'
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
    recordFullRebuild(1, 'initial')
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
    recordFullRebuild(100, 'roof change detected')
    recordFullRebuild(200, 'structural change detected')
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

  it('tracks rebuild counts per verbatim reason label', () => {
    recordFullRebuild(10, 'initial')
    recordFullRebuild(10, 'initial')
    recordFullRebuild(10, 'roof change detected')
    recordFullRebuild(10, 'structural change detected')
    const m = snapshotDeltaMetrics()
    expect(m.fullRebuildsCount).toBe(4)
    expect(m.rebuildCountByReason).toEqual({
      initial: 2,
      'roof change detected': 1,
      'structural change detected': 1,
    })
  })

  it('leaves rebuildCountByReason empty for pure-delta windows', () => {
    recordSceneDelta('wall-add', 1)
    const m = snapshotDeltaMetrics()
    expect(m.rebuildCountByReason).toEqual({})
  })

  it('resets all accumulators after a snapshot', () => {
    recordSceneDelta('furniture-update', 5)
    recordFullRebuild(50, 'initial')
    snapshotDeltaMetrics()
    const m = snapshotDeltaMetrics()
    expect(m.deltaUpdatesCount).toBe(0)
    expect(m.fullRebuildsCount).toBe(0)
    expect(m.deltaCountByType).toEqual({})
    expect(m.rebuildCountByReason).toEqual({})
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

describe('computeSceneUpdates single add', () => {
  it('takes the delta path for a single new wall', () => {
    const old = createEmptyHome()
    const next = createEmptyHome()
    next.walls.push(WA)
    const updates = computeSceneUpdates(old, next)
    expect(updates).toEqual([{ type: 'wall-add', wallId: 'wA', wall: WA }])
  })

  it('takes the delta path for a single new room', () => {
    const room: Room = { id: 'r1', points: [[0, 0], [100, 0], [100, 100]] }
    const old = createEmptyHome()
    const next = createEmptyHome()
    next.rooms.push(room)
    const updates = computeSceneUpdates(old, next)
    expect(updates).toEqual([{ type: 'room-add', roomId: 'r1', room }])
  })
})

describe('applySceneUpdate wall-add', () => {
  it('adds the wall mesh and re-meshes the neighbor joined at its endpoint', () => {
    const old = createEmptyHome()
    old.walls.push(WA)
    const next = createEmptyHome()
    next.walls.push(WA, WB)
    const scene = buildScene(old)
    expect(scene.getObjectByName('wall:WB')).toBeUndefined()

    const ok = applySceneUpdate(scene, { type: 'wall-add', wallId: 'wB', wall: WB }, next, old)

    expect(ok).toBe(true)
    expect(scene.getObjectByName('wall:wB')).toBeDefined()
    // WA shares WB's (100,0) endpoint → miter changed → must be rebuilt too.
    expect(scene.getObjectByName('wall:wA')).toBeDefined()
    expect(scene.getObjectByName('wall-edge:wB')).toBeUndefined()
  })

  it('skips the mesh when the wall is outside the active level filter', () => {
    const level = {
      id: 'level-1', name: 'Ground', elevation: 0, floorThickness: 5,
      height: 250, visible: true, viewable: true,
    }
    const old = createEmptyHome()
    old.levels.push(level)
    const next = createEmptyHome()
    next.levels.push(level)
    next.walls.push({ ...WA, levelRef: 'level-1' })
    const scene = buildScene(old)

    const ok = applySceneUpdate(
      scene,
      { type: 'wall-add', wallId: 'wA', wall: { ...WA, levelRef: 'level-1' } },
      next,
      old,
      { activeLevel: 'some-other-level' },
    )

    expect(ok).toBe(true)
    expect(scene.getObjectByName('wall:wA')).toBeUndefined()
  })
})

describe('applySceneUpdate room-add', () => {
  it('adds floor + ceiling and re-meshes walls whose side classification flipped', () => {
    const room: Room = { id: 'r1', points: [[0, 0], [100, 0], [100, 100]] }
    const old = createEmptyHome()
    old.walls.push(WA)
    const next = createEmptyHome()
    next.walls.push(WA)
    next.rooms.push(room)
    const scene = buildScene(old)
    // Standalone wall: both sides exterior. LEFT samples (50,+12.5) — inside
    // the new triangle once r1 exists — so LEFT must flip to interior.
    const before = scene.getObjectByName('wall:wA')
    expect(before?.userData.leftSideExterior).toBe(true)
    expect(before?.userData.rightSideExterior).toBe(true)

    // Ceilings render only in the outside view (same as buildScene).
    const ok = applySceneUpdate(scene, { type: 'room-add', roomId: 'r1', room }, next, old, {
      isOutsideView: true,
    })

    expect(ok).toBe(true)
    expect(scene.getObjectByName('room:r1')).toBeDefined()
    expect(scene.getObjectByName('ceiling:r1')).toBeDefined()
    const after = scene.getObjectByName('wall:wA')
    expect(after?.userData.leftSideExterior).toBe(false)
    expect(after?.userData.rightSideExterior).toBe(true)
  })

  it('leaves walls alone when no classification flips (room far away)', () => {
    const room: Room = { id: 'r1', points: [[5000, 5000], [5100, 5000], [5100, 5100]] }
    const old = createEmptyHome()
    old.walls.push(WA)
    const next = createEmptyHome()
    next.walls.push(WA)
    next.rooms.push(room)
    const scene = buildScene(old)
    const before = scene.getObjectByName('wall:wA')

    const ok = applySceneUpdate(scene, { type: 'room-add', roomId: 'r1', room }, next, old)

    expect(ok).toBe(true)
    expect(scene.getObjectByName('room:r1')).toBeDefined()
    expect(scene.getObjectByName('wall:wA')).toBe(before)
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

// ── SCENE-DELTA-2: in-place selection-tint delta ─────────────────────────────

/** Read emissive state from every material under a named object. */
function emissivesOf(scene: THREE.Scene, name: string): Array<{ hex: number; intensity: number }> {
  const obj = scene.getObjectByName(name)
  expect(obj, `expected object ${name}`).toBeDefined()
  const out: Array<{ hex: number; intensity: number }> = []
  obj!.traverse((child) => {
    const mesh = child as THREE.Mesh
    if (!('material' in mesh)) return
    const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material]
    for (const m of mats) {
      if ('emissive' in m) {
        const std = m as THREE.MeshStandardMaterial
        out.push({ hex: std.emissive.getHex(), intensity: std.emissiveIntensity })
      }
    }
  })
  expect(out.length).toBeGreaterThan(0)
  return out
}

function expectTinted(scene: THREE.Scene, name: string): void {
  for (const m of emissivesOf(scene, name)) expect(m.hex).toBe(SELECTION_EMISSIVE_COLOR)
}

/** Fresh build, never tinted: black emissive, but default intensity (1). */
function expectUntinted(scene: THREE.Scene, name: string): void {
  for (const m of emissivesOf(scene, name)) expect(m.hex).toBe(0x000000)
}

/** After clearEmissive: black AND intensity explicitly reset to 0. */
function expectCleared(scene: THREE.Scene, name: string): void {
  for (const m of emissivesOf(scene, name)) {
    expect(m.hex).toBe(0x000000)
    expect(m.intensity).toBe(0)
  }
}

/** Two furniture items with different colors → different instancing groups → never instanced. */
function twoSofasHome() {
  const home = createEmptyHome()
  home.furniture.push(chair('A', { color: 0xff0000, x: 100 }), chair('B', { color: 0x00ff00, x: 400 }))
  return home
}

describe('applySceneUpdate selection-update', () => {
  it('single-select: returns only selection-update (not full-rebuild) and tints just A', () => {
    const old = twoSofasHome()
    const next = { ...old, selection: ['A'] }
    const scene = buildScene(old)
    expectUntinted(scene, 'furniture:A')
    expectUntinted(scene, 'furniture:B')

    const updates = computeSceneUpdates(old, next)
    expect(updates).toEqual([{ type: 'selection-update', reason: 'selection changed' }])

    const ok = applySceneUpdate(scene, updates[0]!, next, old)
    expect(ok).toBe(true)
    expectTinted(scene, 'furniture:A')
    expectUntinted(scene, 'furniture:B')
  })

  it('multi-select: tints both selected items', () => {
    const old = twoSofasHome()
    const next = { ...old, selection: ['A', 'B'] }
    const scene = buildScene(old)

    const updates = computeSceneUpdates(old, next)
    expect(updates).toEqual([{ type: 'selection-update', reason: 'selection changed' }])

    expect(applySceneUpdate(scene, updates[0]!, next, old)).toBe(true)
    expectTinted(scene, 'furniture:A')
    expectTinted(scene, 'furniture:B')
  })

  it('deselect: clears the previously-tinted furniture back to black/intensity 0', () => {
    const old = { ...twoSofasHome(), selection: ['A'] }
    const next = { ...old, selection: [] }
    const scene = buildScene(old)
    expectTinted(scene, 'furniture:A')

    const updates = computeSceneUpdates(old, next)
    expect(updates).toEqual([{ type: 'selection-update', reason: 'selection changed' }])

    expect(applySceneUpdate(scene, updates[0]!, next, old)).toBe(true)
    expectCleared(scene, 'furniture:A')
    expectUntinted(scene, 'furniture:B')
  })

  it('wall select then deselect is cleared in place (asymmetry fix: non-furniture clear)', () => {
    const old = createEmptyHome()
    old.walls.push(WA)
    const scene = buildScene(old)
    expectUntinted(scene, 'wall:wA')

    // Select the wall via the delta path.
    const selected = { ...old, selection: ['wA'] }
    const selUpdates = computeSceneUpdates(old, selected)
    expect(selUpdates).toEqual([{ type: 'selection-update', reason: 'selection changed' }])
    expect(applySceneUpdate(scene, selUpdates[0]!, selected, old)).toBe(true)
    expectTinted(scene, 'wall:wA')

    // Deselect: applySelectionHighlight's clearEmissive only special-cases
    // `furniture:` — the delta path must clear walls too, or a previously
    // tinted wall would stay tinted forever on the reused scene.
    const deselected = { ...selected, selection: [] }
    const delUpdates = computeSceneUpdates(selected, deselected)
    expect(delUpdates).toEqual([{ type: 'selection-update', reason: 'selection changed' }])
    expect(applySceneUpdate(scene, delUpdates[0]!, deselected, selected)).toBe(true)
    expectCleared(scene, 'wall:wA')
  })

  it('room select then deselect is cleared in place via the delta path', () => {
    const old = createEmptyHome()
    old.rooms.push({ id: 'r1', points: [[0, 0], [100, 0], [100, 100]] })
    const scene = buildScene(old)
    expectUntinted(scene, 'room:r1')

    const selected = { ...old, selection: ['r1'] }
    const selUpdates = computeSceneUpdates(old, selected)
    expect(selUpdates).toEqual([{ type: 'selection-update', reason: 'selection changed' }])
    expect(applySceneUpdate(scene, selUpdates[0]!, selected, old)).toBe(true)
    expectTinted(scene, 'room:r1')

    const deselected = { ...selected, selection: [] }
    const delUpdates = computeSceneUpdates(selected, deselected)
    expect(delUpdates).toEqual([{ type: 'selection-update', reason: 'selection changed' }])
    expect(applySceneUpdate(scene, delUpdates[0]!, deselected, selected)).toBe(true)
    expectCleared(scene, 'room:r1')
  })

  it('bails (returns false) when the changed id lives in an InstancedMesh batch', () => {
    // 3 identical chairs → one InstancedMesh (mirror of scene.test.ts T1).
    const old = createEmptyHome()
    for (let i = 0; i < 3; i++) old.furniture.push(chair(`c${i}`, { x: i * 60, color: 0xff0000, catalogId: 'chair-a' }))
    const scene = buildScene(old)
    let instanced: THREE.InstancedMesh | undefined
    scene.traverse((o) => {
      if (o instanceof THREE.InstancedMesh && o.name.startsWith('furniture-instanced-')) instanced = o
    })
    expect(instanced).toBeDefined()
    expect(instanced!.count).toBe(3)

    const next = { ...old, selection: ['c1'] }
    const updates = computeSceneUpdates(old, next)
    expect(updates).toEqual([{ type: 'selection-update', reason: 'selection changed' }])

    // Must refuse: tinting the shared batch material would highlight all 3.
    expect(applySceneUpdate(scene, updates[0]!, next, old)).toBe(false)
  })

  it('bundles a selection change with a furniture move and both apply', () => {
    const old = twoSofasHome()
    const moved = { ...old.furniture[0]!, x: 300, y: 250 }
    const next = {
      ...old,
      furniture: [moved, old.furniture[1]!],
      selection: ['A'],
    }
    const scene = buildScene(old)
    const before = scene.getObjectByName('furniture:A') as THREE.Mesh

    const updates = computeSceneUpdates(old, next)
    expect(updates.length).toBe(2)
    expect(updates).toEqual(expect.arrayContaining([
      { type: 'furniture-update', furnitureId: 'A', furniture: moved },
      { type: 'selection-update', reason: 'selection changed' },
    ]))

    const ok = updates.every((u) => applySceneUpdate(scene, u, next, old))
    expect(ok).toBe(true)
    // Neither update reverted the other: moved AND tinted, same mesh object.
    expect(scene.getObjectByName('furniture:A')).toBe(before)
    expect(before.position.x).toBe(300)
    expect(before.position.z).toBe(250)
    expectTinted(scene, 'furniture:A')
  })

  it('no-op when selection is identical (still falls back to structural rebuild)', () => {
    const old = { ...twoSofasHome(), selection: ['A'] }
    const next = { ...old, selection: ['A'] }
    expect(computeSceneUpdates(old, next)).toEqual([
      { type: 'full-rebuild', reason: 'structural change detected' },
    ])
  })
})

// ── SCENE-DELTA-2 benchmark ──────────────────────────────────────────────────
//
// Baseline: before the selection diff existed, `selection` was never compared,
// so a pure selection change produced zero updates and fell into the final
// `structural change detected` branch — i.e. all 50/50 of these calls would
// have returned full-rebuild (mathematically obvious from the pre-fix
// computeSceneUpdates: selection never appeared in any diff). After the fix,
// 0/50.

describe('SCENE-DELTA-2 benchmark', () => {
  it('50 pure selection changes: 0 full-rebuilds, 50 tint applies in <5ms total', () => {
    const home = twoSofasHome()
    const scene = buildScene(home)

    const pairs: Array<{ updates: SceneUpdate[]; prev: ReturnType<typeof createEmptyHome>; cur: ReturnType<typeof createEmptyHome> }> = []
    let prev = home
    let rebuilds = 0
    let selectionUpdates = 0
    for (let i = 0; i < 50; i++) {
      const cur = { ...prev, selection: i % 2 === 0 ? ['A'] : ['B'] }
      const updates = computeSceneUpdates(prev, cur)
      if (updates.some((u) => u.type === 'full-rebuild')) rebuilds++
      if (updates.length === 1 && updates[0]!.type === 'selection-update') selectionUpdates++
      pairs.push({ updates, prev, cur })
      prev = cur
    }
    expect(rebuilds).toBe(0) // before the fix: 50/50
    expect(selectionUpdates).toBe(50)

    // Warm once, then measure the 50 in-place tint applies.
    for (const { updates, prev: p, cur } of pairs) applySceneUpdate(scene, updates[0]!, cur, p)
    const t0 = performance.now()
    for (const { updates, prev: p, cur } of pairs) {
      expect(applySceneUpdate(scene, updates[0]!, cur, p)).toBe(true)
    }
    const elapsed = performance.now() - t0
    expect(elapsed).toBeLessThan(5)
  })
})
