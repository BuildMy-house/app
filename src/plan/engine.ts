import type { HomeModel } from '../core/model'
import { ModelError, NEW_WALL_PATTERN_ID, NEW_WALL_THICKNESS_CM } from '../core/model'
import { DEFAULT_WALL_HEIGHT_CM, getDefaultFloorColor, getDefaultCeilingVisibility } from '../core/home'
import type { NormalizedHomeState } from '../core/home'
import { normalizeAngle } from '../core/export'
import type { WallLoop } from '../core/wall-loop-detector'
import { detectClosedLoops } from '../core/wall-loop-detector'
import { AutoFloorDialog } from '../ui/AutoFloorDialog'
import { pointWithAngleMagnetism, wallPointMagnetism } from './magnetism'
import { snapFurniturePlacement } from './furniture-snap'
import {
  distance,
  distToSegment,
  signedArea,
  type Point,
} from './geometry'
import { ViewMapper, getLastCursorPx, getLastDrawnView } from './renderer'

export const PLAN_SCALE = 1
export const PIXEL_MARGIN = 4 * PLAN_SCALE
export const WALL_ENDS_PIXEL_MARGIN = 2 * PLAN_SCALE
/**
 * Finding A.1: the "pixel" margins above are actually WORLD units (cm) — the
 * engine is world-space only and never sees the view transform, so the real
 * on-screen snap radius is margin × view.scale. Zoomed out (scale < 1) the
 * 4-unit PIXEL_MARGIN shrinks below 4 screen px and clicking near a wall end
 * (to start, continue, or close a chain) misses it. endpointSnapMargin()
 * compensates by converting a constant screen-space radius (~10 px, a
 * comfortable click target) into world units at the live view scale, clamped
 * so it stays usable when zoomed far out (min) and not absurdly grabby when
 * zoomed far in (max).
 */
export const ENDPOINT_SNAP_RADIUS_PX = 10
const ENDPOINT_SNAP_MIN_WORLD = 4
const ENDPOINT_SNAP_MAX_WORLD = 40

/** Screen-space endpoint snap radius converted to world units at the current view scale. */
function endpointSnapMargin(): number {
  const scale = getLastDrawnView()?.scale ?? 1
  return Math.min(ENDPOINT_SNAP_MAX_WORLD, Math.max(ENDPOINT_SNAP_MIN_WORLD, ENDPOINT_SNAP_RADIUS_PX / scale))
}
const EPSILON = 1e-6
const ENDPOINT_HIT_RADIUS = 10
const CONNECTED_WALL_EPSILON = 0.1
const ROTATION_HANDLE_OFFSET = 20

/** Model-space position of the rotation handle for a furniture item. */
export function furnitureRotationHandlePos(f: { x: number; y: number; depth: number; angleDeg: number }): Point {
  const angleRad = (f.angleDeg * Math.PI) / 180
  const cos = Math.cos(angleRad)
  const sin = Math.sin(angleRad)
  const hd = f.depth / 2
  return {
    x: f.x + (hd + ROTATION_HANDLE_OFFSET) * sin,
    y: f.y - (hd + ROTATION_HANDLE_OFFSET) * cos,
  }
}

/** Perpendicular unit vector to a wall's chord (points in the CCW bulge direction). */
function wallChordNormal(wall: { xStart: number; yStart: number; xEnd: number; yEnd: number }): { x: number; y: number } {
  const dx = wall.xEnd - wall.xStart
  const dy = wall.yEnd - wall.yStart
  const len = Math.hypot(dx, dy)
  if (len <= EPSILON) return { x: 0, y: 0 }
  return { x: dy / len, y: -dx / len }
}

/**
 * Model-space position of the round-wall (arc) handle for a wall: the arc's
 * midpoint on the centerline. For a straight wall (arcExtent 0) this is the
 * chord midpoint. The signed perpendicular distance from the chord to the
 * handle is the arc sagitta.
 */
export function wallArcHandlePos(wall: {
  xStart: number
  yStart: number
  xEnd: number
  yEnd: number
  arcExtent?: number | null
}): Point {
  const xMid = (wall.xStart + wall.xEnd) / 2
  const yMid = (wall.yStart + wall.yEnd) / 2
  const n = wallChordNormal(wall)
  if (n.x === 0 && n.y === 0) return { x: xMid, y: yMid }
  const a = typeof wall.arcExtent === 'number' && Number.isFinite(wall.arcExtent) ? wall.arcExtent : 0
  const len = Math.hypot(wall.xEnd - wall.xStart, wall.yEnd - wall.yStart)
  const sagitta = (len / 2) * Math.tan(a / 4)
  return { x: xMid + n.x * sagitta, y: yMid + n.y * sagitta }
}

export type HitResult =
  | { kind: 'wall-endpoint'; wallId: string; endpoint: 'start' | 'end' }
  | { kind: 'wall-arc'; id: string }
  | { kind: 'wall-body'; id: string }
  | { kind: 'furniture-rotate'; id: string }
  | { kind: 'furniture'; id: string }
  | { kind: 'room'; id: string }
  | { kind: 'room-vertex'; roomId: string; vertexIndex: number }
  | { kind: 'roof'; id: string }
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
  | 'roof'

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

export type PlanKey = 'escape' | 'delete' | 'backspace' | 'arrow-up' | 'arrow-down' | 'arrow-left' | 'arrow-right'

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
  marquee: { from: Point; to: Point } | null
  closurePolygon: Array<Point> | null
  closureTooltip: { text: string; x: number; y: number } | null
  /** Endpoint the cursor is currently locked onto (zoom-aware snap), for the visual indicator. */
  snapLock: Point | null
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
  private furnitureRotateDrag: { id: string } | null = null
  private wallArcDrag: { id: string } | null = null
  private activeLevelId: string | null = null
  /** T12: rooms whose boundary loop dissolved (wall deleted/moved apart).
   *  Stays in the model, flagged for a future cleanup ticket. */
  private orphanedRoomIds = new Set<string>()
  private referenceOverlayEnabled = true
  private wallHeightCm = DEFAULT_WALL_HEIGHT_CM
  private wallThicknessCm = NEW_WALL_THICKNESS_CM
  /** Marquee selection state: set on drag-start on empty space, updated on
   *  drag-move, cleared on drag-end (selection is applied at the same time). */
  private marqueeFrom: Point | null = null
  private marqueeTo: Point | null = null
  private _marqueeActive = false
  private closurePolygon: Array<Point> | null = null
  private closureTooltip: { text: string; x: number; y: number } | null = null
  private snapLock: Point | null = null

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
    if (this._marqueeActive) this._endMarqueeDrag(false)
    this.marqueeFrom = null
    this.marqueeTo = null
    if (this.phase === 'drawing') {
      if (this.tool === 'room') this.cancelRoomDrawing()
      else if (this.tool === 'dimensionLine') this.cancelDimensionLine()
      else this.validateDrawnWalls()
    }
    this.tool = tool
    this.closurePolygon = null
    this.closureTooltip = null
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

  setReferenceOverlay(enabled: boolean): void {
    this.referenceOverlayEnabled = enabled === true
  }

  isReferenceOverlayEnabled(): boolean {
    return this.referenceOverlayEnabled
  }

  /**
   * Open the auto-floor confirmation dialog for a detected wall loop.
   * Instantiates the real AutoFloorDialog UI and wires confirm/cancel callbacks.
   * Skipped in non-browser environments (tests).
   */
  openAutoFloorDialog(loop: WallLoop): void {
    // Skip dialog in non-browser environments (unit tests run in Node)
    if (typeof document === 'undefined') {
      return
    }
    const dialog = new AutoFloorDialog(
      loop,
      () => this.createRoomFromLoop(loop),
      () => { /* skip — user cancelled */ },
    )
    dialog.open()
  }

  /**
   * T6: creation-time defaults applied to EVERY new room — all creation
   * paths (loop dialog, double-click enclosure, wall-completion auto-floor,
   * manual room tool) route through addRoom with these args, so this is the
   * single injection point for preference-driven defaults (T5).
   *
   * Decision call: the ceiling *color* preference is NOT applied per-room —
   * the Room model has no ceilingColor field (core/home.ts, core/model.ts and
   * view3d/scene.ts hard-code DEFAULT_CEILING_COLOR are outside this task's
   * engine.ts-only scope). The representable ceiling default — visibility —
   * is applied; wire defaultCeilingColor in here once the model grows a
   * ceilingColor field.
   */
  private roomDefaults(home: NormalizedHomeState) {
    return {
      floorColor: getDefaultFloorColor(home),
      ceilingVisible: getDefaultCeilingVisibility(home),
      levelRef: this.activeLevelId ?? undefined,
    }
  }

  /** Create a room from a detected wall loop. */
  createRoomFromLoop(loop: WallLoop): void {
    const home = this.homeSnapshot()
    this.model.getStore().beginCompoundEdit()
    this.model.addRoom(
      loop.vertices.map((p) => [p.x, p.y] as [number, number]),
      this.roomDefaults(home),
    )
    this.model.getStore().endCompoundEdit()
  }

  /**
   * Finalize wall completion: detect closed loops in the wall pattern.
   * Called when wall editing ends. Returns detected loops for room creation (T3).
   *
   * @param walls - Walls from the home model (with xStart/yStart/xEnd/yEnd)
   * @param activeLevelId - Optional level filter (null = all levels)
   * @returns Array of detected closed loops (empty if none or invalid input)
   */
  finalizeWallCompletion(
    walls: Array<{
      id: string
      xStart: number
      yStart: number
      xEnd: number
      yEnd: number
      levelRef?: string | null
    }>,
    activeLevelId?: string | null,
  ): WallLoop[] {
    if (!walls || walls.length < 3) return []

    const filtered = activeLevelId != null
      ? walls.filter((w) => (w.levelRef ?? null) === activeLevelId)
      : walls

    if (filtered.length < 3) return []

    const detectorWalls = filtered.map((w) => ({
      id: w.id,
      start: { x: w.xStart, y: w.yStart },
      end: { x: w.xEnd, y: w.yEnd },
    }))

    return detectClosedLoops(detectorWalls)
  }

  /** Resolve the overlay toggle from a persisted preference. Missing or
   *  'true' → on (the default for new users); 'false' → explicitly off.
   */
  static referenceOverlayFromStored(stored: string | null): boolean {
    return stored !== 'false'
  }

  private gridSnapEnabled = false
  private gridSnapSizeCm = 10

  setGridSnap(enabled: boolean, sizeCm?: number): void {
    this.gridSnapEnabled = enabled === true
    if (sizeCm != null && sizeCm > 0) this.gridSnapSizeCm = sizeCm
  }

  isGridSnapEnabled(): boolean {
    return this.gridSnapEnabled
  }

  getGridSnapSize(): number {
    return this.gridSnapSizeCm
  }

  /** Snap a model-space point to the nearest grid intersection. */
  snapToGrid(x: number, y: number): Point {
    const s = this.gridSnapSizeCm
    return { x: Math.round(x / s) * s, y: Math.round(y / s) * s }
  }

  /** Records the cursor position (SH3D moveMouse). Clicks carry explicit
   * coordinates in this clone, so move_mouse is advisory/preview only. */
  moveMouse(x: number, y: number): void {
    if (typeof x !== 'number' || !Number.isFinite(x) || typeof y !== 'number' || !Number.isFinite(y)) {
      throw new ModelError('move_mouse params x,y must be finite numbers')
    }
    this.lastMove = { x, y }
    if (this.tool === 'wall' && this.phase === 'drawing') {
      this.detectClosurePreview({ x, y })
    }
  }

  getLastMove(): Point | null {
    return this.lastMove
  }

  /**
   * During wall drawing, check if releasing the next wall endpoint at `point`
   * (connected back to `chainStart`) would close a loop. If so, set the
   * closure preview polygon and tooltip for live feedback.
   */
  private detectClosurePreview(point: Point): void {
    if (this.tool !== 'wall' || this.phase !== 'drawing' || !this.chainStart) {
      this.closurePolygon = null
      this.closureTooltip = null
      return
    }

    // Don't show preview if cursor is at the chain start (zero-length wall).
    if (distance(this.chainStart, point) <= ENDPOINT_HIT_RADIUS) {
      this.closurePolygon = null
      this.closureTooltip = null
      return
    }

    const home = this.homeSnapshot()
    const levelWalls = home.walls.filter((w) => this.matchesActiveLevel(w.levelRef))

    // Finding A.2: the raw cursor is up to the whole snap margin away from the
    // vertex the click will actually land on, so simulating the closing wall
    // with the raw point misses the chain origin and no loop is ever found
    // with a real mouse. Resolve through the same pipeline the click uses.
    const resolved = this.resolveSegmentEnd(this.chainStart, point)
    this.snapLock = this.freeEndpointAt(home, point, endpointSnapMargin())

    // Simulate adding a closing wall from chainStart to the resolved cursor.
    const closingWall = {
      id: '__closure_preview__',
      start: { x: this.chainStart.x, y: this.chainStart.y },
      end: { x: resolved.x, y: resolved.y },
    }

    const allWalls = [
      ...levelWalls.map((w) => ({
        id: w.id,
        start: { x: w.xStart, y: w.yStart },
        end: { x: w.xEnd, y: w.yEnd },
      })),
      closingWall,
    ]

    const loops = detectClosedLoops(allWalls)

    // Find a loop that uses the closing wall (its vertices match the wall endpoints).
    for (const loop of loops) {
      const hasClosing = loop.vertices.some(
        (v) =>
          (Math.abs(v.x - closingWall.start.x) < EPSILON && Math.abs(v.y - closingWall.start.y) < EPSILON) ||
          (Math.abs(v.x - closingWall.end.x) < EPSILON && Math.abs(v.y - closingWall.end.y) < EPSILON),
      )
      if (hasClosing && loop.vertices.length >= 3) {
        this.closurePolygon = loop.vertices.map((v) => ({ x: v.x, y: v.y }))
        this.closureTooltip = {
          text: 'Close room? (Double-click to finish)',
          x: point.x,
          y: point.y,
        }
        return
      }
    }

    this.closurePolygon = null
    this.closureTooltip = null
  }

  /**
   * Finding A.2: the real canvas pointermove handler (main.ts) never calls the
   * engine — move_mouse only arrives from the automation runner — so the
   * closure preview never updated during interactive drawing. Bridge it here:
   * each frame the renderer-tracked cursor/view feed the same closure
   * detection move_mouse would. No-ops in tests/automation where nothing is
   * tracked.
   */
  private syncInteractiveCursor(): void {
    this.snapLock = null
    if (this.tool !== 'wall' || this.phase !== 'drawing' || !this.chainStart) {
      this.closurePolygon = null
      this.closureTooltip = null
      return
    }
    const px = getLastCursorPx()
    const view = getLastDrawnView()
    if (!px || !view) return
    this.detectClosurePreview(new ViewMapper(view).toModel(px.x, px.y))
  }

  getPreview(): PlanPreview {
    this.syncInteractiveCursor()
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
      marquee:
        this._marqueeActive && this.marqueeFrom && this.marqueeTo
          ? { from: this.marqueeFrom, to: this.marqueeTo }
          : null,
      closurePolygon: this.closurePolygon,
      closureTooltip: this.closureTooltip,
      snapLock: this.snapLock,
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
    if (this.tool !== 'selection') {
      if (this._marqueeActive) this._endMarqueeDrag(false)
      return
    }
    const home = this.homeSnapshot()
    const hit = this.hitTest(home, from)

    if (hit) {
      if (this._marqueeActive) this._endMarqueeDrag(input.shift === true)
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
        const vd = this.vertexDrag
        if (!vd) return
        let rawX = vd.startX + (to.x - from.x)
        let rawY = vd.startY + (to.y - from.y)
        if (this.gridSnapEnabled) {
          const g = this.snapToGrid(rawX, rawY)
          rawX = g.x
          rawY = g.y
        }
        const draggedWall = home.walls.find((w) => w.id === vd.wallId)
        if (!draggedWall) return
        const oppositeEnd = vd.endpoint === 'start'
          ? { x: draggedWall.xEnd, y: draggedWall.yEnd }
          : { x: draggedWall.xStart, y: draggedWall.yStart }
        // SH3D WallResizeState.moveMouse: WallPointWithAngleMagnetism anchors
        // on the opposite endpoint and snaps to OTHER walls' endpoints.
        // Gate the whole magnetizer on the toggle (the helper keeps snapping
        // endpoints even with enabled:false, so gate here for SH3D parity).
        let snapped: Point
        if (this.magnetismEnabled) {
          const otherWalls = home.walls.filter((w) => w.id !== vd.wallId && this.matchesActiveLevel(w.levelRef))
          snapped = wallPointMagnetism(
            oppositeEnd,
            { x: rawX, y: rawY },
            otherWalls,
            {
              enabled: true,
              maxDelta: PLAN_SCALE,
              endpointMargin: WALL_ENDS_PIXEL_MARGIN * 2,
            },
          )
          // Cross-level: if same-level didn't snap, try reference walls.
          if (
            this.referenceOverlayEnabled && this.activeLevelId != null
            && snapped.x === rawX && snapped.y === rawY
          ) {
            const refWalls = home.walls.filter(
              (w) => w.id !== vd.wallId && !this.matchesActiveLevel(w.levelRef),
            )
            if (refWalls.length > 0) {
              snapped = wallPointMagnetism(
                oppositeEnd,
                { x: rawX, y: rawY },
                refWalls,
                {
                  enabled: true,
                  maxDelta: PLAN_SCALE,
                  endpointMargin: WALL_ENDS_PIXEL_MARGIN * 2,
                },
              )
            }
          }
        } else {
          snapped = { x: rawX, y: rawY }
        }
        this.model.getStore().beginCompoundEdit()
        this.model.setWallEndpoint(vd.wallId, vd.endpoint, snapped.x, snapped.y)
        for (const cw of vd.connectedWalls) {
          this.model.setWallEndpoint(cw.wallId, cw.endpoint, snapped.x, snapped.y)
        }
        // T11: rooms whose boundary loop contains a moved wall follow the new
        // geometry. Inside the same compound edit so one undo reverts both.
        this.updateRoomsAfterWallMove(
          home,
          [vd.wallId, ...vd.connectedWalls.map((cw) => cw.wallId)],
        )
        this.model.getStore().endCompoundEdit()
        this.vertexDrag = null
        return
      }
      if (hit.kind === 'wall-arc') {
        if (!this.wallArcDrag) {
          this.wallArcDrag = { id: hit.id }
          if (!home.selection.includes(hit.id)) {
            this.model.setSelection([hit.id])
          }
        }
        const wall = home.walls.find((w) => w.id === hit.id)
        if (!wall) return
        const len = Math.hypot(wall.xEnd - wall.xStart, wall.yEnd - wall.yStart)
        if (len <= EPSILON) {
          this.wallArcDrag = null
          return
        }
        const n = wallChordNormal(wall)
        const xMid = (wall.xStart + wall.xEnd) / 2
        const yMid = (wall.yStart + wall.yEnd) / 2
        // Signed sagitta = perpendicular distance of the cursor from the chord.
        const s = (to.x - xMid) * n.x + (to.y - yMid) * n.y
        let arcExtent = 4 * Math.atan((2 * s) / len)
        arcExtent = Math.max(-Math.PI, Math.min(Math.PI, arcExtent))
        if (Math.abs(arcExtent) < 1e-3) arcExtent = 0
        this.model.updateWall(hit.id, { arcExtent })
        this.wallArcDrag = null
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
        let rawX = state.startX + (to.x - from.x)
        let rawY = state.startY + (to.y - from.y)
        if (this.gridSnapEnabled) {
          const snapped = this.snapToGrid(rawX, rawY)
          rawX = snapped.x
          rawY = snapped.y
        }
        const room = home.rooms.find((r) => r.id === state.roomId)
        if (!room) return
        let newX = rawX
        let newY = rawY
        if (this.magnetismEnabled) {
          // SH3D RoomResizeState.moveMouse: first try an exact corner-to-corner
          // snap onto another room vertex or wall endpoint (clean join), else
          // round onto the previous vertex's 15° rays and length grid.
          const snapped = this.snapRoomPointToClosestCorner(room, state.vertexIndex, { x: rawX, y: rawY })
          if (snapped) {
            newX = snapped.x
            newY = snapped.y
          } else {
            const previous = room.points[
              state.vertexIndex === 0 ? room.points.length - 1 : state.vertexIndex - 1
            ]!
            const magnetized = pointWithAngleMagnetism(
              { x: previous[0], y: previous[1] },
              { x: rawX, y: rawY },
              PLAN_SCALE,
            )
            newX = magnetized.x
            newY = magnetized.y
          }
        }
        const points = room.points.map((point, i) =>
          i === state.vertexIndex
            ? ([newX, newY] as [number, number])
            : point,
        )
        this.model.updateRoom(state.roomId, { points })
        this.roomVertexDrag = null
        return
      }
      if (hit.kind === 'furniture-rotate') {
        if (!this.furnitureRotateDrag) {
          this.furnitureRotateDrag = { id: hit.id }
          if (!home.selection.includes(hit.id)) {
            this.model.setSelection([hit.id])
          }
        }
        const f = home.furniture.find((f) => f.id === hit.id)
        if (!f) return
        const angleRad = Math.atan2(to.x - f.x, -(to.y - f.y))
        const angleDeg = (angleRad * 180) / Math.PI
        this.model.updateFurniture(hit.id, { angleDeg: normalizeAngle(angleDeg) })
        this.furnitureRotateDrag = null
        return
      }
      if (hit.kind === 'furniture') {
        if (!home.selection.includes(hit.id)) {
          this.model.setSelection([hit.id])
        }
        const f = home.furniture.find((f) => f.id === hit.id)
        if (f) {
          let naive = {
            x: f.x + (to.x - from.x),
            y: f.y + (to.y - from.y),
          }
          if (this.gridSnapEnabled) naive = this.snapToGrid(naive.x, naive.y)
          const snap = snapFurniturePlacement({
            walls: home.walls,
            point: naive,
            depthCm: f.depth,
            magnetismEnabled: this.magnetismEnabled,
          })
          const snapped =
            snap.x !== naive.x || snap.y !== naive.y
          if (snapped) {
            const dx = snap.x - f.x
            const dy = snap.y - f.y
            this.model.getStore().beginCompoundEdit()
            this.model.moveSelection(dx, dy)
            this.model.updateFurniture(hit.id, {
              angleDeg: normalizeAngle(snap.angleDeg),
            })
            this.model.getStore().endCompoundEdit()
          } else if (this.gridSnapEnabled) {
            const gridX = Math.round((f.x + (to.x - from.x)) / this.gridSnapSizeCm) * this.gridSnapSizeCm
            const gridY = Math.round((f.y + (to.y - from.y)) / this.gridSnapSizeCm) * this.gridSnapSizeCm
            const dx = gridX - f.x
            const dy = gridY - f.y
            this.model.getStore().beginCompoundEdit()
            this.model.moveSelection(dx, dy)
            this.model.getStore().endCompoundEdit()
          } else {
            this.model.moveSelection(to.x - from.x, to.y - from.y)
          }
          return
        }
        this.model.moveSelection(to.x - from.x, to.y - from.y)
        return
      }
      // T11: whole-wall body drag moves walls via moveSelection — rooms on
      // those walls must follow (same release-time update as endpoint drags).
      if (hit.kind === 'wall-body') {
        if (!home.selection.includes(hit.id)) {
          this.model.setSelection([hit.id])
        }
        const moved = new Set<string>(home.selection)
        moved.add(hit.id)
        this.model.moveSelection(to.x - from.x, to.y - from.y)
        this.updateRoomsAfterWallMove(
          home,
          [...moved].filter((id) => home.walls.some((w) => w.id === id)),
        )
        return
      }
      if (!home.selection.includes(hit.id)) {
        this.model.setSelection([hit.id])
      }
      this.model.moveSelection(to.x - from.x, to.y - from.y)
    } else {
      if (!this._marqueeActive) {
        this._marqueeActive = true
        this.marqueeFrom = from
        this.marqueeTo = to
      } else if (this.marqueeFrom && samePoint(this.marqueeFrom, from)) {
        this.marqueeTo = to
      } else {
        this._endMarqueeDrag(input.shift === true)
        this._marqueeActive = true
        this.marqueeFrom = from
        this.marqueeTo = to
      }
      this._applyMarqueeSelection(input.shift === true)
    }
  }

  private _applyMarqueeSelection(shift: boolean): void {
    if (!this.marqueeFrom || !this.marqueeTo) return
    const home = this.homeSnapshot()
    const minX = Math.min(this.marqueeFrom.x, this.marqueeTo.x)
    const maxX = Math.max(this.marqueeFrom.x, this.marqueeTo.x)
    const minY = Math.min(this.marqueeFrom.y, this.marqueeTo.y)
    const maxY = Math.max(this.marqueeFrom.y, this.marqueeTo.y)
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
    for (const dim of home.dimensionLines) {
      const midX = (dim.xStart + dim.xEnd) / 2
      const midY = (dim.yStart + dim.yEnd) / 2
      if (
        inside({ x: dim.xStart, y: dim.yStart }) ||
        inside({ x: dim.xEnd, y: dim.yEnd }) ||
        inside({ x: midX, y: midY })
      ) {
        picked.add(dim.id)
      }
    }
    for (const label of home.labels) {
      if (inside({ x: label.x, y: label.y })) picked.add(label.id)
    }
    const merged =
      shift
        ? [...new Set([...home.selection, ...picked])]
        : [...picked]
    this.model.setSelection(merged)
  }

  private _endMarqueeDrag(shift: boolean): void {
    if (!this._marqueeActive) return
    this._applyMarqueeSelection(shift)
    this._marqueeActive = false
    this.marqueeFrom = null
    this.marqueeTo = null
  }

  key(key: PlanKey, shift = false): void {
    if (key === 'arrow-up' || key === 'arrow-down' || key === 'arrow-left' || key === 'arrow-right') {
      const step = shift ? 10 : 1
      const dx = key === 'arrow-left' ? -step : key === 'arrow-right' ? step : 0
      const dy = key === 'arrow-up' ? -step : key === 'arrow-down' ? step : 0
      if (this.homeSnapshot().selection.length === 0) return
      this.model.moveSelection(dx, dy)
      return
    }
    if (key !== 'escape' && key !== 'delete' && key !== 'backspace') {
      throw new ModelError(`unsupported key ${JSON.stringify(key)}`)
    }
    if (key === 'delete' || key === 'backspace') {
      // Backspace mid-chain walks the wall chain back one step (see
      // removeLastChainPoint) — additive to the compound-undo design below,
      // never touching the real undo stack. Mirrors the Escape mid-chain
      // interception: only while the wall tool is actively drawing.
      if (key === 'backspace' && this.tool === 'wall' && this.phase === 'drawing') {
        this.removeLastChainPoint()
        return
      }
      const before = this.homeSnapshot()
      const selection = before.selection
      if (selection.length === 0) return
      // T12: deleting a wall can dissolve its room's loop — route the removal
      // through the same room-update path so orphaned rooms get flagged.
      const wallIds = new Set(before.walls.map((w) => w.id))
      const deletedWalls = selection.filter((id) => wallIds.has(id))
      this.model.removeItems(selection)
      this.updateRoomsAfterWallMove(before, deletedWalls)
      return
    }
    if (key !== 'escape') return

    if (this._marqueeActive) this._endMarqueeDrag(false)

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
    this.closurePolygon = null
    this.closureTooltip = null
    if (this._marqueeActive) {
      this._marqueeActive = false
      this.marqueeFrom = null
      this.marqueeTo = null
      return
    }
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
    if (this.tool === 'roof') {
      this.roofClick(point)
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
    this.marqueeFrom = null
    this.marqueeTo = null
    if (this.tool === 'roof') {
      const loop = this.findLargestEnclosingWallLoop(point)
      if (loop) {
        this.model.getStore().beginCompoundEdit()
        const roof = this.model.addRoof(
          loop.map((p) => [p.x, p.y] as [number, number]),
          { levelRef: this.activeLevelId ?? undefined },
        )
        this.model.setSelection([roof.id])
        this.model.getStore().endCompoundEdit()
      }
      return
    }
    if (this.tool === 'room') {
      // A real browser double-click fires pointerup→click before dblclick,
      // so singleClick→roomClick has already added 1-2 phantom points at
      // the same position. If all roomPoints are co-located with the dblclick
      // point, this is a trivial drawing session from the gesture itself —
      // reset and try wall-enclosure auto-detect. Otherwise the user was
      // genuinely mid-manual-polygon and wants to close it.
      const isTrivial =
        this.roomPoints.length > 0 &&
        this.roomPoints.every(
          (p) => distance(point, { x: p[0], y: p[1] }) <= ENDPOINT_HIT_RADIUS,
        )
      if (this.phase === 'drawing' && !isTrivial) {
        this.closeRoom()
        return
      }
      if (this.phase === 'drawing') {
        this.roomPoints = []
        this.phase = 'idle'
      }
      const loop = this.findEnclosingWallLoop(point)
      if (loop) {
        const home = this.homeSnapshot()
        this.model.getStore().beginCompoundEdit()
        const room = this.model.addRoom(
          loop.map((p) => [p.x, p.y] as [number, number]),
          this.roomDefaults(home),
        )
        this.model.setSelection([room.id])
        this.model.getStore().endCompoundEdit()
        return
      }
      this.roomClick(point)
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
   * Backspace during an active wall chain (phase === 'drawing'): remove the
   * LAST committed wall and continue the chain from its start point.
   *
   * Deliberately additive to the compound-undo design (validateDrawnWalls /
   * SH3D PlanController.java:10912): the whole session stays ONE undo step,
   * so this mutates the model directly INSIDE the still-open compound edit —
   * no begin/endCompoundEdit, no store.undo()/redo(). After the session is
   * finalized, one Ctrl+Z still reverts everything (removals included)
   * because endCompoundEdit pushes the session's base state in one step.
   *
   * Empty chain (only the first click happened, nothing committed): Backspace
   * means "take back that first click" — cancel the empty session back to
   * idle, staying on the wall tool (mirrors Escape's empty-chain behavior).
   * endCompoundEdit() records no history entry when nothing was ever applied
   * (the store compares compoundBase by reference). Note: a session that
   * had walls committed and then fully rolled back still leaves ONE benign
   * phantom no-op undo entry (apply changed the home reference; content is
   * identical) — content-comparing endCompoundEdit would fix it, not worth
   * the store surgery here.
   *
   * When the pop empties chainIds, chainStart becomes the removed wall's
   * start — which IS the original first-click point — so a separate
   * reset-to-original-start case is unnecessary. Returns true if the chain
   * state changed, false when there was nothing to do (not drawing).
   */
  removeLastChainPoint(): boolean {
    if (this.tool !== 'wall' || this.phase !== 'drawing') return false
    if (this.chainIds.length === 0) {
      this.chainStart = null
      this.phase = 'idle'
      this.closurePolygon = null
      this.closureTooltip = null
      if (this.sessionOpen) {
        this.model.getStore().endCompoundEdit()
        this.sessionOpen = false
      }
      return true
    }
    const wallId = this.chainIds.pop()!
    const wall = this.homeSnapshot().walls.find((w) => w.id === wallId)
    if (wall) this.chainStart = { x: wall.xStart, y: wall.yStart }
    this.closurePolygon = null
    this.closureTooltip = null
    this.model.removeWall(wallId)
    return true
  }

  /**
   * Seals the drawing session as ONE compound undo edit and selects its walls
   * (SH3D PlanController.java:10912).
   *
   * After finalizing, checks for closed wall loops and opens the auto-floor
   * confirmation dialog if one is found. Room creation is gated on user
   * confirmation via confirmAutoFloor().
   */
  private validateDrawnWalls(): void {
    const ids = this.chainIds
    this.chainIds = []
    this.chainStart = null
    this.phase = 'idle'
    this.closurePolygon = null
    this.closureTooltip = null
    if (ids.length > 0) this.model.setSelection(ids)
    if (this.sessionOpen) {
      this.model.getStore().endCompoundEdit()
      this.sessionOpen = false
    }

    if (ids.length >= 3) {
      const loop = this.findClosedLoopFromFinalized(ids)
      if (loop) {
        this.openAutoFloorDialog(loop)
      }
    }
  }

  /**
   * After wall finalization, detect closed loops using WallLoopDetector and
   * return the smallest one that encloses the midpoint of the last wall drawn.
   * Returns null if no valid loop is found.
   */
  private findClosedLoopFromFinalized(wallIds: string[]): WallLoop | null {
    const home = this.homeSnapshot()
    const levelWalls = home.walls.filter(
      (w) => this.matchesActiveLevel(w.levelRef),
    )
    if (levelWalls.length < 3) return null

    const detectorWalls = levelWalls.map((w) => ({
      id: w.id,
      start: { x: w.xStart, y: w.yStart },
      end: { x: w.xEnd, y: w.yEnd },
    }))

    const loops = detectClosedLoops(detectorWalls)
    if (loops.length === 0) return null

    const lastWallId = wallIds[wallIds.length - 1]
    const lastWall = home.walls.find((w) => w.id === lastWallId)
    if (!lastWall) return loops[0] ?? null
    const testPoint: Point = {
      x: (lastWall.xStart + lastWall.xEnd) / 2,
      y: (lastWall.yStart + lastWall.yEnd) / 2,
    }

    let best: WallLoop | null = null
    for (const loop of loops) {
      if (loop.vertices.length < 3) continue
      if (this.pointInPolygon(testPoint, loop.vertices.map((p) => [p.x, p.y] as [number, number]))) {
        if (!best || loop.area < best.area) {
          best = loop
        }
      }
    }

    return best ?? loops.reduce((a, b) => (a.area < b.area ? a : b))
  }

  /**
   * Detect closed wall loops and auto-create rooms for each.
   * Called inside the compound edit session so undo removes auto-created rooms.
   */
  private createRoomsFromWalls(): void {
    const home = this.homeSnapshot()
    const loops = this.finalizeWallCompletion(home.walls, this.activeLevelId)

    for (const loop of loops) {
      const vertices = loop.vertices
      if (!vertices || vertices.length < 3) continue

      if (this.hasDuplicateRoom(vertices, home)) continue

      this.model.addRoom(
        vertices.map((v) => [v.x, v.y] as [number, number]),
        this.roomDefaults(home),
      )
    }
  }

  /** Check if a polygon with the given vertices already exists as a room. */
  private hasDuplicateRoom(
    vertices: Array<{ x: number; y: number }>,
    home: NormalizedHomeState,
  ): boolean {
    return this.findRoomByVertices(vertices, home) !== null
  }

  /** Find the room (active level) whose points exactly match `vertices`
   *  (same count, all points within EPSILON) — the same matching used to
   *  de-duplicate auto-created rooms. */
  private findRoomByVertices(
    vertices: Array<{ x: number; y: number }>,
    home: NormalizedHomeState,
  ): NormalizedHomeState['rooms'][number] | null {
    for (const room of home.rooms) {
      if (!this.matchesActiveLevel(room.levelRef)) continue
      if (room.points.length !== vertices.length) continue
      let match = true
      for (const v of vertices) {
        const found = room.points.some(
          (p) => Math.abs(p[0] - v.x) < EPSILON && Math.abs(p[1] - v.y) < EPSILON,
        )
        if (!found) { match = false; break }
      }
      if (match) return room
    }
    return null
  }

  /**
   * T11: recompute the polygon of rooms whose boundary loop contains a
   * moved wall (replaces PlanController.wallChangeListener from the SH3D
   * reference — in this clone wall moves commit through drag(), which fires
   * once per pointer gesture on mouse release, so updates are inherently
   * debounced to release time; no timer is needed).
   *
   * checkIfWallIsInLoop equivalent: detectClosedLoops + wall membership.
   *
   * Room identification: match against the PRE-move loop by exact vertices
   * (the room's stale polygon is the old loop), then re-point it to the
   * POST-move loop with the same wall-id set. If the loop dissolved (walls
   * no longer close), the room keeps its last polygon — no update needed
   * per ticket. Never writes a degenerate polygon.
   */
  private updateRoomsAfterWallMove(
    before: NormalizedHomeState,
    movedWallIds: string[],
  ): void {
    if (movedWallIds.length === 0) return
    // T12: cross-level isolation — ignore moved walls that don't belong to
    // the active level so foreign-level selections can't rewrite its rooms.
    const offLevel = movedWallIds.filter((id) => {
      const w = before.walls.find((wall) => wall.id === id)
      return w !== undefined && !this.matchesActiveLevel(w.levelRef)
    })
    for (const id of offLevel) {
      const w = before.walls.find((wall) => wall.id === id)
      console.warn(`T12: skipping wall ${id} on level ${w?.levelRef ?? '(none)'} — not on active level ${this.activeLevelId ?? '(none)'}`)
    }
    const moved = new Set(movedWallIds.filter((id) => !offLevel.includes(id)))
    if (moved.size === 0) return
    const levelWalls = before.walls.filter((w) => this.matchesActiveLevel(w.levelRef))
    if (levelWalls.length < 3) return

    const toDetector = (w: { id: string; xStart: number; yStart: number; yEnd: number; xEnd: number; levelRef?: string | null }) => ({
      id: w.id,
      start: { x: w.xStart, y: w.yStart },
      end: { x: w.xEnd, y: w.yEnd },
      levelRef: w.levelRef ?? null,
    })

    const preLoops = detectClosedLoops(levelWalls.map(toDetector))
    const affected = preLoops.filter((loop) => loop.walls.some((w) => moved.has(w.id)))
    if (affected.length === 0) return

    const after = this.homeSnapshot()
    const postLoops = detectClosedLoops(
      after.walls.filter((w) => this.matchesActiveLevel(w.levelRef)).map(toDetector),
    )

    for (const preLoop of affected) {
      const room = this.findRoomByVertices(preLoop.vertices, before)
      if (!room) {
        // Loop exists but no room was ever created for it (or it was edited
        // manually) — warn, don't crash, don't invent an update target.
        console.warn(`T11: wall loop moved but no matching room found (walls: ${preLoop.walls.map((w) => w.id).join(', ')})`)
        continue
      }
      const preIds = new Set(preLoop.walls.map((w) => w.id))
      // T12: multi-level validation — the room must live on the same level as
      // every wall in its boundary loop before we touch its polygon.
      const levelMismatch = preLoop.walls.find((w) => {
        const wall = before.walls.find((bw) => bw.id === w.id)
        return wall !== undefined && (wall.levelRef ?? null) !== (room.levelRef ?? null)
      })
      if (levelMismatch) {
        const wall = before.walls.find((bw) => bw.id === levelMismatch.id)
        console.warn(`T12: level mismatch — room ${room.id} (${room.levelRef ?? 'none'}) vs wall ${levelMismatch.id} (${wall?.levelRef ?? 'none'}); skipping room update`)
        continue
      }
      const post = postLoops.find(
        (l) => l.walls.length === preIds.size && l.walls.every((w) => preIds.has(w.id)),
      )
      if (!post) {
        // T12: the room's loop dissolved (wall deleted or moved apart). Keep
        // the room in the model but mark it orphaned — cleanup is a later
        // ticket; until then it's flagged here and in the undo-able log.
        console.warn(`T12: room ${room.id} orphaned — its wall loop dissolved (walls: ${preLoop.walls.map((w) => w.id).join(', ')})`)
        this.orphanedRoomIds.add(room.id)
        continue
      }
      const points = post.vertices.map((v) => [v.x, v.y] as [number, number])
      if (
        points.length < 3 ||
        points.some(([x, y]) => !Number.isFinite(x) || !Number.isFinite(y))
      ) {
        console.warn(`T11: skipped degenerate polygon for room ${room.id}`)
        continue
      }
      this.model.updateRoom(room.id, { points })
    }
  }

  // ── Room tool ─────────────────────────────────────────────────────────────

  private roomClick(point: Point): void {
    const pt = this.gridSnapEnabled ? this.snapToGrid(point.x, point.y) : point
    if (this.phase === 'idle') {
      this.roomPoints = [[pt.x, pt.y]]
      this.phase = 'drawing'
      this.chainStart = pt
      return
    }
    if (this.roomPoints.length >= 3) {
      const first = this.roomPoints[0]!
      if (distance(pt, { x: first[0], y: first[1] }) <= ENDPOINT_HIT_RADIUS) {
        this.closeRoom()
        return
      }
    }
    this.roomPoints.push([pt.x, pt.y])
    this.chainStart = pt
  }

  private closeRoom(): void {
    const points = this.roomPoints
    this.roomPoints = []
    this.phase = 'idle'
    this.chainStart = null
    if (points.length < 3) return
    const home = this.homeSnapshot()
    this.model.getStore().beginCompoundEdit()
    const room = this.model.addRoom(points, this.roomDefaults(home))
    this.model.setSelection([room.id])
    this.model.getStore().endCompoundEdit()
  }

  private cancelRoomDrawing(): void {
    this.roomPoints = []
    this.phase = 'idle'
    this.chainStart = null
  }

  /**
   * Walk the wall graph to find the smallest enclosing cycle (by area) whose
   * interior contains `point`. Returns the cycle's vertex polygon or null.
   *
   * Scoped to the common rectangular/simple-polygon case: DFS bounded to
   * MAX_CYCLE edges per candidate, picking the smallest-area enclosing face.
   * Works correctly for convex and simple concave enclosures; may miss
   * extremely complex self-touching layouts (acceptable per M64 DoD).
   */
  private findEnclosingWallLoop(point: Point): Array<Point> | null {
    const home = this.homeSnapshot()
    const walls = home.walls.filter((w) => this.matchesActiveLevel(w.levelRef))
    if (walls.length < 3) return null

    const MAX_CYCLE = 10

    // Canonicalize wall endpoints: merge within CONNECTED_WALL_EPSILON.
    const pts: Point[] = []
    const canonicalize = (p: Point): number => {
      for (let i = 0; i < pts.length; i++) {
        if (distance(pts[i] as Point, p) <= CONNECTED_WALL_EPSILON) return i
      }
      pts.push({ x: p.x, y: p.y })
      return pts.length - 1
    }

    // Collect edges (wall-indexed) then build adjacency.
    const edges: Array<[number, number]> = []
    for (const wall of walls) {
      const si = canonicalize({ x: wall.xStart, y: wall.yStart })
      const ei = canonicalize({ x: wall.xEnd, y: wall.yEnd })
      edges.push([si, ei])
    }

    const n = pts.length
    const neighbors: Array<Array<{ node: number; wallIdx: number }>> = Array.from(
      { length: n },
      () => [],
    )
    for (let wi = 0; wi < edges.length; wi++) {
      const [si, ei] = edges[wi]!
      neighbors[si]!.push({ node: ei, wallIdx: wi })
      neighbors[ei]!.push({ node: si, wallIdx: wi })
    }

    let bestCycle: number[] | null = null
    let bestArea = Infinity

    // DFS from each node to find simple cycles containing `point`.
    // Deduplicate by only starting from the lowest-indexed node in each cycle.
    for (let start = 0; start < n; start++) {
      const adj = neighbors[start]
      if (!adj || adj.length === 0) continue

      const stack: Array<{
        node: number
        path: number[]
        usedWalls: Set<number>
      }> = []
      for (const { node, wallIdx } of adj) {
        if (node < start) continue
        stack.push({
          node,
          path: [start, node],
          usedWalls: new Set([wallIdx]),
        })
      }

      while (stack.length > 0) {
        const { node, path, usedWalls } = stack.pop()!
        if (path.length >= MAX_CYCLE) continue

        for (const { node: next, wallIdx } of neighbors[node] ?? []) {
          if (next === start && path.length >= 3) {
            const poly = path.map((i) => pts[i]!)
            if (
              this.pointInPolygon(
                point,
                poly.map((p) => [p.x, p.y]),
              )
            ) {
              const area = Math.abs(signedArea(poly))
              if (area < bestArea) {
                bestArea = area
                bestCycle = [...path]
              }
            }
          } else if (
            next > start &&
            !usedWalls.has(wallIdx) &&
            !path.includes(next)
          ) {
            const nextUsed = new Set(usedWalls)
            nextUsed.add(wallIdx)
            stack.push({
              node: next,
              path: [...path, next],
              usedWalls: nextUsed,
            })
          }
        }
      }
    }

    return bestCycle ? bestCycle.map((i) => pts[i]!) : null
  }

  /**
   * Like findEnclosingWallLoop but returns the LARGEST cycle enclosing the
   * point (max area) — used by the roof tool for footprint auto-detection.
   */
  private findLargestEnclosingWallLoop(point: Point): Array<Point> | null {
    const home = this.homeSnapshot()
    const walls = home.walls.filter((w) => this.matchesActiveLevel(w.levelRef))
    if (walls.length < 3) return null

    const pts: Point[] = []
    function canonicalize(p: Point): number {
      for (let i = 0; i < pts.length; i++) {
        if (distance(pts[i] as Point, p) <= CONNECTED_WALL_EPSILON) return i
      }
      pts.push({ x: p.x, y: p.y })
      return pts.length - 1
    }

    const edges: Array<[number, number]> = []
    for (const wall of walls) {
      const si = canonicalize({ x: wall.xStart, y: wall.yStart })
      const ei = canonicalize({ x: wall.xEnd, y: wall.yEnd })
      edges.push([si, ei])
    }

    const n = pts.length
    const neighbors: Array<Array<{ node: number; wallIdx: number }>> = Array.from(
      { length: n },
      () => [],
    )
    for (let wi = 0; wi < edges.length; wi++) {
      const [si, ei] = edges[wi]!
      neighbors[si]!.push({ node: ei, wallIdx: wi })
      neighbors[ei]!.push({ node: si, wallIdx: wi })
    }

    let bestCycle: number[] | null = null
    let bestArea = -1

    for (let start = 0; start < n; start++) {
      const adj = neighbors[start]
      if (!adj || adj.length === 0) continue

      const stack: Array<{
        node: number
        path: number[]
        usedWalls: Set<number>
      }> = []
      for (const { node, wallIdx } of adj) {
        if (node < start) continue
        stack.push({
          node,
          path: [start, node],
          usedWalls: new Set([wallIdx]),
        })
      }

      while (stack.length > 0) {
        const current = stack.pop()!
        const { node, path, usedWalls } = current

        if (node === start && path.length >= 3) {
          if (!this.pointInPolygon(point, path.map((i) => [pts[i]!.x, pts[i]!.y]))) continue
          const area = Math.abs(
            path.reduce((sum, idx, i) => {
              const next = path[(i + 1) % path.length]!
              return sum + pts[idx]!.x * pts[next]!.y - pts[next]!.x * pts[idx]!.y
            }, 0) / 2,
          )
          if (area > bestArea) {
            bestArea = area
            bestCycle = [...path]
          }
          continue
        }

        if (path.length > n) continue
        const seen = new Set(path)
        for (const { node: next, wallIdx: wi } of neighbors[node]!) {
          if (seen.has(next) && next !== start) continue
          if (usedWalls.has(wi)) continue
          const nextUsed = new Set(usedWalls)
          nextUsed.add(wi)
          stack.push({
            node: next,
            path: [...path, next],
            usedWalls: nextUsed,
          })
        }
      }
    }

    return bestCycle ? bestCycle.map((i) => pts[i]!) : null
  }

  // ── Dimension-line tool ───────────────────────────────────────────────────

  private dimensionLineClick(point: Point): void {
    const pt = this.gridSnapEnabled ? this.snapToGrid(point.x, point.y) : point
    if (this.phase === 'idle') {
      this.dimensionStart = pt
      this.chainStart = pt
      this.phase = 'drawing'
      return
    }
    const start = this.dimensionStart!
    this.dimensionStart = null
    this.chainStart = null
    this.phase = 'idle'
    if (distance(start, pt) <= 0) return
    this.model.getStore().beginCompoundEdit()
    const dim = this.model.addDimensionLine({
      xStart: start.x,
      yStart: start.y,
      xEnd: pt.x,
      yEnd: pt.y,
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

  private roofClick(point: Point): void {
    this.model.getStore().beginCompoundEdit()
    const roof = this.model.addRoof(
      [[point.x, point.y], [point.x + 100, point.y], [point.x + 50, point.y + 100]],
      { levelRef: this.activeLevelId ?? undefined },
    )
    this.model.setSelection([roof.id])
    this.model.getStore().endCompoundEdit()
  }

  /**
   * Chain start snaps to a FREE end/start of an existing wall within
   * PIXEL_MARGIN (getWallEndAt/getWallStartAt semantics); otherwise it is
   * the plain point (no angle reference exists for the first click).
   */
  private resolveChainStart(point: Point): Point {
    const home = this.homeSnapshot()
    const free = this.freeEndpointAt(home, point, endpointSnapMargin())
    if (free) return free
    if (this.gridSnapEnabled) return this.snapToGrid(point.x, point.y)
    return point
  }

  /**
   * Segment end resolution order (SH3D WallDrawingState.moveMouse):
   * 1. exact join onto a FREE endpoint within endpointSnapMargin()
   * 2. angle+length magnetization plus per-axis wall-endpoint snapping
   */
  private resolveSegmentEnd(start: Point, point: Point): Point {
    const home = this.homeSnapshot()
    const margin = endpointSnapMargin()
    const free = this.freeEndpointAt(home, point, margin)
    if (free) return free
    const base = this.gridSnapEnabled ? this.snapToGrid(point.x, point.y) : point
    const sameResult = wallPointMagnetism(start, base, home.walls, {
      enabled: this.magnetismEnabled,
      maxDelta: PLAN_SCALE,
      endpointMargin: margin,
    })
    // Cross-level: if same-level magnetism didn't move the point, try with reference walls.
    if (
      this.referenceOverlayEnabled && this.magnetismEnabled && this.activeLevelId != null
      && sameResult.x === base.x && sameResult.y === base.y
    ) {
      const refWalls = home.walls.filter((w) => !this.matchesActiveLevel(w.levelRef))
      if (refWalls.length > 0) {
        const refResult = wallPointMagnetism(start, base, refWalls, {
          enabled: true,
          maxDelta: PLAN_SCALE,
          endpointMargin: margin,
        })
        return refResult
      }
    }
    return sameResult
  }

  /**
   * SH3D PointMagnetizedToClosestWallOrRoomPoint: snap a dragged room vertex
   * onto the nearest other room vertex or wall endpoint within PIXEL_MARGIN.
   */
  private snapRoomPointToClosestCorner(
    room: NormalizedHomeState['rooms'][number],
    vertexIndex: number,
    point: Point,
  ): Point | null {
    const home = this.homeSnapshot()
    let best: Point | null = null
    let bestDist = PIXEL_MARGIN
    for (let i = 0; i < room.points.length; i++) {
      if (i === vertexIndex) continue
      const other = room.points[i]!
      const dist = distance({ x: other[0], y: other[1] }, point)
      if (dist < bestDist) {
        bestDist = dist
        best = { x: other[0], y: other[1] }
      }
    }
    for (const wall of home.walls) {
      for (const endpoint of [
        { x: wall.xStart, y: wall.yStart },
        { x: wall.xEnd, y: wall.yEnd },
      ]) {
        const dist = distance(endpoint, point)
        if (dist < bestDist) {
          bestDist = dist
          best = endpoint
        }
      }
    }
    return best
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
    // 1b. Wall round-wall (arc) handle (single-selected wall)
    if (home.selection.length === 1) {
      const selectedId = home.selection[0]!
      const sw = home.walls.find((w) => w.id === selectedId && this.matchesActiveLevel(w.levelRef))
      if (sw) {
        const hp = wallArcHandlePos(sw)
        if (distance(point, hp) <= ENDPOINT_HIT_RADIUS) {
          return { kind: 'wall-arc', id: sw.id }
        }
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
    // 3. Furniture rotation handle (single-selected)
    if (home.selection.length === 1) {
      const selectedId = home.selection[0]!
      const sf = home.furniture.find((f) => f.id === selectedId && this.matchesActiveLevel(f.levelRef))
      if (sf) {
        const hp = furnitureRotationHandlePos(sf)
        if (distance(point, hp) <= ENDPOINT_HIT_RADIUS) {
          return { kind: 'furniture-rotate', id: sf.id }
        }
      }
    }
    // 4. Furniture body
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
    // 5. Rooms
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
    // 5b. Roofs (polygon containment)
    for (const roof of home.roofs) {
      if (!this.matchesActiveLevel(roof.levelRef)) continue
      if (this.pointInPolygon(point, roof.points)) return { kind: 'roof', id: roof.id }
    }
    // 6. Labels
    for (const label of home.labels) {
      if (!this.matchesActiveLevel(label.levelRef)) continue
      if (Math.abs(point.x - label.x) <= 20 && Math.abs(point.y - label.y) <= 10) {
        return { kind: 'label', id: label.id }
      }
    }
    // 7. Dimension lines
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
      'roof',
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

