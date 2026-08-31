import { describe, it, expect } from 'vitest'
import { drawPlan, setTestImageCache, type PlanRenderingContext, type ViewTransform } from './renderer'
import { createEmptyHome, WALL_TEXTURES } from '../core/home'

interface Op { type: string; args?: unknown[] }

class MockContext implements PlanRenderingContext {
  ops: Op[] = []
  _gco: GlobalCompositeOperation = 'source-over'
  lineWidth = 1
  strokeStyle = '#000'
  fillStyle = '#000'
  font = '12px sans-serif'
  textAlign: CanvasTextAlign = 'start'
  textBaseline: CanvasTextBaseline = 'alphabetic'
  patternResult: string | null = null

  get globalCompositeOperation(): GlobalCompositeOperation { return this._gco }
  set globalCompositeOperation(v: GlobalCompositeOperation) {
    this._gco = v
    this.ops.push({ type: 'globalCompositeOperation', args: [v] })
  }

  beginPath(): void { this.ops.push({ type: 'beginPath' }) }
  moveTo(x: number, y: number): void { this.ops.push({ type: 'moveTo', args: [x, y] }) }
  lineTo(x: number, y: number): void { this.ops.push({ type: 'lineTo', args: [x, y] }) }
  closePath(): void { this.ops.push({ type: 'closePath' }) }
  stroke(): void { this.ops.push({ type: 'stroke' }) }
  fill(): void { this.ops.push({ type: 'fill' }) }
  fillRect(x: number, y: number, w: number, h: number): void { this.ops.push({ type: 'fillRect', args: [x, y, w, h] }) }
  fillText(text: string, x: number, y: number): void { this.ops.push({ type: 'fillText', args: [text, x, y] }) }
  strokeRect(x: number, y: number, w: number, h: number): void { this.ops.push({ type: 'strokeRect', args: [x, y, w, h] }) }
  arc(x: number, y: number, r: number, s: number, e: number): void { this.ops.push({ type: 'arc', args: [x, y, r, s, e] }) }
  setLineDash(d: number[]): void { this.ops.push({ type: 'setLineDash', args: [d] }) }
  save(): void { this.ops.push({ type: 'save' }) }
  restore(): void { this.ops.push({ type: 'restore' }) }
  createPattern(image: unknown, repetition: string): unknown {
    this.ops.push({ type: 'createPattern', args: [image, repetition] })
    return this.patternResult
  }
}

const IDENTITY_VIEW: ViewTransform = { scale: 1, offsetX: 0, offsetY: 0 }

function usedDestOut(ctx: MockContext): boolean {
  return ctx.ops.some(op => op.type === 'globalCompositeOperation' && op.args?.[0] === 'destination-out')
}

describe('drawPlan wall openings', () => {
  it('punches transparent holes for door/window openings in wall fill', () => {
    const home = createEmptyHome()
    home.walls.push({
      id: 'w1', xStart: 0, yStart: 0, xEnd: 400, yEnd: 0, thickness: 15,
    })
    home.furniture.push({
      id: 'd1', name: 'Door',
      x: 200, y: 0, angleDeg: 0,
      width: 90, depth: 15, height: 210,
      elevation: 0,
      doorOrWindow: true,
      wallRef: 'w1',
      wallOffset: 200,
    })

    const ctx = new MockContext()
    drawPlan(home, null, ctx, IDENTITY_VIEW)

    expect(usedDestOut(ctx)).toBe(true)

    // The save/restore pair wraps the destination-out fills.
    const saveCount = ctx.ops.filter(op => op.type === 'save').length
    const restoreCount = ctx.ops.filter(op => op.type === 'restore').length
    expect(saveCount).toBeGreaterThanOrEqual(1)
    expect(restoreCount).toBeGreaterThanOrEqual(1)
  })

  it('does NOT punch holes when wall has no door/window attached', () => {
    const home = createEmptyHome()
    home.walls.push({
      id: 'w1', xStart: 0, yStart: 0, xEnd: 400, yEnd: 0, thickness: 15,
    })

    const ctx = new MockContext()
    drawPlan(home, null, ctx, IDENTITY_VIEW)

    expect(usedDestOut(ctx)).toBe(false)
  })

  it('does NOT punch holes for non-doorOrWindow furniture on the wall', () => {
    const home = createEmptyHome()
    home.walls.push({
      id: 'w1', xStart: 0, yStart: 0, xEnd: 400, yEnd: 0, thickness: 15,
    })
    home.furniture.push({
      id: 'f1', name: 'Bookshelf',
      x: 200, y: 0, angleDeg: 0,
      width: 90, depth: 30, height: 180,
      elevation: 0,
      doorOrWindow: false,
      wallRef: 'w1',
      wallOffset: 200,
    })

    const ctx = new MockContext()
    drawPlan(home, null, ctx, IDENTITY_VIEW)

    expect(usedDestOut(ctx)).toBe(false)
  })

  it('punches multiple holes for multiple openings on same wall', () => {
    const home = createEmptyHome()
    home.walls.push({
      id: 'w1', xStart: 0, yStart: 0, xEnd: 600, yEnd: 0, thickness: 15,
    })
    home.furniture.push(
      {
        id: 'd1', name: 'Door',
        x: 150, y: 0, angleDeg: 0,
        width: 90, depth: 15, height: 210,
        elevation: 0,
        doorOrWindow: true, wallRef: 'w1', wallOffset: 150,
      },
      {
        id: 'w2', name: 'Window',
        x: 450, y: 0, angleDeg: 0,
        width: 120, depth: 15, height: 120,
        elevation: 90,
        doorOrWindow: true, wallRef: 'w1', wallOffset: 450,
      },
    )

    const ctx = new MockContext()
    drawPlan(home, null, ctx, IDENTITY_VIEW)

    expect(usedDestOut(ctx)).toBe(true)
    // Count fill operations inside the destination-out block.
    // With 2 openings, there should be at least 2 fill() calls inside save/restore.
    const fillCount = ctx.ops.filter(op => op.type === 'fill').length
    // At minimum: 1 wall fill + 2 opening fills = 3
    expect(fillCount).toBeGreaterThanOrEqual(3)
  })
})

describe('drawPlan wall textures', () => {
  it('uses createPattern fill for a wall with leftSideTextureId when image is loaded', () => {
    const tex = WALL_TEXTURES.find(t => t.id === 'wood-oak')!
    const img = { complete: true, naturalWidth: 64 } as unknown as HTMLImageElement
    setTestImageCache(new Map([[`/assets/textures/${tex.file}`, img]]))

    const home = createEmptyHome()
    home.walls.push({
      id: 'w1', xStart: 0, yStart: 0, xEnd: 400, yEnd: 0, thickness: 15,
      leftSideTextureId: 'wood-oak',
    })

    const ctx = new MockContext()
    ctx.patternResult = 'mock-pattern'
    drawPlan(home, null, ctx, IDENTITY_VIEW)

    const patternCalls = ctx.ops.filter(op => op.type === 'createPattern')
    expect(patternCalls.length).toBeGreaterThanOrEqual(1)
    expect(ctx.fillStyle).toBe('mock-pattern')

    setTestImageCache(new Map())
  })

  it('falls back to flat color when no texture is set', () => {
    setTestImageCache(new Map())

    const home = createEmptyHome()
    home.walls.push({
      id: 'w1', xStart: 0, yStart: 0, xEnd: 400, yEnd: 0, thickness: 15,
      leftSideColor: 0xff0000,
    })

    const ctx = new MockContext()
    drawPlan(home, null, ctx, IDENTITY_VIEW)

    const patternCalls = ctx.ops.filter(op => op.type === 'createPattern')
    expect(patternCalls).toHaveLength(0)
    expect(ctx.fillStyle).toBe('#ff0000')

    setTestImageCache(new Map())
  })

  it('falls back to flat color when texture image has not loaded yet', () => {
    const img = { complete: false, naturalWidth: 0 } as unknown as HTMLImageElement
    setTestImageCache(new Map([['/assets/textures/wood-oak.png', img]]))

    const home = createEmptyHome()
    home.walls.push({
      id: 'w1', xStart: 0, yStart: 0, xEnd: 400, yEnd: 0, thickness: 15,
      leftSideTextureId: 'wood-oak',
    })

    const ctx = new MockContext()
    drawPlan(home, null, ctx, IDENTITY_VIEW)

    const patternCalls = ctx.ops.filter(op => op.type === 'createPattern')
    expect(patternCalls).toHaveLength(0)

    setTestImageCache(new Map())
  })

  it('textured wall produces different fillStyle than untextured wall', () => {
    const tex = WALL_TEXTURES.find(t => t.id === 'concrete')!
    const img = { complete: true, naturalWidth: 64 } as unknown as HTMLImageElement
    setTestImageCache(new Map([[`/assets/textures/${tex.file}`, img]]))

    const textured = createEmptyHome()
    textured.walls.push({
      id: 'w1', xStart: 0, yStart: 0, xEnd: 400, yEnd: 0, thickness: 15,
      leftSideTextureId: 'concrete',
    })
    const ctx1 = new MockContext()
    ctx1.patternResult = 'pattern-fill'
    drawPlan(textured, null, ctx1, IDENTITY_VIEW)
    const texturedFill = ctx1.fillStyle

    const plain = createEmptyHome()
    plain.walls.push({
      id: 'w2', xStart: 0, yStart: 0, xEnd: 400, yEnd: 0, thickness: 15,
    })
    const ctx2 = new MockContext()
    drawPlan(plain, null, ctx2, IDENTITY_VIEW)
    const plainFill = ctx2.fillStyle

    expect(texturedFill).not.toBe(plainFill)

    setTestImageCache(new Map())
  })
})
