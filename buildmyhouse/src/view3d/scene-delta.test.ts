import { describe, it, expect, beforeEach } from 'vitest'
import {
  recordSceneDelta,
  recordFullRebuild,
  snapshotDeltaMetrics,
} from './scene-delta'

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
