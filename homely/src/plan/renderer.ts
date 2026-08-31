import type { NormalizedHomeState, Wall, Furniture } from '../core/home'
import { WALL_TEXTURES } from '../core/home'
import { wallOutlinePoints } from '../core/top-camera-follower'
import type { PlanPreview } from './engine'

export interface ViewTransform {
  scale: number
  offsetX: number
  offsetY: number
}

/** Minimal 2D context surface used by the renderer (real canvases satisfy it). */
export interface PlanRenderingContext {
  beginPath(): void
  moveTo(x: number, y: number): void
  lineTo(x: number, y: number): void
  closePath(): void
  stroke(): void
  fill(): void
  fillRect(x: number, y: number, w: number, h: number): void
  fillText(text: string, x: number, y: number): void
  strokeRect(x: number, y: number, w: number, h: number): void
  arc(x: number, y: number, radius: number, startAngle: number, endAngle: number): void
  lineWidth: number
  strokeStyle: string
  fillStyle: string
  font: string
  textAlign: CanvasTextAlign
  textBaseline: CanvasTextBaseline
  setLineDash(dashes: Array<number>): void
  save(): void
  restore(): void
  globalCompositeOperation: GlobalCompositeOperation
  createPattern?(image: unknown, repetition: string): unknown
}

const WALL_COLOR = '#5a5a5a'
const SELECTION_COLOR = '#1a66d6'
const ROOM_FILL = 'rgba(170, 200, 235, 0.3)'
const DIMENSION_COLOR = '#8a6d1a'
const LABEL_COLOR = '#333333'
const PREVIEW_COLOR = '#999999'
const FURNITURE_FILL = 'rgba(160, 160, 90, 0.5)'
const ROTATION_HANDLE_OFFSET = 20
const ROTATION_HANDLE_RADIUS = 5

const MINOR_GRID_COLOR = '#e8e8e8'
const MAJOR_GRID_COLOR = '#d0d0d0'

/** Schema colors are 0xRRGGBB ints; CSS wants strings. */
function cssColor(color: number | null | undefined, fallback: string): string {
  if (color === null || color === undefined) return fallback
  return `#${(color >>> 0).toString(16).padStart(6, '0')}`
}

/** Formats a length in cm as meters with two decimals. */
function formatLength(cm: number): string {
  return `${(cm / 100).toFixed(2)} m`
}

const imageCache = new Map<string, HTMLImageElement>()

/** Test-only: inject a pre-loaded image into the texture cache. */
export function setTestImageCache(entries: Map<string, HTMLImageElement>): void {
  imageCache.clear()
  for (const [k, v] of entries) imageCache.set(k, v)
}

function resolveTextureImage(
  textureId: string | null | undefined,
): HTMLImageElement | null {
  if (!textureId) return null
  const tex = WALL_TEXTURES.find((t) => t.id === textureId)
  if (!tex) return null
  const url = `/assets/textures/${tex.file}`
  const cached = imageCache.get(url)
  if (cached) return cached
  const img = new Image()
  img.src = url
  imageCache.set(url, img)
  return img
}

function patternOrNull(
  ctx: PlanRenderingContext,
  textureId: string | null | undefined,
): string | null {
  if (!textureId || !ctx.createPattern) return null
  const img = resolveTextureImage(textureId)
  if (!img || !img.complete || img.naturalWidth === 0) return null
  const pat = ctx.createPattern(img, 'repeat')
  return pat != null ? (pat as unknown as string) : null
}

function matchesLevel(levelRef: string | null | undefined, activeLevelId: string | null): boolean {
  if (activeLevelId === null) return true
  return (levelRef ?? null) === activeLevelId
}

/** Shoelace formula — returns area in cm². */
function shoelaceArea(points: Array<[number, number]>): number {
  let area = 0
  const n = points.length
  for (let i = 0; i < n; i++) {
    const p1 = points[i]!
    const p2 = points[(i + 1) % n]!
    area += p1[0] * p2[1] - p2[0] * p1[1]
  }
  return Math.abs(area) / 2
}

export function fitToBounds(
  home: NormalizedHomeState,
  width: number,
  height: number,
  padding = 40,
  activeLevelId: string | null = null,
): ViewTransform {
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  const grow = (x: number, y: number) => {
    minX = Math.min(minX, x)
    minY = Math.min(minY, y)
    maxX = Math.max(maxX, x)
    maxY = Math.max(maxY, y)
  }
  for (const wall of home.walls) {
    if (!matchesLevel(wall.levelRef, activeLevelId)) continue
    grow(wall.xStart, wall.yStart)
    grow(wall.xEnd, wall.yEnd)
  }
  for (const room of home.rooms) {
    if (!matchesLevel(room.levelRef, activeLevelId)) continue
    for (const [x, y] of room.points) grow(x, y)
  }
  for (const f of home.furniture) {
    if (!matchesLevel(f.levelRef, activeLevelId)) continue
    grow(f.x - f.width / 2, f.y - f.depth / 2)
    grow(f.x + f.width / 2, f.y + f.depth / 2)
  }
  if (!Number.isFinite(minX)) return { scale: 1, offsetX: width / 2, offsetY: height / 2 }

  const spanX = Math.max(maxX - minX, 1)
  const spanY = Math.max(maxY - minY, 1)
  const scale = Math.min((width - padding * 2) / spanX, (height - padding * 2) / spanY)
  const centerX = (minX + maxX) / 2
  const centerY = (minY + maxY) / 2
  return {
    scale,
    offsetX: width / 2 - centerX * scale,
    offsetY: height / 2 - centerY * scale,
  }
}

export class ViewMapper {
  constructor(private readonly view: ViewTransform) {}

  sx(x: number): number {
    return x * this.view.scale + this.view.offsetX
  }

  sy(y: number): number {
    return y * this.view.scale + this.view.offsetY
  }

  toModel(px: number, py: number): { x: number; y: number } {
    return {
      x: (px - this.view.offsetX) / this.view.scale,
      y: (py - this.view.offsetY) / this.view.scale,
    }
  }
}

function drawGrid(ctx: PlanRenderingContext, view: ViewTransform, width: number, height: number): void {
  const mapper = new ViewMapper(view)
  const topLeft = mapper.toModel(0, 0)
  const bottomRight = mapper.toModel(width, height)
  const minX = Math.min(topLeft.x, bottomRight.x)
  const maxX = Math.max(topLeft.x, bottomRight.x)
  const minY = Math.min(topLeft.y, bottomRight.y)
  const maxY = Math.max(topLeft.y, bottomRight.y)

  const minorStep = 10
  const majorStep = 100

  const startMinorX = Math.floor(minX / minorStep) * minorStep
  const startMinorY = Math.floor(minY / minorStep) * minorStep

  ctx.beginPath()
  for (let x = startMinorX; x <= maxX; x += minorStep) {
    if (x % majorStep === 0) continue
    const px = mapper.sx(x)
    ctx.moveTo(px, 0)
    ctx.lineTo(px, height)
  }
  for (let y = startMinorY; y <= maxY; y += minorStep) {
    if (y % majorStep === 0) continue
    const py = mapper.sy(y)
    ctx.moveTo(0, py)
    ctx.lineTo(width, py)
  }
  ctx.strokeStyle = MINOR_GRID_COLOR
  ctx.lineWidth = 0.5
  ctx.stroke()

  const startMajorX = Math.floor(minX / majorStep) * majorStep
  const startMajorY = Math.floor(minY / majorStep) * majorStep

  ctx.beginPath()
  for (let x = startMajorX; x <= maxX; x += majorStep) {
    const px = mapper.sx(x)
    ctx.moveTo(px, 0)
    ctx.lineTo(px, height)
  }
  for (let y = startMajorY; y <= maxY; y += majorStep) {
    const py = mapper.sy(y)
    ctx.moveTo(0, py)
    ctx.lineTo(width, py)
  }
  ctx.strokeStyle = MAJOR_GRID_COLOR
  ctx.lineWidth = 1
  ctx.stroke()
}

/** Door/window openings on a wall — returns center + wall unit vector + half extents. */
function wallOpenings(
  wall: Wall,
  furniture: ReadonlyArray<Furniture>,
): Array<{ cx: number; cy: number; ux: number; uy: number; halfWidth: number; halfThickness: number }> {
  const dx = wall.xEnd - wall.xStart
  const dy = wall.yEnd - wall.yStart
  const length = Math.hypot(dx, dy)
  if (length === 0) return []
  const ux = dx / length
  const uy = dy / length
  const results: Array<{ cx: number; cy: number; ux: number; uy: number; halfWidth: number; halfThickness: number }> = []
  for (const f of furniture) {
    if (!f.doorOrWindow || f.wallRef !== wall.id) continue
    let centerDist: number
    if (f.wallOffset != null) {
      centerDist = f.wallOffset
    } else {
      const t = ((f.x - wall.xStart) * dx + (f.y - wall.yStart) * dy) / (length * length)
      centerDist = t * length
    }
    results.push({
      cx: wall.xStart + ux * centerDist,
      cy: wall.yStart + uy * centerDist,
      ux,
      uy,
      halfWidth: f.width / 2,
      halfThickness: wall.thickness / 2,
    })
  }
  return results
}

export function drawPlan(
  home: NormalizedHomeState,
  preview: PlanPreview | null,
  ctx: PlanRenderingContext,
  view: ViewTransform,
  canvasWidth?: number,
  canvasHeight?: number,
  activeLevelId: string | null = null,
): void {
  const mapper = new ViewMapper(view)
  const selected = new Set(home.selection)

  if (canvasWidth != null && canvasHeight != null) {
    drawGrid(ctx, view, canvasWidth, canvasHeight)
  }

  // Rooms (floor fill + area label).
  for (const room of home.rooms) {
    if (!matchesLevel(room.levelRef, activeLevelId)) continue
    if (room.points.length < 3) continue
    ctx.beginPath()
    room.points.forEach(([x, y], index) => {
      if (index === 0) ctx.moveTo(mapper.sx(x), mapper.sy(y))
      else ctx.lineTo(mapper.sx(x), mapper.sy(y))
    })
    ctx.closePath()

    const floorFill = cssColor(room.floorColor, ROOM_FILL)
    if (room.floorVisible !== false) {
      ctx.fillStyle = floorFill
      ctx.fill()
    }

    if (selected.has(room.id)) {
      ctx.lineWidth = 2
      ctx.strokeStyle = SELECTION_COLOR
      ctx.stroke()
    }

    const centroidX = room.points.reduce((acc, [x]) => acc + x, 0) / room.points.length
    const centroidY = room.points.reduce((acc, [, y]) => acc + y, 0) / room.points.length
    const areaCm2 = shoelaceArea(room.points)
    const areaM2 = (areaCm2 / 10000).toFixed(2)

    ctx.fillStyle = '#5577aa'
    ctx.font = '12px sans-serif'
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText(`${areaM2} m²`, mapper.sx(centroidX), mapper.sy(centroidY))
    ctx.textAlign = 'start'
    ctx.textBaseline = 'alphabetic'

    if (room.name) {
      ctx.fillStyle = '#5577aa'
      ctx.font = '10px sans-serif'
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      ctx.fillText(room.name, mapper.sx(centroidX), mapper.sy(centroidY) - 14)
      ctx.textAlign = 'start'
      ctx.textBaseline = 'alphabetic'
    }
  }

  // Walls as filled thick shapes with mitered corners.
  for (const wall of home.walls) {
    if (!matchesLevel(wall.levelRef, activeLevelId)) continue
    const wDx = wall.xEnd - wall.xStart
    const wDy = wall.yEnd - wall.yStart
    const wLen = Math.hypot(wDx, wDy)
    const wUx = wLen > 0 ? wDx / wLen : 0
    const wUy = wLen > 0 ? wDy / wLen : 0
    const outline = wallOutlinePoints(wall, home.walls)
    if (outline.length === 0) continue
    ctx.beginPath()
    ctx.moveTo(mapper.sx(outline[0]![0]), mapper.sy(outline[0]![1]))
    for (let i = 1; i < outline.length; i++) {
      ctx.lineTo(mapper.sx(outline[i]![0]), mapper.sy(outline[i]![1]))
    }
    ctx.closePath()
    ctx.fillStyle = selected.has(wall.id)
      ? SELECTION_COLOR
      : patternOrNull(ctx, wall.leftSideTextureId) ?? cssColor(wall.leftSideColor, WALL_COLOR)
    ctx.fill()

    // Punch door/window openings through the wall fill.
    const openings = wallOpenings(wall, home.furniture)
    if (openings.length > 0) {
      ctx.save()
      ctx.globalCompositeOperation = 'destination-out'
      ctx.fillStyle = '#000000'
      for (const o of openings) {
        ctx.beginPath()
        ctx.moveTo(
          mapper.sx(o.cx - o.ux * o.halfWidth - o.uy * o.halfThickness),
          mapper.sy(o.cy - o.uy * o.halfWidth + o.ux * o.halfThickness),
        )
        ctx.lineTo(
          mapper.sx(o.cx + o.ux * o.halfWidth - o.uy * o.halfThickness),
          mapper.sy(o.cy + o.uy * o.halfWidth + o.ux * o.halfThickness),
        )
        ctx.lineTo(
          mapper.sx(o.cx + o.ux * o.halfWidth + o.uy * o.halfThickness),
          mapper.sy(o.cy + o.uy * o.halfWidth - o.ux * o.halfThickness),
        )
        ctx.lineTo(
          mapper.sx(o.cx - o.ux * o.halfWidth + o.uy * o.halfThickness),
          mapper.sy(o.cy - o.uy * o.halfWidth - o.ux * o.halfThickness),
        )
        ctx.closePath()
        ctx.fill()
      }
      ctx.restore()
    }

    ctx.strokeStyle = cssColor(wall.rightSideColor, WALL_COLOR)
    ctx.lineWidth = 0.5
    ctx.stroke()

    // Door swing arcs — quarter-circle + leaf line per door on this wall.
    // MVP: always swings to one consistent side (no per-door swing-direction data).
    const doorFurniture = home.furniture.filter(
      (f) => f.doorOrWindow === true && /door/i.test(f.name) && f.wallRef === wall.id && matchesLevel(f.levelRef, activeLevelId),
    )
    for (const f of doorFurniture) {
      const hw = f.width / 2
      const doorWidth = f.width

      let centerDist: number
      if (f.wallOffset != null) {
        centerDist = f.wallOffset
      } else {
        const t = ((f.x - wall.xStart) * wDx + (f.y - wall.yStart) * wDy) / (wLen * wLen)
        centerDist = t * wLen
      }

      // Hinge point: left edge of door along wall (in model coords).
      const hx = wall.xStart + wUx * centerDist - wUx * hw
      const hy = wall.yStart + wUy * centerDist - wUy * hw

      const hpx = mapper.sx(hx)
      const hpy = mapper.sy(hy)
      const radius = doorWidth * view.scale
      const wallAngle = Math.atan2(wUy, wUx)
      const endAngle = wallAngle + Math.PI / 2

      ctx.beginPath()
      ctx.arc(hpx, hpy, radius, wallAngle, endAngle)
      ctx.strokeStyle = DIMENSION_COLOR
      ctx.lineWidth = 1
      ctx.stroke()

      // Door leaf: straight line from hinge to the arc's far edge.
      ctx.beginPath()
      ctx.moveTo(hpx, hpy)
      ctx.lineTo(hpx + radius * Math.cos(endAngle), hpy + radius * Math.sin(endAngle))
      ctx.stroke()
    }
  }

  // Endpoint handles for selected walls.
  const HANDLE_SIZE = 6
  for (const wall of home.walls) {
    if (!matchesLevel(wall.levelRef, activeLevelId)) continue
    if (!selected.has(wall.id)) continue
    for (const [ex, ey] of [[wall.xStart, wall.yStart], [wall.xEnd, wall.yEnd]] as const) {
      const px = mapper.sx(ex)
      const py = mapper.sy(ey)
      ctx.fillStyle = '#1a66d6'
      ctx.fillRect(px - HANDLE_SIZE / 2, py - HANDLE_SIZE / 2, HANDLE_SIZE, HANDLE_SIZE)
      ctx.strokeStyle = '#ffffff'
      ctx.lineWidth = 2
      ctx.strokeRect(px - HANDLE_SIZE / 2, py - HANDLE_SIZE / 2, HANDLE_SIZE, HANDLE_SIZE)
    }
  }

  // Furniture as rotated rectangles.
  for (const f of home.furniture) {
    if (!matchesLevel(f.levelRef, activeLevelId)) continue
    const angleRad = (f.angleDeg * Math.PI) / 180
    const cos = Math.cos(angleRad)
    const sin = Math.sin(angleRad)
    const hw = f.width / 2
    const hd = f.depth / 2
    const offsets: Array<[number, number]> = [
      [-hw, -hd],
      [hw, -hd],
      [hw, hd],
      [-hw, hd],
    ]
    const corners = offsets.map(([ox, oz]) => ({
      x: mapper.sx(f.x + ox * cos - oz * sin),
      y: mapper.sy(f.y + ox * sin + oz * cos),
    }))
    ctx.beginPath()
    corners.forEach((corner, index) => {
      if (index === 0) ctx.moveTo(corner.x, corner.y)
      else ctx.lineTo(corner.x, corner.y)
    })
    ctx.closePath()
    ctx.fillStyle = cssColor(f.color, FURNITURE_FILL)
    ctx.fill()
    if (selected.has(f.id)) {
      ctx.lineWidth = 2
      ctx.strokeStyle = SELECTION_COLOR
      ctx.stroke()

      // Corner drag handles.
      const handleSize = 6
      ctx.fillStyle = SELECTION_COLOR
      for (const corner of corners) {
        ctx.fillRect(
          corner.x - handleSize / 2,
          corner.y - handleSize / 2,
          handleSize,
          handleSize,
        )
      }
    }
  }

  // Rotation handle for single-selected furniture.
  const selectedFurniture = home.furniture.filter(
    (f) => selected.has(f.id) && matchesLevel(f.levelRef, activeLevelId),
  )
  if (selectedFurniture.length === 1) {
    const f = selectedFurniture[0]!
    const angleRad = (f.angleDeg * Math.PI) / 180
    const cos = Math.cos(angleRad)
    const sin = Math.sin(angleRad)
    const hd = f.depth / 2
    const hx = f.x + (hd + ROTATION_HANDLE_OFFSET) * sin
    const hy = f.y - (hd + ROTATION_HANDLE_OFFSET) * cos
    const px = mapper.sx(hx)
    const py = mapper.sy(hy)
    ctx.beginPath()
    ctx.arc(px, py, ROTATION_HANDLE_RADIUS, 0, Math.PI * 2)
    ctx.fillStyle = SELECTION_COLOR
    ctx.fill()
    ctx.strokeStyle = '#ffffff'
    ctx.lineWidth = 2
    ctx.stroke()
  }

  // Dimension lines.
  for (const dim of home.dimensionLines) {
    if (!matchesLevel(dim.levelRef, activeLevelId)) continue
    ctx.beginPath()
    ctx.moveTo(mapper.sx(dim.xStart), mapper.sy(dim.yStart))
    ctx.lineTo(mapper.sx(dim.xEnd), mapper.sy(dim.yEnd))
    ctx.lineWidth = 1
    ctx.strokeStyle = selected.has(dim.id) ? SELECTION_COLOR : DIMENSION_COLOR
    ctx.stroke()

    const midX = (dim.xStart + dim.xEnd) / 2
    const midY = (dim.yStart + dim.yEnd) / 2
    const length = Math.hypot(dim.xEnd - dim.xStart, dim.yEnd - dim.yStart)
    ctx.fillStyle = selected.has(dim.id) ? SELECTION_COLOR : DIMENSION_COLOR
    ctx.font = '11px sans-serif'
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText(formatLength(length), mapper.sx(midX), mapper.sy(midY))
    ctx.textAlign = 'start'
    ctx.textBaseline = 'alphabetic'
  }

  // Labels.
  for (const label of home.labels) {
    if (!matchesLevel(label.levelRef, activeLevelId)) continue
    ctx.fillStyle = cssColor(
      label.color,
      selected.has(label.id) ? SELECTION_COLOR : LABEL_COLOR,
    )
    ctx.font = '12px sans-serif'
    ctx.fillText(label.text, mapper.sx(label.x), mapper.sy(label.y))
  }

  // Wall-tool preview: committed-but-unvalidated chain segments.
  if (preview && preview.phase === 'drawing') {
    ctx.setLineDash([6, 4])
    ctx.strokeStyle = PREVIEW_COLOR
    ctx.lineWidth = 2
    for (const segment of preview.pendingWalls) {
      ctx.beginPath()
      ctx.moveTo(mapper.sx(segment.start.x), mapper.sy(segment.start.y))
      ctx.lineTo(mapper.sx(segment.end.x), mapper.sy(segment.end.y))
      ctx.stroke()
    }
    if (preview.chainStart) {
      ctx.beginPath()
      ctx.arc(mapper.sx(preview.chainStart.x), mapper.sy(preview.chainStart.y), 4, 0, Math.PI * 2)
      ctx.strokeStyle = PREVIEW_COLOR
      ctx.stroke()
    }
    ctx.setLineDash([])
  }

  // Room-tool preview: in-progress polygon outline + vertex dots.
  if (preview && preview.tool === 'room' && preview.phase === 'drawing' && preview.roomPoints.length > 0) {
    ctx.setLineDash([6, 4])
    ctx.strokeStyle = PREVIEW_COLOR
    ctx.lineWidth = 2
    ctx.beginPath()
    preview.roomPoints.forEach(([x, y], index) => {
      if (index === 0) ctx.moveTo(mapper.sx(x), mapper.sy(y))
      else ctx.lineTo(mapper.sx(x), mapper.sy(y))
    })
    if (preview.roomPoints.length >= 3) {
      const [x0, y0] = preview.roomPoints[0]!
      ctx.lineTo(mapper.sx(x0), mapper.sy(y0))
    }
    ctx.stroke()
    ctx.setLineDash([])
    ctx.fillStyle = PREVIEW_COLOR
    for (const [x, y] of preview.roomPoints) {
      ctx.beginPath()
      ctx.arc(mapper.sx(x), mapper.sy(y), 3, 0, Math.PI * 2)
      ctx.fill()
    }
  }

  // Dimension-line preview: in-progress segment + length readout.
  if (preview && preview.tool === 'dimensionLine' && preview.dimensionLine) {
    const { start, end, length } = preview.dimensionLine
    ctx.beginPath()
    ctx.moveTo(mapper.sx(start.x), mapper.sy(start.y))
    ctx.lineTo(mapper.sx(end.x), mapper.sy(end.y))
    ctx.lineWidth = 1
    ctx.strokeStyle = PREVIEW_COLOR
    ctx.setLineDash([6, 4])
    ctx.stroke()
    ctx.setLineDash([])

    const midX = (start.x + end.x) / 2
    const midY = (start.y + end.y) / 2
    ctx.fillStyle = PREVIEW_COLOR
    ctx.font = '11px sans-serif'
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText(formatLength(length), mapper.sx(midX), mapper.sy(midY))
    ctx.textAlign = 'start'
    ctx.textBaseline = 'alphabetic'
  }
}
