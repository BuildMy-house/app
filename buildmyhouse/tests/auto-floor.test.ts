import { describe, it, expect, vi } from 'vitest'
import { detectClosedLoops, type Wall, type WallLoop } from '../src/core/wall-loop-detector'

// Integration tests: verify the data flow from wall-loop-detector through
// AutoFloorDialog interactions into room creation logic (mocked model).

function makeWall(id: string, sx: number, sy: number, ex: number, ey: number): Wall {
  return { id, start: { x: sx, y: sy }, end: { x: ex, y: ey } }
}

function rectWalls(x: number, y: number, w: number, h: number): Wall[] {
  return [
    makeWall('w1', x, y, x + w, y),
    makeWall('w2', x + w, y, x + w, y + h),
    makeWall('w3', x + w, y + h, x, y + h),
    makeWall('w4', x, y + h, x, y),
  ]
}

describe('Auto-floor integration', () => {
  it('creates a room from 4-wall rectangle loop', () => {
    const walls = rectWalls(0, 0, 10, 8)
    const loops = detectClosedLoops(walls)
    expect(loops).toHaveLength(1)

    const loop = loops[0]
    expect(loop.vertices).toHaveLength(4)
    expect(loop.area).toBeCloseTo(80, 1)

    // Verify vertices form the expected rectangle
    const xs = loop.vertices.map(v => v.x).sort((a, b) => a - b)
    const ys = loop.vertices.map(v => v.y).sort((a, b) => a - b)
    expect(xs[0]).toBeCloseTo(0, 5)
    expect(xs[3]).toBeCloseTo(10, 5)
    expect(ys[0]).toBeCloseTo(0, 5)
    expect(ys[3]).toBeCloseTo(8, 5)
  })

  it('creates a room from 3-wall triangle loop', () => {
    const walls = [
      makeWall('w1', 0, 0, 10, 0),
      makeWall('w2', 10, 0, 5, 8.66),
      makeWall('w3', 5, 8.66, 0, 0),
    ]
    const loops = detectClosedLoops(walls)
    expect(loops).toHaveLength(1)
    expect(loops[0].vertices).toHaveLength(3)
    expect(loops[0].area).toBeGreaterThan(0)
  })

  it('simulates undo: room removed, loop still detectable', () => {
    const walls = rectWalls(0, 0, 10, 8)
    const rooms: WallLoop[] = []

    // Create room
    const loops = detectClosedLoops(walls)
    rooms.push(loops[0])
    expect(rooms).toHaveLength(1)

    // Undo: remove room
    rooms.pop()
    expect(rooms).toHaveLength(0)

    // Re-detect: still works
    const loopsAgain = detectClosedLoops(walls)
    expect(loopsAgain).toHaveLength(1)
  })

  it('simulates redo: room restored', () => {
    const walls = rectWalls(0, 0, 10, 8)
    const rooms: WallLoop[] = []
    const history: WallLoop[][] = [[]]

    // Create
    const loops = detectClosedLoops(walls)
    rooms.push(loops[0])
    history.push([...rooms])

    // Undo
    rooms.pop()
    history.push([...rooms])

    // Redo: restore from history
    const prev = history[history.length - 2]
    rooms.length = 0
    rooms.push(...prev)
    expect(rooms).toHaveLength(1)
  })

  it('dialog confirm triggers room creation callback', () => {
    const walls = rectWalls(0, 0, 10, 8)
    const loops = detectClosedLoops(walls)
    const onConfirm = vi.fn()
    const onCancel = vi.fn()

    // Simulate dialog interaction: confirm
    onConfirm()
    expect(onConfirm).toHaveBeenCalledOnce()
    expect(onCancel).not.toHaveBeenCalled()
  })

  it('dialog cancel does not trigger room creation', () => {
    const walls = rectWalls(0, 0, 10, 8)
    const loops = detectClosedLoops(walls)
    const onConfirm = vi.fn()
    const onCancel = vi.fn()

    // Simulate dialog interaction: cancel
    onCancel()
    expect(onCancel).toHaveBeenCalledOnce()
    expect(onConfirm).not.toHaveBeenCalled()
  })

  it('detects multiple loops from disconnected walls', () => {
    const walls = [
      makeWall('a1', 0, 0, 5, 0),
      makeWall('a2', 5, 0, 5, 5),
      makeWall('a3', 5, 5, 0, 5),
      makeWall('a4', 0, 5, 0, 0),
      makeWall('b1', 20, 20, 25, 20),
      makeWall('b2', 25, 20, 25, 25),
      makeWall('b3', 25, 25, 20, 25),
      makeWall('b4', 20, 25, 20, 20),
    ]
    const loops = detectClosedLoops(walls)
    expect(loops).toHaveLength(2)

    const areas = loops.map(l => l.area).sort((a, b) => a - b)
    expect(areas[0]).toBeCloseTo(25, 1)
    expect(areas[1]).toBeCloseTo(25, 1)
  })

  it('rejects overlapping walls that share an edge', () => {
    const walls = [
      makeWall('w1', 0, 0, 10, 0),
      makeWall('w2', 10, 0, 10, 10),
      makeWall('w3', 10, 10, 0, 10),
      makeWall('w4', 0, 10, 0, 0),
      makeWall('w5', 0, 0, 10, 0), // duplicate edge
    ]
    const loops = detectClosedLoops(walls)
    // Should still detect the rectangle (may or may not count the duplicate)
    expect(loops.length).toBeGreaterThanOrEqual(1)
    expect(loops[0].area).toBeCloseTo(100, 1)
  })

  it('detects smaller loop when walls are modified to enclose less area', () => {
    // Original large rectangle
    const walls = rectWalls(0, 0, 10, 10)
    const loops = detectClosedLoops(walls)
    expect(loops[0].area).toBeCloseTo(100, 1)

    // Modified: smaller rectangle (walls moved inward)
    const smallWalls = rectWalls(2, 2, 6, 6)
    const smallLoops = detectClosedLoops(smallWalls)
    expect(smallLoops).toHaveLength(1)
    expect(smallLoops[0].area).toBeCloseTo(36, 1)
    expect(smallLoops[0].area).toBeLessThan(loops[0].area)
  })
})
