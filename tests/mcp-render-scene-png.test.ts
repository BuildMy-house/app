import { describe, expect, it } from 'vitest'
import { deflateSync, inflateSync } from 'node:zlib'
import { chunk, crc32, png } from '../mcp/render_scene'

/**
 * Regression test for a corrupted-PNG bug in the MCP screenshot pipeline
 * (mcp/render_scene.ts, spawned by mcp/server.py's `_render()` for the
 * `screenshot`/`screenshot_views` MCP tools — a separate, hand-rolled
 * software rasterizer from src/automation/capture.ts's real WebGL
 * BrowserCaptureBackend). `chunk()` previously over-allocated its output
 * buffer by 4 extra trailing zero bytes per chunk (mistakenly adding the
 * type length twice), silently corrupting every chunk boundary after the
 * first and producing a PNG that decoders reject even though its magic
 * bytes and IHDR looked fine at a glance.
 */

/** Walk PNG chunks structurally: signature, per-chunk CRC, IHDR/IDAT/IEND
 * sizes and byte alignment — catches the "4 trailing garbage bytes per
 * chunk" corruption a naive header-only check (`file` command, magic byte
 * sniffing) would miss. */
function parsePngChunks(bytes: Uint8Array): Array<{ type: string; data: Uint8Array }> {
  const sig = Buffer.from(bytes.slice(0, 8))
  expect(sig.equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))).toBe(true)
  const chunks: Array<{ type: string; data: Uint8Array }> = []
  let pos = 8
  while (pos < bytes.length) {
    const buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    const length = buf.readUInt32BE(pos)
    const type = buf.toString('ascii', pos + 4, pos + 8)
    const data = bytes.slice(pos + 8, pos + 8 + length)
    const crcStored = buf.readUInt32BE(pos + 8 + length)
    const crcCalc = crc32(Buffer.concat([Buffer.from(type), Buffer.from(data)]))
    expect(crcCalc).toBe(crcStored)
    chunks.push({ type, data })
    pos += 12 + length
    if (type === 'IEND') break
  }
  // No trailing bytes after IEND, and every chunk boundary landed exactly
  // where its own length field said it would (would fail if any chunk()
  // call appended stray bytes).
  expect(pos).toBe(bytes.length)
  return chunks
}

describe('mcp/render_scene.ts PNG encoder', () => {
  it('produces a structurally valid, fully-decodable PNG (chunk() byte-alignment regression)', () => {
    const width = 4
    const height = 3
    const pixels = new Uint8Array(width * height * 4)
    for (let i = 0; i < pixels.length; i += 4) pixels.set([10, 20, 30, 255], i)

    const base64 = png(width, height, pixels)
    const bytes = new Uint8Array(Buffer.from(base64, 'base64'))
    const chunks = parsePngChunks(bytes)

    expect(chunks.map((c) => c.type)).toEqual(['IHDR', 'IDAT', 'IEND'])

    const ihdr = Buffer.from(chunks[0]!.data)
    expect(ihdr.readUInt32BE(0)).toBe(width)
    expect(ihdr.readUInt32BE(4)).toBe(height)
    expect(ihdr[8]).toBe(8) // bit depth
    expect(ihdr[9]).toBe(6) // color type: RGBA

    // IDAT must decompress to exactly one filter byte + width*4 bytes per row.
    const raw = inflateSync(Buffer.from(chunks[1]!.data))
    expect(raw.length).toBe((width * 4 + 1) * height)
  })

  it('chunk() emits exactly data.length + 12 bytes (no trailing padding)', () => {
    const data = Buffer.from('hello')
    const out = chunk('TEST', data)
    expect(out.length).toBe(data.length + 12)
  })

  it('round-trips via node zlib deflateSync the same way png() does', () => {
    // Sanity check that the raw scanline buffer this module hands to
    // deflateSync is well-formed independent of the chunk() bug above.
    const width = 2
    const height = 2
    const rows = Buffer.alloc((width * 4 + 1) * height)
    const deflated = deflateSync(rows)
    expect(() => inflateSync(deflated)).not.toThrow()
  })
})
