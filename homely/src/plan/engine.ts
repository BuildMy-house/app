import type { HomeModel } from '../core/model'
import { ModelError, NEW_WALL_PATTERN_ID, NEW_WALL_THICKNESS_CM } from '../core/model'
import { DEFAULT_WALL_HEIGHT_CM } from '../core/home'
import type { NormalizedHomeState } from '../core/home'
import { wallPointMagnetism } from './magnetism'
import {
  distance,
  distToSegment,
  type Point,
} from './geometry'

export const PLAN_SCALE = 1
export const PIXEL_MARGIN = 4 * PLAN_SCALE
export const WALL_ENDS_PIXEL_MARGIN = 2 * PLAN_SCALE
const EPSILON = 1e-6
const ENDPOINT_HIT_RADIUS = 10
const CONNECTED_WALL_EPSILON = 0.1

export type HitResult =
  | { kind: 'wall-endpoint'; wallId: string; endpoint: 'start' | 'end' }
  | { kind: 'wall-body'; id: string }
  | { kind: 'furniture'; id: string }
  | { kind: 'room'; id: string }
  | { kind: 'room-vertex'; roomId: string; vertexIndex: number }
  | { kind: 'label'; id: string }
  | { kind: 'dimension'; id: string }

export type PlanTool =
  | 'selection'
  | 'panning'
  | 'wall'
  | 'room'
  | 'polyline'
  | 'dimensionLine'
  | 'label'

export interface ClickInput {
  x: number
  y: number
  dbl?: boolean
  shift?: boolean
  altOrMeta?: boolean
}

export interface DragInput {
  fromX: number
  fromY: number
  toX: number
  toY: number
  shift?: boolean
  altOrMeta?: boolean
}

export type PlanKey = 'escape' | 'delete' | 'backspace'

interface Segment {
  start: Point
  end: Point
}

export interface PlanPreview {
  tool: PlanTool
  phase: 'idle' | 'drawing'
  chainStart: Point | null
  pendingWalls: Array<Segment>
  roomPoints: Array<[number, number]>
  dimensionLine: { start: Point; end: Point; length: number } | null
}

function samePoint(a: Point, b: Point): boolean {
  return Math.abs(a.x - b.x) < EPSILON && Math.abs(a.y - b.y) < EPSILON
}

export class PlanEngine {
  private readonly model: HomeModel
  private tool: PlanTool = 'selection'
  private magnetismEnabled = true
  /** Last position reported by move_mouse (SH3D parity: cursor pre-position). */
  private lastMove: Point | null = null
  private phase: 'idle' | 'drawing' = 'idle'
  private chainStart: Point | null = null
  /** Walls already committed to the home during the open drawing session. */
  private chainIds: Array<string> = []
  private sessionOpen = false
  /** Polygon vertices collected during a room-tool drawing session. */
  private roomPoints: Array<[number, number]> = []
  /** Start point of a dimension-line-tool drawing session. */
  private dimensionStart: Point | null = null
  private vertexDrag: { wallId: string; endpoint: 'start' | 'end'; startX: number; startY: number; connectedWalls: Array<{ wallId: string; endpoint: 'start' | 'end' }> } | null = null
  private roomVertexDrag: { roomId: string; vertexIndex: number; startX: number; startY: number } | null = null
  private activeLevelId: string | null = null
  private wallHeightCm = DEFAULT_WALL_HEIGHT_CM
  private wallThicknessCm = NEW_WALL_THICKNESS_CM

  constructor(model: HomeModel) {
    this.model = model
  }

  setActiveLevel(id: string | null): void {
    this.activeLevelId = id
  }

  getActiveLevel(): string | null {
    return this.activeLevelId
  }

  setWallDefaults(heightCm: number, thicknessCm: number): void {
    this.wallHeightCm = heightCm
    this.wallThicknessCm = thicknessCm
  }

  getWallDefaults(): { heightCm: number; thicknessCm: number } {
    return { heightCm: this.wallHeightCm, thicknessCm: this.wallThicknessCm }
  }

  private homeSnapshot(): NormalizedHomeState {
    return this.model.getStore().getHome()
  }

  getTool(): PlanTool {
    return this.tool
  }

  setTool(tool: PlanTool): void {
    this.validateTool(tool)
    if (this.phase === 'drawing') {
      if (this.tool === 'room') this.cancelRoomDrawing()
      else if (this.tool === 'dimensionLine') this.cancelDimensionLine()
      else this.validateDrawnWalls()
    }
    this.tool = tool
    if (tool !== 'wall' && tool !== 'room' && tool !== 'dimensionLine' && tool !== 'label') this.phase = 'idle'
    // Mirror the tool into home state without polluting undo history.
    this.model.getStore().patchNonUndoable((h) => {
      h.activeTool = tool === 'panning' ? 'panning' : (tool as never)
    })
  }

  setMagnetism(enabled: boolean): void {
    this.magnetismEnabled = enabled === true
  }

  isMagnetismEnabled(): boolean {
    return this.magnetismEnabled
  }

  /** Records the cursor position (SH3D moveMouse). Clicks carry explicit
   * coordinates in this clone, so move_mouse is advisory/preview only. */
  moveMouse(x: number, y: number): void {
    if (typeof x !== 'number' || !Number.isFinite(x) || typeof y !== 'number' || !Number.isFinite(y)) {
      throw new ModelError('move_mouse params x,y must be finite numbers')
    }
    this.lastMove = { x, y }
  }

  getLastMove(): Point | null {
    return this.lastMove
  }

  getPreview(): PlanPreview {
    const dim =
      this.tool === 'dimensionLine' && this.phase === 'drawing' && this.dimensionStart && this.lastMove
        ? {
            start: this.dimensionStart,
            end: this.lastMove,
            length: distance(this.dimensionStart, this.lastMove),
          }
        : null
    return {
      tool: this.tool,
      phase: this.phase,
      chainStart: this.chainStart,
      // Walls enter the home at each click (SH3D WallDrawingState), so the
      // renderer draws them from the store snapshot; nothing stays pending.
      pendingWalls: [],
      roomPoints: this.roomPoints.map(([x, y]) => [x, y] as [number, number]),
      dimensionLine: dim,
    }
  }

  hitTestPoint(point: Point): HitResult | null {
    return this.hitTest(this.homeSnapshot(), point)
  }

  isVertexDragging(): boolean {
    return this.vertexDrag !== null
  }

  click(input: ClickInput): void {
    this.validateClick(input)
    const point = { x: input.x, y: input.y }
    if (input.dbl) {
      this.doubleClick(point)
    } else {
      this.singleClick(point, input.shift === true)
    }
  }

  drag(input: DragInput): void {
    this.validateDrag(input)
    const from = { x: input.fromX, y: input.fromY }
    const to = { x: input.toX, y: input.toY }
    if (this.tool !== 'selection') return
    const home = this.homeSnapshot()
    const hit = this.hitTest(home, from)
    if (hit) {
      if (hit.kind === 'wall-endpoint') {
        if (!this.vertexDrag) {
          const wall = home.walls.find((w) => w.id === hit.wallId)
          if (!wall) return
          const sharedPoint = hit.endpoint === 'start'
            ? { x: wall.xStart, y: wall.yStart }
            : { x: wall.xEnd, y: wall.yEnd }
          const connected = this.findConnectedWalls(home, hit.wallId, sharedPoint)
          const startX = hit.endpoint === 'start' ? wall.xStart : wall.xEnd
          const startY = hit.endpoint === 'start' ? wall.yStart : wall.yEnd
          this.vertexDrag = {
            wallId: hit.wallId,
            endpoint: hit.endpoint,
            startX,
            startY,
            connectedWalls: connected,
          }
          if (!home.selection.includes(hit.wallId)) {
            this.model.setSelection([hit.wallId])
          }
        }
        const newX = this.vertexDrag.startX + (to.x - from.x)
        const newY = this.vertexDrag.startY + (to.y - from.y)
        this.model.setWallEndpoint(this.vertexDrag.wallId, this.vertexDrag.endpoint, newX, newY)
        for (const cw of this.vertexDrag.connectedWalls) {
          this.model.setWallEndpoint(cw.wallId, cw.endpoint, newX, newY)
        }
        this.vertexDrag = null
        return
      }
      if (hit.kind === 'room-vertex') {
        if (!this.roomVertexDrag) {
          const room = home.rooms.find((r) => r.id === hit.roomId)
          if (!room || hit.vertexIndex < 0 || hit.vertexIndex >= room.points.length) return
          const [startX, startY] = room.points[hit.vertexIndex]!
          this.roomVertexDrag = { roomId: hit.roomId, vertexIndex: hit.vertexIndex, startX, startY }
          if (!home.selection.includes(hit.roomId)) {
            this.model.setSelection([hit.roomId])
          }
        }
        const state = this.roomVertexDrag!
        const newX = state.startX + (to.x - from.x)
        const newY = state.startY + (to.y - from.y)
        const room = home.rooms.find((r) => r.id === state.roomId)
        if (!room) return
        const points = room.points.map((point, i) =>
          i === state.vertexIndex
            ? ([newX, newY] as [number, number])
            : point,
        )
        this.model.updateRoom(state.roomId, { points })
        this.roomVertexDrag = null
        return
      }
      if (!home.selection.includes(hit.id)) {
        this.model.setSelection([hit.id])
      }
      this.model.moveSelection(to.x - from.x, to.y - from.y)
    } else {
      const minX = Math.min(from.x, to.x)
      const maxX = Math.max(from.x, to.x)
      const minY = Math.min(from.y, to.y)
      const maxY = Math.max(from.y, to.y)
      const inside = (p: Point) =>
        p.x >= minX && p.x <= maxX && p.y >= minY && p.y <= maxY
      const picked = new Set<string>()
      for (const wall of home.walls) {
        const mid = {
          x: (wall.xStart + wall.xEnd) / 2,
          y: (wall.yStart + wall.yEnd) / 2,
        }
        if (
          inside({ x: wall.xStart, y: wall.yStart }) ||
          inside({ x: wall.xEnd, y: wall.yEnd }) ||
          inside(mid)
        ) {
          picked.add(wall.id)
        }
      }
      for (const room of home.rooms) {
        const sumX = room.points.reduce((acc: number, pt) => acc + pt[0], 0)
        const sumY = room.points.reduce((acc: number, pt) => acc + pt[1], 0)
        const cx = sumX / room.points.length
        const cy = sumY / room.points.length
        if (inside({ x: cx, y: cy })) picked.add(room.id)
      }
      for (const furniture of home.furniture) {
        if (inside({ x: furniture.x, y: furniture.y })) picked.add(furniture.id)
      }
      const merged =
        input.shift === true
          ? [...new Set([...home.selection, ...picked])]
          : [...picked]
      this.model.setSelection(merged)
    }
  }

  key(key: PlanKey): void {
    if (key !== 'escape' && key !== 'delete' && key !== 'backspace') {
      throw new ModelError(`unsupported key ${JSON.stringify(key)}`)
    }
    if (key === 'delete' || key === 'backspace') {
      const selection = this.homeSnapshot().selection
      if (selection.length > 0) this.model.removeItems(selection)
      return
    }
    if (key !== 'escape') return

    if (this.tool === 'wall' && this.phase === 'drawing') {
      this.validateDrawnWalls()
      return
    }
    if (this.tool === 'room' && this.phase === 'drawing') {
      this.cancelRoomDrawing()
      return
    }
    if (this.tool === 'dimensionLine' && this.phase === 'drawing') {
      this.cancelDimensionLine()
      return
    }
    this.setTool('selection')
  }

  private singleClick(point: Point, shift: boolean): void {
    if (this.tool === 'selection') {
      const home = this.homeSnapshot()
      const hit = this.hitTest(home, point)
      if (!hit) {
        if (!shift) this.model.setSelection([])
        return
      }
      const hitId =
        hit.kind === 'wall-endpoint'
          ? hit.wallId
          : hit.kind === 'room-vertex'
            ? hit.roomId
            : hit.id
      const selection = home.selection
      if (shift) {
        this.model.setSelection(
          selection.includes(hitId)
            ? selection.filter((id) => id !== hitId)
            : [...selection, hitId],
        )
      } else if (!selection.includes(hitId)) {
        this.model.setSelection([hitId])
      } else {
        this.model.setSelection([...selection])
      }
      return
    }
    // Frozen protocol creates rooms/dimension-lines/labels via dedicated
    // automation commands (add_room/add_dimension_line/add_label), not via
    // plan clicks. Fail loudly instead of silently producing nothing.
    if (this.tool === 'room') {
      this.roomClick(point)
      return
    }
    if (this.tool === 'dimensionLine') {
      this.dimensionLineClick(point)
      return
    }
    if (this.tool === 'label') {
      this.labelClick(point)
      return
    }
    if (this.tool === 'polyline') {
      throw new ModelError('polyline tool is not supported')
    }
    if (this.tool !== 'wall') return

    if (this.phase === 'idle') {
      const start = this.resolveChainStart(point)
      // SH3D parity: the whole drawing session is ONE compound undo edit
      // posted at validateDrawnWalls, while each wall enters the home AT ITS
      // CLICK (the top camera moves on click 2 — first wall committed then).
      this.model.getStore().beginCompoundEdit()
      this.sessionOpen = true
      this.chainIds = []
      this.model.setSelection([])
      this.chainStart = start
      this.phase = 'drawing'
      return
    }

    const start = this.chainStart!
    const end = this.resolveSegmentEnd(start, point)
    if (distance(start, end) <= 0) return
    this.commitChainWall(start, end)
    this.chainStart = end
  }

  private doubleClick(point: Point): void {
    if (this.tool === 'room' && this.phase === 'drawing') {
      this.closeRoom()
      return
    }
    if (this.tool !== 'wall' || this.phase !== 'drawing') return
    const start = this.chainStart!
    const end = this.resolveSegmentEnd(start, point)
    if (distance(start, end) > 0) {
      // joinNewWallEndToWall: the closing piece from the last wall's end.
      this.commitChainWall(start, end)
    }
    this.validateDrawnWalls()
  }

  private commitChainWall(start: Point, end: Point): void {
    const wall = this.model.addWall({
      xStart: start.x,
      yStart: start.y,
      xEnd: end.x,
      yEnd: end.y,
      thickness: this.wallThicknessCm,
      height: this.wallHeightCm,
      patternId: NEW_WALL_PATTERN_ID,
      levelRef: this.activeLevelId ?? undefined,
    })
    this.chainIds.push(wall.id)
  }

  /**
   * Seals the drawing session as ONE compound undo edit and selects its walls
   * (SH3D PlanController.java:10912); rooms come ONLY from the room tool.
   */
  private validateDrawnWalls(): void {
    const ids = this.chainIds
    this.chainIds = []
    this.chainStart = null
    this.phase = 'idle'
    if (ids.length > 0) this.model.setSelection(ids)
    if (this.sessionOpen) {
      this.model.getStore().endCompoundEdit()
      this.sessionOpen = false
    }
  }

  // ── Room tool ─────────────────────────────────────────────────────────────

  private roomClick(point: Point): void {
    if (this.phase === 'idle') {
      this.roomPoints = [[point.x, point.y]]
      this.phase = 'drawing'
      this.chainStart = point
      return
    }
    if (this.roomPoints.length >= 3) {
      const first = this.roomPoints[0]!
      if (distance(point, { x: first[0], y: first[1] }) <= ENDPOINT_HIT_RADIUS) {
        this.closeRoom()
        return
      }
    }
    this.roomPoints.push([point.x, point.y])
    this.chainStart = point
  }

  private closeRoom(): void {
    const points = this.roomPoints
    this.roomPoints = []
    this.phase = 'idle'
    this.chainStart = null
    if (points.length < 3) return
    this.model.getStore().beginCompoundEdit()
    const room = this.model.addRoom(points, { levelRef: this.activeLevelId ?? undefined })
    this.model.setSelection([room.id])
    this.model.getStore().endCompoundEdit()
  }

  private cancelRoomDrawing(): void {
    this.roomPoints = []
    this.phase = 'idle'
    this.chainStart = null
  }

  // ── Dimension-line tool ───────────────────────────────────────────────────

  private dimensionLineClick(point: Point): void {
    if (this.phase === 'idle') {
      this.dimensionStart = point
      this.chainStart = point
      this.phase = 'drawing'
      return
    }
    const start = this.dimensionStart!
    this.dimensionStart = null
    this.chainStart = null
    this.phase = 'idle'
    if (distance(start, point) <= 0) return
    this.model.getStore().beginCompoundEdit()
    const dim = this.model.addDimensionLine({
      xStart: start.x,
      yStart: start.y,
      xEnd: point.x,
      yEnd: point.y,
      offset: 0,
      levelRef: this.activeLevelId ?? undefined,
    })
    this.model.setSelection([dim.id])
    this.model.getStore().endCompoundEdit()
  }

  private cancelDimensionLine(): void {
    this.dimensionStart = null
    this.chainStart = null
    this.phase = 'idle'
  }

  // ── Label tool ────────────────────────────────────────────────────────────

  private labelClick(point: Point): void {
    this.model.getStore().beginCompoundEdit()
    const label = this.model.addLabel({ text: 'Text', x: point.x, y: point.y, levelRef: this.activeLevelId ?? undefined })
    this.model.setSelection([label.id])
    this.model.getStore().endCompoundEdit()
  }

  /**
   * Chain start snaps to a FREE end/start of an existing wall within
   * PIXEL_MARGIN (getWallEndAt/getWallStartAt semantics); otherwise it is
   * the plain point (no angle reference exists for the first click).
   */
  private resolveChainStart(point: Point): Point {
    const home = this.homeSnapshot()
    const free = this.freeEndpointAt(home, point, PIXEL_MARGIN)
    if (free) return free
    return point
  }

  /**
   * Segment end resolution order (SH3D WallDrawingState.moveMouse):
   * 1. exact join onto a FREE endpoint within PIXEL_MARGIN
   * 2. angle+length magnetization plus per-axis wall-endpoint snapping
   */
  private resolveSegmentEnd(start: Point, point: Point): Point {
    const home = this.homeSnapshot()
    const free = this.freeEndpointAt(home, point, PIXEL_MARGIN)
    if (free) return free
    return wallPointMagnetism(start, point, home.walls, {
      enabled: this.magnetismEnabled,
      maxDelta: PLAN_SCALE,
      endpointMargin: WALL_ENDS_PIXEL_MARGIN * 2,
    })
  }

  private freeEndpointAt(
    home: NormalizedHomeState,
    point: Point,
    margin: number,
  ): Point | null {
    let best: Point | null = null
    let bestDist = margin
    const candidates: Array<{ p: Point; occupied: boolean }> = []
    for (const wall of home.walls) {
      // Committed walls (including ones from the open drawing session) are
      // join targets exactly like SH3D, where drawn walls live in the home.
      candidates.push(
        {
          p: { x: wall.xStart, y: wall.yStart },
          occupied: this.hasOtherWallAt(home, wall.id, { x: wall.xStart, y: wall.yStart }),
        },
        {
          p: { x: wall.xEnd, y: wall.yEnd },
          occupied: this.hasOtherWallAt(home, wall.id, { x: wall.xEnd, y: wall.yEnd }),
        },
      )
    }
    for (const candidate of candidates) {
      if (candidate.occupied) continue
      const dist = distance(point, candidate.p)
      if (dist <= bestDist) {
        bestDist = dist
        best = candidate.p
      }
    }
    return best
  }

  private hasOtherWallAt(
    home: NormalizedHomeState,
    wallId: string,
    point: Point,
  ): boolean {
    return home.walls.some(
      (other) =>
        other.id !== wallId &&
        (samePoint(point, { x: other.xStart, y: other.yStart }) ||
          samePoint(point, { x: other.xEnd, y: other.yEnd })),
    )
  }

  private findConnectedWalls(
    home: NormalizedHomeState,
    excludeWallId: string,
    point: Point,
  ): Array<{ wallId: string; endpoint: 'start' | 'end' }> {
    const connected: Array<{ wallId: string; endpoint: 'start' | 'end' }> = []
    for (const wall of home.walls) {
      if (wall.id === excludeWallId) continue
      if (distance(point, { x: wall.xStart, y: wall.yStart }) <= CONNECTED_WALL_EPSILON) {
        connected.push({ wallId: wall.id, endpoint: 'start' })
      } else if (distance(point, { x: wall.xEnd, y: wall.yEnd }) <= CONNECTED_WALL_EPSILON) {
        connected.push({ wallId: wall.id, endpoint: 'end' })
      }
    }
    return connected
  }

  private matchesActiveLevel(levelRef: string | null | undefined): boolean {
    if (this.activeLevelId === null) return true
    return (levelRef ?? null) === this.activeLevelId
  }

  private hitTest(home: NormalizedHomeState, point: Point): HitResult | null {
    // 1. Wall endpoints first (highest priority)
    for (let i = home.walls.length - 1; i >= 0; i--) {
      const wall = home.walls[i]!
      if (!this.matchesActiveLevel(wall.levelRef)) continue
      if (distance(point, { x: wall.xStart, y: wall.yStart }) <= ENDPOINT_HIT_RADIUS) {
        return { kind: 'wall-endpoint', wallId: wall.id, endpoint: 'start' }
      }
      if (distance(point, { x: wall.xEnd, y: wall.yEnd }) <= ENDPOINT_HIT_RADIUS) {
        return { kind: 'wall-endpoint', wallId: wall.id, endpoint: 'end' }
      }
    }
    // 2. Wall body
    for (let i = home.walls.length - 1; i >= 0; i--) {
      const wall = home.walls[i]!
      if (!this.matchesActiveLevel(wall.levelRef)) continue
      const dist = distToSegment(
        point,
        { x: wall.xStart, y: wall.yStart },
        { x: wall.xEnd, y: wall.yEnd },
      )
      if (dist <= Math.max(wall.thickness / 2, 2) + 2) {
        return { kind: 'wall-body', id: wall.id }
      }
    }
    // 3. Furniture
    for (let i = home.furniture.length - 1; i >= 0; i--) {
      const f = home.furniture[i]!
      if (!this.matchesActiveLevel(f.levelRef)) continue
      if (
        point.x >= f.x - f.width / 2 &&
        point.x <= f.x + f.width / 2 &&
        point.y >= f.y - f.depth / 2 &&
        point.y <= f.y + f.depth / 2
      ) {
        return { kind: 'furniture', id: f.id }
      }
    }
    // 4. Rooms
    for (const room of home.rooms) {
      if (!this.matchesActiveLevel(room.levelRef)) continue
      for (let i = 0; i < room.points.length; i++) {
        const [px, py] = room.points[i]!
        if (distance(point, { x: px, y: py }) <= ENDPOINT_HIT_RADIUS) {
          return { kind: 'room-vertex', roomId: room.id, vertexIndex: i }
        }
      }
      if (this.pointInPolygon(point, room.points)) return { kind: 'room', id: room.id }
    }
    // 5. Labels
    for (const label of home.labels) {
      if (!this.matchesActiveLevel(label.levelRef)) continue
      if (Math.abs(point.x - label.x) <= 20 && Math.abs(point.y - label.y) <= 10) {
        return { kind: 'label', id: label.id }
      }
    }
    // 6. Dimension lines
    for (const dim of home.dimensionLines) {
      if (!this.matchesActiveLevel(dim.levelRef)) continue
      const dist = distToSegment(
        point,
        { x: dim.xStart, y: dim.yStart },
        { x: dim.xEnd, y: dim.yEnd },
      )
      if (dist <= PIXEL_MARGIN) return { kind: 'dimension', id: dim.id }
    }
    return null
  }

  private pointInPolygon(point: Point, polygon: Array<[number, number]>): boolean {
    let inside = false
    for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
      const xi = polygon[i]![0]!
      const yi = polygon[i]![1]!
      const xj = polygon[j]![0]!
      const yj = polygon[j]![1]!
      const intersects =
        yi > point.y !== yj > point.y &&
        point.x < ((xj - xi) * (point.y - yi)) / (yj - yi) + xi
      if (intersects) inside = !inside
    }
    return inside
  }

  private validateTool(tool: PlanTool): void {
    const allowed: Array<PlanTool> = [
      'selection',
      'panning',
      'wall',
      'room',
      'polyline',
      'dimensionLine',
      'label',
    ]
    if (!allowed.includes(tool)) {
      throw new ModelError(`unknown tool ${JSON.stringify(tool)}`)
    }
  }

  private validateClick(input: ClickInput): void {
    if (typeof input?.x !== 'number' || !Number.isFinite(input.x)) {
      throw new ModelError('click param x must be a finite number')
    }
    if (typeof input?.y !== 'number' || !Number.isFinite(input.y)) {
      throw new ModelError('click param y must be a finite number')
    }
  }

  private validateDrag(input: DragInput): void {
    for (const field of ['fromX', 'fromY', 'toX', 'toY'] as const) {
      const value = input?.[field]
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        throw new ModelError(`drag param ${field} must be a finite number`)
      }
    }
  }
}

