import * as THREE from 'three'
import { deflateSync } from 'node:zlib'
import { HomeStore } from '../src/core/store'
import { buildScene } from '../src/view3d/scene'
import type { NormalizedHomeState } from '../src/core/home'

type Request = {
  home: NormalizedHomeState
  view: 'plan' | '3d'
  width: number
  height: number
  camera?: string
  roofVisible?: boolean
  lightIntensity?: number
}
type Point = [number, number]

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n
  for (let i = 0; i < 8; i++) c = (c & 1) ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  return c >>> 0
})

export function crc32(data: Buffer): number {
  let c = 0xffffffff
  for (let i = 0; i < data.length; i++) c = crcTable[(c ^ data[i]!) & 0xff]! ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

export function chunk(type: string, data: Buffer): Buffer {
  const body = Buffer.concat([Buffer.from(type), data])
  const out = Buffer.alloc(body.length + 8) // 4-byte length field + 4-byte CRC (body already includes the 4-byte type)
  out.writeUInt32BE(data.length, 0)
  body.copy(out, 4)
  out.writeUInt32BE(crc32(body), body.length + 4)
  return out
}

export function png(width: number, height: number, pixels: Uint8Array): string {
  const rows = Buffer.alloc((width * 4 + 1) * height)
  for (let y = 0; y < height; y++) {
    const row = y * (width * 4 + 1)
    Buffer.from(pixels.buffer, pixels.byteOffset + y * width * 4, width * 4).copy(rows, row + 1)
  }
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width, 0)
  header.writeUInt32BE(height, 4)
  header[8] = 8
  header[9] = 6
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', header), chunk('IDAT', deflateSync(rows)), chunk('IEND', Buffer.alloc(0)),
  ]).toString('base64')
}

function color(value: string): [number, number, number, number] {
  const hex = value.replace('#', '')
  return [parseInt(hex.slice(0, 2), 16), parseInt(hex.slice(2, 4), 16), parseInt(hex.slice(4, 6), 16), 255]
}

function paint(pixels: Uint8Array, width: number, x: number, y: number, fill: [number, number, number, number]): void {
  if (x < 0 || y < 0 || x >= width) return
  const offset = (y * width + x) * 4
  if (offset + 3 >= pixels.length) return
  pixels.set(fill, offset)
}

function fill(pixels: Uint8Array, value: [number, number, number, number]): void {
  for (let i = 0; i < pixels.length; i += 4) pixels.set(value, i)
}

function polygon(pixels: Uint8Array, width: number, height: number, points: Point[], fill: [number, number, number, number]): void {
  const minX = Math.max(0, Math.floor(Math.min(...points.map((p) => p[0]))))
  const maxX = Math.min(width - 1, Math.ceil(Math.max(...points.map((p) => p[0]))))
  const minY = Math.max(0, Math.floor(Math.min(...points.map((p) => p[1]))))
  const maxY = Math.min(height - 1, Math.ceil(Math.max(...points.map((p) => p[1]))))
  for (let y = minY; y <= maxY; y++) for (let x = minX; x <= maxX; x++) {
    let inside = false
    for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
      const [xi, yi] = points[i]!
      const [xj, yj] = points[j]!
      if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) inside = !inside
    }
    if (inside) paint(pixels, width, x, y, fill)
  }
}

function line(pixels: Uint8Array, width: number, height: number, a: Point, b: Point, fill: [number, number, number, number], thickness = 1): void {
  const steps = Math.ceil(Math.max(Math.abs(b[0] - a[0]), Math.abs(b[1] - a[1])))
  for (let i = 0; i <= steps; i++) {
    const t = steps ? i / steps : 0
    const x = Math.round(a[0] + (b[0] - a[0]) * t)
    const y = Math.round(a[1] + (b[1] - a[1]) * t)
    for (let oy = -Math.floor(thickness / 2); oy <= Math.ceil(thickness / 2); oy++) {
      for (let ox = -Math.floor(thickness / 2); ox <= Math.ceil(thickness / 2); ox++) {
        if (x + ox >= 0 && x + ox < width && y + oy >= 0 && y + oy < height) paint(pixels, width, x + ox, y + oy, fill)
      }
    }
  }
}

function planPoint(point: Point, bounds: { minX: number; minY: number; scale: number; x: number; y: number }): Point {
  return [bounds.x + (point[0] - bounds.minX) * bounds.scale, bounds.y + (point[1] - bounds.minY) * bounds.scale]
}

/**
 * Deterministic per-catalogId fill color: FNV-1a hash picks the hue, while
 * saturation/lightness stay fixed mid-range so boxes are vivid but never
 * near-black/near-white. Same id -> same color on every render.
 */
export function catalogColor(catalogId: string): number {
  let hash = 0x811c9dc5
  for (let i = 0; i < catalogId.length; i++) {
    hash ^= catalogId.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  // Golden-ratio multiplicative hashing spreads distinct ids across the hue
  // circle far better than hash % 360 (which only sees the low bits).
  const h = (((hash >>> 0) * 0.618033988749895) % 1)
  const s = 0.62
  const l = 0.46
  const a = s * Math.min(l, 1 - l)
  const channel = (n: number): number => {
    const k = (n + h * 12) % 12
    return Math.round((l - a * Math.max(-1, Math.min(k - 3, Math.min(9 - k, 1))) ) * 255)
  }
  return (channel(0) << 16) | (channel(8) << 8) | channel(4)
}

function catalogRgb(catalogId: string): [number, number, number, number] {
  const n = catalogColor(catalogId)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255, 255]
}

const INK_DARK: [number, number, number, number] = [26, 26, 26, 255]
const INK_LIGHT: [number, number, number, number] = [255, 255, 255, 255]

function inkFor(fill: [number, number, number, number]): [number, number, number, number] {
  const luma = (0.2126 * fill[0]! + 0.7152 * fill[1]! + 0.0722 * fill[2]!) / 255
  return luma > 0.55 ? INK_DARK : INK_LIGHT
}

/** Human-readable label: item name, else short catalogId ('eTeks#chair' -> 'CHAIR'). */
function furnitureLabel(item: { name: string; catalogId?: string | null }): string {
  const name = item.name.trim()
  if (name) return name.toUpperCase()
  const short = (item.catalogId ?? '').split('#').pop() ?? ''
  return short.toUpperCase()
}

// 5x7 bitmap font (classic GLCD glyphs, one 5-byte column array per char,
// bit 0 = top row). Uppercase A-Z, 0-9, '-', space; unknown chars render blank.
const FONT: Record<string, number[]> = {
  ' ': [0x00, 0x00, 0x00, 0x00, 0x00],
  '-': [0x08, 0x08, 0x08, 0x08, 0x08],
  '0': [0x3e, 0x51, 0x49, 0x45, 0x3e],
  '1': [0x00, 0x42, 0x7f, 0x40, 0x00],
  '2': [0x42, 0x61, 0x51, 0x49, 0x46],
  '3': [0x21, 0x41, 0x45, 0x4b, 0x31],
  '4': [0x18, 0x14, 0x12, 0x7f, 0x10],
  '5': [0x27, 0x45, 0x45, 0x45, 0x39],
  '6': [0x3c, 0x4a, 0x49, 0x49, 0x30],
  '7': [0x01, 0x71, 0x09, 0x05, 0x03],
  '8': [0x36, 0x49, 0x49, 0x49, 0x36],
  '9': [0x06, 0x49, 0x49, 0x29, 0x1e],
  A: [0x7e, 0x11, 0x11, 0x11, 0x7e],
  B: [0x7f, 0x49, 0x49, 0x49, 0x36],
  C: [0x3e, 0x41, 0x41, 0x41, 0x22],
  D: [0x7f, 0x41, 0x41, 0x22, 0x1c],
  E: [0x7f, 0x49, 0x49, 0x49, 0x41],
  F: [0x7f, 0x09, 0x09, 0x09, 0x01],
  G: [0x3e, 0x41, 0x49, 0x49, 0x7a],
  H: [0x7f, 0x08, 0x08, 0x08, 0x7f],
  I: [0x00, 0x41, 0x7f, 0x41, 0x00],
  J: [0x20, 0x40, 0x41, 0x3f, 0x01],
  K: [0x7f, 0x08, 0x14, 0x22, 0x41],
  L: [0x7f, 0x40, 0x40, 0x40, 0x40],
  M: [0x7f, 0x02, 0x0c, 0x02, 0x7f],
  N: [0x7f, 0x04, 0x08, 0x10, 0x7f],
  O: [0x3e, 0x41, 0x41, 0x41, 0x3e],
  P: [0x7f, 0x09, 0x09, 0x09, 0x06],
  Q: [0x3e, 0x41, 0x51, 0x21, 0x5e],
  R: [0x7f, 0x09, 0x19, 0x29, 0x46],
  S: [0x46, 0x49, 0x49, 0x49, 0x31],
  T: [0x01, 0x01, 0x7f, 0x01, 0x01],
  U: [0x3f, 0x40, 0x40, 0x40, 0x3f],
  V: [0x1f, 0x20, 0x40, 0x20, 0x1f],
  W: [0x3f, 0x40, 0x38, 0x40, 0x3f],
  X: [0x63, 0x14, 0x08, 0x14, 0x63],
  Y: [0x07, 0x08, 0x70, 0x08, 0x07],
  Z: [0x61, 0x51, 0x49, 0x45, 0x43],
}
const GLYPH_W = 5
const GLYPH_H = 7
const TEXT_SCALE = 2
const CHAR_ADVANCE = (GLYPH_W + 1) * TEXT_SCALE

function drawText(pixels: Uint8Array, width: number, height: number, x: number, y: number, text: string, fill: [number, number, number, number]): void {
  let cursor = Math.round(x)
  for (const raw of text) {
    const glyph = FONT[raw.toUpperCase()] ?? FONT[' ']!
    for (let col = 0; col < GLYPH_W; col++) {
      for (let row = 0; row < GLYPH_H; row++) {
        if (!(glyph[col]! & (1 << row))) continue
        for (let dy = 0; dy < TEXT_SCALE; dy++) for (let dx = 0; dx < TEXT_SCALE; dx++) {
          paint(pixels, width, cursor + col * TEXT_SCALE + dx, Math.round(y) + row * TEXT_SCALE + dy, fill)
        }
      }
    }
    cursor += CHAR_ADVANCE
  }
}

function textWidth(text: string): number {
  return text.length * CHAR_ADVANCE - TEXT_SCALE
}

type LabelJob = { x: number; y: number; text: string; fill: [number, number, number, number] }

/** Centered, truncated-to-fit label job for a furniture box already in screen space. */
function boxLabel(screenPoints: Point[], text: string, fill: [number, number, number, number], maxChars = 16): LabelJob | null {
  if (!text) return null
  const xs = screenPoints.map((p) => p[0]!)
  const ys = screenPoints.map((p) => p[1]!)
  const boxW = Math.max(...xs) - Math.min(...xs)
  const boxH = Math.max(...ys) - Math.min(...ys)
  const fit = Math.max(1, Math.min(maxChars, Math.floor((boxW - 4) / CHAR_ADVANCE)))
  const clipped = text.slice(0, fit)
  return {
    x: (Math.min(...xs) + Math.max(...xs)) / 2 - textWidth(clipped) / 2,
    y: (Math.min(...ys) + Math.max(...ys)) / 2 - (GLYPH_H * TEXT_SCALE) / 2,
    text: boxW < CHAR_ADVANCE || boxH < GLYPH_H * TEXT_SCALE ? '' : clipped,
    fill: inkFor(fill),
  }
}

async function renderPlan(home: NormalizedHomeState, width: number, height: number): Promise<string> {
  const pixels = new Uint8Array(width * height * 4)
  fill(pixels, [248, 248, 248, 255])
  const points = home.walls.flatMap((w) => [[w.xStart, w.yStart], [w.xEnd, w.yEnd]] as Point[])
    .concat(home.rooms.flatMap((r) => r.points as Point[]), home.furniture.map((f) => [f.x, f.y] as Point))
  const xs = points.map((p) => p[0])
  const ys = points.map((p) => p[1])
  const minX = Math.min(0, ...xs) - 40
  const minY = Math.min(0, ...ys) - 40
  const maxX = Math.max(100, ...xs) + 40
  const maxY = Math.max(100, ...ys) + 40
  const scale = Math.min((width - 24) / (maxX - minX), (height - 24) / (maxY - minY))
  const bounds = { minX, minY, scale, x: (width - (maxX - minX) * scale) / 2, y: (height - (maxY - minY) * scale) / 2 }
  for (const room of home.rooms) polygon(pixels, width, height, room.points.map((p) => planPoint(p as Point, bounds)), color('#e8e4dc'))
  const labels: LabelJob[] = []
  for (const item of home.furniture) if (!item.doorOrWindow) {
    const angleRad = (item.angleDeg * Math.PI) / 180
    const cos = Math.cos(angleRad)
    const sin = Math.sin(angleRad)
    const hw = item.width / 2
    const hd = item.depth / 2
    const offsets: Point[] = [[-hw, -hd], [hw, -hd], [hw, hd], [-hw, hd]]
    const corners: Point[] = offsets.map(
      ([ox, oz]): Point => [item.x + ox * cos - oz * sin, item.y + ox * sin + oz * cos],
    )
    const boxFill = item.catalogId ? catalogRgb(item.catalogId) : color('#9b8068')
    const screenCorners = corners.map((c) => planPoint(c, bounds))
    polygon(pixels, width, height, screenCorners, boxFill)
    const label = boxLabel(screenCorners, furnitureLabel(item), boxFill)
    if (label && label.text) labels.push(label)
  }
  for (const wall of home.walls) line(pixels, width, height, planPoint([wall.xStart, wall.yStart], bounds), planPoint([wall.xEnd, wall.yEnd], bounds), color('#444444'), Math.max(1, Math.round((wall.thickness ?? 7) * scale)))
  for (const label of labels) drawText(pixels, width, height, label.x, label.y, label.text, label.fill)
  return png(width, height, pixels)
}

export type Render3dOptions = { roofVisible?: boolean; lightIntensity?: number }

export async function render3d(home: NormalizedHomeState, width: number, height: number, cameraName = 'observer', options: Render3dOptions = {}): Promise<string> {
  const store = new HomeStore()
  // Compute the deterministic catalog color BEFORE stripping catalogId, and
  // carry it in item.color: buildScene's fallback box uses item.color ?? the
  // default grey, so this alone differentiates boxes in the raster output.
  // Doors/windows keep their own rendering path untouched.
  const safeHome = {
    ...home,
    furniture: home.furniture.map((item) => ({
      ...item,
      catalogId: null,
      modelPath: null,
      color: !item.doorOrWindow && item.catalogId ? catalogColor(item.catalogId) : item.color,
    })),
  }
  store.loadHome(safeHome)
  const scene = buildScene(safeHome, {
    modelUrlResolver: () => '',
    // This is a documentation/verification rasterizer for the whole model
    // (MCP screenshot tool, scripted demos) — not a first-person interior
    // walkthrough — so it renders in "outside view" like CaptureService's
    // headless capture path (see src/automation/capture.ts), independent of
    // the live viewport's interior-view-only roof/ceiling auto-hiding.
    isOutsideView: true,
    showRoof: options.roofVisible ?? true,
    lightIntensity: options.lightIntensity,
  })
  const state = safeHome.cameras[cameraName === 'top' ? 'top' : 'observer']
  const camera = new THREE.PerspectiveCamera(state.fovDeg, width / height, 1, 500_000)
  camera.position.set(state.x, state.z, state.y)
  camera.rotation.order = 'YXZ'
  camera.rotation.y = Math.PI - (state.yawDeg * Math.PI) / 180
  camera.rotation.x = -(state.pitchDeg * Math.PI) / 180
  camera.updateMatrixWorld(true)
  camera.updateProjectionMatrix()
  const pixels = new Uint8Array(width * height * 4)
  fill(pixels, [222, 222, 222, 255])
  const faces: Array<{ points: Point[]; depth: number; color: [number, number, number, number] }> = []
  scene.updateMatrixWorld(true)
  scene.traverse((object) => {
    const mesh = object as THREE.Mesh
    if (!mesh.isMesh || !mesh.geometry) return
    const position = mesh.geometry.getAttribute('position')
    if (!position) return
    const index = mesh.geometry.getIndex()
    const indices = index ? Array.from(index.array) : Array.from({ length: position.count }, (_, i) => i)
    const fill = mesh.material instanceof THREE.Material && 'color' in mesh.material ? `#${(mesh.material as THREE.MeshStandardMaterial).color.getHexString()}` : '#b0b0b0'
    for (let i = 0; i + 2 < indices.length; i += 3) {
      const projected = indices.slice(i, i + 3).map((n) => {
        const point = new THREE.Vector3().fromBufferAttribute(position, n).applyMatrix4(mesh.matrixWorld)
        point.project(camera)
        return { x: (point.x + 1) * width / 2, y: (1 - point.y) * height / 2, z: point.z }
      })
      if (projected.some((p) => p.z < -1 || p.z > 1)) continue
      faces.push({ points: projected.map((p) => [p.x, p.y] as Point), depth: projected.reduce((sum, p) => sum + p.z, 0) / 3, color: color(fill) })
    }
  })
  faces.sort((a, b) => b.depth - a.depth)
  for (const face of faces) polygon(pixels, width, height, face.points, face.color)
  for (const item of home.furniture) if (!item.doorOrWindow) {
    const text = furnitureLabel(item).slice(0, 12)
    if (!text) continue
    const center = new THREE.Vector3(item.x, item.elevation + item.height / 2, item.y).project(camera)
    if (center.z < -1 || center.z > 1) continue
    const fillNumber = item.catalogId ? catalogColor(item.catalogId) : item.color ?? 0xe8e8e8
    const boxFill: [number, number, number, number] = [(fillNumber >> 16) & 255, (fillNumber >> 8) & 255, fillNumber & 255, 255]
    drawText(pixels, width, height, (center.x + 1) * width / 2 - textWidth(text) / 2, (1 - center.y) * height / 2 - (GLYPH_H * TEXT_SCALE) / 2, text, inkFor(boxFill))
  }
  return png(width, height, pixels)
}

// Only run the stdin-driven CLI entrypoint when executed directly (`npx tsx
// render_scene.ts`), not when imported for unit testing the pure PNG/rasterizer
// helpers above.
const isMain = import.meta.url === `file://${process.argv[1]}`
if (isMain) {
  let input = ''
  process.stdin.setEncoding('utf8')
  process.stdin.on('data', (chunk) => { input += chunk })
  process.stdin.on('end', () => {
    const request = JSON.parse(input) as Request
    const rendered = request.view === 'plan'
      ? renderPlan(request.home, request.width, request.height)
      : render3d(request.home, request.width, request.height, request.camera, {
          roofVisible: request.roofVisible,
          lightIntensity: request.lightIntensity,
        })
    Promise.resolve(rendered).then((pngBase64) => process.stdout.write(JSON.stringify({ pngBase64, width: request.width, height: request.height })))
  })
}
