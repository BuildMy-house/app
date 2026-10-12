import { DEFAULT_WALL_HEIGHT_CM } from '../core/home'

/**
 * Elevation rule for furniture clearance (shared by the store invariant and the
 * drag/placement snap, so both agree).
 *
 * Furniture `elevation` is the height of the piece's underside above its level's
 * floor, and a wall stands from that floor up to its top (`height`, or the
 * higher of `height`/`heightAtEnd` for a sloped wall; DEFAULT_WALL_HEIGHT_CM
 * when unset, exactly as the 2D/3D renderers do). A wall only blocks a piece
 * whose underside is BELOW the wall's top: a piece hung entirely above the wall
 * (underside at or over the top) passes over it and may overlap it in plan.
 *
 * Deliberately not modelled: a piece wholly under the floor (negative elevation)
 * is still kept out of walls, and a piece whose underside is merely above the
 * low end of a sloped wall still counts as touching it (the wall's higher end
 * decides). Wall-mounted shelves and cabinets sit well below the wall top, so
 * they keep being held flush against the wall, never inside it. Doors and
 * windows are exempt from clearance entirely (they live IN walls).
 */

export interface WallHeightLike {
  height?: number | null
  heightAtEnd?: number | null
}

export function wallTopCm(wall: WallHeightLike): number {
  const start = wall.height ?? DEFAULT_WALL_HEIGHT_CM
  const end = wall.heightAtEnd ?? start
  return Math.max(start, end)
}

/** The walls that can obstruct a piece whose underside is `elevationCm` above the floor. */
export function wallsBlockingAt<W extends WallHeightLike>(walls: ReadonlyArray<W>, elevationCm: number | undefined | null): W[] {
  if (typeof elevationCm !== 'number' || !Number.isFinite(elevationCm)) return [...walls]
  return walls.filter((wall) => wallTopCm(wall) > elevationCm)
}
