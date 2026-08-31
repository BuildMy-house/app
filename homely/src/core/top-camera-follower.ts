import type { Furniture, Level, NormalizedHomeState, Wall } from './home'
import { DEFAULT_WALL_HEIGHT_CM } from './home'

/**
 * SH3D HomeController3D$TopCameraState port (behaviour contract:
 * docs/behaviours/sh3d-camera-and-export.md §1). The top camera re-places
 * itself on every home CONTENT change, orbiting the new bounds center at its
 * previous distance (clamped). Pure functions only — the store calls
 * followTopCamera() after apply/undo/redo/resetToEmpty.
 *
 * Selection-centering is inert (SH3D pref defaults false) and is not ported;
 * camera-only mutations are skipped so explicit moves are never fought.
 */

export const AERIAL_MIN_BOX_CM = 100
export const AERIAL_MIN_HEIGHT_CM = 20

/** Endpoints closer than this count as joined for wall mitering. */
const JOIN_EPSILON = 1e-6
const PARALLEL_EPSILON = 1e-9

export interface Bounds3D {
  minX: number
  minY: number
  minZ: number
  maxX: number
  maxY: number
  maxZ: number
}

type Pt = [number, number]

/** Everything but cameras — camera-only steps must not re-trigger placement. */
export function contentFingerprint(home: NormalizedHomeState): string {
  const { cameras: _cameras, ...content } = home
  return JSON.stringify(content)
}

function levelOf(home: NormalizedHomeState, levelRef?: string | null): Level | undefined {
  return levelRef == null ? undefined : home.levels.find((l) => l.id === levelRef)
}

/** SH3D isItemAtVisibleLevel: null level counts as visible. */
function atVisibleLevel(level: Level | undefined): boolean {
  return level === undefined || (level.visible && level.viewable)
}

function furnitureCorners(f: Furniture): Pt[] {
  const angle = (f.angleDeg * Math.PI) / 180
  const cos = Math.cos(angle)
  const sin = Math.sin(angle)
  const hw = f.width / 2
  const hd = f.depth / 2
  const corners: Pt[] = []
  for (const [dx, dy] of [
    [-hw, -hd],
    [hw, -hd],
    [hw, hd],
    [-hw, hd],
  ] as const) {
    corners.push([f.x + dx * cos - dy * sin, f.y + dx * sin + dy * cos])
  }
  return corners
}

/** Unjoined thick-wall rectangle: [startL, endL, endR, startR]. */
function unjoinedCorners(wall: Wall): [Pt, Pt, Pt, Pt] {
  const dx = wall.xEnd - wall.xStart
  const dy = wall.yEnd - wall.yStart
  const len = Math.hypot(dx, dy) || 1 // zero-length walls cannot exist via HomeModel
  const half = wall.thickness / 2
  const nx = (-dy / len) * half
  const ny = (dx / len) * half
  return [
    [wall.xStart + nx, wall.yStart + ny],
    [wall.xEnd + nx, wall.yEnd + ny],
    [wall.xEnd - nx, wall.yEnd - ny],
    [wall.xStart - nx, wall.yStart - ny],
  ]
}

/** Effective arc extent: 0 for absent/null/0/NaN, so straight walls pass through. */
function arcExtentOf(wall: Wall): number {
  const a = wall.arcExtent
  return typeof a === 'number' && Number.isFinite(a) ? a : 0
}

/** A wall renders as an arc only when it has a nonzero extent and a real chord. */
function isArcWall(wall: Wall): boolean {
  const dx = wall.xEnd - wall.xStart
  const dy = wall.yEnd - wall.yStart
  return Math.abs(arcExtentOf(wall)) > 0 && dx * dx + dy * dy > 1e-10
}

/**
 * Center of the arc circle through both endpoints (SH3D Wall.getArcCircleCenter).
 * The angle to the center is computed from the included angle `arcExtent` and
 * the chord midpoint; the sign of arcExtent picks the bulge side.
 */
function arcCircleCenter(wall: Wall, arcExtent: number): Pt {
  const d = Math.hypot(wall.xEnd - wall.xStart, wall.yEnd - wall.yStart)
  const alpha =
    Math.abs(arcExtent) > Math.PI ? -(Math.PI + arcExtent) / 2 : (Math.PI - arcExtent) / 2
  const dist = -Math.tan(alpha) * (d / 2)
  const xMid = (wall.xStart + wall.xEnd) / 2
  const yMid = (wall.yStart + wall.yEnd) / 2
  const angle = Math.atan2(wall.xStart - wall.xEnd, wall.yEnd - wall.yStart)
  return [xMid + dist * Math.cos(angle), yMid + dist * Math.sin(angle)]
}

/**
 * Concentric-arc outline for a round wall (SH3D getUnjoinedShapePoints arc
 * branch): exterior and interior arcs offset ±thickness/2 from the centerline
 * arc, returned as one closed ring [exterior end→start, interior start→end]
 * (roles swap for negative arcExtent).
 */
function arcWallOutlinePoints(wall: Wall): Pt[] {
  const arcExtent = arcExtentOf(wall)
  const center = arcCircleCenter(wall, arcExtent)
  const startAngle =
    Math.atan2(center[1] - wall.yStart, center[0] - wall.xStart) +
    2 * Math.atan2(wall.yStart - wall.yEnd, wall.xEnd - wall.xStart)
  const radius = Math.hypot(center[0] - wall.xStart, center[1] - wall.yStart)
  const exteriorRadius = radius + wall.thickness / 2
  const interiorRadius = Math.max(0, radius - wall.thickness / 2)
  const exteriorArcLength = exteriorRadius * Math.abs(arcExtent)
  let angleDelta = arcExtent / Math.sqrt(exteriorArcLength)
  let angleStepCount = Math.floor(arcExtent / angleDelta)
  if (Math.abs(arcExtent - angleStepCount * angleDelta) > 1e-6) {
    angleStepCount++
    angleDelta = arcExtent / angleStepCount
  }
  const exterior: Pt[] = []
  const interior: Pt[] = []
  for (let i = 0; i <= angleStepCount; i++) {
    const angle = startAngle + arcExtent - i * angleDelta
    const cos = Math.cos(angle)
    const sin = Math.sin(angle)
    exterior.push([center[0] + exteriorRadius * cos, center[1] - exteriorRadius * sin])
    interior.push([center[0] + interiorRadius * cos, center[1] - interiorRadius * sin])
  }
  return angleDelta > 0 ? [...exterior, ...interior.reverse()] : [...interior, ...exterior.reverse()]
}

function samePoint(a: Pt, b: Pt): boolean {
  return Math.abs(a[0] - b[0]) < JOIN_EPSILON && Math.abs(a[1] - b[1]) < JOIN_EPSILON
}

function endpoint(wall: Wall, atStart: boolean): Pt {
  return atStart ? [wall.xStart, wall.yStart] : [wall.xEnd, wall.yEnd]
}

/** First other wall sharing this exact endpoint (chained drawing never makes >2-way joints). */
function findJoin(
  allWalls: Wall[],
  self: Wall,
  atStart: boolean,
): { other: Wall; otherAtStart: boolean } | undefined {
  const point = endpoint(self, atStart)
  for (const other of allWalls) {
    if (other.id === self.id) continue
    if (samePoint(point, endpoint(other, true))) return { other, otherAtStart: true }
    if (samePoint(point, endpoint(other, false))) return { other, otherAtStart: false }
  }
  return undefined
}

function lineIntersect(p1: Pt, p2: Pt, p3: Pt, p4: Pt): Pt | null {
  const d1x = p2[0] - p1[0]
  const d1y = p2[1] - p1[1]
  const d2x = p4[0] - p3[0]
  const d2y = p4[1] - p3[1]
  const denom = d1x * d2y - d1y * d2x
  if (Math.abs(denom) < PARALLEL_EPSILON) return null
  const t = ((p3[0] - p1[0]) * d2y - (p3[1] - p1[1]) * d2x) / denom
  return [p1[0] + t * d1x, p1[1] + t * d1y]
}

/**
 * Moves one cap corner of `wall` to the intersection of its side line with a
 * side line of the joined wall (SH3D computeIntersection: only when non-
 * parallel and within limit = 2*max thickness of the original corner).
 */
function miterCorner(
  pts: [Pt, Pt, Pt, Pt],
  capIndex: number,
  neighborIndex: number,
  theirPts: [Pt, Pt, Pt, Pt],
  theirCapIndex: number,
  theirNeighborIndex: number,
  limit: number,
): void {
  const cap = pts[capIndex]
  const neighbor = pts[neighborIndex]
  const theirCap = theirPts[theirCapIndex]
  const theirNeighbor = theirPts[theirNeighborIndex]
  if (!cap || !neighbor || !theirCap || !theirNeighbor) return
  const moved = lineIntersect(cap, neighbor, theirCap, theirNeighbor)
  if (!moved) return
  const dx = moved[0] - cap[0]
  const dy = moved[1] - cap[1]
  if (dx * dx + dy * dy < limit * limit) {
    cap[0] = moved[0]
    cap[1] = moved[1]
  }
}

// Unjoined corner order: [startL(0), endL(1), endR(2), startR(3)];
// left side = {0,1}, right side = {3,2}.
function miterEnd(
  pts: [Pt, Pt, Pt, Pt],
  atStart: boolean,
  theirs: [Pt, Pt, Pt, Pt],
  theirAtStart: boolean,
  limit: number,
): void {
  const myLeft = atStart ? 0 : 1
  const myRight = atStart ? 3 : 2
  const myLeftN = atStart ? 1 : 0
  const myRightN = atStart ? 2 : 3
  const theirLeft = theirAtStart ? 0 : 1
  const theirRight = theirAtStart ? 3 : 2
  const theirLeftN = theirAtStart ? 1 : 0
  const theirRightN = theirAtStart ? 2 : 3
  if (atStart === theirAtStart) {
    // Head-on meeting: left side lines face the other wall's right side.
    miterCorner(pts, myLeft, myLeftN, theirs, theirRight, theirRightN, limit)
    miterCorner(pts, myRight, myRightN, theirs, theirLeft, theirLeftN, limit)
  } else {
    // Chain order (my end ↔ their start or my start ↔ their end).
    miterCorner(pts, myLeft, myLeftN, theirs, theirLeft, theirLeftN, limit)
    miterCorner(pts, myRight, myRightN, theirs, theirRight, theirRightN, limit)
  }
}

/**
 * Thick-polygon corner points with mitered joins where walls share an exact
 * endpoint (geometric equivalent of SH3D wallAtStart/wallAtEnd outlines).
 * Round walls (nonzero arcExtent) return their concentric-arc outline with no
 * mitering — curved-to-straight joins are a later milestone (M53c).
 */
export function wallOutlinePoints(wall: Wall, allWalls: Wall[]): Pt[] {
  if (isArcWall(wall)) return arcWallOutlinePoints(wall)
  const pts = unjoinedCorners(wall)
  for (const atStart of [true, false]) {
    const join = findJoin(allWalls, wall, atStart)
    if (!join) continue
    const theirs = unjoinedCorners(join.other)
    const limit = 2 * Math.max(wall.thickness, join.other.thickness)
    miterEnd(pts, atStart, theirs, join.otherAtStart, limit)
  }
  return pts
}

/** Whole-home 3D bounds per SH3D updateAerialViewBoundsFromHomeBounds. */
export function computeHomeBounds(home: NormalizedHomeState): Bounds3D {
  let bounds: Bounds3D | null = null
  const add = (x: number, y: number, minZ: number, maxZ: number): void => {
    if (bounds === null) {
      bounds = { minX: x, minY: y, minZ, maxX: x, maxY: y, maxZ }
      return
    }
    bounds.minX = Math.min(bounds.minX, x)
    bounds.minY = Math.min(bounds.minY, y)
    bounds.minZ = Math.min(bounds.minZ, minZ)
    bounds.maxX = Math.max(bounds.maxX, x)
    bounds.maxY = Math.max(bounds.maxY, y)
    bounds.maxZ = Math.max(bounds.maxZ, maxZ)
  }

  let containsVisibleWalls = false
  for (const wall of home.walls) {
    const level = levelOf(home, wall.levelRef)
    if (!atVisibleLevel(level)) continue
    containsVisibleWalls = true
    const elevation = level?.elevation ?? 0
    let maxZ = elevation + (wall.height ?? DEFAULT_WALL_HEIGHT_CM)
    if (wall.heightAtEnd != null) maxZ = Math.max(maxZ, elevation + wall.heightAtEnd)
    for (const [x, y] of wallOutlinePoints(wall, home.walls)) add(x, y, 0, maxZ)
  }

  for (const piece of home.furniture) {
    if (piece.visible === false) continue
    const level = levelOf(home, piece.levelRef)
    if (!atVisibleLevel(level)) continue
    const ground = piece.elevation + (level?.elevation ?? 0)
    for (const [x, y] of furnitureCorners(piece)) add(x, y, Math.max(0, ground), Math.max(0, ground + piece.height))
  }

  for (const room of home.rooms) {
    const level = levelOf(home, room.levelRef)
    if (!atVisibleLevel(level)) continue
    let minZ = 0
    let maxZ = AERIAL_MIN_HEIGHT_CM
    if (level) {
      minZ = Math.max(0, level.elevation - level.floorThickness)
      maxZ = Math.max(AERIAL_MIN_HEIGHT_CM, level.elevation)
    }
    for (const [x, y] of room.points) add(x, y, minZ, maxZ)
  }

  for (const line of home.dimensionLines) {
    const level = levelOf(home, line.levelRef)
    if (!atVisibleLevel(level)) continue
    const elevation = level?.elevation ?? 0
    add(
      line.xStart,
      line.yStart,
      Math.max(0, elevation + (line.elevationStart ?? 0)),
      Math.max(AERIAL_MIN_HEIGHT_CM, elevation + (line.elevationEnd ?? 0)),
    )
    add(
      line.xEnd,
      line.yEnd,
      Math.max(0, elevation + (line.elevationStart ?? 0)),
      Math.max(AERIAL_MIN_HEIGHT_CM, elevation + (line.elevationEnd ?? 0)),
    )
  }

  // Labels are excluded: homely labels have no pitch (floor-flat labels never
  // contribute in SH3D either); polylines do not exist in the schema.

  if (bounds === null) {
    return {
      minX: 0,
      minY: 0,
      minZ: 0,
      maxX: AERIAL_MIN_BOX_CM,
      maxY: AERIAL_MIN_BOX_CM,
      maxZ: AERIAL_MIN_HEIGHT_CM,
    }
  }
  if (containsVisibleWalls) {
    const grow = (lo: keyof Bounds3D, hi: keyof Bounds3D, minSize: number): void => {
      const b = bounds as Bounds3D
      if (b[hi] - b[lo] < minSize) {
        const center = (b[lo] + b[hi]) / 2
        b[lo] = center - minSize / 2
        b[hi] = b[lo] + minSize
      }
    }
    grow('minX', 'maxX', AERIAL_MIN_BOX_CM)
    grow('minY', 'maxY', AERIAL_MIN_BOX_CM)
    grow('minZ', 'maxZ', AERIAL_MIN_HEIGHT_CM)
  }
  return bounds
}

/**
 * Re-places next.cameras.top after a content change: keeps yaw/pitch/fov,
 * orbits the NEW bounds center at the PREVIOUS distance, clamped to
 * [halfDiag*1.05, max(5*halfDiag*1.05, 5000)]. Position/orientation are read
 * from the PREVIOUS camera — SH3D's camera object persists across undo/redo
 * (only content time-travels), so the orbit stays continuous there too.
 * No-op for camera-only or no-op mutations. Mutates `next` in place.
 */
export function followTopCamera(next: NormalizedHomeState, previous: NormalizedHomeState): void {
  if (contentFingerprint(previous) === contentFingerprint(next)) return

  const prevBounds = computeHomeBounds(previous)
  const prevCenterX = (prevBounds.minX + prevBounds.maxX) / 2
  const prevCenterY = (prevBounds.minY + prevBounds.maxY) / 2
  const prevCenterZ = (prevBounds.minZ + prevBounds.maxZ) / 2

  const camera = previous.cameras.top
  const distanceToCenter = Math.hypot(
    prevCenterX - camera.x,
    prevCenterY - camera.y,
    prevCenterZ - camera.z,
  )

  const bounds = computeHomeBounds(next)
  const centerX = (bounds.minX + bounds.maxX) / 2
  const centerY = (bounds.minY + bounds.maxY) / 2
  const centerZ = (bounds.minZ + bounds.maxZ) / 2

  const halfDiagonal =
    Math.hypot(bounds.maxX - bounds.minX, bounds.maxY - bounds.minY, bounds.maxZ - bounds.minZ) / 2
  const minDistance = halfDiagonal * 1.05
  const maxDistance = Math.max(5 * minDistance, 5000)
  const distance = Math.min(Math.max(distanceToCenter, minDistance), maxDistance)

  const yaw = (camera.yawDeg * Math.PI) / 180
  const pitch = (camera.pitchDeg * Math.PI) / 180
  const groundDistance = distance * Math.cos(pitch)
  const placed = next.cameras.top
  placed.x = centerX + Math.sin(yaw) * groundDistance
  placed.y = centerY - Math.cos(yaw) * groundDistance
  placed.z = centerZ + Math.sin(pitch) * distance
}
