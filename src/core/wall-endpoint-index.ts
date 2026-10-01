import type { Wall } from './home'

/**
 * Endpoints closer than this count as the same point — matches
 * top-camera-follower.ts's JOIN_EPSILON and engine.ts's EPSILON (both 1e-6
 * already; keep all three in sync if this ever changes).
 */
const EPSILON = 1e-6
const GRID_CM = 2 * EPSILON

interface WallEndpointMatch {
  wallId: string
  /** The matching wall object itself, so callers never re-scan by id. */
  wall: Wall
  atStart: boolean
}

export interface WallEndpointIndex {
  /**
   * All wall endpoints within EPSILON of (x, y), excluding `excludeWallId`
   * if given. Order is not a documented contract (see note below) but in
   * practice matches wall-array insertion order for exact-coincident points.
   */
  matchesAt(x: number, y: number, excludeWallId?: string): WallEndpointMatch[]
}

function samePoint(x1: number, y1: number, x2: number, y2: number): boolean {
  return Math.abs(x1 - x2) < EPSILON && Math.abs(y1 - y2) < EPSILON
}

function cellOf(v: number): number {
  return Math.floor(v / GRID_CM)
}

/**
 * O(W) to build, O(1)-amortized per matchesAt() call (bounded by how many
 * walls actually share ~that point, not by total wall count W) — replaces
 * O(W) linear rescans in top-camera-follower.ts's findJoin and engine.ts's
 * freeEndpointAt.
 *
 * Grid cell size is 2×EPSILON, so any two points within EPSILON of each
 * other are guaranteed to land in the same cell or a directly-adjacent one.
 * matchesAt() scans the full 3x3 neighborhood around the query point's cell
 * and re-checks the exact EPSILON distance on every candidate found there —
 * this reproduces the exact same "within EPSILON" semantics as a real O(W)
 * linear scan would, it just avoids paying O(W) to get there.
 *
 * ponytail: indices are cached by walls-array identity — store.apply() clones
 * per edit, so a new home state means a new array and a fresh build. Safe only
 * while nothing mutates wall endpoints in place (same discipline as
 * contentFingerprint's cache in top-camera-follower.ts).
 */
const indexCache = new WeakMap<Wall[], WallEndpointIndex>()

export function buildWallEndpointIndex(walls: Wall[]): WallEndpointIndex {
  const cached = indexCache.get(walls)
  if (cached) return cached
  const index = buildIndex(walls)
  indexCache.set(walls, index)
  return index
}

function buildIndex(walls: Wall[]): WallEndpointIndex {
  const buckets = new Map<string, Array<{ wall: Wall; atStart: boolean }>>()
  const insert = (wall: Wall, atStart: boolean): void => {
    const x = atStart ? wall.xStart : wall.xEnd
    const y = atStart ? wall.yStart : wall.yEnd
    const key = `${cellOf(x)},${cellOf(y)}`
    const list = buckets.get(key)
    if (list) list.push({ wall, atStart })
    else buckets.set(key, [{ wall, atStart }])
  }
  for (const wall of walls) {
    insert(wall, true)
    insert(wall, false)
  }

  return {
    matchesAt(x: number, y: number, excludeWallId?: string): WallEndpointMatch[] {
      const cx = cellOf(x)
      const cy = cellOf(y)
      const out: WallEndpointMatch[] = []
      for (let dx = -1; dx <= 1; dx++) {
        for (let dy = -1; dy <= 1; dy++) {
          const list = buckets.get(`${cx + dx},${cy + dy}`)
          if (!list) continue
          for (const entry of list) {
            if (excludeWallId != null && entry.wall.id === excludeWallId) continue
            const ex = entry.atStart ? entry.wall.xStart : entry.wall.xEnd
            const ey = entry.atStart ? entry.wall.yStart : entry.wall.yEnd
            if (samePoint(x, y, ex, ey))
              out.push({ wallId: entry.wall.id, wall: entry.wall, atStart: entry.atStart })
          }
        }
      }
      return out
    },
  }
}
