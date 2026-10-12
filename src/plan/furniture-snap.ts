import type { Point } from './geometry'
import { distance } from './geometry'
import { footprintAt, nearestFreeSpot, overlapsAnySolid, settleAmongSolids, wallSolids } from './wall-solids'
import { insidePolygon, resolveFootprint, type RoomLike } from './furniture-room-fit'
import { wallsBlockingAt } from './wall-height'

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
  /** Radians, non-zero = round wall (exact conservative arc band for clearance). */
  arcExtent?: number | null
  /** Wall top (cm above its level's floor); unset = the default wall height. */
  height?: number | null
  heightAtEnd?: number | null
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
  /** Underside of the piece above its level's floor (cm). A wall whose top is at
   *  or below this does not obstruct the piece (see wall-height.ts); omit for
   *  floor-standing pieces. */
  elevationCm?: number
  /** Wall id the furniture was snapped to at the start of this drag frame, if
   *  any — used only to widen the release threshold for THAT specific wall
   *  (hysteresis). Does not affect snapping onto a different/new wall, which
   *  always uses the normal FURNITURE_SNAP_DISTANCE_CM entry threshold. */
  previousWallId?: string | null
  /** The home's rooms. When given, a piece inside a room is kept inside it: if
   *  it cannot fit anywhere in that room the raw `point` is returned untouched
   *  (never a spot outside the room) and the store rejects the edit. Omit only
   *  for callers with no room context — they get the plain wall push-out. */
  rooms?: ReadonlyArray<RoomLike>
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
 *  omitted `levelRef`, otherwise only same-level walls (null = ground); walls
 *  the piece hangs above (`elevationCm`) are left out. */
function wallsFor(input: Pick<FurnitureSnapInput, 'walls' | 'levelRef' | 'elevationCm'>): ReadonlyArray<WallLike> {
  const sameLevel = input.levelRef === undefined
    ? input.walls
    : input.walls.filter((wall) => (wall.levelRef ?? null) === input.levelRef)
  return wallsBlockingAt(sameLevel, input.elevationCm)
}

/** Rooms that can hold the piece: same-level ones (all when `levelRef` is omitted). */
function roomsFor(input: Pick<FurnitureSnapInput, 'rooms' | 'levelRef'>): RoomLike[] | null {
  if (!input.rooms) return null
  return input.rooms.filter((room) =>
    room.points.length >= 3 && (input.levelRef === undefined || (room.levelRef ?? null) === input.levelRef))
}

/** Clears a position of the walls (see resolveFootprint); null when the piece is
 *  too large for the room it is in. */
function clearOfWalls(
  input: Pick<FurnitureSnapInput, 'rooms' | 'levelRef'>,
  walls: ReadonlyArray<WallLike>,
  point: Point,
  widthCm: number,
  depthCm: number,
  angleDeg: number,
): Point | null {
  const rooms = roomsFor(input)
  if (!rooms) return separateFurnitureFromWalls(point, walls, widthCm, depthCm, angleDeg)
  const result = resolveFootprint(wallSolids(walls), rooms, point, widthCm, depthCm, angleDeg)
  return result.fits ? { x: result.x, y: result.y } : null
}

/** Like clearOfWalls for a magnetized (wall-flush) candidate position: null too
 *  when the candidate would leave the room the raw point is in — magnetizing to a
 *  wall must never carry a piece out of its room. */
function clearWithinRoom(
  input: Pick<FurnitureSnapInput, 'rooms' | 'levelRef'>,
  walls: ReadonlyArray<WallLike>,
  raw: Point,
  candidate: Point,
  widthCm: number,
  depthCm: number,
  angleDeg: number,
): Point | null {
  const cleared = clearOfWalls(input, walls, candidate, widthCm, depthCm, angleDeg)
  const rooms = roomsFor(input)
  if (!cleared || !rooms) return cleared
  const holding = rooms.filter((room) => insidePolygon(raw, room.points))
  if (holding.length > 0 && !holding.some((room) => insidePolygon(cleared, room.points))) return null
  return cleared
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
    const separated = clearOfWalls(input, walls, point, input.widthCm ?? depthCm, depthCm, input.angleDeg ?? 0) ?? point
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
    const clear = clearOfWalls(input, walls, point, input.widthCm ?? depthCm, depthCm, input.angleDeg ?? 0) ?? point
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
  const separated = clearWithinRoom(input, walls, point, { x, y }, input.widthCm ?? depthCm, depthCm, angleDeg)
  if (!separated) {
    const clear = clearOfWalls(input, walls, point, input.widthCm ?? depthCm, depthCm, input.angleDeg ?? 0) ?? point
    return { x: clear.x, y: clear.y, angleDeg: input.angleDeg ?? 0, wallRef: null, wallOffset: null }
  }

  const wallRef = best.wall.id ?? null
  const wallOffset = best.t * len

  return { x: separated.x, y: separated.y, angleDeg, wallRef, wallOffset }
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
  return overlapsAnySolid(footprintAt(point.x, point.y, widthCm, depthCm, angleDeg), wallSolids(walls))
}

/**
 * Hard anti-clip for a piece that is NOT known to be inside a room: the nearest
 * position at which the footprint no longer overlaps any wall — relaxation, and
 * if that cannot settle (tight corner) the closest free spot by ring search.
 * Non-finite input is returned as-is. Pieces inside a room go through
 * resolveFootprint (furniture-room-fit.ts) instead, which never moves a piece
 * out of its room.
 */
export function separateFurnitureFromWalls(
  point: Point,
  walls: ReadonlyArray<WallLike>,
  widthCm: number,
  depthCm: number,
  angleDeg: number,
): Point {
  const solids = wallSolids(walls)
  const settled = settleAmongSolids(solids, point, widthCm, depthCm, angleDeg)
  if (settled.settled) return { x: settled.x, y: settled.y }
  return nearestFreeSpot(solids, point, widthCm, depthCm, angleDeg)
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
    const clear = clearOfWalls(input, walls, point, widthCm, depthCm, angleDeg) ?? point
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
  const separated = clearWithinRoom(
    input, walls, point,
    { x: best.point.x + nx * best.side * offset, y: best.point.y + ny * best.side * offset },
    widthCm, depthCm, resultAngle,
  )
  if (!separated) {
    const clear = clearOfWalls(input, walls, point, widthCm, depthCm, angleDeg) ?? point
    return { x: clear.x, y: clear.y, angleDeg, wallRef: null, wallOffset: null }
  }
  return {
    x: separated.x,
    y: separated.y,
    angleDeg: resultAngle,
    wallRef: best.wall.id ?? null,
    wallOffset: null,
  }
}
