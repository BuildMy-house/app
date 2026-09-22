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
  for (const item of home.furniture) if (!item.doorOrWindow) {
    const p = planPoint([item.x, item.y], bounds)
    const sx = item.width * scale / 2
    const sy = item.depth * scale / 2
    polygon(pixels, width, height, [[p[0] - sx, p[1] - sy], [p[0] + sx, p[1] - sy], [p[0] + sx, p[1] + sy], [p[0] - sx, p[1] + sy]], color('#9b8068'))
  }
  for (const wall of home.walls) line(pixels, width, height, planPoint([wall.xStart, wall.yStart], bounds), planPoint([wall.xEnd, wall.yEnd], bounds), color('#444444'), Math.max(1, Math.round((wall.thickness ?? 7) * scale)))
  return png(width, height, pixels)
}

export type Render3dOptions = { roofVisible?: boolean; lightIntensity?: number }

export async function render3d(home: NormalizedHomeState, width: number, height: number, cameraName = 'observer', options: Render3dOptions = {}): Promise<string> {
  const store = new HomeStore()
  const safeHome = { ...home, furniture: home.furniture.map((item) => ({ ...item, catalogId: null, modelPath: null })) }
  store.loadHome(safeHome)
  const scene = buildScene(safeHome, {
    modelUrlResolver: () => '',
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
