import { describe, it, expect } from 'vitest'
import {
  snapFurniturePlacement,
  snapFurnitureRotation,
  closestPointOnSegment,
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
