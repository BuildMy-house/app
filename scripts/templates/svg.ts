import type { TemplatePlan } from '../../src/templates/types'

const FLOOR_FILL: Record<string, string> = {
  'wood-oak': '#ead9bc',
  'wood-pine': '#f0e2c8',
  carpet: '#e0dbe6',
  'tile-floor': '#e2e8ea',
  concrete: '#dcdcd8',
}

const hex = (n: number) => `#${n.toString(16).padStart(6, '0')}`
const num = (n: number) => String(Math.round(n * 10) / 10)

function escapeXml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

/** Clean top-down floor-plan drawing of a template: floors, walls, door swings, windows, furniture. */
export function planSvg(plan: TemplatePlan, inward: Array<[number, number]>): string {
  const xs = plan.walls.flatMap((w) => [w.xStart, w.xEnd])
  const ys = plan.walls.flatMap((w) => [w.yStart, w.yEnd])
  const pad = 60
  const minX = Math.min(...xs) - pad
  const minY = Math.min(...ys) - pad
  const width = Math.max(...xs) + pad - minX
  const height = Math.max(...ys) + pad - minY
  const wallsById = new Map(plan.walls.map((w) => [w.key, w]))
  const out: string[] = []

  for (const room of plan.rooms) {
    const pts = room.points.map(([x, y]) => `${num(x)},${num(y)}`).join(' ')
    out.push(`<polygon points="${pts}" fill="${FLOOR_FILL[room.floorTextureId] ?? '#eee'}"/>`)
  }

  const wallRects = plan.walls.map((w) => {
    const horizontal = w.yStart === w.yEnd
    const half = w.thickness / 2
    const x1 = Math.min(w.xStart, w.xEnd) - (horizontal ? half : 0)
    const x2 = Math.max(w.xStart, w.xEnd) + (horizontal ? half : 0)
    const y1 = Math.min(w.yStart, w.yEnd) - (horizontal ? 0 : half)
    const y2 = Math.max(w.yStart, w.yEnd) + (horizontal ? 0 : half)
    const [rx, ry, rw, rh] = horizontal ? [x1, w.yStart - half, x2 - x1, w.thickness] : [w.xStart - half, y1, w.thickness, y2 - y1]
    return `<rect x="${num(rx)}" y="${num(ry)}" width="${num(rw)}" height="${num(rh)}"/>`
  })
  out.push(`<g fill="#2f3437">${wallRects.join('')}</g>`)

  plan.openings.forEach((o, i) => {
    const wall = wallsById.get(o.wallKey)!
    const horizontal = wall.yStart === wall.yEnd
    const dir = horizontal ? Math.sign(wall.xEnd - wall.xStart) : Math.sign(wall.yEnd - wall.yStart)
    const start = (horizontal ? wall.xStart : wall.yStart) + dir * (o.offset - o.width / 2)
    const end = start + dir * o.width
    const a = Math.min(start, end)
    const b = Math.max(start, end)
    const t = wall.thickness
    const gap = horizontal
      ? `<rect x="${num(a)}" y="${num(wall.yStart - t / 2 - 1)}" width="${num(b - a)}" height="${num(t + 2)}" fill="#f7f5f0"/>`
      : `<rect x="${num(wall.xStart - t / 2 - 1)}" y="${num(a)}" width="${num(t + 2)}" height="${num(b - a)}" fill="#f7f5f0"/>`
    out.push(gap)
    if (o.kind === 'window') {
      const c = horizontal ? wall.yStart : wall.xStart
      const lines = [-t / 4, 0, t / 4].map((d) =>
        horizontal
          ? `<line x1="${num(a)}" y1="${num(c + d)}" x2="${num(b)}" y2="${num(c + d)}"/>`
          : `<line x1="${num(c + d)}" y1="${num(a)}" x2="${num(c + d)}" y2="${num(b)}"/>`,
      )
      out.push(`<g stroke="#6aa6c8" stroke-width="3">${lines.join('')}</g>`)
      return
    }
    // Door: leaf hinged at the lower-coordinate jamb, swinging into the room it belongs to.
    const [ix, iy] = inward[i]!
    const hingeX = horizontal ? a : wall.xStart
    const hingeY = horizontal ? wall.yStart : a
    const leafW = Math.min(o.width, 100)
    const leafEndX = hingeX + ix * leafW
    const leafEndY = hingeY + iy * leafW
    const closedX = horizontal ? hingeX + leafW : hingeX
    const closedY = horizontal ? hingeY : hingeY + leafW
    const sweep = (horizontal ? (iy > 0 ? 1 : 0) : ix > 0 ? 0 : 1)
    out.push(
      `<g fill="none" stroke="#5b6166" stroke-width="3"><line x1="${num(hingeX)}" y1="${num(hingeY)}" x2="${num(leafEndX)}" y2="${num(leafEndY)}"/>` +
        `<path d="M${num(closedX)} ${num(closedY)} A${num(leafW)} ${num(leafW)} 0 0 ${sweep} ${num(leafEndX)} ${num(leafEndY)}" stroke-width="2" stroke-dasharray="6 5"/></g>`,
    )
  })

  for (const f of plan.furniture) {
    if (f.height <= 3) continue // rugs are drawn first, as a tint
    const fill = f.color !== undefined ? hex(f.color) : '#d8c7a8'
    const overhead = f.elevation >= 100
    out.push(
      `<g transform="translate(${num(f.x)} ${num(f.y)}) rotate(${f.angleDeg})"><rect x="${num(-f.width / 2)}" y="${num(-f.depth / 2)}" width="${num(f.width)}" height="${num(f.depth)}" rx="4" ` +
        (overhead ? 'fill="none" stroke="#8c8f93" stroke-dasharray="5 4" stroke-width="2"' : `fill="${fill}" stroke="#6f6a60" stroke-width="2"`) +
        '/></g>',
    )
  }
  const rugs = plan.furniture
    .filter((f) => f.height <= 3)
    .map(
      (f) =>
        `<g transform="translate(${num(f.x)} ${num(f.y)}) rotate(${f.angleDeg})"><rect x="${num(-f.width / 2)}" y="${num(-f.depth / 2)}" width="${num(f.width)}" height="${num(f.depth)}" rx="6" fill="#c9b9a0" fill-opacity="0.45" stroke="#b09f86" stroke-width="2"/></g>`,
    )
  // Rugs sit under furniture: splice them in right after the floors.
  const firstWall = out.findIndex((s) => s.startsWith('<g fill="#2f3437">'))
  out.splice(firstWall, 0, ...rugs)

  const labels = plan.rooms.map((room) => {
    const xs2 = room.points.map((p) => p[0])
    const ys2 = room.points.map((p) => p[1])
    const w = Math.max(...xs2) - Math.min(...xs2)
    const cx = (Math.max(...xs2) + Math.min(...xs2)) / 2
    const cy = Math.min(...ys2) + 28
    const size = w < 260 ? 20 : 26
    return `<text x="${num(cx)}" y="${num(cy)}" text-anchor="middle" font-size="${size}">${escapeXml(room.name)}</text>`
  })
  out.push(`<g font-family="Inter, Helvetica, Arial, sans-serif" font-weight="600" fill="#3d4448" fill-opacity="0.85" stroke="#ffffff" stroke-opacity="0.8" stroke-width="3" stroke-linejoin="round" paint-order="stroke">${labels.join('')}</g>`)

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${num(minX)} ${num(minY)} ${num(width)} ${num(height)}" role="img" aria-label="${escapeXml(plan.name)} floor plan">` +
    `<title>${escapeXml(plan.name)} floor plan</title><rect x="${num(minX)}" y="${num(minY)}" width="${num(width)}" height="${num(height)}" fill="#f7f5f0"/>` +
    out.join('') +
    '</svg>\n'
  )
}
