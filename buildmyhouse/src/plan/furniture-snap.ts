import type { Point } from './geometry'
import { distance } from './geometry'

/**
 * Furniture placement snapping (ticket U9).
 *
 * When magnetism is on, a placement point snaps to the nearest wall: the piece
 * is offset by half its depth along the wall normal so its back edge rests
 * against the wall, and its angle aligns with the wall direction — SH3D parity.
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
}

export interface FurnitureSnapInput {
  walls: ReadonlyArray<WallLike>
  point: Point
  /** Furniture depth (cm). Half of it is the back-edge offset from the wall. */
  depthCm: number
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

  let best: { dist: number; point: Point; wall: WallLike; t: number } | null = null
  for (const wall of walls) {
    const a = { x: wall.xStart, y: wall.yStart }
    const b = { x: wall.xEnd, y: wall.yEnd }
    const seg = closestPointOnSegment(point, a, b)
    const dist = distance(point, seg.point)
    if (!best || dist < best.dist) best = { dist, point: seg.point, wall, t: seg.t }
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

  // Place on the side of the wall the click came from (the room interior).
  const side = (point.x - best.point.x) * nx + (point.y - best.point.y) * ny >= 0 ? 1 : -1
  const offset = depthCm / 2
  const x = best.point.x + nx * side * offset
  const y = best.point.y + ny * side * offset
  const angleDeg = normalizeAngle180((Math.atan2(dy, dx) * 180) / Math.PI)

  const wallRef = best.wall.id ?? null
  const wallOffset = best.t * len

  return { x, y, angleDeg, wallRef, wallOffset }
}
