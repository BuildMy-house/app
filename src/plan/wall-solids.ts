import type { WallLike } from './furniture-snap'

/**
 * Wall solids for furniture clearance.
 *
 * A straight wall is one oriented rectangle (length x thickness): overlap
 * detection and exact push-out come from a separating-axis test.
 *
 * A round wall (arcExtent != 0) is the exact annular band
 *   { r in [R - t/2, R + t/2], angle within the arc's sweep }.
 * Overlap is DETECTED against thin convex trapezoid slices that are
 * conservative on both faces (the outer edge of each slice is the tangent to
 * the outer circle, the inner edge joins two points ON the inner circle), so
 * their union always contains the true band and furniture can never overlap the
 * real curved wall. The slice count is chosen from the radius so the outer face
 * stands off the true arc by at most ARC_TOLERANCE_CM. Slices are generated
 * lazily around the footprint being tested, so a wall's slice count costs
 * nothing unless a piece is actually near it.
 * The push-OUT is analytic, not per slice: the exact minimum translation that
 * takes the footprint outside the outer circle, inside the inner circle, or
 * past an end of the arc (see arcPush) — pushing slice by slice would shove a
 * piece along the curve from one slice into the next.
 */

/** Max distance (cm) the slice approximation may stand off the true curved
 *  wall face. 0.005 cm is two orders of magnitude below one screen pixel at any
 *  realistic zoom (the plan view is never above ~10 px/cm). */
export const ARC_TOLERANCE_CM = 0.005
/** Hard cap on slices per wall, so degenerate (kilometre-scale) arcs stay
 *  cheap; far above anything needed for radii up to 20 m (see tests). */
export const MAX_ARC_SLICES = 4096

/** Penetration (cm) tolerated before furniture counts as overlapping a wall —
 *  absorbs floating-point error from the exact-flush push-out. */
const OVERLAP_EPSILON_CM = 1e-6

export interface Footprint {
  x: number
  y: number
  ux: number
  uy: number
  halfW: number
  halfD: number
}

export function footprintAt(x: number, y: number, widthCm: number, depthCm: number, angleDeg: number): Footprint {
  const rad = (angleDeg * Math.PI) / 180
  return { x, y, ux: Math.cos(rad), uy: Math.sin(rad), halfW: widthCm / 2, halfD: depthCm / 2 }
}

interface Axis {
  x: number
  y: number
}

export interface Solid {
  /** Four corners, x0,y0,x1,y1,... (convex). */
  pts: number[]
  axes: Axis[]
}

function rectSolid(wall: WallLike): Solid | null {
  const dx = wall.xEnd - wall.xStart
  const dy = wall.yEnd - wall.yStart
  const length = Math.hypot(dx, dy)
  if (!(length > 0)) return null
  const tx = dx / length
  const ty = dy / length
  const nx = -ty
  const ny = tx
  const cx = (wall.xStart + wall.xEnd) / 2
  const cy = (wall.yStart + wall.yEnd) / 2
  const hl = length / 2
  const ht = Math.max(0, wall.thickness ?? 0) / 2
  return {
    pts: [
      cx - tx * hl - nx * ht, cy - ty * hl - ny * ht,
      cx + tx * hl - nx * ht, cy + ty * hl - ny * ht,
      cx + tx * hl + nx * ht, cy + ty * hl + ny * ht,
      cx - tx * hl + nx * ht, cy - ty * hl + ny * ht,
    ],
    // Wall normal first: on ties the push goes straight out of the wall face
    // rather than sliding along it.
    axes: [{ x: nx, y: ny }, { x: tx, y: ty }],
  }
}

export interface ArcGeometry {
  cx: number
  cy: number
  radius: number
  innerR: number
  outerR: number
  /** Angle of the arc start (radians) and +1/-1 sweep direction. */
  start: number
  dir: 1 | -1
  sweep: number
  slices: number
  /** Half the angular width of one slice. */
  half: number
}

/** Circle centre, radius, start angle, direction and sweep of a round wall
 *  (SH3D convention: sagitta = (chord / 2) * tan(arcExtent / 4)); null for
 *  straight or degenerate walls. */
export function arcGeometry(wall: WallLike): ArcGeometry | null {
  const extent = wall.arcExtent
  if (typeof extent !== 'number' || !Number.isFinite(extent) || extent === 0) return null
  const dx = wall.xEnd - wall.xStart
  const dy = wall.yEnd - wall.yStart
  const chord = Math.hypot(dx, dy)
  if (!(chord > 0)) return null
  const sagitta = (chord / 2) * Math.tan(extent / 4)
  if (!Number.isFinite(sagitta) || Math.abs(sagitta) < 1e-9) return null
  const nx = dy / chord
  const ny = -dx / chord
  const mx = (wall.xStart + wall.xEnd) / 2 + nx * sagitta
  const my = (wall.yStart + wall.yEnd) / 2 + ny * sagitta
  const radius = (chord * chord / 4 + sagitta * sagitta) / (2 * Math.abs(sagitta))
  const cx = mx - nx * Math.sign(sagitta) * radius
  const cy = my - ny * Math.sign(sagitta) * radius
  const cross = (wall.xStart - cx) * (my - cy) - (wall.yStart - cy) * (mx - cx)
  const halfThickness = Math.max(0, wall.thickness ?? 0) / 2
  const outerR = radius + halfThickness
  const sweep = Math.abs(extent)
  // Outer tangent edge sits at outerR / cos(h) at the slice cut lines, i.e.
  // outerR * (1 / cos(h) - 1) off the true circle; solve that for h.
  const maxHalf = Math.acos(1 / (1 + ARC_TOLERANCE_CM / outerR))
  const slices = Math.min(MAX_ARC_SLICES, Math.max(1, Math.ceil(sweep / (2 * maxHalf))))
  return {
    cx, cy, radius,
    innerR: Math.max(0, radius - halfThickness),
    outerR,
    start: Math.atan2(wall.yStart - cy, wall.xStart - cx),
    dir: cross >= 0 ? 1 : -1,
    sweep,
    slices,
    half: sweep / (2 * slices),
  }
}

function arcSlice(arc: ArcGeometry, i: number): Solid {
  const step = arc.sweep / arc.slices
  const a0 = arc.start + arc.dir * step * i
  const a1 = arc.start + arc.dir * step * (i + 1)
  const am = (a0 + a1) / 2
  const outerCut = arc.outerR / Math.cos(arc.half)
  const point = (angle: number, r: number): [number, number] => [arc.cx + r * Math.cos(angle), arc.cy + r * Math.sin(angle)]
  const [ix0, iy0] = point(a0, arc.innerR)
  const [ix1, iy1] = point(a1, arc.innerR)
  const [ox1, oy1] = point(a1, outerCut)
  const [ox0, oy0] = point(a0, outerCut)
  return {
    pts: [ix0, iy0, ix1, iy1, ox1, oy1, ox0, oy0],
    axes: [
      { x: Math.cos(am), y: Math.sin(am) },
      { x: -Math.sin(a0), y: Math.cos(a0) },
      { x: -Math.sin(a1), y: Math.cos(a1) },
    ],
  }
}

function wrapPi(angle: number): number {
  const twoPi = 2 * Math.PI
  let a = angle % twoPi
  if (a > Math.PI) a -= twoPi
  if (a <= -Math.PI) a += twoPi
  return a
}

function corners(f: Footprint): Array<[number, number]> {
  const vx = -f.uy
  const vy = f.ux
  const out: Array<[number, number]> = []
  for (const [sx, sy] of [[-1, -1], [1, -1], [1, 1], [-1, 1]] as const) {
    out.push([f.x + f.ux * f.halfW * sx + vx * f.halfD * sy, f.y + f.uy * f.halfW * sx + vy * f.halfD * sy])
  }
  return out
}

/** Slices of `arc` that could touch the footprint (radius and angle culling). */
function arcSlicesNear(arc: ArcGeometry, f: Footprint): Solid[] {
  const cs = corners(f)
  let dMax = 0
  for (const [x, y] of cs) dMax = Math.max(dMax, Math.hypot(x - arc.cx, y - arc.cy))
  const cosHalf = Math.cos(arc.half)
  if (dMax < arc.innerR * cosHalf) return []
  // Distance from the arc centre to the footprint (0 when the centre is inside).
  const rx = arc.cx - f.x
  const ry = arc.cy - f.y
  const lx = Math.abs(rx * f.ux + ry * f.uy)
  const ly = Math.abs(-rx * f.uy + ry * f.ux)
  const dMin = Math.hypot(Math.max(0, lx - f.halfW), Math.max(0, ly - f.halfD))
  if (dMin > arc.outerR / cosHalf) return []

  const step = arc.sweep / arc.slices
  const out: Solid[] = []
  if (dMin === 0) {
    for (let i = 0; i < arc.slices; i++) out.push(arcSlice(arc, i))
    return out
  }
  // The centre is outside the (convex) footprint, so it subtends < pi: bound
  // the angle by the corners, relative to the footprint centre's direction.
  const ref = Math.atan2(f.y - arc.cy, f.x - arc.cx)
  let lo = 0
  let hi = 0
  for (const [x, y] of cs) {
    const delta = wrapPi(Math.atan2(y - arc.cy, x - arc.cx) - ref)
    lo = Math.min(lo, delta)
    hi = Math.max(hi, delta)
  }
  // Angles along the sweep run 0..sweep from the arc start in direction dir.
  const along = (angle: number): number => {
    const twoPi = 2 * Math.PI
    const a = (arc.dir * (angle - arc.start)) % twoPi
    return a < 0 ? a + twoPi : a
  }
  // With dir = -1 the sweep coordinate runs against the angle, so the interval starts at its far end.
  const from = along(ref + (arc.dir > 0 ? lo : hi))
  const width = hi - lo
  const ranges: Array<[number, number]> = from + width <= 2 * Math.PI
    ? [[from, from + width]]
    : [[from, 2 * Math.PI], [0, from + width - 2 * Math.PI]]
  for (const [a, b] of ranges) {
    if (a > arc.sweep) continue
    const first = Math.max(0, Math.floor(a / step) - 1)
    const last = Math.min(arc.slices - 1, Math.floor(b / step) + 1)
    for (let i = first; i <= last; i++) out.push(arcSlice(arc, i))
  }
  return out
}

function overlapsSlices(arc: ArcGeometry, f: Footprint): boolean {
  return arcSlicesNear(arc, f).some((slice) => solidPush(f, slice) !== null)
}

/** Smallest translation taking the footprint outside the circle (c, radius), or
 *  null when it is already outside. Exact for a convex footprint and a disk: the
 *  push runs along the line from the circle centre to the footprint's closest
 *  point (or out through the nearest face when the centre is inside it). */
function outwardPush(f: Footprint, cx: number, cy: number, radius: number): { x: number; y: number } | null {
  const vx = -f.uy
  const vy = f.ux
  const lx = (cx - f.x) * f.ux + (cy - f.y) * f.uy
  const ly = (cx - f.x) * vx + (cy - f.y) * vy
  const ex = Math.abs(lx) - f.halfW
  const ey = Math.abs(ly) - f.halfD
  if (ex > 0 || ey > 0) {
    const dist = Math.hypot(Math.max(ex, 0), Math.max(ey, 0))
    if (dist >= radius) return null
    // Centre -> closest footprint point, in footprint axes, then to world.
    const px = Math.max(-f.halfW, Math.min(f.halfW, lx)) - lx
    const py = Math.max(-f.halfD, Math.min(f.halfD, ly)) - ly
    const nx = (f.ux * px + vx * py) / dist
    const ny = (f.uy * px + vy * py) / dist
    return { x: nx * (radius - dist), y: ny * (radius - dist) }
  }
  // Centre inside the footprint: slide the piece out through its nearest face.
  const slackX = f.halfW - Math.abs(lx)
  const slackY = f.halfD - Math.abs(ly)
  if (slackX <= slackY) {
    const s = -Math.sign(lx || 1) * (slackX + radius)
    return { x: f.ux * s, y: f.uy * s }
  }
  const s = -Math.sign(ly || 1) * (slackY + radius)
  return { x: vx * s, y: vy * s }
}

/** Smallest translation putting the whole footprint inside the circle (c,
 *  radius), or null when it cannot fit (or the circle is degenerate). Minimum-norm
 *  point of the four corner disks' intersection: either the nearest point of
 *  one disk or an intersection of two disk boundaries. */
function inwardPush(f: Footprint, cx: number, cy: number, radius: number): { x: number; y: number } | null {
  if (!(radius > 0)) return null
  const centres = corners(f).map(([x, y]) => [cx - x, cy - y] as const)
  const slack = 1e-9
  let best: { x: number; y: number; norm: number } | null = null
  const consider = (tx: number, ty: number): void => {
    if (!centres.every(([px, py]) => Math.hypot(tx - px, ty - py) <= radius + slack)) return
    const norm = Math.hypot(tx, ty)
    if (!best || norm < best.norm) best = { x: tx, y: ty, norm }
  }
  for (const [px, py] of centres) {
    const dist = Math.hypot(px, py)
    if (dist > radius) consider((px * (dist - radius)) / dist, (py * (dist - radius)) / dist)
  }
  for (let k = 0; k < 4; k++) {
    for (let l = k + 1; l < 4; l++) {
      const [ax, ay] = centres[k]!
      const [bx, by] = centres[l]!
      const d = Math.hypot(bx - ax, by - ay)
      if (d === 0 || d > 2 * radius) continue
      const h = Math.sqrt(Math.max(0, radius * radius - (d / 2) * (d / 2)))
      const mx = (ax + bx) / 2
      const my = (ay + by) / 2
      consider(mx - ((by - ay) / d) * h, my + ((bx - ax) / d) * h)
      consider(mx + ((by - ay) / d) * h, my - ((bx - ax) / d) * h)
    }
  }
  const hit = best as { x: number; y: number } | null
  return hit ? { x: hit.x, y: hit.y } : null
}

/** Smallest translation taking the footprint clear of the arc's band, or null
 *  when it does not overlap it. Candidates: outside the outer circle, inside the
 *  inner circle, or past either end of the arc. The circle radii are inflated to
 *  the slice envelope (outerR / cos h, innerR * cos h) so the result clears every
 *  slice, while standing off the true face by at most ARC_TOLERANCE_CM. */
function arcPush(f: Footprint, arc: ArcGeometry): { x: number; y: number } | null {
  if (!overlapsSlices(arc, f)) return null
  const cosHalf = Math.cos(arc.half)
  const candidates: Array<{ x: number; y: number }> = []
  const outward = outwardPush(f, arc.cx, arc.cy, arc.outerR / cosHalf)
  if (outward) candidates.push(outward)
  const inward = inwardPush(f, arc.cx, arc.cy, arc.innerR * cosHalf)
  if (inward) candidates.push(inward)
  // Past an end of the arc: translate along the cut line's outward tangent until
  // the footprint lies entirely beyond it (only valid if that really clears the
  // band, which it may not for sweeps over half a turn).
  for (const end of [0, 1] as const) {
    const angle = arc.start + arc.dir * arc.sweep * end
    const sign = end === 0 ? -arc.dir : arc.dir
    const ex = -Math.sin(angle) * sign
    const ey = Math.cos(angle) * sign
    let lowest = Infinity
    for (const [x, y] of corners(f)) lowest = Math.min(lowest, (x - arc.cx) * ex + (y - arc.cy) * ey)
    if (lowest >= 0) continue
    const moved = footprintAt(f.x - ex * lowest, f.y - ey * lowest, f.halfW * 2, f.halfD * 2, Math.atan2(f.uy, f.ux) * 180 / Math.PI)
    if (!overlapsSlices(arc, moved)) candidates.push({ x: -ex * lowest, y: -ey * lowest })
  }
  let best: { x: number; y: number } | null = null
  for (const c of candidates) if (!best || Math.hypot(c.x, c.y) < Math.hypot(best.x, best.y)) best = c
  return best
}

/** Pre-processed walls ready for repeated clearance queries. */
export interface WallSolids {
  rects: Solid[]
  arcs: ArcGeometry[]
}

export function wallSolids(walls: ReadonlyArray<WallLike>): WallSolids {
  const rects: Solid[] = []
  const arcs: ArcGeometry[] = []
  for (const wall of walls) {
    const arc = arcGeometry(wall)
    if (arc) {
      arcs.push(arc)
      continue
    }
    const rect = rectSolid(wall)
    if (rect) rects.push(rect)
  }
  return { rects, arcs }
}

function hasWalls(solids: WallSolids): boolean {
  return solids.rects.length > 0 || solids.arcs.length > 0
}

/** Solids that could touch this footprint: every straight wall, plus the
 *  slices of round walls near it. */
export function solidsNear(solids: WallSolids, f: Footprint): Solid[] {
  if (solids.arcs.length === 0) return solids.rects
  const near = [...solids.rects]
  for (const arc of solids.arcs) near.push(...arcSlicesNear(arc, f))
  return near
}

/** Smallest SAT push (unit axis * distance) separating the footprint from the
 *  solid, or null when they do not overlap. */
function solidPush(f: Footprint, solid: Solid): { x: number; y: number } | null {
  const vx = -f.uy
  const vy = f.ux
  const { pts } = solid
  let best: { x: number; y: number; depth: number } | null = null
  const test = (ax: number, ay: number): boolean => {
    const rf = Math.abs(f.ux * ax + f.uy * ay) * f.halfW + Math.abs(vx * ax + vy * ay) * f.halfD
    let min = Infinity
    let max = -Infinity
    for (let i = 0; i < 8; i += 2) {
      const p = pts[i]! * ax + pts[i + 1]! * ay
      if (p < min) min = p
      if (p > max) max = p
    }
    const dist = f.x * ax + f.y * ay - (min + max) / 2
    const depth = rf + (max - min) / 2 - Math.abs(dist)
    if (depth <= OVERLAP_EPSILON_CM) return false
    if (!best || depth < best.depth - 1e-9) {
      const sign = dist < 0 ? -1 : 1
      best = { x: ax * sign * depth, y: ay * sign * depth, depth }
    }
    return true
  }
  for (const axis of solid.axes) if (!test(axis.x, axis.y)) return null
  if (!test(f.ux, f.uy) || !test(vx, vy)) return null
  const hit = best as { x: number; y: number; depth: number } | null
  return hit ? { x: hit.x, y: hit.y } : null
}

export function overlapsAnySolid(f: Footprint, solids: WallSolids): boolean {
  return solidsNear(solids, f).some((solid) => solidPush(f, solid) !== null)
}

const RELAX_PASSES = 64
const SEARCH_STEP_CM = 5
const SEARCH_DIRECTIONS = 32

export interface SettledFurniture {
  x: number
  y: number
  /** False when pushes ping-pong between walls (tight corner, piece bigger than
   *  its room): the position is then only the last iterate and may still
   *  overlap a wall. */
  settled: boolean
}

/**
 * Relaxes the footprint out of the walls: repeated exact pushes (SAT for
 * straight walls, arcPush for round ones), wall by wall, until none overlaps, so
 * corners, thin, rotated and round walls all behave the same and a piece comes
 * to rest flush.
 */
export function settleAmongSolids(
  solids: WallSolids,
  point: { x: number; y: number },
  widthCm: number,
  depthCm: number,
  angleDeg: number,
): SettledFurniture {
  let { x, y } = point
  if (![x, y, widthCm, depthCm, angleDeg].every(Number.isFinite) || !hasWalls(solids)) return { x, y, settled: true }
  for (let pass = 0; pass < RELAX_PASSES; pass++) {
    let moved = false
    for (const rect of solids.rects) {
      const push = solidPush(footprintAt(x, y, widthCm, depthCm, angleDeg), rect)
      if (push) {
        x += push.x
        y += push.y
        moved = true
      }
    }
    for (const arc of solids.arcs) {
      const push = arcPush(footprintAt(x, y, widthCm, depthCm, angleDeg), arc)
      if (push) {
        x += push.x
        y += push.y
        moved = true
      }
    }
    if (!moved) return { x, y, settled: true }
  }
  return { x, y, settled: !overlapsAnySolid(footprintAt(x, y, widthCm, depthCm, angleDeg), solids) }
}

/**
 * Nearest position (expanding ring search from `point`) where the footprint
 * touches no wall; one always exists beyond the walls' bounding box. Only for
 * pieces that are not inside any room — a piece inside a room that cannot be
 * settled is rejected by the store instead of being moved out of its room.
 */
export function nearestFreeSpot(
  solids: WallSolids,
  point: { x: number; y: number },
  widthCm: number,
  depthCm: number,
  angleDeg: number,
): { x: number; y: number } {
  let reach = 0
  for (const solid of solids.rects) {
    for (let i = 0; i < 8; i += 2) reach = Math.max(reach, Math.hypot(solid.pts[i]! - point.x, solid.pts[i + 1]! - point.y))
  }
  for (const arc of solids.arcs) {
    reach = Math.max(reach, Math.hypot(arc.cx - point.x, arc.cy - point.y) + arc.outerR / Math.cos(arc.half))
  }
  const maxRadius = reach + Math.hypot(widthCm, depthCm) + SEARCH_STEP_CM
  for (let radius = SEARCH_STEP_CM; radius <= maxRadius + SEARCH_STEP_CM; radius += SEARCH_STEP_CM) {
    for (let i = 0; i < SEARCH_DIRECTIONS; i++) {
      const theta = (2 * Math.PI * i) / SEARCH_DIRECTIONS
      const x = point.x + Math.cos(theta) * radius
      const y = point.y + Math.sin(theta) * radius
      if (!overlapsAnySolid(footprintAt(x, y, widthCm, depthCm, angleDeg), solids)) return { x, y }
    }
  }
  return { x: point.x, y: point.y }
}

