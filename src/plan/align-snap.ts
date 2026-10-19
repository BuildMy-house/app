import type { Point } from './geometry'
import type { AngleLock } from './snap-math'

/**
 * Alignment ("smart guide") snapping for the wall tool: the cursor point
 * softly lines up horizontally / vertically with existing vertices (wall
 * endpoints, room corners) even when it is not near them. Pure math, shared
 * by the live preview and the click commit so what you see is what is placed.
 *
 * Priority (strongest first): direct vertex > guide intersection > single
 * guide > (caller's) length / angle steps > grid. A single guide never bends
 * a locked angle: on a locked direction it only slides the end along the ray.
 */

/** Screen-pixel radius within which a guide captures the cursor. */
export const ALIGN_CAPTURE_PX = 9
/** Wider radius that keeps an already-captured guide (hysteresis, no flicker). */
export const ALIGN_RELEASE_PX = 13
/** A ray nearly parallel to a guide line crosses it far away: ignore those. */
const MIN_RAY_COMPONENT = 0.3
const MIN_RAY_LENGTH_CM = 1
const SAME_POINT_CM = 0.5

export interface AlignBounds {
  minX: number
  maxX: number
  minY: number
  maxY: number
}

export interface AlignIndex {
  /** Unique vertices sorted by x then y. */
  byX: Point[]
  /** The same vertices sorted by y then x. */
  byY: Point[]
}

export interface AlignGuide {
  /** 'x' = vertical guide line x = value; 'y' = horizontal guide line y = value. */
  axis: 'x' | 'y'
  value: number
  /** Vertex the guide originates from (marked on screen). */
  source: Point
}

export interface AlignState {
  x: number | null
  y: number | null
}

/** 'vertex' = onto a vertex itself, 'intersection' = two guides cross, 'guide' = one guide. */
export type AlignKind = 'none' | 'guide' | 'intersection' | 'vertex'

export interface AlignResult {
  end: Point
  guides: AlignGuide[]
  kind: AlignKind
  state: AlignState
}

export interface AlignInput {
  index: AlignIndex
  start: Point
  /** Raw cursor in model space. */
  cursor: Point
  /** End produced by the angle/length solver (used when a direction is locked). */
  end: Point
  angleLock: AngleLock
  /** Direction of the solved segment in degrees (atan2 convention). */
  angleDeg: number
  /** Hard (Shift) lock: the angle is the contract, guides only slide along it. */
  hard: boolean
  /** View scale: screen px per model cm. Capture radius is constant in px. */
  scale: number
  /** Only vertices inside these bounds (model space) take part; null = all. */
  bounds: AlignBounds | null
  prev: AlignState | null
}

export const NO_ALIGN: AlignState = { x: null, y: null }

export function buildAlignIndex(points: Iterable<Point>): AlignIndex {
  const seen = new Set<string>()
  const unique: Point[] = []
  for (const p of points) {
    if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) continue
    const key = `${Math.round(p.x * 100)},${Math.round(p.y * 100)}`
    if (seen.has(key)) continue
    seen.add(key)
    unique.push({ x: p.x, y: p.y })
  }
  return {
    byX: [...unique].sort((a, b) => a.x - b.x || a.y - b.y),
    byY: [...unique].sort((a, b) => a.y - b.y || a.x - b.x),
  }
}

/** World-unit capture radius at a view scale (constant on screen). */
export function alignRadiusCm(scale: number, px = ALIGN_CAPTURE_PX): number {
  return px / (scale > 0 ? scale : 1)
}

function lowerBound(list: Point[], axis: 'x' | 'y', value: number): number {
  let lo = 0
  let hi = list.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (list[mid]![axis] < value) lo = mid + 1
    else hi = mid
  }
  return lo
}

function inBounds(p: Point, b: AlignBounds | null): boolean {
  return b === null || (p.x >= b.minX && p.x <= b.maxX && p.y >= b.minY && p.y <= b.maxY)
}

function samePoint(a: Point, b: Point): boolean {
  return Math.abs(a.x - b.x) <= SAME_POINT_CM && Math.abs(a.y - b.y) <= SAME_POINT_CM
}

interface AxisCandidate {
  value: number
  /** |value - probe| along the axis; smaller is better. */
  delta: number
  source: Point
}

/**
 * Best guide value on one axis near `probe`: the vertex whose coordinate is
 * closest (a previously captured value is held out to the release radius and
 * favoured). Ties on the same value keep the source closest to `near`.
 */
function bestOnAxis(
  list: Point[],
  axis: 'x' | 'y',
  probe: number,
  near: Point,
  capture: number,
  release: number,
  prevValue: number | null,
  start: Point,
  bounds: AlignBounds | null,
): AxisCandidate | null {
  const other = axis === 'x' ? 'y' : 'x'
  let best: AxisCandidate | null = null
  let bestScore = Infinity
  for (let i = lowerBound(list, axis, probe - release); i < list.length; i++) {
    const v = list[i]!
    if (v[axis] > probe + release) break
    if (!inBounds(v, bounds) || samePoint(v, start)) continue
    const delta = Math.abs(v[axis] - probe)
    const held = prevValue !== null && Math.abs(v[axis] - prevValue) < 1e-6
    if (delta > (held ? release : capture)) continue
    const score = held ? delta * 0.5 : delta
    const better =
      score < bestScore - 1e-9 ||
      (Math.abs(score - bestScore) <= 1e-9 &&
        best !== null &&
        Math.abs(v[other] - near[other]) < Math.abs(best.source[other] - near[other]))
    if (better) {
      best = { value: v[axis], delta, source: v }
      bestScore = score
    }
  }
  return best
}

function hasVertexAt(index: AlignIndex, p: Point): boolean {
  for (let i = lowerBound(index.byX, 'x', p.x - SAME_POINT_CM); i < index.byX.length; i++) {
    const v = index.byX[i]!
    if (v.x > p.x + SAME_POINT_CM) break
    if (Math.abs(v.y - p.y) <= SAME_POINT_CM) return true
  }
  return false
}

function cosSin(angleDeg: number): { cos: number; sin: number } {
  const rad = (angleDeg * Math.PI) / 180
  const q = angleDeg / 90
  if (Math.abs(q - Math.round(q)) < 1e-9) {
    const k = (((Math.round(q) % 4) + 4) % 4)
    return [{ cos: 1, sin: 0 }, { cos: 0, sin: 1 }, { cos: -1, sin: 0 }, { cos: 0, sin: -1 }][k]!
  }
  return { cos: Math.cos(rad), sin: Math.sin(rad) }
}

function guideFor(axis: 'x' | 'y', c: AxisCandidate): AlignGuide {
  return { axis, value: c.value, source: { x: c.source.x, y: c.source.y } }
}

/**
 * Resolve alignment guides for the segment end. Returns kind 'none' (end is
 * returned untouched) when nothing captures. The caller must skip this
 * entirely for Alt (snapping off) and typed lengths.
 */
export function solveAlignment(input: AlignInput): AlignResult {
  const { index, start, cursor, end, angleLock, angleDeg, scale, bounds } = input
  const prev = input.prev ?? NO_ALIGN
  const none: AlignResult = { end, guides: [], kind: 'none', state: NO_ALIGN }
  if (index.byX.length === 0) return none

  const capture = alignRadiusCm(scale, ALIGN_CAPTURE_PX)
  const release = alignRadiusCm(scale, ALIGN_RELEASE_PX)
  const locked = input.hard || angleLock !== 'none'

  const xs = bestOnAxis(index.byX, 'x', cursor.x, cursor, capture, release, prev.x, start, bounds)
  const ys = bestOnAxis(index.byY, 'y', cursor.y, cursor, capture, release, prev.y, start, bounds)

  // Two guides crossing (or a vertex itself) beat angle steps, but never the
  // Shift hard lock.
  if (xs && ys && !input.hard) {
    const at = { x: xs.value, y: ys.value }
    return {
      end: at,
      guides: [guideFor('x', xs), guideFor('y', ys)],
      kind: hasVertexAt(index, at) ? 'vertex' : 'intersection',
      state: { x: xs.value, y: ys.value },
    }
  }

  if (!locked) {
    if (xs) {
      return { end: { x: xs.value, y: cursor.y }, guides: [guideFor('x', xs)], kind: 'guide', state: { x: xs.value, y: null } }
    }
    if (ys) {
      return { end: { x: cursor.x, y: ys.value }, guides: [guideFor('y', ys)], kind: 'guide', state: { x: null, y: ys.value } }
    }
    return none
  }

  // Locked direction: guides only slide the end along the ray.
  const { cos, sin } = cosSin(angleDeg)
  const tCursor = (cursor.x - start.x) * cos + (cursor.y - start.y) * sin
  if (tCursor <= 0) return none
  const probe = { x: start.x + tCursor * cos, y: start.y + tCursor * sin }
  const rx = Math.abs(cos) >= MIN_RAY_COMPONENT
    ? bestOnAxis(index.byX, 'x', probe.x, probe, capture, release, prev.x, start, bounds)
    : null
  const ry = Math.abs(sin) >= MIN_RAY_COMPONENT
    ? bestOnAxis(index.byY, 'y', probe.y, probe, capture, release, prev.y, start, bounds)
    : null
  const tx = rx ? (rx.value - start.x) / cos : null
  const ty = ry ? (ry.value - start.y) / sin : null
  const okX = tx !== null && tx >= MIN_RAY_LENGTH_CM
  const okY = ty !== null && ty >= MIN_RAY_LENGTH_CM
  if (!okX && !okY) return none

  const at = (t: number): Point => ({ x: start.x + t * cos, y: start.y + t * sin })
  if (okX && okY && Math.abs(tx! - ty!) <= SAME_POINT_CM) {
    const e = at(tx!)
    return {
      end: e,
      guides: [guideFor('x', rx!), guideFor('y', ry!)],
      kind: hasVertexAt(index, e) ? 'vertex' : 'intersection',
      state: { x: rx!.value, y: ry!.value },
    }
  }
  const useX = okX && (!okY || rx!.delta <= ry!.delta)
  if (useX) {
    // Snap the guide's own coordinate exactly (no float residue on the line).
    const e = at(tx!)
    return { end: { x: rx!.value, y: e.y }, guides: [guideFor('x', rx!)], kind: 'guide', state: { x: rx!.value, y: null } }
  }
  const e = at(ty!)
  return { end: { x: e.x, y: ry!.value }, guides: [guideFor('y', ry!)], kind: 'guide', state: { x: null, y: ry!.value } }
}
