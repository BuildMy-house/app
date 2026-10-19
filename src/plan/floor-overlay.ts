/**
 * Canvas overlay for the floor-creation UX: hover highlight of an enclosed
 * area, near-closed gap markers, and the room tool's live fill / snap / area
 * readout. Pure drawing — all state arrives through PlanPreview.floorAssist.
 */
import type { PlanRenderingContext } from './renderer'

type P = { x: number; y: number }

export interface FloorAssistPreview {
  /** Enclosed area under the cursor that has no floor yet. */
  hoverFace: { polygon: P[]; areaCm2: number } | null
  /** Near-closed loop gaps; `active` = the one under the cursor. */
  gaps: Array<{ from: P; to: P; distanceCm: number; active: boolean; areaCm2: number }>
  /** Room tool, while drawing: live polygon incl. the snapped cursor. */
  roomLive: { polygon: P[]; areaCm2: number; closing: boolean } | null
  /** Snapped cursor for the room tool. */
  roomSnap: { point: P; kind: 'corner' | 'align' | 'grid' | 'none'; guides: Array<{ from: P; to: P }> } | null
  /** Short hint rendered next to the cursor. */
  hint: { text: string; at: P } | null
}

interface Mapper {
  sx(x: number): number
  sy(y: number): number
}

const FLOOR_FILL = 'rgba(46, 125, 214, 0.22)'
const FLOOR_STROKE = 'rgba(46, 125, 214, 0.95)'
const GAP_COLOR = '#e08a00'

function tracePath(ctx: PlanRenderingContext, m: Mapper, pts: P[]): void {
  ctx.beginPath()
  pts.forEach((p, i) => {
    if (i === 0) ctx.moveTo(m.sx(p.x), m.sy(p.y))
    else ctx.lineTo(m.sx(p.x), m.sy(p.y))
  })
}

function centroid(pts: P[]): P {
  let x = 0
  let y = 0
  for (const p of pts) {
    x += p.x
    y += p.y
  }
  return { x: x / pts.length, y: y / pts.length }
}

function pill(ctx: PlanRenderingContext, text: string, px: number, py: number, bg: string): void {
  ctx.font = '12px sans-serif'
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  const w = ctx.measureText(text).width + 14
  ctx.fillStyle = bg
  ctx.fillRect(px - w / 2, py - 11, w, 22)
  ctx.fillStyle = '#ffffff'
  ctx.fillText(text, px, py)
  ctx.textAlign = 'start'
  ctx.textBaseline = 'alphabetic'
}

const m2 = (cm2: number): string => `${(cm2 / 10000).toFixed(2)} m²`

export function drawFloorAssist(ctx: PlanRenderingContext, m: Mapper, fa: FloorAssistPreview): void {
  if (fa.hoverFace) {
    tracePath(ctx, m, fa.hoverFace.polygon)
    ctx.closePath()
    ctx.fillStyle = FLOOR_FILL
    ctx.fill()
    ctx.setLineDash([])
    ctx.strokeStyle = FLOOR_STROKE
    ctx.lineWidth = 2
    ctx.stroke()
    const c = centroid(fa.hoverFace.polygon)
    pill(ctx, `Click to create floor · ${m2(fa.hoverFace.areaCm2)}`, m.sx(c.x), m.sy(c.y), 'rgba(30, 90, 170, 0.92)')
  }

  for (const g of fa.gaps) {
    const x1 = m.sx(g.from.x)
    const y1 = m.sy(g.from.y)
    const x2 = m.sx(g.to.x)
    const y2 = m.sy(g.to.y)
    ctx.setLineDash([5, 4])
    ctx.strokeStyle = GAP_COLOR
    ctx.lineWidth = g.active ? 4 : 3
    ctx.beginPath()
    ctx.moveTo(x1, y1)
    ctx.lineTo(x2, y2)
    ctx.stroke()
    ctx.setLineDash([])
    ctx.fillStyle = GAP_COLOR
    for (const [x, y] of [
      [x1, y1],
      [x2, y2],
    ] as const) {
      ctx.beginPath()
      ctx.arc(x, y, 5, 0, Math.PI * 2)
      ctx.fill()
    }
    if (g.active) {
      pill(
        ctx,
        `Gap ${Math.round(g.distanceCm)} cm · click to close and create floor (${m2(g.areaCm2)})`,
        (x1 + x2) / 2,
        (y1 + y2) / 2 - 18,
        'rgba(170, 100, 0, 0.94)',
      )
    }
  }

  if (fa.roomLive && fa.roomLive.polygon.length >= 2) {
    const poly = fa.roomLive.polygon
    if (poly.length >= 3) {
      tracePath(ctx, m, poly)
      ctx.closePath()
      ctx.fillStyle = FLOOR_FILL
      ctx.fill()
    }
    tracePath(ctx, m, poly)
    if (poly.length >= 3) ctx.closePath()
    ctx.setLineDash([])
    ctx.strokeStyle = FLOOR_STROKE
    ctx.lineWidth = 2
    ctx.stroke()
    ctx.fillStyle = FLOOR_STROKE
    for (const p of poly.slice(0, -1)) {
      ctx.beginPath()
      ctx.arc(m.sx(p.x), m.sy(p.y), 3.5, 0, Math.PI * 2)
      ctx.fill()
    }
    if (poly.length >= 3) {
      const c = centroid(poly)
      pill(ctx, m2(fa.roomLive.areaCm2), m.sx(c.x), m.sy(c.y), 'rgba(30, 90, 170, 0.92)')
    }
  }

  if (fa.roomSnap) {
    ctx.setLineDash([4, 4])
    ctx.strokeStyle = 'rgba(46, 125, 214, 0.7)'
    ctx.lineWidth = 1
    for (const g of fa.roomSnap.guides) {
      ctx.beginPath()
      ctx.moveTo(m.sx(g.from.x), m.sy(g.from.y))
      ctx.lineTo(m.sx(g.to.x), m.sy(g.to.y))
      ctx.stroke()
    }
    ctx.setLineDash([])
    if (fa.roomSnap.kind === 'corner' || fa.roomSnap.kind === 'align') {
      const sx = m.sx(fa.roomSnap.point.x)
      const sy = m.sy(fa.roomSnap.point.y)
      ctx.beginPath()
      ctx.arc(sx, sy, fa.roomSnap.kind === 'corner' ? 8 : 5, 0, Math.PI * 2)
      ctx.strokeStyle = FLOOR_STROKE
      ctx.lineWidth = 2
      ctx.stroke()
    }
  }

  if (fa.hint) pill(ctx, fa.hint.text, m.sx(fa.hint.at.x), m.sy(fa.hint.at.y) - 22, 'rgba(40, 40, 40, 0.85)')
}
