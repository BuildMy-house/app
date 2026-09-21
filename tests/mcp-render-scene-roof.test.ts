import { describe, expect, it } from 'vitest'
import { inflateSync } from 'node:zlib'
import { crc32, render3d } from '../mcp/render_scene'
import { createEmptyHome } from '../src/core/home'
import { HomeStore } from '../src/core/store'
import { HomeModel } from '../src/core/model'

/**
 * Regression test for the MCP screenshot pipeline ignoring `set_roof_visible`.
 * mcp/server.py renders `screenshot`/`screenshot_views` by re-rendering the
 * raw `get_state` home JSON through the headless mcp/render_scene.ts
 * rasterizer, which previously hard-coded buildScene's showRoof default —
 * so a roof hidden via set_roof_visible (stored browser-side on
 * CaptureService) could never disappear from a scripted screenshot.
 */

const WIDTH = 160
const HEIGHT = 120
const ROOF_COLOR: [number, number, number] = [255, 0, 255] // 0xff00ff, unique in the fixture scene

function roofedHome() {
  const store = new HomeStore()
  const model = new HomeModel(store)
  model.addRoof([[20, 20], [180, 20], [100, 120]], { color: 0xff00ff })
  return { ...createEmptyHome('Etc/GMT'), ...store.getHome(), name: 'roof-regression' }
}

/** Walk PNG chunks to IDAT and decode scanlines (encoder emits filter type 0). */
function pixels(base64: string, width: number, height: number): Uint8Array {
  const bytes = Buffer.from(base64, 'base64')
  expect(bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))).toBe(true)
  const parts: Buffer[] = []
  let pos = 8
  while (pos < bytes.length) {
    const length = bytes.readUInt32BE(pos)
    const type = bytes.toString('ascii', pos + 4, pos + 8)
    expect(crc32(bytes.subarray(pos + 4, pos + 8 + length))).toBe(bytes.readUInt32BE(pos + 8 + length))
    if (type === 'IDAT') parts.push(Buffer.from(bytes.subarray(pos + 8, pos + 8 + length)))
    pos += 12 + length
    if (type === 'IEND') break
  }
  expect(pos).toBe(bytes.length)
  const raw = inflateSync(Buffer.concat(parts))
  const stride = width * 4 + 1
  const out = new Uint8Array(width * height * 4)
  for (let y = 0; y < height; y++) out.set(raw.subarray(y * stride + 1, (y + 1) * stride), y * width * 4)
  return out
}

function countColor(px: Uint8Array, [r, g, b]: [number, number, number]): number {
  let count = 0
  for (let i = 0; i < px.length; i += 4) {
    if (px[i] === r && px[i + 1] === g && px[i + 2] === b) count++
  }
  return count
}

describe('mcp/render_scene.ts roof-visibility wiring (set_roof_visible regression)', () => {
  it('renders the roof by default and drops every roof pixel with roofVisible: false', async () => {
    const home = roofedHome()
    const visible = pixels(await render3d(home, WIDTH, HEIGHT, 'top'), WIDTH, HEIGHT)
    const hidden = pixels(await render3d(home, WIDTH, HEIGHT, 'top', { roofVisible: false }), WIDTH, HEIGHT)
    expect(countColor(visible, ROOF_COLOR)).toBeGreaterThan(0)
    expect(countColor(hidden, ROOF_COLOR)).toBe(0)
  })
})
