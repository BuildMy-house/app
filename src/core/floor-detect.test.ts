import { describe, expect, it } from 'vitest'
import {
  detectFloorFaces,
  detectFloorGaps,
  faceAt,
  roomCoversFace,
  signedPolygonArea,
  type FloorWall,
} from './floor-detect'

const w = (id: string, x1: number, y1: number, x2: number, y2: number): FloorWall => ({
  id,
  start: { x: x1, y: y1 },
  end: { x: x2, y: y2 },
})
const square = (s = 400, ox = 0, oy = 0, pre = 'w'): FloorWall[] => [
  w(`${pre}1`, ox, oy, ox + s, oy),
  w(`${pre}2`, ox + s, oy, ox + s, oy + s),
  w(`${pre}3`, ox + s, oy + s, ox, oy + s),
  w(`${pre}4`, ox, oy + s, ox, oy),
]

describe('detectFloorFaces', () => {
  it('finds a closed square with correct area and a single winding', () => {
    const faces = detectFloorFaces(square())
    expect(faces).toHaveLength(1)
    expect(faces[0]!.area).toBeCloseTo(160000)
    expect(faces[0]!.polygon).toHaveLength(4)
    expect(signedPolygonArea(faces[0]!.polygon)).toBeGreaterThan(0)
    expect(faces[0]!.wallIds.sort()).toEqual(['w1', 'w2', 'w3', 'w4'])
  })

  it('is independent of wall order and direction (reversed walls)', () => {
    const walls = square().reverse().map((x) => ({ ...x, start: x.end, end: x.start }))
    expect(detectFloorFaces(walls)).toHaveLength(1)
  })

  it('tolerates small corner gaps and overlaps', () => {
    const walls = square()
    walls[1] = w('w2', 405, -3, 402, 400) // corners a few cm off
    walls[3] = w('w4', 3, 396, 0, 6)
    const faces = detectFloorFaces(walls, { snapTol: 8 })
    expect(faces).toHaveLength(1)
    expect(faces[0]!.area).toBeGreaterThan(150000)
  })

  it('does not close a gap larger than the tolerance', () => {
    const walls = square()
    walls[3] = w('w4', 0, 400, 0, 60) // leaves a 60cm hole
    expect(detectFloorFaces(walls, { snapTol: 8 })).toHaveLength(0)
  })

  it('handles a T-junction: last wall ends mid-way along an existing wall', () => {
    const walls = square()
    walls[3] = w('w4', 0, 400, 0, 100)
    walls.push(w('w5', 0, 100, 0, 0)) // keeps loop closed; now w4/w5 collinear
    const walls2 = [...square().slice(0, 3), w('w4', 0, 400, 0, 0)]
    walls2.push(w('stub', -100, 200, 0, 200)) // dangling spur must not leak into the outline
    const faces = detectFloorFaces(walls2)
    expect(faces).toHaveLength(1)
    expect(faces[0]!.polygon).toHaveLength(4)
    expect(detectFloorFaces(walls)).toHaveLength(1)
  })

  it('splits a room by a partition wall that ends on both sides (two faces)', () => {
    const walls = [...square(), w('p', 200, 0, 200, 400)]
    const faces = detectFloorFaces(walls)
    expect(faces).toHaveLength(2)
    for (const f of faces) expect(f.area).toBeCloseTo(80000)
  })

  it('detects a wall that crosses the box without sharing endpoints', () => {
    const walls = [...square(), w('x', 200, -100, 200, 500)]
    expect(detectFloorFaces(walls)).toHaveLength(2)
  })

  it('handles loops with more than 10 walls', () => {
    const n = 14
    const walls: FloorWall[] = []
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2
      const b = ((i + 1) / n) * Math.PI * 2
      walls.push(w(`c${i}`, Math.cos(a) * 300, Math.sin(a) * 300, Math.cos(b) * 300, Math.sin(b) * 300))
    }
    const faces = detectFloorFaces(walls)
    expect(faces).toHaveLength(1)
    expect(faces[0]!.polygon).toHaveLength(14)
  })

  it('ignores slivers and degenerate/NaN walls', () => {
    const walls = [...square(40), w('nan', NaN, 0, 10, 10), w('zero', 5, 5, 5, 5)]
    expect(detectFloorFaces(walls)).toHaveLength(0) // 40x40 = 1600 < min area
    expect(detectFloorFaces(square(400).slice(0, 2))).toHaveLength(0)
  })

  it('finds nested faces and faceAt picks the smallest containing', () => {
    const walls = [...square(600), ...square(200, 200, 200, 'i')]
    const faces = detectFloorFaces(walls)
    expect(faces.length).toBeGreaterThanOrEqual(2)
    expect(faceAt(faces, { x: 300, y: 300 })!.area).toBeCloseTo(40000)
    expect(faceAt(faces, { x: 50, y: 50 })!.area).toBeCloseTo(360000)
    expect(faceAt(faces, { x: 900, y: 900 })).toBeNull()
  })
})

describe('roomCoversFace', () => {
  it('matches an existing room of about the same footprint only', () => {
    const face = detectFloorFaces(square())[0]!
    expect(roomCoversFace([[0, 0], [400, 0], [400, 400], [0, 400]], face)).toBe(true)
    expect(roomCoversFace([[0, 0], [200, 0], [200, 200], [0, 200]], face)).toBe(false)
    expect(roomCoversFace([[1000, 1000], [1400, 1000], [1400, 1400], [1000, 1400]], face)).toBe(false)
  })
})

describe('detectFloorGaps', () => {
  it('reports the gap in a nearly closed loop and the floor it would create', () => {
    const walls = square()
    walls[3] = w('w4', 0, 400, 0, 40) // 40cm short of the start corner
    const gaps = detectFloorGaps(walls)
    expect(gaps).toHaveLength(1)
    const gap = gaps[0]!
    expect(gap.distance).toBeCloseTo(40)
    expect(gap.from.x).toBeCloseTo(0)
    expect(['w1', 'w4']).toContain(gap.fromWallId)
    expect(gap.face.area).toBeCloseTo(160000, -1)
  })

  it('offers a bridge onto the body of another wall (T-gap)', () => {
    const walls = [...square().slice(0, 3), w('w4', 0, 400, 0, 50)]
    const gaps = detectFloorGaps(walls)
    expect(gaps.some((g) => g.distance > 30 && g.distance < 60)).toBe(true)
  })

  it('offers nothing when already closed, when too far, or when no floor would form', () => {
    expect(detectFloorGaps(square())).toHaveLength(0)
    const far = square()
    far[3] = w('w4', 0, 400, 0, 400 - 200)
    expect(detectFloorGaps(far, { maxGap: 150 })).toHaveLength(0)
    expect(detectFloorGaps([w('a', 0, 0, 300, 0), w('b', 340, 0, 600, 0)])).toHaveLength(0)
  })

  it('never proposes a bridge that crosses another wall', () => {
    const walls = [...square().slice(0, 3), w('w4', 0, 400, 0, 60), w('mid', -50, 30, 50, 30)]
    const gaps = detectFloorGaps(walls)
    expect(gaps.every((g) => !(g.from.y > 30 && g.to.y < 30))).toBe(true)
  })
})
