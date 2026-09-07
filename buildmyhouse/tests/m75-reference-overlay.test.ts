import { describe, expect, it } from 'vitest'
import { HomeModel } from '../src/core/model'
import { HomeStore } from '../src/core/store'
import { createEmptyHome } from '../src/core/home'
import { PlanEngine } from '../src/plan/engine'
import { drawPlan, findReferenceLevelId, type PlanRenderingContext, type ViewTransform } from '../src/plan/renderer'

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
  _globalAlpha = 1

  get globalCompositeOperation(): GlobalCompositeOperation { return this._gco }
  set globalCompositeOperation(v: GlobalCompositeOperation) { this._gco = v; this.ops.push({ type: 'globalCompositeOperation', args: [v] }) }

  get globalAlpha(): number { return this._globalAlpha }
  set globalAlpha(v: number) { this._globalAlpha = v; this.ops.push({ type: 'globalAlpha', args: [v] }) }

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
}

const IDENTITY_VIEW: ViewTransform = { scale: 1, offsetX: 0, offsetY: 0 }

function setup() {
  const store = new HomeStore()
  const model = new HomeModel(store)
  const engine = new PlanEngine(model)
  return { store, model, engine }
}

describe('findReferenceLevelId', () => {
  it('returns null when activeLevelId is null', () => {
    expect(findReferenceLevelId([], null)).toBeNull()
  })

  it('returns null when no level has lower elevation', () => {
    const levels = [
      { id: 'L1', name: 'Ground', elevation: 0, floorThickness: 20, height: 250, visible: true, viewable: true },
    ]
    expect(findReferenceLevelId(levels, 'L1')).toBeNull()
  })

  it('returns the level with highest elevation below active', () => {
    const levels = [
      { id: 'L1', name: 'Ground', elevation: 0, floorThickness: 20, height: 250, visible: true, viewable: true },
      { id: 'L2', name: 'Floor 2', elevation: 250, floorThickness: 20, height: 250, visible: true, viewable: true },
      { id: 'L3', name: 'Floor 3', elevation: 500, floorThickness: 20, height: 250, visible: true, viewable: true },
    ]
    expect(findReferenceLevelId(levels, 'L3')).toBe('L2')
    expect(findReferenceLevelId(levels, 'L2')).toBe('L1')
  })

  it('returns null when active level not found', () => {
    const levels = [
      { id: 'L1', name: 'Ground', elevation: 0, floorThickness: 20, height: 250, visible: true, viewable: true },
    ]
    expect(findReferenceLevelId(levels, 'nonexistent')).toBeNull()
  })
})

describe('reference overlay — renderer draws ghost walls+rooms', () => {
  it('sets globalAlpha to 0.3 when overlay enabled and reference level exists', () => {
    const home = createEmptyHome('UTC')
    home.levels.push(
      { id: 'L1', name: 'Ground', elevation: 0, floorThickness: 20, height: 250, visible: true, viewable: true },
      { id: 'L2', name: 'Upper', elevation: 250, floorThickness: 20, height: 250, visible: true, viewable: true },
    )
    home.walls.push(
      { id: 'ref-wall', xStart: 0, yStart: 0, xEnd: 100, yEnd: 0, thickness: 7, levelRef: 'L1' },
      { id: 'active-wall', xStart: 0, yStart: 100, xEnd: 100, yEnd: 100, thickness: 7, levelRef: 'L2' },
    )
    const ctx = new MockContext()
    drawPlan(home, null, ctx, IDENTITY_VIEW, 800, 600, 'L2', true)
    const alphaOps = ctx.ops.filter(op => op.type === 'globalAlpha')
    expect(alphaOps.some(op => op.args?.[0] === 0.3)).toBe(true)
  })

  it('does NOT draw overlay when overlayEnabled is false', () => {
    const home = createEmptyHome('UTC')
    home.levels.push(
      { id: 'L1', name: 'Ground', elevation: 0, floorThickness: 20, height: 250, visible: true, viewable: true },
      { id: 'L2', name: 'Upper', elevation: 250, floorThickness: 20, height: 250, visible: true, viewable: true },
    )
    home.walls.push(
      { id: 'ref-wall', xStart: 0, yStart: 0, xEnd: 100, yEnd: 0, thickness: 7, levelRef: 'L1' },
    )
    const ctx = new MockContext()
    drawPlan(home, null, ctx, IDENTITY_VIEW, 800, 600, 'L2', false)
    const alphaOps = ctx.ops.filter(op => op.type === 'globalAlpha')
    expect(alphaOps).toHaveLength(0)
  })

  it('does NOT draw overlay when no reference level exists', () => {
    const home = createEmptyHome('UTC')
    home.levels.push(
      { id: 'L1', name: 'Ground', elevation: 0, floorThickness: 20, height: 250, visible: true, viewable: true },
    )
    home.walls.push(
      { id: 'w1', xStart: 0, yStart: 0, xEnd: 100, yEnd: 0, thickness: 7, levelRef: 'L1' },
    )
    const ctx = new MockContext()
    drawPlan(home, null, ctx, IDENTITY_VIEW, 800, 600, 'L1', true)
    const alphaOps = ctx.ops.filter(op => op.type === 'globalAlpha')
    expect(alphaOps).toHaveLength(0)
  })
})

describe('reference overlay — engine cross-level snap', () => {
  it('snaps wall chain to reference-level endpoint when overlay+mag on', () => {
    const { model, engine } = setup()
    const ground = model.addLevel({ name: 'Ground', elevation: 0, floorThickness: 20, height: 250, visible: true, viewable: true })
    const upper = model.addLevel({ name: 'Upper', elevation: 250, floorThickness: 20, height: 250, visible: true, viewable: true })

    // Draw a wall on the ground level.
    model.addWall({ xStart: 0, yStart: 0, xEnd: 200, yEnd: 0, thickness: 7, levelRef: ground.id })

    // Switch to upper level, enable overlay + magnetism.
    engine.setActiveLevel(upper.id)
    engine.setReferenceOverlay(true)
    engine.setMagnetism(true)
    engine.setTool('wall')

    // Click near the reference-level endpoint (0,0) — should snap to it.
    engine.click({ x: 0, y: 0 })
    engine.click({ x: 200, y: 0 })
    engine.key('escape')

    const home = model.getStore().getHome()
    // Should have 2 walls: the original ground wall + the new upper wall.
    expect(home.walls).toHaveLength(2)
    const upperWall = home.walls.find((w) => w.levelRef === upper.id)!
    expect(upperWall).toBeDefined()
    // The upper wall should have snapped to the ground-level endpoint (0,0).
    expect(upperWall.xStart).toBe(0)
    expect(upperWall.yStart).toBe(0)
  })

  it('gives same-level snap priority over cross-level', () => {
    const { model, engine } = setup()
    const ground = model.addLevel({ name: 'Ground', elevation: 0, floorThickness: 20, height: 250, visible: true, viewable: true })
    const upper = model.addLevel({ name: 'Upper', elevation: 250, floorThickness: 20, height: 250, visible: true, viewable: true })

    // Walls on both levels — upper wall at x=500, ground wall at x=0.
    model.addWall({ xStart: 0, yStart: 0, xEnd: 100, yEnd: 0, thickness: 7, levelRef: ground.id })

    engine.setActiveLevel(upper.id)
    engine.setReferenceOverlay(true)
    engine.setMagnetism(true)
    engine.setTool('wall')

    // Click near ground-level endpoint at (0,0) — should still snap to it as cross-level.
    engine.click({ x: 0, y: 0 })
    engine.click({ x: 100, y: 0 })
    engine.key('escape')

    const home = model.getStore().getHome()
    const upperWall = home.walls.find((w) => w.levelRef === upper.id)!
    expect(upperWall).toBeDefined()
    expect(upperWall.xStart).toBe(0)
    expect(upperWall.yStart).toBe(0)
  })

  it('does NOT cross-level snap when overlay is off', () => {
    const { model, engine } = setup()
    const ground = model.addLevel({ name: 'Ground', elevation: 0, floorThickness: 20, height: 250, visible: true, viewable: true })
    const upper = model.addLevel({ name: 'Upper', elevation: 250, floorThickness: 20, height: 250, visible: true, viewable: true })

    // Two ground walls meeting at (0,0) — makes the endpoint "occupied" so freeEndpointAt skips it.
    model.addWall({ xStart: -100, yStart: 0, xEnd: 0, yEnd: 0, thickness: 7, levelRef: ground.id })
    model.addWall({ xStart: 0, yStart: 0, xEnd: 200, yEnd: 0, thickness: 7, levelRef: ground.id })

    engine.setActiveLevel(upper.id)
    engine.setReferenceOverlay(false)
    engine.setMagnetism(true)
    engine.setTool('wall')

    // Click near the occupied ground endpoint — freeEndpointAt skips it, overlay off so cross-level magnetism won't fire.
    engine.click({ x: 2, y: 0 })
    engine.click({ x: 100, y: 0 })
    engine.key('escape')

    const home = model.getStore().getHome()
    const newUpper = home.walls.find((w) => w.levelRef === upper.id && w.xStart !== 500)
    expect(newUpper).toBeDefined()
    expect(newUpper!.xStart).toBe(2)
    expect(newUpper!.yStart).toBe(0)
  })

  it('does NOT cross-level snap when magnetism is off', () => {
    const { model, engine } = setup()
    const ground = model.addLevel({ name: 'Ground', elevation: 0, floorThickness: 20, height: 250, visible: true, viewable: true })
    const upper = model.addLevel({ name: 'Upper', elevation: 250, floorThickness: 20, height: 250, visible: true, viewable: true })

    // Two ground walls meeting at (0,0) — makes the endpoint "occupied".
    model.addWall({ xStart: -100, yStart: 0, xEnd: 0, yEnd: 0, thickness: 7, levelRef: ground.id })
    model.addWall({ xStart: 0, yStart: 0, xEnd: 200, yEnd: 0, thickness: 7, levelRef: ground.id })

    engine.setActiveLevel(upper.id)
    engine.setReferenceOverlay(true)
    engine.setMagnetism(false)
    engine.setTool('wall')

    // Click near the occupied ground endpoint — mag off, so cross-level magnetism won't fire.
    engine.click({ x: 2, y: 0 })
    engine.click({ x: 100, y: 0 })
    engine.key('escape')

    const home = model.getStore().getHome()
    const newUpper = home.walls.find((w) => w.levelRef === upper.id)
    expect(newUpper).toBeDefined()
    expect(newUpper!.xStart).toBe(2)
    expect(newUpper!.yStart).toBe(0)
  })
})

describe('reference overlay — engine toggle', () => {
  it('defaults to ON for a fresh engine (no persisted preference)', () => {
    const { engine } = setup()
    expect(engine.isReferenceOverlayEnabled()).toBe(true)
  })

  it('setReferenceOverlay / isReferenceOverlayEnabled round-trip', () => {
    const { engine } = setup()
    engine.setReferenceOverlay(false)
    expect(engine.isReferenceOverlayEnabled()).toBe(false)
    engine.setReferenceOverlay(true)
    expect(engine.isReferenceOverlayEnabled()).toBe(true)
    engine.setReferenceOverlay(false)
    expect(engine.isReferenceOverlayEnabled()).toBe(false)
  })

  it('resolves persisted value: missing/true → on, explicit false → off', () => {
    expect(PlanEngine.referenceOverlayFromStored(null)).toBe(true)
    expect(PlanEngine.referenceOverlayFromStored('')).toBe(true)
    expect(PlanEngine.referenceOverlayFromStored('true')).toBe(true)
    expect(PlanEngine.referenceOverlayFromStored('false')).toBe(false)
  })
})
