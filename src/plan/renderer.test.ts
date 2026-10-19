import { describe, it, expect } from 'vitest'
import {
  drawPlan,
  formatWallLength,
  wallSnapReadoutText,
  setTestImageCache,
  type PlanRenderingContext,
  type ViewTransform,
} from './renderer'
import type { WallSnapReadout } from './engine'
import { createEmptyHome, WALL_TEXTURES, resolveTextureUrl } from '../core/home'

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
  globalAlpha = 1

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
  measureText(text: string): { width: number } {
    this.ops.push({ type: 'measureText', args: [text] })
    return { width: text.length * 6 }
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
    setTestImageCache(new Map([[resolveTextureUrl(tex.file), img]]))

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
    setTestImageCache(new Map([[resolveTextureUrl('wood-oak.png'), img]]))

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
    setTestImageCache(new Map([[resolveTextureUrl(tex.file), img]]))

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

describe('drawPlan furniture textures', () => {
  it('uses the furniture texture pattern when its image is loaded', () => {
    const tex = WALL_TEXTURES.find(t => t.id === 'wood-oak')!
    const img = { complete: true, naturalWidth: 64 } as unknown as HTMLImageElement
    setTestImageCache(new Map([[resolveTextureUrl(tex.file), img]]))

    const home = createEmptyHome()
    home.furniture.push({
      id: 'f1', name: 'Table', x: 200, y: 150, angleDeg: 0,
      width: 120, depth: 60, height: 75, elevation: 0,
      textureId: 'wood-oak',
    })

    const ctx = new MockContext()
    ctx.patternResult = 'furniture-pattern'
    drawPlan(home, null, ctx, IDENTITY_VIEW)

    expect(ctx.ops.filter(op => op.type === 'createPattern')).toHaveLength(1)
    expect(ctx.fillStyle).toBe('furniture-pattern')
    setTestImageCache(new Map())
  })
})

describe('drawPlan door swing arcs', () => {
  it('draws a quarter-circle arc and leaf line for a door', () => {
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

    const arcCalls = ctx.ops.filter(op => op.type === 'arc')
    expect(arcCalls.length).toBeGreaterThanOrEqual(1)
    const [, , r, sa, ea] = arcCalls[0]!.args as [number, number, number, number, number]
    expect(r).toBe(90)
    expect(ea - sa).toBeCloseTo(Math.PI / 2)

    const lineToCalls = ctx.ops.filter(op => op.type === 'lineTo')
    expect(lineToCalls.length).toBeGreaterThanOrEqual(1)
  })

  it('does NOT draw a swing arc for a window', () => {
    const home = createEmptyHome()
    home.walls.push({
      id: 'w1', xStart: 0, yStart: 0, xEnd: 400, yEnd: 0, thickness: 15,
    })
    home.furniture.push({
      id: 'w1f', name: 'Window',
      x: 200, y: 0, angleDeg: 0,
      width: 120, depth: 15, height: 120,
      elevation: 90,
      doorOrWindow: true,
      wallRef: 'w1',
      wallOffset: 200,
    })

    const ctx = new MockContext()
    const arcCountBefore = ctx.ops.filter(op => op.type === 'arc').length
    drawPlan(home, null, ctx, IDENTITY_VIEW)
    const arcCountAfter = ctx.ops.filter(op => op.type === 'arc').length

    expect(arcCountAfter).toBe(arcCountBefore)
  })
})

describe('drawPlan wall measurement preview', () => {
  it('draws the live segment and its length above the line', () => {
    const ctx = new MockContext()
    drawPlan(createEmptyHome(), {
      tool: 'wall',
      phase: 'drawing',
      chainStart: { x: 0, y: 0 },
      pendingWalls: [],
      wallLine: {
        start: { x: 0, y: 0 },
        end: { x: 125, y: 0 },
        length: 125,
      },
      roomPoints: [],
      polylinePoints: [],
      dimensionLine: null,
      marquee: null,
      closurePolygon: null,
      closureTooltip: null,
      snapLock: null,
      wallDragGhost: null,
      wallSnap: null,
      furnitureDragHint: null,
    }, ctx, IDENTITY_VIEW)

    expect(ctx.ops.some(op => op.type === 'lineTo' && op.args?.[0] === 125 && op.args?.[1] === 0)).toBe(true)
    expect(ctx.ops.some(op => op.type === 'fillText' && op.args?.[0] === '1.25 m' && Number(op.args?.[2]) < 0)).toBe(true)
  })
})

function makeSnap(partial: Partial<WallSnapReadout>): WallSnapReadout {
  return {
    end: { x: 125, y: 0 },
    lengthCm: 125,
    angleDeg: 0,
    lengthLock: 'none',
    angleLock: 'none',
    mode: 'soft',
    fine: false,
    typed: null,
    unit: 'cm',
    ...partial,
  }
}

function makeWallPreview(snap: WallSnapReadout, wallEnd: { x: number; y: number }) {
  return {
    tool: 'wall' as const,
    phase: 'drawing' as const,
    chainStart: { x: 0, y: 0 },
    pendingWalls: [],
    wallLine: {
      start: { x: 0, y: 0 },
      end: wallEnd,
      length: 125,
    },
    roomPoints: [],
    polylinePoints: [],
    dimensionLine: null,
    marquee: null,
    closurePolygon: null,
    closureTooltip: null,
    snapLock: null,
    wallDragGhost: null,
    wallSnap: snap,
    furnitureDragHint: null,
  }
}

describe('formatWallLength', () => {
  it('formats cm as metres with two decimals', () => {
    expect(formatWallLength(340, 'cm')).toBe('3.40 m')
    expect(formatWallLength(0, 'cm')).toBe('0.00 m')
  })

  it('rounds inch lengths to the nearest foot/inch', () => {
    expect(formatWallLength(30.48, 'inch')).toBe("1' 0\"")
    expect(formatWallLength(10.16, 'inch')).toBe("0' 4\"")
    expect(formatWallLength(45.72, 'inch')).toBe("1' 6\"")
  })
})

describe('wallSnapReadoutText', () => {
  it('builds soft-mode main + hint from length and angle', () => {
    const r = wallSnapReadoutText(makeSnap({ lengthCm: 340, angleDeg: 45 }))
    expect(r.main).toBe('3.40 m | 45°')
    expect(r.hint).toBe('Shift: lock 15° · Alt: free · Ctrl: fine · type length + Enter')
    expect(r.locked).toBe(false)
  })

  it('shows the hard-mode hint', () => {
    expect(wallSnapReadoutText(makeSnap({ mode: 'hard' })).hint).toBe('Shift: 15° lock')
  })

  it('shows the off-mode hint', () => {
    expect(wallSnapReadoutText(makeSnap({ mode: 'off' })).hint).toBe('Snapping off (Alt)')
  })

  it('appends the fine-step suffix', () => {
    expect(wallSnapReadoutText(makeSnap({ mode: 'hard', fine: true })).hint).toBe(
      'Shift: 15° lock · fine step',
    )
  })

  it('replaces the length with typed digits and the apply hint', () => {
    const r = wallSnapReadoutText(makeSnap({ typed: '120', angleDeg: 15 }))
    expect(r.main).toBe('length: 120 cm | 15°')
    expect(r.hint).toBe('Enter to apply, Esc to clear')
  })

  it('uses inch wording for typed digits in inch units', () => {
    const r = wallSnapReadoutText(makeSnap({ typed: '4', unit: 'inch' }))
    expect(r.main).toBe("length: 4 in | 0°")
  })

  it('formats inch unit lengths as feet and inches', () => {
    const r = wallSnapReadoutText(makeSnap({ lengthCm: 30.48, unit: 'inch' }))
    expect(r.main).toBe("1' 0\" | 0°")
  })

  it('rounds the angle to 0.1 degree without trailing .0', () => {
    expect(wallSnapReadoutText(makeSnap({ angleDeg: 44.96 })).main).toBe('1.25 m | 45°')
    expect(wallSnapReadoutText(makeSnap({ angleDeg: 45.06 })).main).toBe('1.25 m | 45.1°')
  })

  it('flags major/axis/diagonal locks but not step locks', () => {
    expect(wallSnapReadoutText(makeSnap({ lengthLock: 'major' })).locked).toBe(true)
    expect(wallSnapReadoutText(makeSnap({ angleLock: 'axis' })).locked).toBe(true)
    expect(wallSnapReadoutText(makeSnap({ angleLock: 'diagonal' })).locked).toBe(true)
    expect(wallSnapReadoutText(makeSnap({ lengthLock: 'step', angleLock: 'step' })).locked).toBe(false)
  })
})

describe('drawPlan wall snap readout', () => {
  it('draws the snapped line, readout text and pill without throwing', () => {
    const ctx = new MockContext()
    drawPlan(
      createEmptyHome(),
      makeWallPreview(
        makeSnap({ lengthCm: 125, angleDeg: 45 }),
        { x: 130, y: 2 }, // raw cursor; snapped end is at (125, 0)
      ),
      ctx,
      IDENTITY_VIEW,
    )

    // Line stops at the snapped end, not the raw cursor.
    expect(ctx.ops.some(op => op.type === 'lineTo' && op.args?.[0] === 125 && op.args?.[1] === 0)).toBe(true)
    expect(ctx.ops.some(op => op.type === 'lineTo' && op.args?.[0] === 130 && op.args?.[1] === 2)).toBe(false)

    const texts = ctx.ops.filter(op => op.type === 'fillText').map(op => op.args?.[0])
    expect(texts).toContain('1.25 m | 45°')
    expect(texts).toContain('Shift: lock 15° · Alt: free · Ctrl: fine · type length + Enter')

    // Dark pill background: fillRect anchored at the end point + 14/-14 offset.
    expect(ctx.ops.some(op => op.type === 'fillRect' && op.args?.[0] === 134 && op.args?.[1] === -24 && op.args?.[3] === 32)).toBe(true)
  })

  it('draws a major-lock ring at the snapped end', () => {
    const ctx = new MockContext()
    drawPlan(
      createEmptyHome(),
      makeWallPreview(makeSnap({ lengthLock: 'major' }), { x: 130, y: 2 }),
      ctx,
      IDENTITY_VIEW,
    )
    const rings = ctx.ops.filter(op => op.type === 'arc' && op.args?.[2] === 9)
    expect(rings.length).toBeGreaterThan(0)
  })

  it('draws the axis square at the chain start and the diagonal diamond at the end', () => {
    const ctx = new MockContext()
    drawPlan(
      createEmptyHome(),
      makeWallPreview(makeSnap({ angleLock: 'axis' }), { x: 130, y: 2 }),
      ctx,
      IDENTITY_VIEW,
    )
    expect(ctx.ops.some(op => op.type === 'strokeRect')).toBe(true)

    const ctx2 = new MockContext()
    drawPlan(
      createEmptyHome(),
      makeWallPreview(makeSnap({ angleLock: 'diagonal' }), { x: 130, y: 2 }),
      ctx2,
      IDENTITY_VIEW,
    )
    // Diamond = closed 4-vertex path around the end point (125, 0).
    expect(ctx2.ops.some(op => op.type === 'lineTo' && op.args?.[0] === 130 && op.args?.[1] === 0)).toBe(true)
  })

  it('draws no extra indicators for step locks or typed-length readout', () => {
    const ctx = new MockContext()
    drawPlan(
      createEmptyHome(),
      makeWallPreview(makeSnap({ lengthLock: 'step', angleLock: 'step', typed: '120' }), { x: 130, y: 2 }),
      ctx,
      IDENTITY_VIEW,
    )
    expect(ctx.ops.some(op => op.type === 'arc' && op.args?.[2] === 9)).toBe(false)
    expect(ctx.ops.some(op => op.type === 'strokeRect')).toBe(false)
    // No diamond either (its first lineTo lands at the end + 5px).
    expect(ctx.ops.filter(op => op.type === 'lineTo').some(op => op.args?.[0] === 130 && op.args?.[1] === 0)).toBe(false)
  })
})

describe('committed dimension lines', () => {
  function homeWithDimension(offset: number) {
    const home = createEmptyHome()
    home.dimensionLines.push({ id: 'd1', xStart: 0, yStart: 0, xEnd: 300, yEnd: 0, offset })
    return home
  }

  it('draws the line pushed out by the offset with extension lines and a metric label', () => {
    const ctx = new MockContext()
    drawPlan(homeWithDimension(50), null, ctx, IDENTITY_VIEW)
    expect(ctx.ops.some(op => op.type === 'lineTo' && op.args?.[0] === 300 && op.args?.[1] === 50)).toBe(true)
    // Extension line back to the measured point.
    expect(ctx.ops.some(op => op.type === 'moveTo' && op.args?.[0] === 300 && op.args?.[1] === 0)).toBe(true)
    expect(ctx.ops.filter(op => op.type === 'fillText').map(op => op.args?.[0])).toContain('3.00 m')
  })

  it('labels in feet and inches for the imperial preference', () => {
    const ctx = new MockContext()
    drawPlan(homeWithDimension(0), null, ctx, IDENTITY_VIEW, undefined, undefined, null, undefined, 'inch')
    expect(ctx.ops.filter(op => op.type === 'fillText').map(op => op.args?.[0])).toContain(`9' 10"`)
  })
})
