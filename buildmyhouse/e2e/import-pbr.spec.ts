import { deflateSync } from 'node:zlib'
import { expect, test, type Page } from '@playwright/test'

/**
 * MAT-T3: a REAL textured GLB (embedded baseColor + normal + metallicRoughness
 * PNGs) must survive the full import path with all maps intact and correctly
 * color-space tagged — in the catalog thumbnail AND when placed in the 3D
 * scene. The fixture is hand-assembled (pure Node, no three.js) so the test
 * controls every byte of the glTF JSON.
 */

// ── Minimal PNG encoder (8-bit RGBA, filter 0, no interlace) ────────────────

let crcTable: Int32Array | null = null
function crc32(buf: Buffer): number {
  if (!crcTable) {
    crcTable = new Int32Array(256)
    for (let n = 0; n < 256; n++) {
      let c = n
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
      crcTable[n] = c
    }
  }
  let crc = -1
  for (let i = 0; i < buf.length; i++) crc = (crc >>> 8) ^ crcTable[(crc ^ buf[i]!) & 0xff]!
  return (crc ^ -1) >>> 0
}

function pngChunk(type: string, data: Buffer): Buffer {
  const out = Buffer.alloc(12 + data.length)
  out.writeUInt32BE(data.length, 0)
  out.write(type, 4, 'ascii')
  data.copy(out, 8)
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length)
  return out
}

function encodePng(width: number, height: number, rgba: Buffer): Buffer {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // color type: RGBA
  const stride = width * 4 + 1
  const raw = Buffer.alloc(stride * height)
  for (let y = 0; y < height; y++) {
    raw[y * stride] = 0 // filter: none
    rgba.copy(raw, y * stride + 1, y * width * 4, (y + 1) * width * 4)
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0)),
  ])
}

function gradientTexture(r: (x: number, y: number) => number, g: (x: number, y: number) => number, b: (x: number, y: number) => number): Buffer {
  const size = 64
  const px = Buffer.alloc(size * size * 4)
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4
      px[i] = r(x, y) & 0xff
      px[i + 1] = g(x, y) & 0xff
      px[i + 2] = b(x, y) & 0xff
      px[i + 3] = 255
    }
  }
  return encodePng(size, size, px)
}

// ── GLB assembly (one textured quad) ────────────────────────────────────────

function buildGlb(json: object, bin: Buffer): Buffer {
  let jsonBuf = Buffer.from(JSON.stringify(json), 'utf8')
  const jsonPad = (4 - (jsonBuf.length % 4)) % 4
  if (jsonPad) jsonBuf = Buffer.concat([jsonBuf, Buffer.alloc(jsonPad, 0x20)])
  const binPad = (4 - (bin.length % 4)) % 4
  const binBuf = binPad ? Buffer.concat([bin, Buffer.alloc(binPad)]) : bin
  const header = Buffer.alloc(12)
  header.writeUInt32LE(0x46546c67, 0) // magic glTF
  header.writeUInt32LE(2, 4) // version
  header.writeUInt32LE(12 + 8 + jsonBuf.length + 8 + binBuf.length, 8)
  const jsonChunk = Buffer.alloc(8)
  jsonChunk.writeUInt32LE(jsonBuf.length, 0)
  jsonChunk.write('JSON', 4, 'ascii')
  const binChunk = Buffer.alloc(8)
  binChunk.writeUInt32LE(binBuf.length, 0)
  binChunk.write('BIN\0', 4, 'ascii')
  return Buffer.concat([header, jsonChunk, jsonBuf, binChunk, binBuf])
}

const baseColorPng = gradientTexture((x) => x * 4, (_, y) => y * 4, () => 200)
const normalPng = gradientTexture(
  (x) => 128 + Math.round(Math.sin(x / 6) * 60), // sloped normals, stays 0..255
  () => 128,
  () => 255,
)
const metalRoughPng = gradientTexture(() => 255, (x) => 120 + x, (_, y) => 60 + y) // G=roughness, B=metalness, vary per texel

function buildPbrFixtureGlb(): Buffer {
  const positions = new Float32Array([
    -0.5, -0.5, 0,
    0.5, -0.5, 0,
    0.5, 0.5, 0,
    -0.5, 0.5, 0,
  ])
  const normals = new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1])
  const uvs = new Float32Array([0, 0, 1, 0, 1, 1, 0, 1])
  const indices = new Uint16Array([0, 1, 2, 0, 2, 3])

  const buffers: Buffer[] = []
  const views: { buffer: number; byteOffset: number; byteLength: number; target?: number }[] = []
  let offset = 0
  const pushView = (data: Buffer, target?: number): number => {
    const pad = (4 - (offset % 4)) % 4
    if (pad) {
      buffers.push(Buffer.alloc(pad))
      offset += pad
    }
    buffers.push(data)
    views.push({ buffer: 0, byteOffset: offset, byteLength: data.length, target })
    offset += data.length
    return views.length - 1
  }
  const posView = pushView(Buffer.from(positions.buffer), 34962)
  const nrmView = pushView(Buffer.from(normals.buffer), 34962)
  const uvView = pushView(Buffer.from(uvs.buffer), 34962)
  const idxView = pushView(Buffer.from(indices.buffer), 34963)
  const img0 = pushView(baseColorPng)
  const img1 = pushView(normalPng)
  const img2 = pushView(metalRoughPng)

  const json = {
    asset: { version: '2.0', generator: 'mat-t3 fixture' },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0 }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0, NORMAL: 1, TEXCOORD_0: 2 }, indices: 3, material: 0 }] }],
    materials: [
      {
        name: 'pbr-fixture',
        pbrMetallicRoughness: {
          baseColorFactor: [1, 1, 1, 1],
          baseColorTexture: { index: 0 },
          metallicFactor: 1,
          roughnessFactor: 1,
          metallicRoughnessTexture: { index: 2 },
        },
        normalTexture: { index: 1 },
      },
    ],
    textures: [
      { sampler: 0, source: 0 },
      { sampler: 0, source: 1 },
      { sampler: 0, source: 2 },
    ],
    images: [
      { bufferView: img0, mimeType: 'image/png' },
      { bufferView: img1, mimeType: 'image/png' },
      { bufferView: img2, mimeType: 'image/png' },
    ],
    samplers: [{ magFilter: 9729, minFilter: 9987, wrapS: 10497, wrapT: 10497 }],
    accessors: [
      { bufferView: posView, componentType: 5126, count: 4, type: 'VEC3', min: [-0.5, -0.5, 0], max: [0.5, 0.5, 0] },
      { bufferView: nrmView, componentType: 5126, count: 4, type: 'VEC3' },
      { bufferView: uvView, componentType: 5126, count: 4, type: 'VEC2' },
      { bufferView: idxView, componentType: 5123, count: 6, type: 'SCALAR' },
    ],
    buffers: [{ byteLength: offset }],
    bufferViews: views,
  }
  return buildGlb(json, Buffer.concat(buffers))
}

const pbrGlb = buildPbrFixtureGlb()

// ── Test flow ───────────────────────────────────────────────────────────────

async function importGlb(page: Page, name: string, buffer: Buffer): Promise<void> {
  const [chooser] = await Promise.all([
    page.waitForEvent('filechooser'),
    page.locator('.catalog-import').click(),
  ])
  await chooser.setFiles({ name, mimeType: 'model/gltf-binary', buffer })
}

async function sceneMaterialInfo(page: Page): Promise<Record<string, unknown>> {
  return page.evaluate(() => {
    const v = (window as unknown as { __view3d?: { _scene?: { traverse: (cb: (o: unknown) => void) => void } } }).__view3d
    let info: Record<string, unknown> | null = null
    v!._scene!.traverse((o) => {
      const mesh = o as { isMesh?: boolean; material?: { map?: { colorSpace: string; generateMipmaps: boolean; minFilter: number; anisotropy: number }; normalMap?: { colorSpace: string }; roughnessMap?: { colorSpace: string }; metalnessMap?: { colorSpace: string } } }
      if (!mesh.isMesh || !mesh.material?.normalMap || info) return
      const m = mesh.material
      info = {
        hasMap: !!m.map,
        hasNormal: !!m.normalMap,
        hasRough: !!m.roughnessMap,
        hasMetal: !!m.metalnessMap,
        mapCs: m.map?.colorSpace,
        normalCs: m.normalMap?.colorSpace,
        roughCs: m.roughnessMap?.colorSpace,
        metalCs: m.metalnessMap?.colorSpace,
        generateMipmaps: m.map?.generateMipmaps,
        minFilter: m.map?.minFilter,
        anisotropy: m.map?.anisotropy,
      }
    })
    if (!info) throw new Error('no textured mesh in scene')
    return info
  })
}

test.beforeEach(async ({ page }) => {
  await page.goto('/')
  await page.waitForSelector('#view3d canvas', { timeout: 30_000 })
  await page.waitForSelector('.catalog-import', { timeout: 15_000 })
})

test('Basis transcoder is served from the synced assets dir', async ({ request }) => {
  expect((await request.get('/assets/basis/basis_transcoder.js')).status()).toBe(200)
  expect((await request.get('/assets/basis/basis_transcoder.wasm')).status()).toBe(200)
})

test('real-PBR GLB: maps survive import → thumbnail → 3D scene placement', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(`pageerror: ${e}`))
  const before = await page.locator('.catalog-card').count()

  await importGlb(page, 'pbr-fixture.glb', pbrGlb)
  await expect(page.locator('#status-automation')).toHaveText('imported pbr-fixture', { timeout: 15_000 })
  await expect(page.locator('.catalog-card')).toHaveCount(before + 1)

  // Thumbnail: the imported card's canvas must show real rendered variety,
  // not just the flat color-swatch fallback.
  await page.waitForFunction(() => {
    const cards = document.querySelectorAll('.catalog-card')
    const canvas = cards[cards.length - 1]?.querySelector('canvas')
    if (!canvas) return false
    const ctx = canvas.getContext('2d')
    if (!ctx) return false
    const d = ctx.getImageData(0, 0, canvas.width, canvas.height).data
    const seen = new Set<number>()
    for (let i = 0; i < d.length; i += 4) seen.add((d[i]! << 16) | (d[i + 1]! << 8) | d[i + 2]!)
    return seen.size > 8
  }, { timeout: 15_000 })

  // Place the imported model in the 3D scene (card click arms placement).
  await page.locator('.catalog-card').last().click()
  const v3 = await page.locator('#view3d canvas').boundingBox()
  await page.mouse.click(v3!.x + v3!.width * 0.5, v3!.y + v3!.height * 0.7)

  // Resolves only once the placed GLTF model (normalMap + shared cache tag)
  // is in the live scene — no further assertion needed.
  await page.waitForFunction(() => {
    const v = (window as unknown as { __view3d?: { _scene?: { traverse: (cb: (o: unknown) => void) => void } } }).__view3d
    let found = false
    v!._scene!.traverse((o) => {
      const mesh = o as { isMesh?: boolean; material?: { normalMap?: unknown }; userData?: { shared?: boolean } }
      if (mesh.isMesh && mesh.material?.normalMap && mesh.userData?.shared) found = true
    })
    return found
  }, undefined, { timeout: 15_000 }) // model swap-in is async (blob URL GLTF load)

  const mat = await sceneMaterialInfo(page)
  // All four maps present (glTF metallicRoughness splits into roughness+metalness).
  expect(mat).toMatchObject({ hasMap: true, hasNormal: true, hasRough: true, hasMetal: true })
  // Color spaces: diffuse sRGB, data maps linear (NoColorSpace) — the exact
  // round-trip hazard MAT-T2 fixed for the catalog texture pipeline.
  expect(mat.mapCs).toBe('srgb')
  expect(mat.normalCs).toBe('')
  expect(mat.roughCs).toBe('')
  expect(mat.metalCs).toBe('')
  // Mipmapping on with trilinear min filter; anisotropy applied from the
  // viewport-quality setting (default medium tier = 4).
  expect(mat.generateMipmaps).toBe(true)
  expect(mat.minFilter).toBe(1008) // LinearMipmapLinearFilter (three.js constant)
  expect(mat.anisotropy).toBe(4)

  expect(errors).toEqual([])
})
