/**
 * floor-detect — pure planar-face detection for "create a floor from walls".
 *
 * Walls are treated as centerline segments. They are merged into a planar
 * graph (endpoints within `snapTol` fuse; a wall end that lands on another
 * wall's body splits that wall — a T-junction; crossing walls split at the
 * crossing) and every bounded face of that graph is a candidate floor.
 *
 * This replaces the exact-endpoint loop walker for floor creation: a floor no
 * longer silently fails to appear because a corner is a few cm off, a wall ends
 * on the middle of another wall, or the loop has more than a handful of walls.
 *
 * Also detects *near-closed* loops: dangling wall ends that would form a floor
 * if one short bridging wall were added, so the UI can point at the gap and
 * offer to close it.
 *
 * No DOM, no engine imports.
 */
import { wallCenterlinePoints } from './wall-loop-detector'

export interface FloorPoint {
  x: number
  y: number
}

export interface FloorWall {
  id: string
  start: FloorPoint
  end: FloorPoint
  arcExtent?: number | null
}

export interface FloorFace {
  /** Corner points; winding normalised to a positive shoelace sum. */
  polygon: FloorPoint[]
  /** Absolute area in cm². */
  area: number
  /** Real walls (not the synthetic gap bridge) forming the boundary. */
  wallIds: string[]
}

export interface FloorDetectOptions {
  /** Endpoints / T-junctions closer than this (cm) are treated as touching. */
  snapTol?: number
  /** Faces smaller than this (cm²) are ignored as slivers. */
  minArea?: number
}

export interface FloorGap {
  /** Dangling wall end the bridge starts from. */
  from: FloorPoint
  /** Where the bridge lands: another dangling end or a point on a wall body. */
  to: FloorPoint
  /** Bridge length in cm. */
  distance: number
  /** Id of the wall owning `from` (so the bridge can inherit its style). */
  fromWallId: string
  /** The floor that closing this gap would create. */
  face: FloorFace
}

export interface GapOptions extends FloorDetectOptions {
  /** Largest gap (cm) still offered for closing. */
  maxGap?: number
  /** Cap on returned candidates. */
  limit?: number
}

export const DEFAULT_SNAP_TOL_CM = 8
export const DEFAULT_MIN_FLOOR_AREA_CM2 = 2500 // 0.25 m²
export const DEFAULT_MAX_GAP_CM = 150
const BRIDGE_ID = '__gap__'

/** Shoelace sum: positive for one winding, negative for the other. */
export function signedPolygonArea(poly: ReadonlyArray<FloorPoint>): number {
  let s = 0
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i]!
    const b = poly[(i + 1) % poly.length]!
    s += a.x * b.y - b.x * a.y
  }
  return s / 2
}

export function pointInPolygon(p: FloorPoint, poly: ReadonlyArray<FloorPoint>): boolean {
  let inside = false
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i]!
    const b = poly[j]!
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) {
      inside = !inside
    }
  }
  return inside
}

/** A point guaranteed (for simple polygons) to lie inside, via widest scanline span. */
export function interiorPoint(poly: ReadonlyArray<FloorPoint>): FloorPoint {
  let minY = Infinity
  let maxY = -Infinity
  for (const p of poly) {
    minY = Math.min(minY, p.y)
    maxY = Math.max(maxY, p.y)
  }
  let best: FloorPoint = poly[0]!
  let bestSpan = -1
  for (const f of [0.5, 0.35, 0.65, 0.2, 0.8]) {
    const y = minY + (maxY - minY) * f
    const xs: number[] = []
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i]!
      const b = poly[(i + 1) % poly.length]!
      if (a.y > y !== b.y > y) xs.push(a.x + ((y - a.y) / (b.y - a.y)) * (b.x - a.x))
    }
    xs.sort((p, q) => p - q)
    for (let i = 0; i + 1 < xs.length; i += 2) {
      const span = xs[i + 1]! - xs[i]!
      if (span > bestSpan) {
        bestSpan = span
        best = { x: (xs[i]! + xs[i + 1]!) / 2, y }
      }
    }
  }
  return best
}

interface Seg {
  a: number
  b: number
  wallId: string
}

interface Graph {
  nodes: FloorPoint[]
  edges: Map<string, { a: number; b: number; wallIds: Set<string> }>
  /** Wall-endpoint nodes (arc samples excluded) with their owning wall. */
  endpointOwner: Map<number, string>
}

const edgeKey = (a: number, b: number) => (a < b ? `${a}-${b}` : `${b}-${a}`)

function buildGraph(
  walls: ReadonlyArray<FloorWall>,
  tol: number,
  bridge?: { a: FloorPoint; b: FloorPoint },
): Graph {
  const nodes: FloorPoint[] = []
  const tolSq = tol * tol
  const nodeFor = (p: FloorPoint): number => {
    for (let i = 0; i < nodes.length; i++) {
      const dx = nodes[i]!.x - p.x
      const dy = nodes[i]!.y - p.y
      if (dx * dx + dy * dy <= tolSq) return i
    }
    nodes.push({ x: p.x, y: p.y })
    return nodes.length - 1
  }

  const endpointOwner = new Map<number, string>()
  let segs: Seg[] = []
  const addPolyline = (id: string, pts: FloorPoint[], trackEnds: boolean) => {
    let prev = -1
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i]!
      if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) return
      const n = nodeFor(p)
      if (trackEnds && (i === 0 || i === pts.length - 1) && !endpointOwner.has(n)) endpointOwner.set(n, id)
      if (prev >= 0 && prev !== n) segs.push({ a: prev, b: n, wallId: id })
      prev = n
    }
  }
  for (const w of walls) addPolyline(w.id, wallCenterlinePoints(w), true)
  if (bridge) addPolyline(BRIDGE_ID, [bridge.a, bridge.b], false)

  // Split points per segment: T-junctions (a node lying on the body) and
  // proper crossings. Collected first, applied after, so a new crossing node
  // lands on BOTH segments.
  const splits: number[][] = segs.map(() => [])
  const t = (s: Seg, p: FloorPoint) => {
    const a = nodes[s.a]!
    const b = nodes[s.b]!
    const dx = b.x - a.x
    const dy = b.y - a.y
    return ((p.x - a.x) * dx + (p.y - a.y) * dy) / (dx * dx + dy * dy)
  }
  const nodeCountBefore = nodes.length
  for (let i = 0; i < segs.length; i++) {
    const s = segs[i]!
    const a = nodes[s.a]!
    const b = nodes[s.b]!
    const len = Math.hypot(b.x - a.x, b.y - a.y)
    for (let n = 0; n < nodeCountBefore; n++) {
      if (n === s.a || n === s.b) continue
      const p = nodes[n]!
      const tt = t(s, p)
      if (tt <= 0 || tt >= 1) continue
      const fx = a.x + (b.x - a.x) * tt
      const fy = a.y + (b.y - a.y) * tt
      if (Math.hypot(p.x - fx, p.y - fy) <= tol && tt * len > 1e-6 && (1 - tt) * len > 1e-6) {
        splits[i]!.push(n)
      }
    }
  }
  for (let i = 0; i < segs.length; i++) {
    for (let j = i + 1; j < segs.length; j++) {
      const s1 = segs[i]!
      const s2 = segs[j]!
      if (s1.a === s2.a || s1.a === s2.b || s1.b === s2.a || s1.b === s2.b) continue
      const p = properCrossing(nodes[s1.a]!, nodes[s1.b]!, nodes[s2.a]!, nodes[s2.b]!)
      if (!p) continue
      const n = nodeFor(p)
      if (!splits[i]!.includes(n) && n !== s1.a && n !== s1.b) splits[i]!.push(n)
      if (!splits[j]!.includes(n) && n !== s2.a && n !== s2.b) splits[j]!.push(n)
    }
  }
  const next: Seg[] = []
  segs.forEach((s, i) => {
    const mids = [...new Set(splits[i]!)].sort((p, q) => t(s, nodes[p]!) - t(s, nodes[q]!))
    const chain = [s.a, ...mids, s.b]
    for (let k = 0; k + 1 < chain.length; k++) {
      if (chain[k] !== chain[k + 1]) next.push({ a: chain[k]!, b: chain[k + 1]!, wallId: s.wallId })
    }
  })
  segs = next

  const edges: Graph['edges'] = new Map()
  for (const s of segs) {
    const k = edgeKey(s.a, s.b)
    const e = edges.get(k)
    if (e) e.wallIds.add(s.wallId)
    else edges.set(k, { a: s.a, b: s.b, wallIds: new Set([s.wallId]) })
  }
  return { nodes, edges, endpointOwner }
}

function properCrossing(p1: FloorPoint, p2: FloorPoint, p3: FloorPoint, p4: FloorPoint): FloorPoint | null {
  const d1x = p2.x - p1.x
  const d1y = p2.y - p1.y
  const d2x = p4.x - p3.x
  const d2y = p4.y - p3.y
  const den = d1x * d2y - d1y * d2x
  if (Math.abs(den) < 1e-9) return null
  const u = ((p3.x - p1.x) * d2y - (p3.y - p1.y) * d2x) / den
  const v = ((p3.x - p1.x) * d1y - (p3.y - p1.y) * d1x) / den
  if (u <= 1e-6 || u >= 1 - 1e-6 || v <= 1e-6 || v >= 1 - 1e-6) return null
  return { x: p1.x + u * d1x, y: p1.y + u * d1y }
}

function adjacency(g: Graph): Map<number, number[]> {
  const adj = new Map<number, number[]>()
  for (const e of g.edges.values()) {
    if (!adj.has(e.a)) adj.set(e.a, [])
    if (!adj.has(e.b)) adj.set(e.b, [])
    adj.get(e.a)!.push(e.b)
    adj.get(e.b)!.push(e.a)
  }
  return adj
}

function dropCollinear(poly: FloorPoint[]): FloorPoint[] {
  let pts = poly
  for (let changed = true; changed && pts.length > 3; ) {
    changed = false
    for (let i = 0; i < pts.length; i++) {
      const p = pts[(i - 1 + pts.length) % pts.length]!
      const c = pts[i]!
      const n = pts[(i + 1) % pts.length]!
      const cross = (c.x - p.x) * (n.y - c.y) - (c.y - p.y) * (n.x - c.x)
      const dot = (c.x - p.x) * (n.x - c.x) + (c.y - p.y) * (n.y - c.y)
      const scale = Math.hypot(c.x - p.x, c.y - p.y) * Math.hypot(n.x - c.x, n.y - c.y)
      if (scale > 0 && Math.abs(cross) / scale < 0.004 && dot > 0) {
        pts = pts.filter((_, k) => k !== i)
        changed = true
        break
      }
    }
  }
  return pts
}

function facesOf(g: Graph, minArea: number): FloorFace[] {
  const adj = adjacency(g)
  // Prune dangling spurs so open-ended walls never leak into a face outline.
  for (let pruned = true; pruned; ) {
    pruned = false
    for (const [n, list] of adj) {
      if (list.length <= 1) {
        for (const m of list) adj.set(m, adj.get(m)!.filter((x) => x !== n))
        adj.delete(n)
        pruned = true
      }
    }
  }
  for (const [n, list] of adj) {
    const o = g.nodes[n]!
    list.sort(
      (p, q) =>
        Math.atan2(g.nodes[p]!.y - o.y, g.nodes[p]!.x - o.x) -
        Math.atan2(g.nodes[q]!.y - o.y, g.nodes[q]!.x - o.x),
    )
  }
  const seen = new Set<string>()
  const faces: FloorFace[] = []
  for (const [u0, list] of adj) {
    for (const v0 of list) {
      if (seen.has(`${u0}>${v0}`)) continue
      const loop: number[] = []
      let u = u0
      let v = v0
      let guard = 0
      while (!seen.has(`${u}>${v}`) && guard++ < 10000) {
        seen.add(`${u}>${v}`)
        loop.push(u)
        const around = adj.get(v)!
        const i = around.indexOf(u)
        const w = around[(i - 1 + around.length) % around.length]!
        u = v
        v = w
      }
      if (loop.length < 3) continue
      const raw = loop.map((n) => g.nodes[n]!)
      if (signedPolygonArea(raw) <= 0) continue // outer boundary of a component
      const polygon = dropCollinear(raw)
      if (polygon.length < 3) continue
      const area = Math.abs(signedPolygonArea(polygon))
      if (area < minArea) continue
      const ids = new Set<string>()
      for (let k = 0; k < loop.length; k++) {
        const e = g.edges.get(edgeKey(loop[k]!, loop[(k + 1) % loop.length]!))
        e?.wallIds.forEach((id) => ids.add(id))
      }
      faces.push({ polygon: polygon.map((p) => ({ x: p.x, y: p.y })), area, wallIds: [...ids].filter((id) => id !== BRIDGE_ID) })
    }
  }
  return faces
}

/** All enclosed areas formed by `walls` (one level's worth), gap-tolerant. */
export function detectFloorFaces(walls: ReadonlyArray<FloorWall>, opts: FloorDetectOptions = {}): FloorFace[] {
  const tol = opts.snapTol ?? DEFAULT_SNAP_TOL_CM
  const sane = walls.filter(
    (w) => [w.start.x, w.start.y, w.end.x, w.end.y].every(Number.isFinite),
  )
  if (sane.length < 3) return []
  return facesOf(buildGraph(sane, tol), opts.minArea ?? DEFAULT_MIN_FLOOR_AREA_CM2)
}

/** Smallest face containing `p`, or null. */
export function faceAt(faces: ReadonlyArray<FloorFace>, p: FloorPoint): FloorFace | null {
  let best: FloorFace | null = null
  for (const f of faces) {
    if (pointInPolygon(p, f.polygon) && (!best || f.area < best.area)) best = f
  }
  return best
}

/** True when `roomPoints` already is (about) this face — so no new floor is needed. */
export function roomCoversFace(roomPoints: ReadonlyArray<readonly [number, number]>, face: FloorFace): boolean {
  if (roomPoints.length < 3) return false
  const poly = roomPoints.map(([x, y]) => ({ x, y }))
  const roomArea = Math.abs(signedPolygonArea(poly))
  if (roomArea <= 0) return false
  const ratio = face.area / roomArea
  return ratio > 0.85 && ratio < 1.15 && pointInPolygon(interiorPoint(face.polygon), poly)
}

function distToSegment(p: FloorPoint, a: FloorPoint, b: FloorPoint): { d: number; t: number; foot: FloorPoint } {
  const dx = b.x - a.x
  const dy = b.y - a.y
  const len2 = dx * dx + dy * dy
  const t = len2 === 0 ? 0 : ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2
  const c = Math.max(0, Math.min(1, t))
  const foot = { x: a.x + dx * c, y: a.y + dy * c }
  return { d: Math.hypot(p.x - foot.x, p.y - foot.y), t, foot }
}

/**
 * Near-closed loops: a dangling wall end within `maxGap` of another dangling
 * end (or of another wall's body) such that one bridging wall would enclose a
 * new floor. Nearest first.
 */
export function detectFloorGaps(walls: ReadonlyArray<FloorWall>, opts: GapOptions = {}): FloorGap[] {
  const tol = opts.snapTol ?? DEFAULT_SNAP_TOL_CM
  const minArea = opts.minArea ?? DEFAULT_MIN_FLOOR_AREA_CM2
  const maxGap = opts.maxGap ?? DEFAULT_MAX_GAP_CM
  const sane = walls.filter((w) => [w.start.x, w.start.y, w.end.x, w.end.y].every(Number.isFinite))
  if (sane.length < 2) return []
  const g = buildGraph(sane, tol)
  const adj = adjacency(g)
  const dangling = [...adj.entries()].filter(([n, l]) => l.length === 1 && g.endpointOwner.has(n)).map(([n]) => n)
  const segs = [...g.edges.values()]

  const candidates: Array<{ from: number; to: FloorPoint; d: number }> = []
  for (const d of dangling) {
    const p = g.nodes[d]!
    for (const e of dangling) {
      if (e <= d) continue
      const dist = Math.hypot(g.nodes[e]!.x - p.x, g.nodes[e]!.y - p.y)
      if (dist > tol && dist <= maxGap) candidates.push({ from: d, to: g.nodes[e]!, d: dist })
    }
    let nearest: { d: number; foot: FloorPoint } | null = null
    for (const s of segs) {
      if (s.a === d || s.b === d) continue
      const r = distToSegment(p, g.nodes[s.a]!, g.nodes[s.b]!)
      if (r.t <= 0.02 || r.t >= 0.98) continue // endpoints are covered by the dangling-pair case
      if (r.d > tol && r.d <= maxGap && (!nearest || r.d < nearest.d)) nearest = { d: r.d, foot: r.foot }
    }
    if (nearest) candidates.push({ from: d, to: nearest.foot, d: nearest.d })
  }
  candidates.sort((a, b) => a.d - b.d)

  const out: FloorGap[] = []
  const baseKeys = new Set(facesOf(g, minArea).map(faceKey))
  for (const c of candidates) {
    if (out.length >= (opts.limit ?? 12)) break
    const a = g.nodes[c.from]!
    const crosses = segs.some((s) => {
      if (s.a === c.from || s.b === c.from) return false
      return properCrossing(a, c.to, g.nodes[s.a]!, g.nodes[s.b]!) !== null
    })
    if (crosses) continue
    const faces = facesOf(buildGraph(sane, tol, { a, b: c.to }), minArea).filter((f) => !baseKeys.has(faceKey(f)))
    if (faces.length === 0) continue
    const face = faces.reduce((p, q) => (p.area <= q.area ? p : q))
    out.push({ from: { ...a }, to: { ...c.to }, distance: c.d, fromWallId: g.endpointOwner.get(c.from)!, face })
  }
  return out
}

function faceKey(f: FloorFace): string {
  const cx = f.polygon.reduce((s, p) => s + p.x, 0) / f.polygon.length
  const cy = f.polygon.reduce((s, p) => s + p.y, 0) / f.polygon.length
  return `${Math.round(f.area / 50)}:${Math.round(cx / 5)}:${Math.round(cy / 5)}`
}
