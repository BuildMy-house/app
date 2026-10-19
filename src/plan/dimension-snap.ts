import type { Point } from './geometry'
import { snapWallSegment, type AngleLock, type SnapMode, type UnitSystem } from './snap-math'

/**
 * Pure snapping + geometry for the dimension-line tool. Mirrors the wall
 * tool's solver (`snapWallSegment`) and adds point anchors (wall endpoints,
 * wall midpoints, room corners) so a dimension can be measured from real
 * geometry instead of free-floating grid points.
 */

export type AnchorKind = 'endpoint' | 'midpoint' | 'corner'

export interface DimensionAnchor {
  point: Point
  kind: AnchorKind
}

export interface DimensionAnchorSource {
  walls: ReadonlyArray<{ xStart: number; yStart: number; xEnd: number; yEnd: number }>
  rooms: ReadonlyArray<{ points: ReadonlyArray<readonly [number, number]> }>
}

/** All snap anchors for the dimension tool: wall ends, wall midpoints, room corners. */
export function collectDimensionAnchors(source: DimensionAnchorSource): DimensionAnchor[] {
  const anchors: DimensionAnchor[] = []
  for (const w of source.walls) {
    anchors.push({ point: { x: w.xStart, y: w.yStart }, kind: 'endpoint' })
    anchors.push({ point: { x: w.xEnd, y: w.yEnd }, kind: 'endpoint' })
    anchors.push({ point: { x: (w.xStart + w.xEnd) / 2, y: (w.yStart + w.yEnd) / 2 }, kind: 'midpoint' })
  }
  for (const room of source.rooms) {
    for (const [x, y] of room.points) anchors.push({ point: { x, y }, kind: 'corner' })
  }
  return anchors
}

const KIND_PRIORITY: Record<AnchorKind, number> = { endpoint: 0, corner: 1, midpoint: 2 }

/**
 * Nearest anchor within `margin` of the cursor. On a tie in distance (an
 * endpoint and a room corner on the same spot) the more specific kind wins:
 * endpoint, then corner, then midpoint.
 */
export function nearestAnchor(
  cursor: Point,
  anchors: ReadonlyArray<DimensionAnchor>,
  margin: number,
): DimensionAnchor | null {
  let best: DimensionAnchor | null = null
  let bestDist = Infinity
  for (const a of anchors) {
    const d = Math.hypot(a.point.x - cursor.x, a.point.y - cursor.y)
    if (d > margin) continue
    if (
      d < bestDist - 1e-9 ||
      (Math.abs(d - bestDist) <= 1e-9 && best !== null && KIND_PRIORITY[a.kind] < KIND_PRIORITY[best.kind])
    ) {
      best = a
      bestDist = d
    }
  }
  return best
}

export interface DimensionPointInput {
  cursor: Point
  /** First point already placed; null while choosing the first point. */
  start: Point | null
  unit: UnitSystem
  mode: SnapMode
  fine?: boolean
  typedLengthCm?: number | null
  anchors: ReadonlyArray<DimensionAnchor>
  anchorMargin: number
  /** Grid fallback for the first point (null = no grid snapping). */
  gridSnap?: ((p: Point) => Point) | null
  prev?: { lengthMajor: boolean; angleLockedDeg: number | null } | null
}

export interface DimensionPointResult {
  point: Point
  /** Anchor the point snapped onto (null when length/angle/grid-snapped or free). */
  anchor: DimensionAnchor | null
  lengthCm: number
  angleDeg: number
  lengthLock: 'none' | 'step' | 'major'
  angleLock: AngleLock
  state: { lengthMajor: boolean; angleLockedDeg: number | null }
}

/**
 * Resolve where a dimension point lands. Order: Alt (mode 'off') is raw;
 * otherwise an anchor within the margin wins (except when a typed length is
 * pending, because an exact value must not turn into "snap to whatever is
 * nearby"); the first point then falls back to the grid; the second point
 * falls back to the wall solver's length/angle steps from the first point.
 */
export function resolveDimensionPoint(input: DimensionPointInput): DimensionPointResult {
  const { cursor, start, mode } = input
  const typed = input.typedLengthCm ?? null
  const fresh = { lengthMajor: false, angleLockedDeg: null }

  if (mode !== 'off' && typed === null) {
    const anchor = nearestAnchor(cursor, input.anchors, input.anchorMargin)
    if (anchor) {
      const base = start ?? anchor.point
      return {
        point: { x: anchor.point.x, y: anchor.point.y },
        anchor,
        lengthCm: Math.hypot(anchor.point.x - base.x, anchor.point.y - base.y),
        angleDeg: normalizeDegrees((Math.atan2(anchor.point.y - base.y, anchor.point.x - base.x) * 180) / Math.PI),
        lengthLock: 'none',
        angleLock: 'none',
        state: fresh,
      }
    }
  }

  if (start === null) {
    const point = mode === 'off' || !input.gridSnap ? { x: cursor.x, y: cursor.y } : input.gridSnap(cursor)
    return { point, anchor: null, lengthCm: 0, angleDeg: 0, lengthLock: 'none', angleLock: 'none', state: fresh }
  }

  const snap = snapWallSegment({
    start,
    cursor,
    unit: input.unit,
    mode,
    fine: input.fine,
    typedLengthCm: typed,
    prev: input.prev ?? null,
  })
  return {
    point: snap.end,
    anchor: null,
    lengthCm: snap.lengthCm,
    angleDeg: snap.angleDeg,
    lengthLock: snap.lengthLock === 'fine' ? 'step' : snap.lengthLock,
    angleLock: snap.angleLock,
    state: snap.state,
  }
}

function normalizeDegrees(deg: number): number {
  return ((deg % 360) + 360) % 360
}

// ── Offset step ─────────────────────────────────────────────────────────────

/** Signed perpendicular distance of `cursor` from the start→end line
 *  (positive = left of the direction of travel in plan coordinates). */
export function perpendicularOffset(start: Point, end: Point, cursor: Point): number {
  const dx = end.x - start.x
  const dy = end.y - start.y
  const len = Math.hypot(dx, dy)
  if (len === 0) return 0
  return ((cursor.x - start.x) * -dy + (cursor.y - start.y) * dx) / len
}

/**
 * Offset for the third step: perpendicular distance of the cursor, stepped
 * (10 cm / 4 in; 1 cm / 1 in when `fine`), and exactly 0 inside a small dead
 * zone around the measured line so "no offset" is easy to hit. Alt (mode
 * 'off') returns the raw distance.
 */
export function snapDimensionOffset(
  rawOffset: number,
  opts: { unit: UnitSystem; mode: SnapMode; fine?: boolean; deadZoneCm?: number },
): number {
  if (opts.mode === 'off') return rawOffset
  const step = opts.fine ? (opts.unit === 'inch' ? 2.54 : 1) : opts.unit === 'inch' ? 10.16 : 10
  const dead = opts.deadZoneCm ?? step / 2
  if (Math.abs(rawOffset) < dead) return 0
  return Math.round(rawOffset / step) * step
}

// ── Geometry shared by the renderer and hit-testing ─────────────────────────

export interface DimensionGeometryInput {
  xStart: number
  yStart: number
  xEnd: number
  yEnd: number
  offset: number
}

export interface DimensionGeometry {
  /** Measured points, pushed out by `offset` along the left normal. */
  lineStart: Point
  lineEnd: Point
  lineMid: Point
  /** Extension lines from each measured point to the dimension line (empty when offset is 0). */
  extensions: Array<[Point, Point]>
  lengthCm: number
}

export function dimensionGeometry(dim: DimensionGeometryInput): DimensionGeometry {
  const dx = dim.xEnd - dim.xStart
  const dy = dim.yEnd - dim.yStart
  const len = Math.hypot(dx, dy)
  const nx = len === 0 ? 0 : -dy / len
  const ny = len === 0 ? 0 : dx / len
  const ox = nx * dim.offset
  const oy = ny * dim.offset
  const a: Point = { x: dim.xStart, y: dim.yStart }
  const b: Point = { x: dim.xEnd, y: dim.yEnd }
  const lineStart = { x: a.x + ox, y: a.y + oy }
  const lineEnd = { x: b.x + ox, y: b.y + oy }
  return {
    lineStart,
    lineEnd,
    lineMid: { x: (lineStart.x + lineEnd.x) / 2, y: (lineStart.y + lineEnd.y) / 2 },
    extensions: dim.offset === 0 ? [] : [[a, lineStart], [b, lineEnd]],
    lengthCm: len,
  }
}

function distToSegment(p: Point, a: Point, b: Point): number {
  const dx = b.x - a.x
  const dy = b.y - a.y
  const len2 = dx * dx + dy * dy
  if (len2 === 0) return Math.hypot(p.x - a.x, p.y - a.y)
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2))
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy))
}

/**
 * Distance from `point` to the dimension as drawn: the offset line, its
 * or its extension lines — whichever is closest — so the thing the user sees
 * is the thing they can click, at any offset. The hidden baseline is NOT
 * hittable when offset != 0 (it usually overlaps a wall).
 */
export function distanceToDimension(point: Point, dim: DimensionGeometryInput): number {
  const g = dimensionGeometry(dim)
  let best = distToSegment(point, g.lineStart, g.lineEnd)
  for (const [p, q] of g.extensions) best = Math.min(best, distToSegment(point, p, q))
  return best
}
