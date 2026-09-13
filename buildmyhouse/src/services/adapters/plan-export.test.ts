import { deflateSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import type { CaptureBackend } from '../../automation/capture'
import { HomeModel } from '../../core/model'
import { HomeStore } from '../../core/store'
import {
  PLAN_EXPORT_HEIGHT,
  PLAN_EXPORT_WIDTH,
  render3dPng,
  renderPlanPng,
} from './plan-export'

// ── minimal PNG encoder (node stdlib only) ──────────────────────────────────

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? (0xedb88320 ^ (c >>> 1)) >>> 0 : c >>> 1
  return c
})
const crc32 = (buf: Uint8Array): number => {
  let c = 0xffffffff
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff]! ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}
const chunk = (type: string, data: Uint8Array): Buffer => {
  const out = Buffer.alloc(data.length + 12)
  out.writeUInt32BE(data.length, 0)
  out.write(type, 4, 'ascii')
  out.set(data, 8)
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length)
  return out
}

/** Valid 8-bit RGBA PNG with varied (poorly-compressible) pixels. */
function makePng(width: number, height: number): Buffer {
  const stride = width * 4 + 1
  const raw = Buffer.alloc(stride * height)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const o = y * stride + 1 + x * 4
      raw[o] = (x * 13 + y * 7) % 256
      raw[o + 1] = (x * x + y) % 256
      raw[o + 2] = (x + y * 11) % 256
      raw[o + 3] = 255
    }
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

// ── fixtures ────────────────────────────────────────────────────────────────

function sampleHome() {
  const store = new HomeStore()
  new HomeModel(store).addWall({ xStart: 0, yStart: 0, xEnd: 400, yEnd: 300, thickness: 10 })
  return store.getHome()
}

function fakeBackend(png: Uint8Array) {
  const calls: Array<{ home: unknown; width: number; height: number }> = []
  const backend: CaptureBackend = {
    renderPlan(home, width, height) {
      calls.push({ home, width, height })
      return Buffer.from(png).toString('base64')
    },
    render3d: () => {
      throw new Error('unexpected render3d call')
    },
  }
  return { backend, calls }
}

function fake3dBackend(png: Uint8Array) {
  const calls: Array<{ scene: unknown; camera: unknown; width: number; height: number }> = []
  const backend: CaptureBackend = {
    renderPlan: () => {
      throw new Error('unexpected renderPlan call')
    },
    render3d(scene, camera, width, height) {
      calls.push({ scene, camera, width, height })
      return Buffer.from(png).toString('base64')
    },
  }
  return { backend, calls }
}

const FAKE_SCENE = {} as import('three').Scene
const FAKE_CAMERA = {} as import('three').PerspectiveCamera

const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]

// ── tests ───────────────────────────────────────────────────────────────────

describe('M9: plan PNG export', () => {
  it('produces a valid, non-trivial PNG from a sample home state', () => {
    const png = makePng(64, 64)
    const { backend, calls } = fakeBackend(png)
    const home = sampleHome()
    const bytes = renderPlanPng(home, { backend })

    // Valid PNG: signature + IHDR dimensions round-trip.
    expect(Array.from(bytes.slice(0, 8))).toEqual(PNG_SIG)
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    expect(view.getUint32(16)).toBe(64)
    expect(view.getUint32(20)).toBe(64)
    // Non-trivial payload and lossless base64 round-trip.
    expect(bytes.byteLength).toBeGreaterThan(500)
    expect(Array.from(bytes)).toEqual(Array.from(png))
    // The home flowed through at the default export size.
    expect(calls).toEqual([{ home, width: PLAN_EXPORT_WIDTH, height: PLAN_EXPORT_HEIGHT }])
  })

  it('passes custom dimensions through to the rasterizer', () => {
    const { backend, calls } = fakeBackend(makePng(2, 2))
    renderPlanPng(sampleHome(), { backend, width: 800, height: 600 })
    expect(calls[0]?.width).toBe(800)
    expect(calls[0]?.height).toBe(600)
  })

  it('fails fast outside a DOM environment (no silent empty export)', () => {
    expect(() => renderPlanPng(sampleHome())).toThrow(/requires a DOM/)
  })
})

describe('M48: 3D PNG export', () => {
  it('produces a valid, non-trivial PNG from a live scene', () => {
    const png = makePng(64, 64)
    const { backend, calls } = fake3dBackend(png)
    const bytes = render3dPng(FAKE_SCENE, FAKE_CAMERA, { backend })

    expect(Array.from(bytes.slice(0, 8))).toEqual(PNG_SIG)
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    expect(view.getUint32(16)).toBe(64)
    expect(view.getUint32(20)).toBe(64)
    expect(bytes.byteLength).toBeGreaterThan(500)
    expect(Array.from(bytes)).toEqual(Array.from(png))
    expect(calls).toEqual([
      { scene: FAKE_SCENE, camera: FAKE_CAMERA, width: PLAN_EXPORT_WIDTH, height: PLAN_EXPORT_HEIGHT },
    ])
  })

  it('passes custom dimensions through to the rasterizer', () => {
    const { backend, calls } = fake3dBackend(makePng(2, 2))
    render3dPng(FAKE_SCENE, FAKE_CAMERA, { backend, width: 800, height: 600 })
    expect(calls[0]?.width).toBe(800)
    expect(calls[0]?.height).toBe(600)
  })

  it('fails fast outside a DOM environment', () => {
    expect(() => render3dPng(FAKE_SCENE, FAKE_CAMERA)).toThrow(/requires a DOM/)
  })
})
