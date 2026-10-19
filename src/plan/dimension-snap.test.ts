import { describe, expect, it } from 'vitest'
import {
  collectDimensionAnchors,
  dimensionGeometry,
  distanceToDimension,
  nearestAnchor,
  perpendicularOffset,
  resolveDimensionPoint,
  snapDimensionOffset,
} from './dimension-snap'

const anchors = collectDimensionAnchors({
  walls: [{ xStart: 0, yStart: 0, xEnd: 400, yEnd: 0 }],
  rooms: [{ points: [[400, 0], [400, 300], [0, 300]] }],
})

describe('collectDimensionAnchors / nearestAnchor', () => {
  it('collects wall endpoints, wall midpoints and room corners', () => {
    expect(anchors.filter((a) => a.kind === 'endpoint')).toHaveLength(2)
    expect(anchors.filter((a) => a.kind === 'midpoint')).toEqual([{ point: { x: 200, y: 0 }, kind: 'midpoint' }])
    expect(anchors.filter((a) => a.kind === 'corner')).toHaveLength(3)
  })

  it('returns the nearest anchor within the margin, null outside it', () => {
    expect(nearestAnchor({ x: 203, y: 4 }, anchors, 10)?.kind).toBe('midpoint')
    expect(nearestAnchor({ x: 100, y: 100 }, anchors, 10)).toBeNull()
  })

  it('prefers endpoint over a coincident room corner', () => {
    expect(nearestAnchor({ x: 400, y: 0 }, anchors, 10)?.kind).toBe('endpoint')
  })
})

describe('resolveDimensionPoint', () => {
  const base = { unit: 'cm' as const, anchors, anchorMargin: 10 }

  it('first point snaps to an anchor when near one', () => {
    const r = resolveDimensionPoint({ ...base, cursor: { x: 3, y: -2 }, start: null, mode: 'soft' })
    expect(r.point).toEqual({ x: 0, y: 0 })
    expect(r.anchor?.kind).toBe('endpoint')
  })

  it('first point falls back to the grid, and to raw with Alt', () => {
    const grid = (p: { x: number; y: number }) => ({ x: Math.round(p.x / 25) * 25, y: Math.round(p.y / 25) * 25 })
    const far = { x: 130, y: 112 }
    expect(resolveDimensionPoint({ ...base, cursor: far, start: null, mode: 'soft', gridSnap: grid }).point).toEqual({ x: 125, y: 100 })
    expect(resolveDimensionPoint({ ...base, cursor: far, start: null, mode: 'off', gridSnap: grid }).point).toEqual(far)
  })

  it('second point snaps length to 10 cm steps and angle to the axis', () => {
    const r = resolveDimensionPoint({ ...base, cursor: { x: 1000 + 47, y: 1004 }, start: { x: 1000 - 1000, y: 1000 }, mode: 'soft' })
    expect(r.anchor).toBeNull()
    expect(r.angleLock).toBe('axis')
    expect(r.point.y).toBe(1000)
    expect(r.lengthCm % 10).toBeCloseTo(0, 6)
  })

  it('second point snaps onto an anchor, reporting the real distance', () => {
    const r = resolveDimensionPoint({ ...base, cursor: { x: 398, y: 302 }, start: { x: 0, y: 300 }, mode: 'soft' })
    expect(r.point).toEqual({ x: 400, y: 300 })
    expect(r.lengthCm).toBe(400)
  })

  it('a typed length wins over anchors and runs along the cursor direction', () => {
    const r = resolveDimensionPoint({
      ...base, cursor: { x: 398, y: 2 }, start: { x: 0, y: 0 }, mode: 'soft', typedLengthCm: 250,
    })
    expect(r.anchor).toBeNull()
    expect(r.lengthCm).toBe(250)
    expect(r.point.x).toBeCloseTo(250, 6)
  })

  it('Shift (hard) locks 15 degree angles', () => {
    const r = resolveDimensionPoint({ ...base, cursor: { x: 300, y: 90 }, start: { x: 0, y: 0 }, mode: 'hard' })
    expect(r.anchor).toBeNull()
    expect(r.angleDeg % 15).toBeCloseTo(0, 6)
  })

  it('Alt returns the raw cursor and ignores anchors', () => {
    const r = resolveDimensionPoint({ ...base, cursor: { x: 3, y: 2 }, start: null, mode: 'off' })
    expect(r.point).toEqual({ x: 3, y: 2 })
    expect(r.anchor).toBeNull()
  })
})

describe('offset step', () => {
  it('measures signed perpendicular distance', () => {
    const a = { x: 0, y: 0 }
    const b = { x: 100, y: 0 }
    expect(perpendicularOffset(a, b, { x: 50, y: 40 })).toBe(40)
    expect(perpendicularOffset(a, b, { x: 50, y: -40 })).toBe(-40)
    expect(perpendicularOffset(a, a, { x: 5, y: 5 })).toBe(0)
  })

  it('steps by 10 cm with a dead zone at zero; fine steps 1 cm; Alt is raw', () => {
    expect(snapDimensionOffset(3, { unit: 'cm', mode: 'soft' })).toBe(0)
    expect(snapDimensionOffset(47, { unit: 'cm', mode: 'soft' })).toBe(50)
    expect(snapDimensionOffset(-47, { unit: 'cm', mode: 'soft' })).toBe(-50)
    expect(snapDimensionOffset(47.4, { unit: 'cm', mode: 'soft', fine: true })).toBe(47)
    expect(snapDimensionOffset(47.4, { unit: 'cm', mode: 'off' })).toBe(47.4)
    expect(snapDimensionOffset(30.48, { unit: 'inch', mode: 'soft' })).toBeCloseTo(30.48, 6)
  })
})

describe('dimension geometry and hit distance', () => {
  const dim = { xStart: 0, yStart: 0, xEnd: 200, yEnd: 0, offset: 50 }

  it('pushes the line out by the offset with extension lines', () => {
    const g = dimensionGeometry(dim)
    expect(g.lineStart).toEqual({ x: 0, y: 50 })
    expect(g.lineEnd).toEqual({ x: 200, y: 50 })
    expect(g.extensions).toHaveLength(2)
    expect(g.lengthCm).toBe(200)
    expect(dimensionGeometry({ ...dim, offset: 0 }).extensions).toEqual([])
  })

  it('hits the drawn offset line, not the hidden baseline', () => {
    expect(distanceToDimension({ x: 100, y: 50 }, dim)).toBe(0)
    expect(distanceToDimension({ x: 100, y: 0 }, dim)).toBeCloseTo(50, 6)
    expect(distanceToDimension({ x: 100, y: 0 }, { ...dim, offset: 0 })).toBe(0)
  })

  it('hits the extension lines', () => {
    expect(distanceToDimension({ x: 0, y: 25 }, dim)).toBe(0)
  })
})
