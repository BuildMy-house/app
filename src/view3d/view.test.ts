import { describe, it, expect, beforeEach } from 'vitest'
import { HomeStore } from '../core/store'
import { snapshotDeltaMetrics } from './scene-delta'
import type { Wall } from '../core/home'
import { View3D } from './view'

const WA: Wall = { id: 'wA', xStart: 0, yStart: 0, xEnd: 100, yEnd: 0, thickness: 15 }

/** Headless View3D: no container → no renderer → draw() no-ops, but every
 * store-change/metrics path (rebuild, delta apply, recordFullRebuild,
 * recordSceneDelta) runs for real. */
function makeView(): { store: HomeStore; view: View3D } {
  const store = new HomeStore('UTC')
  const view = new View3D(store)
  return { store, view }
}

/** First mutation on an empty home — computeSceneUpdates labels it 'initial'. */
function addWall(store: HomeStore): void {
  store.apply((draft) => {
    draft.walls.push(WA)
  })
}

beforeEach(() => {
  // Reset the module-level 60s delta window between tests.
  snapshotDeltaMetrics()
})

describe('View3D rebuild telemetry', () => {
  it("records the first store change as an 'initial' full rebuild", () => {
    const { store, view } = makeView()

    addWall(store)

    const m = snapshotDeltaMetrics()
    expect(m.fullRebuildsCount).toBe(1)
    expect(m.rebuildCountByReason).toEqual({ initial: 1 })
    expect(view.lastSceneUpdate.path).toBe('rebuild')
    expect(view.lastSceneUpdate.ms).toBeGreaterThanOrEqual(0)
    view.dispose()
  })

  it('records a wall add on a rendered home through the delta path', () => {
    const { store, view } = makeView()
    addWall(store) // initial rebuild
    snapshotDeltaMetrics() // clear the window so only the delta is counted

    store.apply((draft) => {
      draft.walls.push({ id: 'wB', xStart: 100, yStart: 0, xEnd: 100, yEnd: 100, thickness: 15 })
    })

    const m = snapshotDeltaMetrics()
    expect(m.deltaUpdatesCount).toBe(1)
    expect(m.deltaCountByType).toEqual({ 'wall-add': 1 })
    expect(m.fullRebuildsCount).toBe(0)
    expect(view.lastSceneUpdate.path).toBe('delta')
    expect(view.lastSceneUpdate.ms).toBeGreaterThan(0)
    view.dispose()
  })

  it("labels setRoofVisible rebuilds 'roof-visible-toggle'", () => {
    const { store, view } = makeView()
    addWall(store)
    snapshotDeltaMetrics()

    view.setRoofVisible(false)

    expect(view.lastSceneUpdate.path).toBe('rebuild')
    expect(snapshotDeltaMetrics().rebuildCountByReason).toEqual({ 'roof-visible-toggle': 1 })
    view.dispose()
  })

  it("labels setActiveLevel rebuilds 'active-level-change'", () => {
    const { store, view } = makeView()
    addWall(store)
    snapshotDeltaMetrics()

    view.setActiveLevel('level-1')

    expect(view.lastSceneUpdate.path).toBe('rebuild')
    expect(snapshotDeltaMetrics().rebuildCountByReason).toEqual({ 'active-level-change': 1 })
    view.dispose()
  })

  it("labels a failed delta batch 'delta-apply-failed'", () => {
    const { store, view } = makeView()
    addWall(store)
    snapshotDeltaMetrics()
    // furniture-update only applies when the change is transform-only; a
    // color change makes applySceneUpdate return false → batch rebuild.
    store.apply((draft) => {
      draft.furniture.push({
        id: 'f1', name: 'Chair', x: 10, y: 10, angleDeg: 0,
        width: 40, depth: 40, height: 80, elevation: 0,
        color: 0xff0000, catalogId: 'chair', movable: true,
      })
    })
    snapshotDeltaMetrics()

    store.apply((draft) => {
      const f = draft.furniture.find((f) => f.id === 'f1')
      if (f) f.color = 0x00ff00
    })

    expect(view.lastSceneUpdate.path).toBe('rebuild')
    expect(snapshotDeltaMetrics().rebuildCountByReason).toEqual({ 'delta-apply-failed': 1 })
    view.dispose()
  })
})
