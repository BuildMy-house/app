/**
 * Template authoring DSL. A template is a tiling of rectangular rooms on
 * wall-centerline coordinates; walls, floor polygons, door/window attachment
 * and furniture coordinates are derived so each plan stays geometrically
 * consistent. `compileTemplate` emits the flat TemplatePlan the app loads.
 */
import type { TemplatePlan, TemplateWall } from '../../src/templates/types'
import { ITEMS, OPENINGS, type ItemId, type OpeningId } from './items'

export type Side = 'n' | 'e' | 's' | 'w'
type Floor = 'wood-oak' | 'wood-pine' | 'carpet' | 'tile-floor' | 'concrete'

const EXT = 20
const INT = 10
const WALL_HEIGHT = 250

interface RoomDef {
  id: string
  name: string
  /** [x1, y1, x2, y2] on wall centerlines, cm. */
  rect: [number, number, number, number]
  floor: Floor
  /** Sides left without a wall (open plan). Applies to the shared edge. */
  open?: Side[]
  /** Room kind used for bedroom/bathroom counts. */
  kind?: 'bedroom' | 'bath' | 'other'
  /** Count as exterior living space rather than interior (porch, deck): no floor area in totals. */
  outdoor?: boolean
}

interface OpeningDef {
  room: string
  side: Side
  /** Center, cm from the room's rect start along that side (left for n/s, top for e/w). */
  at: number | 'center'
  style: OpeningId
  width?: number
}

export interface FurnDef {
  room: string
  item: ItemId
  /** Against a wall: back to that wall. `at` is the center along it from the inner start. */
  wall?: Side
  at?: number | 'center' | 'start' | 'end'
  /** Distance off the wall face (cm). */
  gap?: number
  /** Free placement: center in inner-room coordinates. 'c' = room center. */
  x?: number | 'c'
  y?: number | 'c'
  /** Front direction for free placement (default: faces south). */
  face?: Side
  /** Size overrides (cm); default to the catalog item's. */
  w?: number
  d?: number
  h?: number
  elev?: number
  name?: string
  color?: number
}

export interface TemplateDef {
  id: string
  name: string
  category: string
  description: string
  features: string[]
  rooms: RoomDef[]
  openings: OpeningDef[]
  furniture: FurnDef[]
}

interface Edge {
  horizontal: boolean
  fixed: number
  from: number
  to: number
  room: RoomDef
  side: Side
}

interface Seg {
  horizontal: boolean
  fixed: number
  from: number
  to: number
  thickness: number
}

const round = (n: number) => Math.round(n * 10) / 10

function edgesOf(room: RoomDef): Edge[] {
  const [x1, y1, x2, y2] = room.rect
  return [
    { horizontal: true, fixed: y1, from: x1, to: x2, room, side: 'n' },
    { horizontal: true, fixed: y2, from: x1, to: x2, room, side: 's' },
    { horizontal: false, fixed: x1, from: y1, to: y2, room, side: 'w' },
    { horizontal: false, fixed: x2, from: y1, to: y2, room, side: 'e' },
  ]
}

/** Atomic wall segments (split at every junction, shared edges once), then merged per line. */
function buildSegments(rooms: RoomDef[]): Seg[] {
  const edges = rooms.flatMap(edgesOf)
  const lines = new Map<string, Edge[]>()
  for (const e of edges) {
    const key = `${e.horizontal ? 'h' : 'v'}${e.fixed}`
    lines.set(key, [...(lines.get(key) ?? []), e])
  }
  const out: Seg[] = []
  for (const group of lines.values()) {
    const points = [...new Set(group.flatMap((e) => [e.from, e.to]))].sort((a, b) => a - b)
    const atoms: Seg[] = []
    for (let i = 0; i + 1 < points.length; i++) {
      const a = points[i]!
      const b = points[i + 1]!
      const covering = group.filter((e) => e.from <= a && e.to >= b)
      if (covering.length === 0) continue
      if (covering.some((e) => e.room.open?.includes(e.side))) continue
      atoms.push({ horizontal: group[0]!.horizontal, fixed: group[0]!.fixed, from: a, to: b, thickness: covering.length > 1 ? INT : EXT })
    }
    for (const atom of atoms) {
      const last = out[out.length - 1]
      if (last && last.horizontal === atom.horizontal && last.fixed === atom.fixed && last.to === atom.from && last.thickness === atom.thickness) last.to = atom.to
      else out.push({ ...atom })
    }
  }
  return out
}

/** Inner (floor) rectangle of a room: centerline rect inset by half the wall thickness on walled sides. */
function innerRect(room: RoomDef, segs: Seg[]): [number, number, number, number] {
  const [x1, y1, x2, y2] = room.rect
  const inset = (edge: Edge) => {
    if (room.open?.includes(edge.side)) return 0
    const t = segs
      .filter((s) => s.horizontal === edge.horizontal && s.fixed === edge.fixed && s.from < edge.to && s.to > edge.from)
      .map((s) => s.thickness)
    return t.length ? Math.max(...t) / 2 : 0
  }
  const e = Object.fromEntries(edgesOf(room).map((edge) => [edge.side, edge])) as Record<Side, Edge>
  return [x1 + inset(e.w), y1 + inset(e.n), x2 - inset(e.e), y2 - inset(e.s)]
}

/** SH3D angle: 0 = front faces south (+y); positive turns clockwise on screen. */
const FACE_ANGLE: Record<Side, number> = { s: 0, w: 90, n: 180, e: 270 }
/** Back against this wall => front faces the opposite side. */
const WALL_ANGLE: Record<Side, number> = { n: 0, e: 90, s: 180, w: 270 }

export interface CompiledTemplate {
  plan: TemplatePlan
  /** Per opening: unit vector pointing into the room it opens onto (for plan drawings). */
  inward: Array<[number, number]>
  /** Per room: floor rectangle, plus whether it is outdoor/bedroom/bath. */
  rooms: Array<{ id: string; kind: RoomDef['kind']; outdoor: boolean }>
}

export function compileTemplate(def: TemplateDef): CompiledTemplate {
  const segs = buildSegments(def.rooms)
  const rooms = new Map(def.rooms.map((r) => [r.id, r]))
  const room = (id: string) => {
    const r = rooms.get(id)
    if (!r) throw new Error(`${def.id}: unknown room ${id}`)
    return r
  }

  const walls: TemplateWall[] = segs.map((s, i) => ({
    key: `wall-${i + 1}`,
    xStart: s.horizontal ? s.from : s.fixed,
    yStart: s.horizontal ? s.fixed : s.from,
    xEnd: s.horizontal ? s.to : s.fixed,
    yEnd: s.horizontal ? s.fixed : s.to,
    thickness: s.thickness,
    height: WALL_HEIGHT,
  }))

  const planRooms = def.rooms.map((r) => {
    const [ix1, iy1, ix2, iy2] = innerRect(r, segs)
    return {
      name: r.name,
      points: [[ix1, iy1], [ix2, iy1], [ix2, iy2], [ix1, iy2]] as Array<[number, number]>,
      floorTextureId: r.floor,
    }
  })

  const inward: Array<[number, number]> = []
  const openings = def.openings.map((o) => {
    const r = room(o.room)
    const [x1, y1, x2, y2] = r.rect
    const horizontal = o.side === 'n' || o.side === 's'
    const fixed = o.side === 'n' ? y1 : o.side === 's' ? y2 : o.side === 'w' ? x1 : x2
    const start = horizontal ? x1 : y1
    const length = horizontal ? x2 - x1 : y2 - y1
    const pos = start + (o.at === 'center' ? length / 2 : o.at)
    const idx = segs.findIndex((s) => s.horizontal === horizontal && s.fixed === fixed && s.from <= pos && s.to >= pos)
    if (idx < 0) throw new Error(`${def.id}: opening on ${o.room}/${o.side} at ${o.at} hits no wall`)
    const style = OPENINGS[o.style]
    const width = o.width ?? style.w
    inward.push(o.side === 'n' ? [0, 1] : o.side === 's' ? [0, -1] : o.side === 'w' ? [1, 0] : [-1, 0])
    return {
      kind: style.kind,
      name: style.name,
      wallKey: walls[idx]!.key,
      offset: round(pos - segs[idx]!.from),
      catalogId: style.catalog,
      width,
      depth: style.d,
      height: style.h,
      elevation: style.elev,
    }
  })

  const furniture = def.furniture.map((f) => {
    const item = ITEMS[f.item] as import('./items').Item
    const [ix1, iy1, ix2, iy2] = innerRect(room(f.room), segs)
    const w = f.w ?? item.w
    const d = f.d ?? item.d
    let x: number
    let y: number
    let angle: number
    if (f.wall) {
      const gap = f.gap ?? 0
      const horizontal = f.wall === 'n' || f.wall === 's'
      const length = horizontal ? ix2 - ix1 : iy2 - iy1
      const along = f.at === 'start' ? w / 2 : f.at === 'end' ? length - w / 2 : f.at === 'center' || f.at === undefined ? length / 2 : f.at
      angle = WALL_ANGLE[f.wall]
      if (f.wall === 'n') [x, y] = [ix1 + along, iy1 + gap + d / 2]
      else if (f.wall === 's') [x, y] = [ix1 + along, iy2 - gap - d / 2]
      else if (f.wall === 'w') [x, y] = [ix1 + gap + d / 2, iy1 + along]
      else [x, y] = [ix2 - gap - d / 2, iy1 + along]
    } else {
      x = ix1 + (f.x === 'c' || f.x === undefined ? (ix2 - ix1) / 2 : f.x)
      y = iy1 + (f.y === 'c' || f.y === undefined ? (iy2 - iy1) / 2 : f.y)
      angle = FACE_ANGLE[f.face ?? 's']
    }
    return {
      name: f.name ?? item.name,
      ...(item.catalog ? { catalogId: item.catalog } : {}),
      x: round(x),
      y: round(y),
      angleDeg: angle,
      width: w,
      depth: d,
      height: f.h ?? item.h,
      elevation: f.elev ?? item.elev ?? 0,
      ...((f.color ?? item.color) !== undefined ? { color: f.color ?? item.color } : {}),
    }
  })

  return {
    plan: { schemaVersion: 1, id: def.id, name: def.name, walls, rooms: planRooms, openings, furniture },
    inward,
    rooms: def.rooms.map((r) => ({ id: r.id, kind: r.kind, outdoor: r.outdoor === true })),
  }
}

/** Consecutive floor-standing pieces along one wall, e.g. a kitchen run. */
export function run(roomId: string, wall: Side, start: number, items: ItemId[], extra: Partial<FurnDef> = {}): FurnDef[] {
  let cursor = start
  return items.map((item) => {
    const w = ITEMS[item].w
    const f: FurnDef = { room: roomId, item, wall, at: cursor + w / 2, ...extra }
    cursor += w
    return f
  })
}
