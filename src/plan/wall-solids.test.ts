import { describe, expect, it } from 'vitest'
import {
  ARC_TOLERANCE_CM,
  MAX_ARC_SLICES,
  arcGeometry,
  footprintAt,
  nearestFreeSpot,
  overlapsAnySolid,
  settleAmongSolids,
  solidsNear,
  wallSolids,
} from './wall-solids'

/** The true curved wall, derived independently of arcGeometry: chord P0->P1,
 *  signed extent a (SH3D: sagitta = chord/2 * tan(a/4), positive = left of the
 *  chord direction rotated -90deg). */
interface ArcWall {
  xStart: number
  yStart: number
  xEnd: number
  yEnd: number
  thickness: number
  arcExtent: number
}

function trueBand(wall: ArcWall) {
  const { xStart, yStart, xEnd, yEnd, thickness, arcExtent: a } = wall
  const chord = Math.hypot(xEnd - xStart, yEnd - yStart)
  const radius = chord / (2 * Math.sin(Math.abs(a) / 2))
  const nx = (yEnd - yStart) / chord
  const ny = -(xEnd - xStart) / chord
  const sign = Math.sign(a)
  const mx = (xStart + xEnd) / 2
  const my = (yStart + yEnd) / 2
  const cx = mx - nx * sign * radius * Math.cos(a / 2)
  const cy = my - ny * sign * radius * Math.cos(a / 2)
  const sagitta = (chord / 2) * Math.tan(a / 4)
  const midX = mx + nx * sagitta
  const midY = my + ny * sagitta
  const startAngle = Math.atan2(yStart - cy, xStart - cx)
  const dir = (xStart - cx) * (midY - cy) - (yStart - cy) * (midX - cx) >= 0 ? 1 : -1
  const innerR = Math.max(0, radius - thickness / 2)
  const outerR = radius + thickness / 2
  const twoPi = 2 * Math.PI
  /** Signed penetration (>0 inside the band, within its sweep); 0 when outside. */
  const depthAt = (x: number, y: number): number => {
    const r = Math.hypot(x - cx, y - cy)
    let along = (dir * (Math.atan2(y - cy, x - cx) - startAngle)) % twoPi
    if (along < 0) along += twoPi
    if (along > Math.abs(a)) return 0
    return Math.max(0, Math.min(r - innerR, outerR - r))
  }
  /** Radial distance to the nearest face (0 inside); null outside the sweep. */
  const gapAt = (x: number, y: number): number | null => {
    const r = Math.hypot(x - cx, y - cy)
    let along = (dir * (Math.atan2(y - cy, x - cx) - startAngle)) % twoPi
    if (along < 0) along += twoPi
    if (along > Math.abs(a)) return null
    return r < innerR ? innerR - r : r > outerR ? r - outerR : 0
  }
  return { cx, cy, radius, innerR, outerR, depthAt, gapAt }
}

function boundarySamples(x: number, y: number, w: number, d: number, angleDeg: number, step = 0.25): Array<[number, number]> {
  const rad = (angleDeg * Math.PI) / 180
  const ux = Math.cos(rad)
  const uy = Math.sin(rad)
  const out: Array<[number, number]> = []
  const corners = [[-1, -1], [1, -1], [1, 1], [-1, 1]] as const
  for (let k = 0; k < 4; k++) {
    const [ax, ay] = corners[k]!
    const [bx, by] = corners[(k + 1) % 4]!
    const length = Math.hypot((bx - ax) * w, (by - ay) * d) / 2
    const n = Math.max(1, Math.ceil(length / step))
    for (let i = 0; i < n; i++) {
      const t = i / n
      const lx = ((ax + (bx - ax) * t) * w) / 2
      const ly = ((ay + (by - ay) * t) * d) / 2
      out.push([x + ux * lx - uy * ly, y + uy * lx + ux * ly])
    }
  }
  return out
}

function maxDepth(band: ReturnType<typeof trueBand>, x: number, y: number, w: number, d: number, angle: number, step?: number): number {
  let worst = 0
  for (const [px, py] of boundarySamples(x, y, w, d, angle, step)) worst = Math.max(worst, band.depthAt(px, py))
  return worst
}

function minGap(band: ReturnType<typeof trueBand>, x: number, y: number, w: number, d: number, angle: number): number | null {
  let best: number | null = null
  for (const [px, py] of boundarySamples(x, y, w, d, angle)) {
    const g = band.gapAt(px, py)
    if (g !== null && (best === null || g < best)) best = g
  }
  return best
}

function seeded(seed: number) {
  let s = seed >>> 0
  const rand = () => {
    s = (s * 1664525 + 1013904223) >>> 0
    return s / 2 ** 32
  }
  return { rand, between: (lo: number, hi: number) => lo + rand() * (hi - lo) }
}

describe('round wall approximation: quantified', () => {
  const radii = [30, 50, 100, 250, 500, 1000, 2000]
  const thicknesses = [0, 2, 10, 30, 60]
  const sweeps = [0.3, Math.PI / 2, Math.PI, 1.8 * Math.PI]

  const arcFor = (radius: number, thickness: number, sweep: number) => {
    const chord = 2 * radius * Math.sin(sweep / 2)
    return { xStart: 0, yStart: 0, xEnd: chord, yEnd: 0, thickness, arcExtent: sweep }
  }

  it('stands off the true curved face by at most ARC_TOLERANCE_CM, for radii 30 cm to 20 m', () => {
    let worst = 0
    let maxSlices = 0
    for (const radius of radii) {
      for (const thickness of thicknesses) {
        for (const sweep of sweeps) {
          const arc = arcGeometry(arcFor(radius, thickness, sweep))!
          expect(arc.radius).toBeCloseTo(radius, 6)
          // Outer tangent edge reaches outerR / cos(half) at the cut lines; the
          // inner chord dips innerR * (1 - cos(half)) inside the inner circle.
          const outer = arc.outerR * (1 / Math.cos(arc.half) - 1)
          const inner = arc.innerR * (1 - Math.cos(arc.half))
          worst = Math.max(worst, outer, inner)
          maxSlices = Math.max(maxSlices, arc.slices)
          expect(arc.slices).toBeLessThan(MAX_ARC_SLICES)
        }
      }
    }
    expect(worst).toBeLessThanOrEqual(ARC_TOLERANCE_CM + 1e-9)
    expect(ARC_TOLERANCE_CM).toBeLessThanOrEqual(0.5)
    expect(maxSlices).toBeLessThanOrEqual(2400)
  })

  it('the slices always cover the true band, so the approximation never cuts into the real wall', () => {
    for (const [radius, thickness, sweep] of [[30, 10, Math.PI], [250, 30, 1.8 * Math.PI], [2000, 10, Math.PI / 2], [100, 0, 0.3]] as const) {
      const wall = arcFor(radius, thickness, sweep)
      const arc = arcGeometry(wall)!
      const band = trueBand(wall)
      const f = footprintAt(arc.cx, arc.cy, 4 * radius, 4 * radius, 0)
      const slices = solidsNear(wallSolids([wall]), f)
      expect(slices).toHaveLength(arc.slices)
      const inside = (px: number, py: number): boolean =>
        slices.some((s) => {
          let sign = 0
          for (let i = 0; i < 4; i++) {
            const ax = s.pts[2 * i]!
            const ay = s.pts[2 * i + 1]!
            const bx = s.pts[(2 * i + 2) % 8]!
            const by = s.pts[(2 * i + 3) % 8]!
            const cross = (bx - ax) * (py - ay) - (by - ay) * (px - ax)
            if (Math.abs(cross) < 1e-7) continue
            const c = Math.sign(cross)
            if (sign === 0) sign = c
            else if (c !== sign) return false
          }
          return true
        })
      const start = Math.atan2(wall.yStart - band.cy, wall.xStart - band.cx)
      const dir = arc.dir
      for (let i = 0; i <= 60; i++) {
        const angle = start + dir * (sweep * i) / 60
        for (const r of thickness === 0 ? [radius] : [band.innerR + 1e-6, radius, band.outerR - 1e-6]) {
          expect(inside(band.cx + r * Math.cos(angle), band.cy + r * Math.sin(angle)), `R${radius} t${thickness} i${i} r${r}`).toBe(true)
        }
      }
    }
  })

  it('caps slices for absurd arcs and still produces valid geometry', () => {
    const arc = arcGeometry({ xStart: 0, yStart: 0, xEnd: 1e6, yEnd: 0, thickness: 10, arcExtent: Math.PI })!
    expect(arc.slices).toBe(MAX_ARC_SLICES)
    expect(Number.isFinite(arc.half)).toBe(true)
  })
})

describe('round wall clearance against the true curve', () => {
  const TOL = 0.01

  it('property: random rotated pieces end up outside the true band, touching it, and barely moved', () => {
    const { between } = seeded(20261012)
    let checked = 0
    let oracleChecked = 0
    for (let run = 0; run < 150; run++) {
      const radius = between(30, 2000)
      const thickness = between(2, Math.min(40, radius * 0.5))
      const sweep = between(0.6 * Math.PI, 1.8 * Math.PI)
      const chord = 2 * radius * Math.sin(sweep / 2)
      const sign = run % 2 === 0 ? 1 : -1
      const wall = { xStart: 0, yStart: 0, xEnd: chord, yEnd: 0, thickness, arcExtent: sign * sweep }
      const band = trueBand(wall)
      const w = between(20, Math.min(160, radius * 0.6))
      const d = between(20, Math.min(160, radius * 0.6))
      const angle = between(-180, 180)
      // Start at the middle of the arc, anywhere within the band +- the piece's reach.
      const sagitta = (chord / 2) * Math.tan(wall.arcExtent / 4)
      const midX = chord / 2
      const midY = -sagitta
      const radialX = (midX - band.cx) / Math.hypot(midX - band.cx, midY - band.cy)
      const radialY = (midY - band.cy) / Math.hypot(midX - band.cx, midY - band.cy)
      const offset = between(-Math.hypot(w, d) / 2, Math.hypot(w, d) / 2)
      const start = { x: midX + radialX * offset, y: midY + radialY * offset }
      const solids = wallSolids([wall])
      const r = settleAmongSolids(solids, start, w, d, angle)
      expect(r.settled, `run ${run} settles`).toBe(true)
      expect(overlapsAnySolid(footprintAt(r.x, r.y, w, d, angle), solids), `run ${run} solids`).toBe(false)
      // 1. no point of the footprint inside the TRUE band.
      expect(maxDepth(band, r.x, r.y, w, d, angle), `run ${run} penetration`).toBeLessThanOrEqual(TOL)
      // 2. if it had to move, it is flush: the gap to the true wall face is within tolerance.
      const moved = Math.hypot(r.x - start.x, r.y - start.y)
      if (maxDepth(band, start.x, start.y, w, d, angle) > TOL) {
        const gap = minGap(band, r.x, r.y, w, d, angle)
        expect(gap, `run ${run} gap`).not.toBeNull()
        expect(gap!, `run ${run} gap`).toBeLessThanOrEqual(TOL)
        // 3. not pushed further than needed: no translation shorter than the
        // result (by more than the tolerance) clears the band either.
        if (run % 4 === 0) {
          const shortest = shortestClearingTranslation(band, start, w, d, angle, moved)
          expect(moved, `run ${run} over-push`).toBeLessThanOrEqual(shortest + 2 * TOL)
          oracleChecked++
        }
        checked++
      }
    }
    expect(checked).toBeGreaterThan(100)
    expect(oracleChecked).toBeGreaterThan(25)
  }, 60_000)

  it('an unchanged piece that is already clear stays exactly where it is', () => {
    const wall = { xStart: 0, yStart: 0, xEnd: 400, yEnd: 0, thickness: 10, arcExtent: Math.PI }
    const solids = wallSolids([wall])
    // Chord midpoint bulges to y = -200; the circle centre (200, 0) is clear.
    const r = settleAmongSolids(solids, { x: 200, y: 0 }, 60, 60, 25)
    expect(r).toEqual({ x: 200, y: 0, settled: true })
  })

  it('pieces on the concave side sit flush with the inner face (no visible gap)', () => {
    const wall = { xStart: 0, yStart: 0, xEnd: 400, yEnd: 0, thickness: 10, arcExtent: Math.PI }
    const band = trueBand(wall)
    const solids = wallSolids([wall])
    // Push a 60x60 piece up into the inner face at the top of the arc, from inside.
    const r = settleAmongSolids(solids, { x: 200, y: -190 }, 60, 60, 0)
    expect(band.depthAt(r.x, r.y)).toBeLessThanOrEqual(TOL)
    expect(maxDepth(band, r.x, r.y, 60, 60, 0)).toBeLessThanOrEqual(TOL)
    expect(minGap(band, r.x, r.y, 60, 60, 0)!).toBeLessThanOrEqual(TOL)
  })

  it('a piece wider than the arc end slides off the end cap instead of being trapped', () => {
    const wall = { xStart: 0, yStart: 0, xEnd: 100, yEnd: 0, thickness: 10, arcExtent: 1 }
    const solids = wallSolids([wall])
    const p = nearestFreeSpot(solids, { x: 50, y: -10 }, 500, 500, 0)
    expect(overlapsAnySolid(footprintAt(p.x, p.y, 500, 500, 0), solids)).toBe(false)
  })
})

/** Smallest |t| (found by scanning 360 directions) such that moving the piece
 *  by t leaves no footprint point inside the band by more than the tolerance. */
function shortestClearingTranslation(
  band: ReturnType<typeof trueBand>,
  start: { x: number; y: number },
  w: number,
  d: number,
  angle: number,
  limit: number,
): number {
  let best = Infinity
  const cap = limit + 1
  for (let k = 0; k < 360; k += 2) {
    const theta = (k * Math.PI) / 180
    const ux = Math.cos(theta)
    const uy = Math.sin(theta)
    let lo = 0
    let found = Infinity
    for (let s = 0; s <= Math.min(cap, best); s += 1) {
      if (maxDepth(band, start.x + ux * s, start.y + uy * s, w, d, angle, 1) <= 0.01) {
        found = s
        break
      }
      lo = s
    }
    if (found === Infinity) continue
    // Refine within the last coarse step.
    let a = lo
    let b = found
    for (let i = 0; i < 12; i++) {
      const m = (a + b) / 2
      if (maxDepth(band, start.x + ux * m, start.y + uy * m, w, d, angle, 1) <= 0.01) b = m
      else a = m
    }
    best = Math.min(best, b)
  }
  return best
}
