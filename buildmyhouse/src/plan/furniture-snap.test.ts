import { describe, it, expect } from 'vitest'
import {
  snapFurniturePlacement,
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

  it('snaps onto a vertical wall from either side', () => {
    const r = snapFurniturePlacement({ walls: [wallV], point: { x: 58, y: 0 }, depthCm: 20, magnetismEnabled: true })
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
    // Closest is the vertical wall (x≈50), snaps to x=55, y≈5.
    expect(near.x).toBeCloseTo(55)
    expect(Math.abs(near.angleDeg)).toBeCloseTo(90)
  })

  it('respects the snap distance threshold', () => {
    const justOutside = FURNITURE_SNAP_DISTANCE_CM + 1
    const r = snapFurniturePlacement({ walls: [wallH], point: { x: 50, y: justOutside }, depthCm: 10, magnetismEnabled: true })
    expect(r.y).toBeCloseTo(justOutside)
  })
})
