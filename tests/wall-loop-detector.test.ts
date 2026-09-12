import { describe, it, expect } from 'vitest'
import { detectClosedLoops } from '../src/core/wall-loop-detector'
import type { Wall } from '../src/core/wall-loop-detector'

function makeWall(
  id: string,
  sx: number, sy: number,
  ex: number, ey: number
): Wall {
  return {
    id,
    start: { x: sx, y: sy },
    end: { x: ex, y: ey },
  }
}

function rectWalls(
  x: number, y: number,
  w: number, h: number
): Wall[] {
  return [
    makeWall('w1', x, y, x + w, y),
    makeWall('w2', x + w, y, x + w, y + h),
    makeWall('w3', x + w, y + h, x, y + h),
    makeWall('w4', x, y + h, x, y),
  ]
}

describe('detectClosedLoops', () => {
  it('detects a simple rectangle', () => {
    const walls = rectWalls(0, 0, 10, 8)
    const loops = detectClosedLoops(walls)

    expect(loops).toHaveLength(1)
    expect(loops[0]!.walls).toHaveLength(4)
    expect(loops[0]!.area).toBeCloseTo(80, 1)
    expect(loops[0]!.vertices).toHaveLength(4)
  })

  it('detects a triangle', () => {
    const walls = [
      makeWall('w1', 0, 0, 10, 0),
      makeWall('w2', 10, 0, 5, 8.66),
      makeWall('w3', 5, 8.66, 0, 0),
    ]
    const loops = detectClosedLoops(walls)

    expect(loops).toHaveLength(1)
    expect(loops[0]!.walls).toHaveLength(3)
    expect(loops[0]!.area).toBeGreaterThan(0)
  })

  it('detects a hexagon', () => {
    const r = 10
    const hex: Wall[] = []
    for (let i = 0; i < 6; i++) {
      const a1 = (Math.PI / 3) * i - Math.PI / 2
      const a2 = (Math.PI / 3) * (i + 1) - Math.PI / 2
      hex.push(makeWall(
        `w${i}`,
        r * Math.cos(a1), r * Math.sin(a1),
        r * Math.cos(a2), r * Math.sin(a2),
      ))
    }
    const loops = detectClosedLoops(hex)

    expect(loops).toHaveLength(1)
    expect(loops[0]!.walls).toHaveLength(6)
    const expectedArea = (3 * Math.sqrt(3) * r * r) / 2
    expect(loops[0]!.area).toBeCloseTo(expectedArea, 0)
  })

  it('returns empty for an open chain', () => {
    const walls = [
      makeWall('w1', 0, 0, 5, 0),
      makeWall('w2', 5, 0, 5, 5),
      makeWall('w3', 5, 5, 0, 5),
    ]
    const loops = detectClosedLoops(walls)
    expect(loops).toHaveLength(0)
  })

  it('returns empty for a T-junction (open graph)', () => {
    const walls = [
      makeWall('w1', 0, 0, 10, 0),
      makeWall('w2', 10, 0, 10, 5),
      makeWall('w3', 10, 0, 10, 10),
      makeWall('w4', 5, 0, 5, 5),
    ]
    const loops = detectClosedLoops(walls)
    expect(loops).toHaveLength(0)
  })

  it('handles overlapping walls', () => {
    const walls = [
      makeWall('w1', 0, 0, 10, 0),
      makeWall('w2', 10, 0, 10, 10),
      makeWall('w3', 10, 10, 0, 10),
      makeWall('w4', 0, 10, 0, 0),
      makeWall('w5', 0, 0, 10, 0), // duplicate of w1
    ]
    const loops = detectClosedLoops(walls)

    expect(loops.length).toBeGreaterThanOrEqual(1)
  })

  it('uses tolerance for endpoint matching', () => {
    // Walls with small gaps between endpoints (gap = 0.005)
    const walls = [
      makeWall('w1', 0, 0, 10, 0),
      makeWall('w2', 10.005, 0, 20, 0),
      makeWall('w3', 20, 0.005, 20, 10),
      makeWall('w4', 20, 10, 10, 10),
      makeWall('w5', 10, 10, 0, 10),
      makeWall('w6', 0, 10, 0, 0.005),
    ]
    // Default tolerance (0.01) matches gaps of 0.005
    const loopsDefault = detectClosedLoops(walls)
    expect(loopsDefault).toHaveLength(1)

    // Strict tolerance (0.001) does NOT match gaps of 0.005
    const loopsStrict = detectClosedLoops(walls, 0.001)
    expect(loopsStrict).toHaveLength(0)
  })

  it('rejects a degenerate loop with zero area', () => {
    const walls = [
      makeWall('w1', 0, 0, 10, 0),
      makeWall('w2', 10, 0, 5, 0.001),
      makeWall('w3', 5, 0.001, 0, 0),
    ]
    const loops = detectClosedLoops(walls)
    expect(loops).toHaveLength(0)
  })

  it('detects multiple independent loops', () => {
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

  it('returns empty for fewer than 3 walls', () => {
    expect(detectClosedLoops([])).toHaveLength(0)
    expect(detectClosedLoops([makeWall('w1', 0, 0, 5, 0)])).toHaveLength(0)
    expect(detectClosedLoops([
      makeWall('w1', 0, 0, 5, 0),
      makeWall('w2', 5, 0, 5, 5),
    ])).toHaveLength(0)
  })
})
