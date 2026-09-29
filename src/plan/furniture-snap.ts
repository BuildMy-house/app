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
}

export interface FurnitureSnapInput {
  walls: ReadonlyArray<WallLike>
  point: Point
  /** Furniture dimensions and current orientation, in cm/degrees. */
  widthCm?: number
  depthCm: number
  angleDeg?: number
  magnetismEnabled: boolean
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
export const FURNITURE_ROTATION_SNAP_ANGLE_DEG = 8

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

export function snapFurniturePlacement(input: FurnitureSnapInput): FurnitureSnapResult {
  const { walls, point, depthCm, magnetismEnabled } = input
  if (!magnetismEnabled || walls.length === 0) {
    return { x: point.x, y: point.y, angleDeg: 0, wallRef: null, wallOffset: null }
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

  if (!best || best.dist > FURNITURE_SNAP_DISTANCE_CM) {
    return { x: point.x, y: point.y, angleDeg: 0, wallRef: null, wallOffset: null }
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

function separateFurnitureFromWalls(
  point: Point,
  walls: ReadonlyArray<WallLike>,
  widthCm: number,
  depthCm: number,
  angleDeg: number,
): Point {
  let { x, y } = point
  // ponytail: cap relaxation at 8 sweeps; this handles room corners without
  // spending unbounded work on malformed or tightly intersecting wall knots.
  for (let pass = 0; pass < 8; pass++) {
    let moved = false
    for (const wall of walls) {
      const dx = wall.xEnd - wall.xStart
      const dy = wall.yEnd - wall.yStart
      const length = Math.hypot(dx, dy)
      if (!length) continue
      const tx = dx / length
      const ty = dy / length
      const nx = -ty
      const ny = tx
      const wallAngle = (Math.atan2(dy, dx) * 180) / Math.PI
      const relative = ((angleDeg - wallAngle) * Math.PI) / 180
      const halfNormal = (Math.abs(Math.sin(relative)) * widthCm + Math.abs(Math.cos(relative)) * depthCm) / 2
      const halfTangent = (Math.abs(Math.cos(relative)) * widthCm + Math.abs(Math.sin(relative)) * depthCm) / 2
      const along = (x - wall.xStart) * tx + (y - wall.yStart) * ty
      if (along < -halfTangent || along > length + halfTangent) continue
      const normal = (x - wall.xStart) * nx + (y - wall.yStart) * ny
      const side = normal < 0 ? -1 : 1
      const clearance = Math.abs(normal) - halfNormal - (wall.thickness ?? 0) / 2
      if (clearance < 0) {
        const shift = -clearance * side
        x += nx * shift
        y += ny * shift
        moved = true
      }
    }
    if (!moved) break
  }
  return { x, y }
}

export function snapFurnitureRotation(input: Omit<FurnitureSnapInput, 'magnetismEnabled'>): FurnitureSnapResult {
  const { walls, point, widthCm = input.depthCm, depthCm, angleDeg = 0 } = input
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
    return { x: point.x, y: point.y, angleDeg, wallRef: null, wallOffset: null }
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
