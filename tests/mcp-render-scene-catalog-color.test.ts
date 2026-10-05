import { describe, expect, it } from 'vitest'
import { catalogColor } from '../mcp/render_scene'

/**
 * T3: deterministic per-catalogId colors for furniture boxes in the MCP
 * screenshot rasterizer (mcp/render_scene.ts).
 */
describe('mcp/render_scene.ts catalogColor', () => {
  it('returns the same color for the same catalogId on repeat calls', () => {
    expect(catalogColor('eTeks#sofa')).toBe(catalogColor('eTeks#sofa'))
    expect(catalogColor('sofa-3-seater')).toBe(catalogColor('sofa-3-seater'))
  })

  it('gives different catalogIds different colors', () => {
    const ids = [
      'eTeks#sofa', 'eTeks#bookshelf', 'eTeks#lamp', 'eTeks#chair',
      'eTeks#table', 'eTeks#bed', 'eTeks#rug', 'eTeks#wardrobe',
    ]
    const colors = new Set(ids.map((id) => catalogColor(id)))
    expect(colors.size).toBe(ids.length)
  })

  it('stays mid-range: no near-black or near-white channels', () => {
    for (const id of ['eTeks#sofa', 'light', 'zzzz', 'a', '0', 'window-1', 'sofa-3-seater']) {
      const n = catalogColor(id)
      const channels = [(n >> 16) & 255, (n >> 8) & 255, n & 255]
      for (const c of channels) {
        expect(c).toBeGreaterThan(30)
        expect(c).toBeLessThan(230)
      }
      expect(Math.max(...channels)).toBeGreaterThan(120)
    }
  })
})
