/**
 * floor-assist — pure helpers behind the floor-creation UX (hover highlight,
 * one-click floor, near-closed gap hints, room-tool snapping). The engine owns
 * state and side effects; everything here is a function of plain data so it
 * stays unit-testable.
 */
import {
  detectFloorFaces,
  detectFloorGaps,
  faceAt,
  roomCoversFace,
  type FloorFace,
  type FloorGap,
  type FloorPoint,
  type FloorWall,
} from '../core/floor-detect'

export interface AssistWall {
  id: string
  xStart: number
  yStart: number
  xEnd: number
  yEnd: number
  arcExtent?: number | null
  levelRef?: string | null
}

export interface AssistRoom {
  points: Array<[number, number]>
  levelRef?: string | null
}

export function toFloorWalls(walls: ReadonlyArray<AssistWall>, onLevel: (levelRef: string | null | undefined) => boolean): FloorWall[] {
  return walls
    .filter((w) => onLevel(w.levelRef))
    .map((w) => ({
      id: w.id,
      start: { x: w.xStart, y: w.yStart },
      end: { x: w.xEnd, y: w.yEnd },
      arcExtent: w.arcExtent,
    }))
}

function signature(walls: ReadonlyArray<FloorWall>): string {
  let s = ''
  for (const w of walls) s += `${w.id}:${w.start.x},${w.start.y},${w.end.x},${w.end.y},${w.arcExtent ?? 0};`
  return s
}

/** Memoises face/gap detection until the wall geometry actually changes. */
export class FloorDetectionCache {
  private sig = ''
  private cachedFaces: FloorFace[] = []
  private gapSig = ''
  private cachedGaps: FloorGap[] = []

  faces(walls: ReadonlyArray<FloorWall>): FloorFace[] {
    const sig = signature(walls)
    if (sig !== this.sig) {
      this.sig = sig
      this.cachedFaces = detectFloorFaces(walls)
    }
    return this.cachedFaces
  }

  gaps(walls: ReadonlyArray<FloorWall>, maxGap: number): FloorGap[] {
    const sig = `${maxGap}|${signature(walls)}`
    if (sig !== this.gapSig) {
      this.gapSig = sig
      this.cachedGaps = detectFloorGaps(walls, { maxGap })
    }
    return this.cachedGaps
  }
}

/** Does any room on the level already provide this face's floor? */
export function faceHasRoom(
  face: FloorFace,
  rooms: ReadonlyArray<AssistRoom>,
  onLevel: (levelRef: string | null | undefined) => boolean,
): boolean {
  return rooms.some((r) => onLevel(r.levelRef) && roomCoversFace(r.points, face))
}

/** Smallest enclosed area under `p` that does not have a floor yet. */
export function uncoveredFaceAt(
  faces: ReadonlyArray<FloorFace>,
  rooms: ReadonlyArray<AssistRoom>,
  p: FloorPoint,
  onLevel: (levelRef: string | null | undefined) => boolean,
): FloorFace | null {
  const free = faces.filter((f) => !faceHasRoom(f, rooms, onLevel))
  return faceAt(free, p)
}

export function formatAreaM2(areaCm2: number): string {
  return `${(areaCm2 / 10000).toFixed(2)} m²`
}

export type RoomSnapKind = 'corner' | 'align' | 'grid' | 'none'

export interface RoomSnapResult {
  point: FloorPoint
  kind: RoomSnapKind
  /** Dashed alignment guides (model space) to draw while snapped. */
  guides: Array<{ from: FloorPoint; to: FloorPoint }>
}

/**
 * Snap a room-tool cursor: wall corners / existing floor corners first, then
 * horizontal/vertical alignment with the previous vertex, the first vertex and
 * any corner, then the grid.
 */
export function snapRoomPoint(args: {
  point: FloorPoint
  radius: number
  corners: ReadonlyArray<FloorPoint>
  prev: FloorPoint | null
  first: FloorPoint | null
  grid?: (p: FloorPoint) => FloorPoint
  align?: boolean
}): RoomSnapResult {
  const { point, radius, corners, prev, first, grid } = args
  let best: FloorPoint | null = null
  let bestD = radius
  for (const c of corners) {
    const d = Math.hypot(c.x - point.x, c.y - point.y)
    if (d <= bestD) {
      best = c
      bestD = d
    }
  }
  if (best) return { point: { x: best.x, y: best.y }, kind: 'corner', guides: [] }

  if (args.align !== false) {
    const refs: FloorPoint[] = []
    if (prev) refs.push(prev)
    if (first) refs.push(first)
    refs.push(...corners)
    let x = point.x
    let y = point.y
    let rx: FloorPoint | null = null
    let ry: FloorPoint | null = null
    let dxBest = radius * 0.6
    let dyBest = radius * 0.6
    for (const r of refs) {
      const dx = Math.abs(r.x - point.x)
      const dy = Math.abs(r.y - point.y)
      if (dx <= dxBest) {
        dxBest = dx
        x = r.x
        rx = r
      }
      if (dy <= dyBest) {
        dyBest = dy
        y = r.y
        ry = r
      }
    }
    if (rx || ry) {
      const snapped = { x, y }
      const guides: RoomSnapResult['guides'] = []
      if (rx) guides.push({ from: { x, y: rx.y }, to: snapped })
      if (ry) guides.push({ from: { x: ry.x, y }, to: snapped })
      return { point: snapped, kind: 'align', guides }
    }
  }
  if (grid) return { point: grid(point), kind: 'grid', guides: [] }
  return { point: { x: point.x, y: point.y }, kind: 'none', guides: [] }
}
