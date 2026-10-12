import { describe, it, expect } from 'vitest'
import {
  snapFurniturePlacement,
  snapFurnitureRotation,
  closestPointOnSegment,
  furnitureOverlapsWalls,
  separateFurnitureFromWalls,
  FURNITURE_SNAP_DISTANCE_CM,
} from './furniture-snap'
import type { WallLike } from './furniture-snap'

const wallH: WallLike = { xStart: 0, yStart: 0, xEnd: 100, yEnd: 0 }
const wallV: WallLike = { xStart: 50, yStart: -50, xEnd: 50, yEnd: 50 }

describe('closestPointOnSegment', () => {
  it('clamps to the nearest endpoint past the ends', () => {
    expect(closestPointOnSegment({ x: -10, y: 0 }, { x: 0, y: 0 }, { x: 100, y: 0 }).point).toEqual({ x: 0, y: 0 })
    expect(closestPointOnSegment({ x: 200, y: 0 }, { x: 0, y: 0 }, { x: 100, y: 0 }).point).toEqual({ x: 100, y: 0 })
  })
  it('projects onto the interior', () => {
    expect(closestPointOnSegment({ x: 40, y: 30 }, { x: 0, y: 0 }, { x: 100, y: 0 }).point).toEqual({ x: 40, y: 0 })
  })
})

describe('snapFurniturePlacement', () => {
  it('returns the raw point when magnetism is off', () => {
    const r = snapFurniturePlacement({ walls: [wallH], point: { x: 50, y: 40 }, depthCm: 40, magnetismEnabled: false })
    expect(r).toEqual({ x: 50, y: 40, angleDeg: 0, wallRef: null, wallOffset: null })
  })

  it('still pushes an overlapping footprint out of the wall when magnetism is off', () => {
    const r = snapFurniturePlacement({
      walls: [{ xStart: 0, yStart: 0, xEnd: 200, yEnd: 0, thickness: 10 }],
      point: { x: 100, y: 100 },
      widthCm: 300,
      depthCm: 20,
      angleDeg: 90,
      magnetismEnabled: false,
    })
    // Half-extent along y at 90° = width/2 = 150, + half wall 5 → flush-out at 155.
    // No forced alignment or wallRef — but no overlap either.
    expect(r.x).toBe(100)
    expect(r.y).toBe(155)
    expect(r.angleDeg).toBe(90)
    expect(r.wallRef).toBeNull()
    expect(r.wallOffset).toBeNull()
  })

  it('returns the raw point when no wall is within range', () => {
    const r = snapFurniturePlacement({ walls: [wallH], point: { x: 50, y: 200 }, depthCm: 40, magnetismEnabled: true })
    expect(r).toEqual({ x: 50, y: 200, angleDeg: 0, wallRef: null, wallOffset: null })
  })

  it('snaps onto a horizontal wall, offset by half depth and aligned', () => {
    const r = snapFurniturePlacement({ walls: [wallH], point: { x: 50, y: 12 }, depthCm: 40, magnetismEnabled: true })
    // 12cm is within range → snaps to wall y=0 then offset 20cm on +y side.
    expect(r.x).toBeCloseTo(50)
    expect(r.y).toBeCloseTo(20)
    // Wall runs along +x → angle 0.
    expect(r.angleDeg).toBeCloseTo(0)
    // No wall id → wallRef null, but wallOffset should be computed (t * len).
    expect(r.wallRef).toBeNull()
    expect(r.wallOffset).toBeCloseTo(50) // midpoint of 0→100
  })

  it('chooses the closest of four wall alignments and clears wall thickness', () => {
    const r = snapFurniturePlacement({
      walls: [{ ...wallH, thickness: 10 }],
      point: { x: 50, y: 5 },
      widthCm: 80,
      depthCm: 40,
      angleDeg: 90,
      magnetismEnabled: true,
    })
    expect(r.angleDeg).toBe(90)
    expect(r.y).toBe(45) // width edge (40) + half wall (5)
  })

  it('snaps onto a vertical wall from either side', () => {
    const r = snapFurniturePlacement({ walls: [wallV], point: { x: 58, y: 0 }, depthCm: 20, angleDeg: 90, magnetismEnabled: true })
    expect(r.x).toBeCloseTo(60) // wall x=50 + half depth on +x side
    expect(r.y).toBeCloseTo(0)
    // Vertical wall runs along +y → angle 90.
    expect(Math.abs(r.angleDeg)).toBeCloseTo(90)
  })

  it('returns wallRef and wallOffset when wall has an id', () => {
    const wallWithId: WallLike = { id: 'wall-1', xStart: 0, yStart: 0, xEnd: 100, yEnd: 0 }
    const r = snapFurniturePlacement({ walls: [wallWithId], point: { x: 30, y: 10 }, depthCm: 20, magnetismEnabled: true })
    expect(r.wallRef).toBe('wall-1')
    expect(r.wallOffset).toBeCloseTo(30) // t=0.3, len=100
  })

  it('returns wallRef null for walls without id', () => {
    const r = snapFurniturePlacement({ walls: [wallH], point: { x: 50, y: 10 }, depthCm: 20, magnetismEnabled: true })
    expect(r.wallRef).toBeNull()
    expect(typeof r.wallOffset).toBe('number')
  })

  it('uses the closest wall when several exist', () => {
    const near = snapFurniturePlacement({
      walls: [wallH, wallV],
      point: { x: 51, y: 5 },
      depthCm: 10,
      magnetismEnabled: true,
    })
    // The footprint touches the horizontal wall and is separated from the
    // intersecting vertical wall without passing through either.
    expect(near).toMatchObject({ x: 55, y: 5, angleDeg: 0 })
  })

  it('respects the snap distance threshold', () => {
    const justOutside = FURNITURE_SNAP_DISTANCE_CM + 1 + 5 // 5cm half-depth
    const r = snapFurniturePlacement({ walls: [wallH], point: { x: 50, y: justOutside }, depthCm: 10, magnetismEnabled: true })
    expect(r.y).toBeCloseTo(justOutside)
  })

  it('snaps an overlapping wide footprint even when its center is beyond the snap range', () => {
    const result = snapFurniturePlacement({
      walls: [{ id: 'wall-1', xStart: 0, yStart: 0, xEnd: 200, yEnd: 0, thickness: 10 }],
      point: { x: 100, y: 40 },
      widthCm: 100,
      depthCm: 20,
      angleDeg: 90,
      magnetismEnabled: true,
    })

    expect(result).toMatchObject({ x: 100, y: 55, angleDeg: 90, wallRef: 'wall-1', wallOffset: 100 })
  })

  it('pulls an overlapping footprint back out even when it crossed deeply through a wall', () => {
    const result = snapFurniturePlacement({
      walls: [{ xStart: 0, yStart: 0, xEnd: 200, yEnd: 0, thickness: 10 }],
      point: { x: 100, y: 100 },
      widthCm: 300,
      depthCm: 20,
      angleDeg: 90,
      magnetismEnabled: true,
    })
    const rotated = snapFurnitureRotation({
      walls: [{ xStart: 0, yStart: 0, xEnd: 200, yEnd: 0, thickness: 10 }],
      point: { x: 100, y: 100 },
      widthCm: 300,
      depthCm: 20,
      angleDeg: 90,
    })

    expect(result.y).toBe(155)
    expect(rotated.y).toBe(155)
  })

  it('clears intersecting walls at corners and at wall endpoints', () => {
    const cornerWalls = [
      { xStart: 0, yStart: 0, xEnd: 200, yEnd: 0, thickness: 10 },
      { xStart: 0, yStart: 0, xEnd: 0, yEnd: 200, thickness: 10 },
    ]
    const corner = snapFurniturePlacement({
      walls: cornerWalls,
      point: { x: 30, y: 30 },
      widthCm: 100,
      depthCm: 20,
      angleDeg: 90,
      magnetismEnabled: true,
    })
    const endpoint = snapFurniturePlacement({
      walls: [{ ...wallH, thickness: 10 }],
      point: { x: -49, y: 0 },
      widthCm: 100,
      depthCm: 20,
      angleDeg: 0,
      magnetismEnabled: true,
    })

    expect(corner).toMatchObject({ x: 15, y: 55 })
    expect(endpoint.y).toBe(15)
  })
})

describe('snap hysteresis (previousWallId)', () => {
  const wallA = { id: 'wall-a', xStart: 0, yStart: 0, xEnd: 100, yEnd: 0 }

  it('holds the snap beyond the entry threshold while dragging away from the same wall', () => {
    // depth 20 → flush at y=10 (half depth from wall centerline);
    // clearance at y=50 is 40 (> 25 entry, < 50 release)
    const r = snapFurniturePlacement({ walls: [wallA], point: { x: 50, y: 50 }, depthCm: 20, magnetismEnabled: true, previousWallId: 'wall-a' })
    expect(r.y).toBe(10)
    expect(r.wallRef).toBe('wall-a')
  })

  it('releases once beyond the release threshold', () => {
    // clearance at y=75 is 65 (> 50 release)
    const r = snapFurniturePlacement({ walls: [wallA], point: { x: 50, y: 75 }, depthCm: 20, magnetismEnabled: true, previousWallId: 'wall-a' })
    expect(r).toEqual({ x: 50, y: 75, angleDeg: 0, wallRef: null, wallOffset: null })
  })

  it('uses the normal entry threshold for a different wall than the previous one', () => {
    const walls = [
      wallA,
      { id: 'wall-b', xStart: 130, yStart: -50, xEnd: 130, yEnd: 50 },
    ]
    // Closest wall is wall-b at clearance 30 (> 25 entry, < 50 release):
    // hysteresis on wall-a must not lower wall-b's entry bar.
    const r = snapFurniturePlacement({ walls, point: { x: 170, y: 0 }, depthCm: 20, magnetismEnabled: true, previousWallId: 'wall-a' })
    expect(r).toEqual({ x: 170, y: 0, angleDeg: 0, wallRef: null, wallOffset: null })
  })
})

describe('snapFurnitureRotation', () => {
  it.each([[1, 0], [91, 90], [181, 180], [271, -90]])('snaps rotation %i° to wall alignment %i°', (angleDeg, expected) => {
    const r = snapFurnitureRotation({
      walls: [{ ...wallH, thickness: 10 }],
      point: { x: 50, y: 15 },
      widthCm: 40,
      depthCm: 20,
      angleDeg,
    })
    expect(r.angleDeg).toBe(expected)
    expect(r.y).toBeCloseTo(expected === 90 || expected === -90 ? 25 : 15)
  })

  it('does not snap rotation when no wall is close to the furniture edge', () => {
    const r = snapFurnitureRotation({ walls: [wallH], point: { x: 50, y: 100 }, widthCm: 40, depthCm: 20, angleDeg: 3 })
    expect(r).toMatchObject({ x: 50, y: 100, angleDeg: 3, wallRef: null })
  })
})

describe('wide footprint clearance (rotated and unrotated)', () => {
  const vertical = { id: 'wall-v', xStart: 50, yStart: -100, xEnd: 50, yEnd: 100, thickness: 10 }

  it('clears an unrotated wide piece whose centre is past the snap range', () => {
    // At angle 0 the width spans the wall normal, so half width (150) +
    // half thickness (5) must reach x = 205 even though the centre (150) is
    // 100cm from the wall — far beyond the 25cm entry threshold.
    const withMagnetism = snapFurniturePlacement({
      walls: [vertical],
      point: { x: 150, y: 0 },
      widthCm: 300,
      depthCm: 20,
      angleDeg: 0,
      magnetismEnabled: true,
    })
    expect(withMagnetism).toMatchObject({ x: 205, y: 0, angleDeg: 0, wallRef: 'wall-v', wallOffset: 100 })

    // Anti-clip alone (magnetism off) must reach the same clear position.
    const withoutMagnetism = snapFurniturePlacement({
      walls: [vertical],
      point: { x: 150, y: 0 },
      widthCm: 300,
      depthCm: 20,
      angleDeg: 0,
      magnetismEnabled: false,
    })
    expect(withoutMagnetism).toMatchObject({ x: 205, y: 0, wallRef: null, wallOffset: null })
  })
})

describe('level filtering (levelRef)', () => {
  // Same geometry as the wide unrotated case: overlapping, past snap range.
  const upperWall = { id: 'wall-upper', xStart: 50, yStart: -100, xEnd: 50, yEnd: 100, thickness: 10, levelRef: 'lvl-1' }
  const input = {
    point: { x: 150, y: 0 },
    widthCm: 300,
    depthCm: 20,
    angleDeg: 0,
  }

  it('ignores an overlapping wall on another level', () => {
    const r = snapFurniturePlacement({ walls: [upperWall], ...input, magnetismEnabled: true, levelRef: null })
    expect(r).toEqual({ x: 150, y: 0, angleDeg: 0, wallRef: null, wallOffset: null })
  })

  it('never pushes a footprint out of another level’s wall when magnetism is off', () => {
    const r = snapFurniturePlacement({ walls: [upperWall], ...input, magnetismEnabled: false, levelRef: null })
    expect(r).toEqual({ x: 150, y: 0, angleDeg: 0, wallRef: null, wallOffset: null })
  })

  it('snaps and clears against a same-level wall', () => {
    const r = snapFurniturePlacement({ walls: [upperWall], ...input, magnetismEnabled: true, levelRef: 'lvl-1' })
    expect(r).toMatchObject({ x: 205, wallRef: 'wall-upper', wallOffset: 100 })
  })

  it('treats a missing wall levelRef as the ground floor', () => {
    const groundWall = { ...upperWall, levelRef: undefined }
    expect(snapFurniturePlacement({ walls: [groundWall], ...input, magnetismEnabled: true, levelRef: null }).wallRef).toBe('wall-upper')
    expect(snapFurniturePlacement({ walls: [upperWall], ...input, magnetismEnabled: true, levelRef: null }).wallRef).toBeNull()
  })

  it('considers every wall when the caller omits levelRef', () => {
    const r = snapFurniturePlacement({ walls: [upperWall], ...input, magnetismEnabled: true })
    expect(r).toMatchObject({ x: 205, wallRef: 'wall-upper' })
  })

  it('applies the same filter to snapFurnitureRotation', () => {
    const mismatch = snapFurnitureRotation({ walls: [upperWall], ...input, levelRef: null })
    expect(mismatch).toMatchObject({ x: 150, y: 0, wallRef: null })

    const match = snapFurnitureRotation({ walls: [upperWall], ...input, levelRef: 'lvl-1' })
    expect(match).toMatchObject({ x: 205, wallRef: 'wall-upper' })
  })
})

describe('separateFurnitureFromWalls robustness', () => {
  const box = (thickness = 10): WallLike[] => [
    { xStart: 0, yStart: 0, xEnd: 300, yEnd: 0, thickness },
    { xStart: 300, yStart: 0, xEnd: 300, yEnd: 300, thickness },
    { xStart: 300, yStart: 300, xEnd: 0, yEnd: 300, thickness },
    { xStart: 0, yStart: 300, xEnd: 0, yEnd: 0, thickness },
  ]

  it('leaves a clear footprint untouched', () => {
    expect(separateFurnitureFromWalls({ x: 150, y: 150 }, box(), 60, 60, 30)).toEqual({ x: 150, y: 150 })
  })

  it('clears a corner without re-entering either wall', () => {
    const p = separateFurnitureFromWalls({ x: 2, y: 2 }, box(), 80, 40, 45)
    expect(furnitureOverlapsWalls(p, box(), 80, 40, 45)).toBe(false)
  })

  it('clears thin, zero-thickness and rotated walls', () => {
    for (const thickness of [0, 0.1, 2]) {
      const walls: WallLike[] = [{ xStart: 0, yStart: 0, xEnd: 200, yEnd: 120, thickness }]
      const p = separateFurnitureFromWalls({ x: 100, y: 60 }, walls, 50, 30, 17)
      expect(furnitureOverlapsWalls(p, walls, 50, 30, 17), `thickness ${thickness}`).toBe(false)
    }
  })

  it('treats round walls as solid along their bulge', () => {
    const arc: WallLike = { xStart: 0, yStart: 0, xEnd: 200, yEnd: 0, thickness: 10, arcExtent: Math.PI }
    // Chord midpoint bulges to y = -100 (engine convention: positive = ccw); sit on the bulge.
    const bulge = { x: 100, y: -100 }
    const p = separateFurnitureFromWalls(bulge, [arc], 40, 40, 0)
    expect(p).not.toEqual(bulge)
    expect(furnitureOverlapsWalls(p, [arc], 40, 40, 0)).toBe(false)
  })

  it('finds free space for a piece larger than its room (no infinite push, no NaN)', () => {
    const p = separateFurnitureFromWalls({ x: 150, y: 150 }, box(), 500, 500, 33)
    expect(Number.isFinite(p.x) && Number.isFinite(p.y)).toBe(true)
    expect(furnitureOverlapsWalls(p, box(), 500, 500, 33)).toBe(false)
  })

  it('returns non-finite input unchanged instead of producing NaN', () => {
    expect(separateFurnitureFromWalls({ x: Number.NaN, y: 5 }, box(), 50, 50, 0).y).toBe(5)
    expect(separateFurnitureFromWalls({ x: 1, y: 2 }, box(), Number.POSITIVE_INFINITY, 50, 0)).toEqual({ x: 1, y: 2 })
  })

  it('ignores degenerate zero-length walls', () => {
    expect(separateFurnitureFromWalls({ x: 5, y: 5 }, [{ xStart: 5, yStart: 5, xEnd: 5, yEnd: 5, thickness: 10 }], 20, 20, 0)).toEqual({ x: 5, y: 5 })
  })

  it('property: the result never overlaps any wall, for random layouts', () => {
    let seed = 20261012
    const rand = () => {
      seed = (seed * 1664525 + 1013904223) >>> 0
      return seed / 2 ** 32
    }
    const between = (lo: number, hi: number) => lo + rand() * (hi - lo)
    for (let run = 0; run < 400; run++) {
      const walls: WallLike[] = Array.from({ length: 1 + Math.floor(rand() * 6) }, () => ({
        xStart: between(-300, 300),
        yStart: between(-300, 300),
        xEnd: between(-300, 300),
        yEnd: between(-300, 300),
        thickness: rand() < 0.2 ? 0 : between(0.5, 40),
        arcExtent: rand() < 0.25 ? between(-Math.PI, Math.PI) : null,
      }))
      const w = between(5, 400)
      const d = between(5, 400)
      const angle = between(-180, 180)
      const start = { x: between(-350, 350), y: between(-350, 350) }
      const p = separateFurnitureFromWalls(start, walls, w, d, angle)
      expect(Number.isFinite(p.x) && Number.isFinite(p.y), `run ${run} finite`).toBe(true)
      expect(furnitureOverlapsWalls(p, walls, w, d, angle), `run ${run} overlaps`).toBe(false)
    }
  })

  it('snapFurniturePlacement never returns an overlapping position, magnetism on or off', () => {
    const walls = box(12).map((wall, i) => ({ ...wall, id: `w${i}` }))
    for (const magnetismEnabled of [true, false]) {
      for (const { x, y } of [{ x: 0, y: 0 }, { x: 150, y: 3 }, { x: 298, y: 150 }, { x: 150, y: 150 }, { x: -40, y: 150 }]) {
        const r = snapFurniturePlacement({ walls, point: { x, y }, widthCm: 90, depthCm: 45, angleDeg: 20, magnetismEnabled })
        const angle = r.wallRef ? r.angleDeg : 20
        expect(furnitureOverlapsWalls(r, walls, 90, 45, angle), `${x},${y} magnetism ${magnetismEnabled}`).toBe(false)
      }
    }
  })
})

describe('snapping with rooms (a piece never leaves the room it is in)', () => {
  const walls: WallLike[] = [
    { id: 'n', xStart: 0, yStart: 0, xEnd: 300, yEnd: 0, thickness: 10 },
    { id: 'e', xStart: 300, yStart: 0, xEnd: 300, yEnd: 300, thickness: 10 },
    { id: 's', xStart: 300, yStart: 300, xEnd: 0, yEnd: 300, thickness: 10 },
    { id: 'w', xStart: 0, yStart: 300, xEnd: 0, yEnd: 0, thickness: 10 },
  ]
  const rooms = [{ id: 'room-1', name: 'Den', points: [[0, 0], [300, 0], [300, 300], [0, 300]] as Array<[number, number]> }]

  it('returns the raw point (not a spot outside the walls) for a piece too large for the room', () => {
    for (const magnetismEnabled of [true, false]) {
      const point = { x: 150, y: 150 }
      const r = snapFurniturePlacement({ walls, rooms, point, widthCm: 400, depthCm: 80, angleDeg: 0, magnetismEnabled })
      expect({ x: r.x, y: r.y }, `magnetism ${magnetismEnabled}`).toEqual(point)
      const rot = snapFurnitureRotation({ walls, rooms, point, widthCm: 400, depthCm: 80, angleDeg: 30 })
      expect({ x: rot.x, y: rot.y }, `rotation, magnetism ${magnetismEnabled}`).toEqual(point)
    }
  })

  it('magnetizing to a wall never carries a piece out of the room it is in (corridor regression)', () => {
    const corridorWalls: WallLike[] = [
      { id: 'n', xStart: -100, yStart: -40, xEnd: 100, yEnd: -40, thickness: 10 },
      { id: 'e', xStart: 100, yStart: -40, xEnd: 100, yEnd: 40, thickness: 10 },
      { id: 's', xStart: 100, yStart: 40, xEnd: -100, yEnd: 40, thickness: 10 },
      { id: 'w', xStart: -100, yStart: 40, xEnd: -100, yEnd: -40, thickness: 10 },
    ]
    const corridor = [{ id: 'c', name: 'Corridor', points: [[-100, -40], [100, -40], [100, 40], [-100, 40]] as Array<[number, number]> }]
    const point = { x: 0, y: 0 }
    for (const angleDeg of [30, 60, 79, 85, 90]) {
      const rot = snapFurnitureRotation({ walls: corridorWalls, rooms: corridor, point, widthCm: 150, depthCm: 40, angleDeg })
      expect(Math.abs(rot.y), `rotation ${angleDeg}`).toBeLessThanOrEqual(40)
      const place = snapFurniturePlacement({ walls: corridorWalls, rooms: corridor, point, widthCm: 150, depthCm: 40, angleDeg, magnetismEnabled: true })
      expect(Math.abs(place.y), `placement ${angleDeg}`).toBeLessThanOrEqual(40)
    }
  })

  it('still clears the walls INSIDE the room for a piece that fits', () => {
    const r = snapFurniturePlacement({ walls, rooms, point: { x: 20, y: 150 }, widthCm: 60, depthCm: 60, angleDeg: 0, magnetismEnabled: false })
    expect(r.x).toBeCloseTo(5 + 30, 6)
    expect(furnitureOverlapsWalls(r, walls, 60, 60, 0)).toBe(false)
  })

  it('without rooms the plain push-out (and ring search) still applies', () => {
    const r = snapFurniturePlacement({ walls, point: { x: 150, y: 150 }, widthCm: 400, depthCm: 80, angleDeg: 0, magnetismEnabled: false })
    expect(furnitureOverlapsWalls(r, walls, 400, 80, 0)).toBe(false)
  })

  it('only rooms on the same level count', () => {
    const upstairs = [{ ...rooms[0]!, levelRef: 'level-2' }]
    const point = { x: 150, y: 150 }
    const r = snapFurniturePlacement({ walls, rooms: upstairs, point, widthCm: 400, depthCm: 80, angleDeg: 0, magnetismEnabled: false, levelRef: null })
    // The ground-floor piece is not in the first-floor room: falls back to the plain push-out.
    expect(furnitureOverlapsWalls(r, walls, 400, 80, 0)).toBe(false)
  })
})
