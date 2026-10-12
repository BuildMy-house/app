import { nearestFreeSpot, settleAmongSolids, type WallSolids } from './wall-solids'

/**
 * Where a piece of furniture ends up when it is made to clear the walls, with
 * the room it sits in taken into account. Shared by the store invariant
 * (core/furniture-clearance.ts) and the drag/placement snapping
 * (furniture-snap.ts), so "does it fit" has exactly one definition.
 *
 * Inside a room (the piece's centre is in the room polygon) the piece is pushed
 * to the nearest flush position INSIDE that room; if it fits nowhere in the
 * room it is reported as too large, never relocated out of the room. Outside
 * every room the plain push-out applies, with the ring search as the fallback
 * for a piece trapped between walls.
 */

export interface RoomLike {
  id: string
  name?: string | null
  points: ReadonlyArray<readonly [number, number]>
  levelRef?: string | null
}

interface Point2 {
  x: number
  y: number
}

export type Resolution =
  | { fits: true; x: number; y: number }
  | { fits: false; room: RoomLike; roomWidthCm: number; roomDepthCm: number }

export function insidePolygon(p: Point2, points: ReadonlyArray<readonly [number, number]>): boolean {
  let inside = false
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const [xi, yi] = points[i]!
    const [xj, yj] = points[j]!
    if ((yi > p.y) !== (yj > p.y) && p.x < ((xj - xi) * (p.y - yi)) / (yj - yi) + xi) inside = !inside
  }
  return inside
}

function distanceToPolygon(p: Point2, points: ReadonlyArray<readonly [number, number]>): number {
  if (insidePolygon(p, points)) return 0
  let best = Infinity
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const [ax, ay] = points[j]!
    const [bx, by] = points[i]!
    const dx = bx - ax
    const dy = by - ay
    const lengthSq = dx * dx + dy * dy
    const t = lengthSq > 0 ? Math.max(0, Math.min(1, ((p.x - ax) * dx + (p.y - ay) * dy) / lengthSq)) : 0
    best = Math.min(best, Math.hypot(p.x - (ax + t * dx), p.y - (ay + t * dy)))
  }
  return best
}

function polygonArea(points: ReadonlyArray<readonly [number, number]>): number {
  let sum = 0
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    sum += points[j]![0] * points[i]![1] - points[i]![0] * points[j]![1]
  }
  return Math.abs(sum) / 2
}

function bounds(points: ReadonlyArray<readonly [number, number]>) {
  const xs = points.map((p) => p[0])
  const ys = points.map((p) => p[1])
  return { minX: Math.min(...xs), maxX: Math.max(...xs), minY: Math.min(...ys), maxY: Math.max(...ys) }
}

const SEED_GRID = 5

/** Start points for the "does it fit anywhere in this room" search: where the
 *  piece is now, a grid over the room's bounding box (kept if inside the
 *  polygon) and the vertex centroid. */
function seedsFor(room: RoomLike, origin: Point2): Point2[] {
  const b = bounds(room.points)
  const seeds: Point2[] = [origin]
  for (let i = 0; i < SEED_GRID; i++) {
    for (let j = 0; j < SEED_GRID; j++) {
      const p = {
        x: b.minX + ((i + 0.5) / SEED_GRID) * (b.maxX - b.minX),
        y: b.minY + ((j + 0.5) / SEED_GRID) * (b.maxY - b.minY),
      }
      if (insidePolygon(p, room.points)) seeds.push(p)
    }
  }
  const n = room.points.length
  const centroid = {
    x: room.points.reduce((sum, p) => sum + p[0], 0) / n,
    y: room.points.reduce((sum, p) => sum + p[1], 0) / n,
  }
  if (insidePolygon(centroid, room.points)) seeds.push(centroid)
  return seeds
}

/** The position nearest `origin` inside `room` where the piece touches no wall,
 *  or null when it fits nowhere in the room. Relaxation from several seeds
 *  converges onto the feasible region whenever one exists, so this finds exactly
 *  flush fits (a 300 cm piece in a 300 cm gap) that a position grid would miss. */
function fitInRoom(room: RoomLike, solids: WallSolids, origin: Point2, w: number, d: number, angleDeg: number): Point2 | null {
  let best: Point2 | null = null
  let bestDistance = Infinity
  for (const seed of seedsFor(room, origin)) {
    const r = settleAmongSolids(solids, seed, w, d, angleDeg)
    if (!r.settled || !insidePolygon(r, room.points)) continue
    const distance = Math.hypot(r.x - origin.x, r.y - origin.y)
    if (distance < bestDistance) {
      best = { x: r.x, y: r.y }
      bestDistance = distance
    }
  }
  return best
}

/**
 * `rooms` must already be filtered to the piece's level (and to >= 3 points),
 * `solids` built from that level's walls.
 */
export function resolveFootprint(
  solids: WallSolids,
  rooms: ReadonlyArray<RoomLike>,
  origin: Point2,
  widthCm: number,
  depthCm: number,
  angleDeg: number,
): Resolution {
  const relaxed = settleAmongSolids(solids, origin, widthCm, depthCm, angleDeg)
  if (relaxed.settled && relaxed.x === origin.x && relaxed.y === origin.y) return { fits: true, x: origin.x, y: origin.y }

  let candidates = rooms.filter((room) => insidePolygon(origin, room.points))
  if (relaxed.settled) {
    // Pushed to a clear spot: fine unless that spot is outside the room it was in.
    if (candidates.length === 0 || candidates.some((room) => insidePolygon(relaxed, room.points))) {
      return { fits: true, x: relaxed.x, y: relaxed.y }
    }
  } else if (candidates.length === 0) {
    // Trapped between walls with no room polygon around its centre: the nearest
    // room within reach (a wall-enclosed space whose centre sits in the wall band).
    const reach = Math.hypot(widthCm, depthCm) / 2
    candidates = rooms
      .map((room) => ({ room, d: distanceToPolygon(origin, room.points) }))
      .filter(({ d }) => d <= reach)
      .sort((a, b) => a.d - b.d)
      .slice(0, 1)
      .map(({ room }) => room)
  }
  if (candidates.length === 0) {
    const free = nearestFreeSpot(solids, origin, widthCm, depthCm, angleDeg)
    return { fits: true, x: free.x, y: free.y }
  }

  candidates = [...candidates].sort((a, b) => polygonArea(a.points) - polygonArea(b.points))
  let best: Point2 | null = null
  let bestDistance = Infinity
  for (const room of candidates) {
    const fit = fitInRoom(room, solids, origin, widthCm, depthCm, angleDeg)
    if (!fit) continue
    const distance = Math.hypot(fit.x - origin.x, fit.y - origin.y)
    if (distance < bestDistance) {
      best = fit
      bestDistance = distance
    }
  }
  if (best) return { fits: true, x: best.x, y: best.y }
  const b = bounds(candidates[0]!.points)
  return { fits: false, room: candidates[0]!, roomWidthCm: b.maxX - b.minX, roomDepthCm: b.maxY - b.minY }
}
