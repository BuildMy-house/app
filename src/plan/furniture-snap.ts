import type { Point } from './geometry'
import { distance } from './geometry'

/**
 * Furniture placement snapping (ticket U9).
 *
 * When magnetism is on, a placement point snaps to the nearest wall: the piece
 * aligns to the wall and its projected footprint clears the wall face.
 * Without magnetism the raw point is returned unchanged.
 *
 * Works identically for 2D plan clicks and 3D floor clicks because both feed a
 * model-space point.
 */

export interface WallLike {
  id?: string
  xStart: number
  yStart: number
  xEnd: number
  yEnd: number
  thickness?: number
  /** Radians, non-zero = round wall (approximated by chords for clearance). */
  arcExtent?: number | null
  /** Level the wall sits on; null = ground floor. Optional so plain walls
   *  (and existing callers) stay valid. */
  levelRef?: string | null
}

export interface FurnitureSnapInput {
  walls: ReadonlyArray<WallLike>
  point: Point
  /** Furniture dimensions and current orientation, in cm/degrees. */
  widthCm?: number
  depthCm: number
  angleDeg?: number
  magnetismEnabled: boolean
  /** Level the furniture sits on. Omit (undefined) to consider every wall;
   *  when provided, only same-level walls participate — so a first-floor
   *  piece never snaps to (or is pushed by) a ground-floor wall. */
  levelRef?: string | null
  /** Wall id the furniture was snapped to at the start of this drag frame, if
   *  any — used only to widen the release threshold for THAT specific wall
   *  (hysteresis). Does not affect snapping onto a different/new wall, which
   *  always uses the normal FURNITURE_SNAP_DISTANCE_CM entry threshold. */
  previousWallId?: string | null
}

export interface FurnitureSnapResult {
  x: number
  y: number
  angleDeg: number
  /** Matched wall id when snapped within range, null otherwise. */
  wallRef: string | null
  /** Along-wall offset (cm) from the wall start to the nearest point, null if no snap. */
  wallOffset: number | null
}

/** Max distance (cm) from a wall within which a placement magnetizes to it. */
export const FURNITURE_SNAP_DISTANCE_CM = 25
/** Once flush against a wall, require clearing this larger radius (not the
 *  entry radius) before the snap releases — prevents an in-progress drag
 *  away from the wall from being continuously re-glued to it. */
export const FURNITURE_SNAP_RELEASE_DISTANCE_CM = FURNITURE_SNAP_DISTANCE_CM * 2
const FURNITURE_ROTATION_SNAP_ANGLE_DEG = 8

export function closestPointOnSegment(
  p: Point,
  a: Point,
  b: Point,
): { point: Point; t: number } {
  const dx = b.x - a.x
  const dy = b.y - a.y
  const lengthSq = dx * dx + dy * dy
  if (lengthSq === 0) return { point: { x: a.x, y: a.y }, t: 0 }
  let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / lengthSq
  t = Math.max(0, Math.min(1, t))
  return { point: { x: a.x + t * dx, y: a.y + t * dy }, t }
}

function normalizeAngle180(deg: number): number {
  let a = deg % 360
  if (a > 180) a -= 360
  if (a < -180) a += 360
  return a
}

/** Walls that can interact with the furniture: all of them when the caller
 *  omitted `levelRef`, otherwise only same-level walls (null = ground). */
function wallsFor(input: Pick<FurnitureSnapInput, 'walls' | 'levelRef'>): ReadonlyArray<WallLike> {
  if (input.levelRef === undefined) return input.walls
  return input.walls.filter((wall) => (wall.levelRef ?? null) === input.levelRef)
}

export function snapFurniturePlacement(input: FurnitureSnapInput): FurnitureSnapResult {
  const { point, depthCm, magnetismEnabled } = input
  const walls = wallsFor(input)
  if (walls.length === 0) {
    return { x: point.x, y: point.y, angleDeg: 0, wallRef: null, wallOffset: null }
  }
  // Hard anti-clip constraint runs regardless of magnetism; only the
  // flush-alignment convenience snap below is magnetism-gated.
  if (!magnetismEnabled) {
    const separated = separateFurnitureFromWalls(point, walls, input.widthCm ?? depthCm, depthCm, input.angleDeg ?? 0)
    return { x: separated.x, y: separated.y, angleDeg: input.angleDeg ?? 0, wallRef: null, wallOffset: null }
  }

  let best: { dist: number; point: Point; wall: WallLike; t: number; side: number; angleDeg: number } | null = null
  for (const wall of walls) {
    const a = { x: wall.xStart, y: wall.yStart }
    const b = { x: wall.xEnd, y: wall.yEnd }
    const seg = closestPointOnSegment(point, a, b)
    const dx = b.x - a.x
    const dy = b.y - a.y
    const len = Math.hypot(dx, dy) || 1
    const nx = -dy / len
    const ny = dx / len
    const side = (point.x - seg.point.x) * nx + (point.y - seg.point.y) * ny >= 0 ? 1 : -1
    const wallAngle = (Math.atan2(dy, dx) * 180) / Math.PI
    const currentAngle = input.angleDeg ?? wallAngle
    const angleDeg = [0, 90, 180, 270]
      .map((turn) => normalizeAngle180(wallAngle + turn))
      .sort((a, b) => Math.abs(normalizeAngle180(a - currentAngle)) - Math.abs(normalizeAngle180(b - currentAngle)))[0]!
    const relative = ((angleDeg - wallAngle) * Math.PI) / 180
    const width = input.widthCm ?? depthCm
    const halfExtent = (Math.abs(Math.sin(relative)) * width + Math.abs(Math.cos(relative)) * depthCm) / 2
    const endExtent = Math.hypot(width / 2, depthCm / 2)
    const clearance = distance(point, seg.point) - (seg.t === 0 || seg.t === 1 ? endExtent : halfExtent) - (wall.thickness ?? 0) / 2
    if (!best || Math.abs(clearance) < Math.abs(best.dist)) {
      best = { dist: clearance, point: seg.point, wall, t: seg.t, side, angleDeg }
    }
  }

  const threshold = input.previousWallId && best?.wall.id === input.previousWallId
    ? FURNITURE_SNAP_RELEASE_DISTANCE_CM
    : FURNITURE_SNAP_DISTANCE_CM
  if (!best || best.dist > threshold) {
    const clear = separateFurnitureFromWalls(point, walls, input.widthCm ?? depthCm, depthCm, input.angleDeg ?? 0)
    return { x: clear.x, y: clear.y, angleDeg: 0, wallRef: null, wallOffset: null }
  }

  const a = { x: best.wall.xStart, y: best.wall.yStart }
  const b = { x: best.wall.xEnd, y: best.wall.yEnd }
  const dx = b.x - a.x
  const dy = b.y - a.y
  const len = Math.hypot(dx, dy) || 1
  const nx = -dy / len
  const ny = dx / len
  const wallAngle = (Math.atan2(dy, dx) * 180) / Math.PI
  const side = best.side
  const angleDeg = best.angleDeg
  const relative = ((angleDeg - wallAngle) * Math.PI) / 180
  const halfExtent = (Math.abs(Math.sin(relative)) * (input.widthCm ?? depthCm) + Math.abs(Math.cos(relative)) * depthCm) / 2
  const offset = halfExtent + (best.wall.thickness ?? 0) / 2
  const x = best.point.x + nx * side * offset
  const y = best.point.y + ny * side * offset
  const separated = separateFurnitureFromWalls(
    { x, y }, walls, input.widthCm ?? depthCm, depthCm, angleDeg,
  )

  const wallRef = best.wall.id ?? null
  const wallOffset = best.t * len

  return { x: separated.x, y: separated.y, angleDeg, wallRef, wallOffset }
}

/** Penetration (cm) tolerated before furniture counts as overlapping a wall —
 *  absorbs floating-point error from the exact-flush push-out. */
export const WALL_OVERLAP_EPSILON_CM = 1e-6

interface WallRect {
  cx: number
  cy: number
  tx: number
  ty: number
  halfLength: number
  halfThickness: number
}

function wallRect(wall: WallLike): WallRect | null {
  const dx = wall.xEnd - wall.xStart
  const dy = wall.yEnd - wall.yStart
  const length = Math.hypot(dx, dy)
  if (!(length > 0)) return null
  return {
    cx: (wall.xStart + wall.xEnd) / 2,
    cy: (wall.yStart + wall.yEnd) / 2,
    tx: dx / length,
    ty: dy / length,
    halfLength: length / 2,
    halfThickness: Math.max(0, wall.thickness ?? 0) / 2,
  }
}

/** Round walls (arcExtent != 0) are approximated by chords so a curved wall's
 *  bulge is as solid as a straight one. Straight walls pass through as-is. */
function straightPieces(wall: WallLike & { arcExtent?: number | null }): WallLike[] {
  const a = wall.arcExtent
  if (typeof a !== 'number' || !Number.isFinite(a) || a === 0) return [wall]
  const dx = wall.xEnd - wall.xStart
  const dy = wall.yEnd - wall.yStart
  const d = Math.hypot(dx, dy)
  if (!(d > 0)) return [wall]
  const sagitta = (d / 2) * Math.tan(a / 4)
  if (!Number.isFinite(sagitta) || Math.abs(sagitta) < 1e-9) return [wall]
  const nx = dy / d
  const ny = -dx / d
  const mx = (wall.xStart + wall.xEnd) / 2 + nx * sagitta
  const my = (wall.yStart + wall.yEnd) / 2 + ny * sagitta
  const radius = (d * d / 4 + sagitta * sagitta) / (2 * Math.abs(sagitta))
  const cx = mx - nx * Math.sign(sagitta) * radius
  const cy = my - ny * Math.sign(sagitta) * radius
  const a0 = Math.atan2(wall.yStart - cy, wall.xStart - cx)
  const cross = (wall.xStart - cx) * (my - cy) - (wall.yStart - cy) * (mx - cx)
  const dir = cross >= 0 ? 1 : -1
  const steps = Math.max(2, Math.ceil(Math.abs(a) / (Math.PI / 12)))
  const pieces: WallLike[] = []
  let prev = { x: wall.xStart, y: wall.yStart }
  for (let i = 1; i <= steps; i++) {
    const next = i === steps
      ? { x: wall.xEnd, y: wall.yEnd }
      : { x: cx + radius * Math.cos(a0 + (dir * Math.abs(a) * i) / steps), y: cy + radius * Math.sin(a0 + (dir * Math.abs(a) * i) / steps) }
    pieces.push({ ...wall, xStart: prev.x, yStart: prev.y, xEnd: next.x, yEnd: next.y, arcExtent: null })
    prev = next
  }
  return pieces
}

interface Footprint {
  x: number
  y: number
  ux: number
  uy: number
  halfW: number
  halfD: number
}

/** Smallest SAT push (unit axis * distance) separating the footprint from the
 *  wall rectangle, or null when they do not overlap. */
function wallPush(f: Footprint, w: WallRect): { x: number; y: number } | null {
  const vx = -f.uy
  const vy = f.ux
  const nx = -w.ty
  const ny = w.tx
  // Wall normal first: on ties the push goes straight out of the wall face
  // rather than sliding along it.
  const axes: Array<[number, number]> = [[nx, ny], [w.tx, w.ty], [f.ux, f.uy], [vx, vy]]
  const dx = f.x - w.cx
  const dy = f.y - w.cy
  let best: { x: number; y: number; depth: number } | null = null
  for (const [ax, ay] of axes) {
    const rf = Math.abs(f.ux * ax + f.uy * ay) * f.halfW + Math.abs(vx * ax + vy * ay) * f.halfD
    const rw = Math.abs(w.tx * ax + w.ty * ay) * w.halfLength + Math.abs(nx * ax + ny * ay) * w.halfThickness
    const dist = dx * ax + dy * ay
    const depth = rf + rw - Math.abs(dist)
    if (depth <= WALL_OVERLAP_EPSILON_CM) return null
    if (!best || depth < best.depth - 1e-9) {
      const sign = dist < 0 ? -1 : 1
      best = { x: ax * sign * depth, y: ay * sign * depth, depth }
    }
  }
  return best ? { x: best.x, y: best.y } : null
}

function footprintAt(x: number, y: number, widthCm: number, depthCm: number, angleDeg: number): Footprint {
  const rad = (angleDeg * Math.PI) / 180
  return { x, y, ux: Math.cos(rad), uy: Math.sin(rad), halfW: widthCm / 2, halfD: depthCm / 2 }
}

function rectsFor(walls: ReadonlyArray<WallLike>): WallRect[] {
  const rects: WallRect[] = []
  for (const wall of walls) {
    for (const piece of straightPieces(wall)) {
      const rect = wallRect(piece)
      if (rect) rects.push(rect)
    }
  }
  return rects
}

function overlapsAny(f: Footprint, rects: ReadonlyArray<WallRect>): boolean {
  return rects.some((rect) => wallPush(f, rect) !== null)
}

/** True when a furniture footprint (centre, size, angle) penetrates any wall in
 *  `walls`. Callers filter walls by level first. */
export function furnitureOverlapsWalls(
  point: Point,
  walls: ReadonlyArray<WallLike>,
  widthCm: number,
  depthCm: number,
  angleDeg: number,
): boolean {
  return overlapsAny(footprintAt(point.x, point.y, widthCm, depthCm, angleDeg), rectsFor(walls))
}

const RELAX_PASSES = 32
const SEARCH_STEP_CM = 5
const SEARCH_DIRECTIONS = 32

/**
 * Hard anti-clip: returns the nearest position at which the footprint no
 * longer overlaps any wall. Walls are solid oriented rectangles (length x
 * thickness), so corners, thin and rotated walls all behave the same. Pushes
 * relax wall by wall; if that cannot settle (tight corner, piece bigger than
 * its room) an expanding ring search finds the closest free spot, which always
 * exists beyond the walls' bounding box. Non-finite input is returned as-is.
 */
export function separateFurnitureFromWalls(
  point: Point,
  walls: ReadonlyArray<WallLike>,
  widthCm: number,
  depthCm: number,
  angleDeg: number,
): Point {
  if (![point.x, point.y, widthCm, depthCm, angleDeg].every(Number.isFinite)) return { x: point.x, y: point.y }
  const rects = rectsFor(walls)
  if (rects.length === 0) return { x: point.x, y: point.y }
  const at = (x: number, y: number) => footprintAt(x, y, widthCm, depthCm, angleDeg)

  let { x, y } = point
  for (let pass = 0; pass < RELAX_PASSES; pass++) {
    let moved = false
    for (const rect of rects) {
      const push = wallPush(at(x, y), rect)
      if (push) {
        x += push.x
        y += push.y
        moved = true
      }
    }
    if (!moved) return { x, y }
  }
  if (!overlapsAny(at(x, y), rects)) return { x, y }

  let reach = 0
  for (const rect of rects) {
    reach = Math.max(reach, Math.hypot(rect.cx - point.x, rect.cy - point.y) + rect.halfLength + rect.halfThickness)
  }
  const maxRadius = reach + Math.hypot(widthCm, depthCm) + SEARCH_STEP_CM
  for (let radius = SEARCH_STEP_CM; radius <= maxRadius + SEARCH_STEP_CM; radius += SEARCH_STEP_CM) {
    for (let i = 0; i < SEARCH_DIRECTIONS; i++) {
      const theta = (2 * Math.PI * i) / SEARCH_DIRECTIONS
      const cx = point.x + Math.cos(theta) * radius
      const cy = point.y + Math.sin(theta) * radius
      if (!overlapsAny(at(cx, cy), rects)) return { x: cx, y: cy }
    }
  }
  return { x: point.x, y: point.y }
}

export function snapFurnitureRotation(input: Omit<FurnitureSnapInput, 'magnetismEnabled'>): FurnitureSnapResult {
  const { point, widthCm = input.depthCm, depthCm, angleDeg = 0 } = input
  const walls = wallsFor(input)
  let best: { wall: WallLike; point: Point; dist: number; side: number } | null = null
  for (const wall of walls) {
    const a = { x: wall.xStart, y: wall.yStart }
    const b = { x: wall.xEnd, y: wall.yEnd }
    const projection = closestPointOnSegment(point, a, b)
    const projected = projection.point
    const dx = b.x - a.x
    const dy = b.y - a.y
    const len = Math.hypot(dx, dy) || 1
    const nx = -dy / len
    const ny = dx / len
    const side = (point.x - projected.x) * nx + (point.y - projected.y) * ny >= 0 ? 1 : -1
    const wallAngle = (Math.atan2(dy, dx) * 180) / Math.PI
    const relative = ((angleDeg - wallAngle) * Math.PI) / 180
    const extent = (Math.abs(Math.sin(relative)) * widthCm + Math.abs(Math.cos(relative)) * depthCm) / 2
    const tangentExtent = (Math.abs(Math.cos(relative)) * widthCm + Math.abs(Math.sin(relative)) * depthCm) / 2
    const endpointExtent = Math.hypot(extent, tangentExtent)
    const dist = distance(point, projected) - (projection.t === 0 || projection.t === 1 ? endpointExtent : extent) - (wall.thickness ?? 0) / 2
    if (!best || Math.abs(dist) < Math.abs(best.dist)) best = { wall, point: projected, dist, side }
  }
  if (!best || best.dist > FURNITURE_SNAP_DISTANCE_CM) {
    const clear = separateFurnitureFromWalls(point, walls, widthCm, depthCm, angleDeg)
    return { x: clear.x, y: clear.y, angleDeg, wallRef: null, wallOffset: null }
  }

  const a = { x: best.wall.xStart, y: best.wall.yStart }
  const b = { x: best.wall.xEnd, y: best.wall.yEnd }
  const dx = b.x - a.x
  const dy = b.y - a.y
  const len = Math.hypot(dx, dy) || 1
  const nx = -dy / len
  const ny = dx / len
  const wallAngle = (Math.atan2(dy, dx) * 180) / Math.PI
  const alignedAngle = [0, 90, 180, 270]
    .map((turn) => normalizeAngle180(wallAngle + turn))
    .sort((a, b) => Math.abs(normalizeAngle180(a - angleDeg)) - Math.abs(normalizeAngle180(b - angleDeg)))[0]!
  const snapped = Math.abs(normalizeAngle180(alignedAngle - angleDeg)) <= FURNITURE_ROTATION_SNAP_ANGLE_DEG
  const resultAngle = snapped ? alignedAngle : angleDeg
  const relative = ((resultAngle - wallAngle) * Math.PI) / 180
  const extent = (Math.abs(Math.sin(relative)) * widthCm + Math.abs(Math.cos(relative)) * depthCm) / 2
  const offset = extent + (best.wall.thickness ?? 0) / 2
  const separated = separateFurnitureFromWalls(
    { x: best.point.x + nx * best.side * offset, y: best.point.y + ny * best.side * offset },
    walls, widthCm, depthCm, resultAngle,
  )
  return {
    x: separated.x,
    y: separated.y,
    angleDeg: resultAngle,
    wallRef: best.wall.id ?? null,
    wallOffset: null,
  }
}
