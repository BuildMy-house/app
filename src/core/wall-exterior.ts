/**
 * Wall-side exterior/interior derivation from room geometry.
 *
 * A wall side is "exterior" when a sample point just off that side of the
 * wall is NOT inside any room polygon (on the same level). Pure geometry —
 * no dependency on concrete home state types.
 */

export type WallSide = 'left' | 'right'

export interface WallSideGeometry {
  xStart: number
  yStart: number
  xEnd: number
  yEnd: number
  thickness: number
  levelRef?: string | null
}

export interface WallSideOverride {
  leftSideExteriorOverride?: boolean | null
  rightSideExteriorOverride?: boolean | null
}

export interface RoomPolygon {
  points: Array<[number, number]>
  levelRef?: string | null
}

/** Outward unit normal of one wall side. RIGHT normal = (uy, -ux); LEFT = (-uy, ux). */
export function wallSideOutwardNormal(
  wall: { xStart: number; yStart: number; xEnd: number; yEnd: number },
  side: WallSide,
): { nx: number; ny: number } {
  const dx = wall.xEnd - wall.xStart
  const dy = wall.yEnd - wall.yStart
  const len = Math.hypot(dx, dy)
  if (len === 0) return { nx: 0, ny: 0 }
  const ux = dx / len
  const uy = dy / len
  return side === 'right' ? { nx: uy || 0, ny: -ux || 0 } : { nx: -uy || 0, ny: ux || 0 }
}

/** Standard even-odd ray casting point-in-polygon test. */
function pointInPolygon(point: [number, number], polygon: Array<[number, number]>): boolean {
  const [px, py] = point
  let inside = false
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const edgeI = polygon[i]!
    const edgeJ = polygon[j]!
    const crosses = edgeI[1] > py !== edgeJ[1] > py
    if (crosses && px < ((edgeJ[0] - edgeI[0]) * (py - edgeI[1])) / (edgeJ[1] - edgeI[1]) + edgeI[0]) {
      inside = !inside
    }
  }
  return inside
}

/**
 * Derive whether one side of a wall faces the exterior: sample a point just
 * off the side (wall midpoint + outward normal * (thickness/2 + 5 cm)) and
 * check it against every room on the wall's level. Inside any room →
 * interior; otherwise (or with no rooms) → exterior.
 */
export function deriveWallSideExterior(
  wall: WallSideGeometry,
  side: WallSide,
  rooms: RoomPolygon[],
): boolean {
  const { nx, ny } = wallSideOutwardNormal(wall, side)
  const mx = (wall.xStart + wall.xEnd) / 2
  const my = (wall.yStart + wall.yEnd) / 2
  const sample: [number, number] = [mx + nx * (wall.thickness / 2 + 5), my + ny * (wall.thickness / 2 + 5)]
  for (const room of rooms) {
    if ((room.levelRef ?? null) !== (wall.levelRef ?? null)) continue
    if (pointInPolygon(sample, room.points)) return false
  }
  return true
}

/** Boolean override short-circuits; otherwise auto-derive from room geometry. */
export function getWallSideExterior(
  wall: WallSideGeometry & WallSideOverride,
  side: WallSide,
  rooms: RoomPolygon[],
): boolean {
  const override = side === 'left' ? wall.leftSideExteriorOverride : wall.rightSideExteriorOverride
  if (typeof override === 'boolean') return override
  return deriveWallSideExterior(wall, side, rooms)
}
