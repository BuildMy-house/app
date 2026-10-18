import { describe, expect, it } from 'vitest'
import { HomeModel } from '../src/core/model'
import { HomeStore } from '../src/core/store'
import { PlanEngine, type ClickInput, type WallSnapReadout } from '../src/plan/engine'

// B1 wall-snap integration: public-API behavior tests. All expectations are
// derived from snap-math.ts semantics (10cm steps, ±8cm metre capture,
// 15°/45°/90° soft capture radii 3/6/8°, +2° hysteresis, hard ±10°).

function setup() {
  const store = new HomeStore()
  const model = new HomeModel(store)
  const engine = new PlanEngine(model)
  const click = (x: number, y: number, rest: Omit<ClickInput, 'x' | 'y'> = {}) =>
    engine.click({ x, y, ...rest })
  return { store, model, engine, click }
}

function at(deg: number, len: number): { x: number; y: number } {
  const rad = (deg * Math.PI) / 180
  return { x: len * Math.cos(rad), y: len * Math.sin(rad) }
}

describe('wall snapping: length steps and metre stops', () => {
  it('rounds the segment length to 10cm steps on the soft path', () => {
    const { engine } = setup()
    engine.setTool('wall')
    engine.click({ x: 0, y: 0 })
    engine.moveMouse(337, 2)

    const snap = engine.getPreview().wallSnap
    expect(snap).not.toBeNull()
    expect(snap!.end).toEqual({ x: 340, y: 0 })
    expect(snap!.lengthCm).toBe(340)
    expect(snap!.angleDeg).toBe(0)
    expect(snap!.lengthLock).toBe('step')
    expect(snap!.angleLock).toBe('axis')
    expect(snap!.mode).toBe('soft')
    expect(snap!.fine).toBe(false)
    expect(snap!.unit).toBe('cm')
    expect(engine.getPreview().wallLine).toEqual({ start: { x: 0, y: 0 }, end: { x: 340, y: 0 }, length: 340 })
  })

  it('captures a metre stop when the raw length is near one', () => {
    const { engine } = setup()
    engine.setTool('wall')
    engine.click({ x: 0, y: 0 })
    engine.moveMouse(96, 1)

    const snap = engine.getPreview().wallSnap
    expect(snap!.end).toEqual({ x: 100, y: 0 })
    expect(snap!.lengthCm).toBe(100)
    expect(snap!.lengthLock).toBe('major')
  })

  it('stays sticky on the 45° diagonal beyond the plain capture radius', () => {
    const { engine } = setup()
    engine.setTool('wall')
    engine.click({ x: 0, y: 0 })
    engine.moveMouse(300, 262)
    expect(engine.getPreview().wallSnap!.angleLock).toBe('diagonal')

    // raw ≈ 38.66° is outside the plain ±6° diagonal window; only the
    // +2° hysteresis of the persisted 45° lock can keep it captured.
    engine.moveMouse(280, 224)
    const snap = engine.getPreview().wallSnap!
    expect(snap.angleDeg).toBe(45)
    expect(snap.angleLock).toBe('diagonal')
    expect(snap.lengthCm).toBe(360)
  })

  it('preview and commit agree on the snapped end (A45 corner test)', () => {
    const { store, engine } = setup()
    engine.setTool('wall')
    engine.click({ x: 0, y: 0 })
    engine.moveMouse(337, 2)

    const previewSnap = engine.getPreview().wallSnap
    expect(previewSnap).not.toBeNull()

    engine.click({ x: 337, y: 2 })
    const wall = store.getHome().walls[0]!
    expect(wall.xEnd).toBeCloseTo(previewSnap!.end.x, 9)
    expect(wall.yEnd).toBeCloseTo(previewSnap!.end.y, 9)
    expect(wall.xEnd).toBe(340)
    expect(wall.yEnd).toBe(0)
  })
})

describe('wall snapping: angular modes', () => {
  it('Shift hard-locks a 38° cursor onto the nearest 45° diagonal', () => {
    const store = new HomeStore()
    const model = new HomeModel(store)
    const engine = new PlanEngine(model)
    engine.setTool('wall')
    engine.setModifierKeys({ shift: true })
    engine.click({ x: 0, y: 0 })
    // raw ≈ 38.15° — outside soft capture, inside the hard ±10° window
    engine.moveMouse(261, 205)

    const snap = engine.getPreview().wallSnap!
    expect(snap.mode).toBe('hard')
    expect(snap.angleDeg).toBe(45)
    expect(snap.angleLock).toBe('diagonal')
    expect(snap.lengthCm).toBe(330)

    engine.click({ x: 261, y: 205 })
    const wall = store.getHome().walls[0]!
    expect(wall.xEnd).toBeCloseTo(330 * Math.cos(Math.PI / 4), 6)
    expect(wall.yEnd).toBeCloseTo(330 * Math.sin(Math.PI / 4), 6)
  })

  it('Alt bypasses all snapping and returns the raw cursor verbatim', () => {
    const store = new HomeStore()
    const model = new HomeModel(store)
    const engine = new PlanEngine(model)
    engine.setTool('wall')
    engine.setModifierKeys({ alt: true })
    engine.click({ x: 0, y: 0 })
    engine.moveMouse(337, 2)

    const snap = engine.getPreview().wallSnap!
    expect(snap.mode).toBe('off')
    expect(snap.end).toEqual({ x: 337, y: 2 })
    expect(snap.lengthCm).toBeCloseTo(Math.hypot(337, 2), 6)
    expect(snap.lengthLock).toBe('none')
    expect(snap.angleLock).toBe('none')

    engine.click({ x: 337, y: 2 })
    const wall = store.getHome().walls[0]!
    expect(wall.xEnd).toBe(337)
    expect(wall.yEnd).toBe(2)
  })
})

describe('wall snapping: fine step and imperial units', () => {
  it('Ctrl/Cmd fine steps to 1cm', () => {
    const store = new HomeStore()
    const model = new HomeModel(store)
    const engine = new PlanEngine(model)
    engine.setTool('wall')
    engine.setModifierKeys({ fine: true })
    engine.click({ x: 0, y: 0 })
    engine.moveMouse(337, 2)

    const snap = engine.getPreview().wallSnap!
    expect(snap.fine).toBe(true)
    expect(snap.lengthCm).toBe(337)
    expect(snap.lengthLock).toBe('step')
    expect(snap.end).toEqual({ x: 337, y: 0 })
  })

  it('imperial units snap to 4in steps with 1ft metre stops', () => {
    const { store, engine } = setup()
    engine.setTool('wall')
    expect(engine.getUnit()).toBe('cm')
    engine.setUnit('inch')
    expect(engine.getUnit()).toBe('inch')

    engine.click({ x: 0, y: 0 })

    // 96cm cursor → raw 37.8in lands within capture of the 3ft stop
    engine.moveMouse(96, 1)
    const snap = engine.getPreview().wallSnap!
    expect(snap.unit).toBe('inch')
    expect(snap.lengthCm).toBeCloseTo(91.44, 6)
    expect(snap.lengthLock).toBe('major')
    expect(snap.end).toEqual({ x: 91.44, y: 0 })

    engine.click({ x: 96, y: 1 })
    const wall = store.getHome().walls[0]!
    expect(wall.xEnd).toBe(91.44)
  })
})

describe('wall snapping: relative to the previous chain wall', () => {
  it('locks the next segment 90° relative to the committed wall direction', () => {
    const store = new HomeStore()
    const model = new HomeModel(store)
    const engine = new PlanEngine(model)
    engine.setTool('wall')

    // First wall committed at a raw 20° (soft capture misses everything) —
    // deliberately NOT a multiple of 15°, so any world-only snap of the next
    // segment could not explain the result.
    engine.click({ x: 0, y: 0 })
    const firstCursor = at(20, 100)
    engine.moveMouse(firstCursor.x, firstCursor.y)
    expect(engine.getPreview().wallSnap!.angleLock).toBe('none')
    engine.click({ x: firstCursor.x, y: firstCursor.y })

    // Cursor at 110°: 90° from the previous wall direction (relative axis
    // lock), a direction no world-only snap produces with an axis lock.
    const secondCursor = {
      x: firstCursor.x + 120 * Math.cos((110 * Math.PI) / 180),
      y: firstCursor.y + 120 * Math.sin((110 * Math.PI) / 180),
    }
    engine.moveMouse(secondCursor.x, secondCursor.y)
    const snap = engine.getPreview().wallSnap!
    expect(snap.angleDeg).toBeCloseTo(110, 6)
    expect(snap.angleLock).toBe('axis')
    expect(snap.lengthCm).toBeCloseTo(120, 6)

    engine.click({ x: secondCursor.x, y: secondCursor.y })
    const walls = store.getHome().walls
    expect(walls.length).toBe(2)
    const dy = walls[1]!.yEnd - walls[1]!.yStart
    const dx = walls[1]!.xEnd - walls[1]!.xStart
    expect((Math.atan2(dy, dx) * 180) / Math.PI).toBeCloseTo(110, 6)
  })
})

describe('typed exact length', () => {
  it('commits an exactly-250cm wall on Enter', () => {
    const { store, engine } = setup()
    engine.setTool('wall')
    engine.click({ x: 0, y: 0 })
    engine.moveMouse(147, 2)
    expect(engine.isDrawingWall()).toBe(true)

    expect(engine.typeLengthChar('2')).toBe(true)
    expect(engine.typeLengthChar('5')).toBe(true)
    expect(engine.typeLengthChar('0')).toBe(true)
    expect(engine.getTypedLength()).toBe('250')
    expect(engine.getPreview().wallSnap!.typed).toBe('250')

    expect(engine.commitTypedLength()).toBe(true)
    expect(engine.getTypedLength()).toBeNull()
    const wall = store.getHome().walls[0]!
    expect(wall.xStart).toBe(0)
    expect(wall.yStart).toBe(0)
    expect(wall.xEnd).toBe(250)
    expect(wall.yEnd).toBe(0)
  })

  it('interprets a typed length in inches when the unit is imperial', () => {
    const { store, engine } = setup()
    engine.setTool('wall')
    engine.setUnit('inch')
    engine.click({ x: 0, y: 0 })
    engine.moveMouse(147, 2)

    expect(engine.typeLengthChar('1')).toBe(true)
    expect(engine.typeLengthChar('0')).toBe(true)
    expect(engine.commitTypedLength()).toBe(true)
    const wall = store.getHome().walls[0]!
    // 10in = 25.4cm along the live snapped (east) direction
    expect(wall.xEnd).toBeCloseTo(25.4, 9)
    expect(wall.yEnd).toBeCloseTo(0, 9)
  })

  it('Escape clears the typed buffer before cancelling the chain', () => {
    const { engine } = setup()
    engine.setTool('wall')
    engine.click({ x: 0, y: 0 })
    engine.moveMouse(147, 2)

    engine.typeLengthChar('2')
    engine.typeLengthChar('5')
    expect(engine.key('escape')).toBeUndefined()
    expect(engine.getTypedLength()).toBeNull()
    // Chain still open: typing works again after the buffer clear
    expect(engine.typeLengthChar('3')).toBe(true)
    expect(engine.getTypedLength()).toBe('3')

    // Next two Escapes: first clears the re-typed buffer, then the
    // now-empty-buffer Escape cancels the chain.
    engine.key('escape')
    engine.key('escape')
    expect(engine.isDrawingWall()).toBe(false)
    expect(engine.typeLengthChar('4')).toBe(false)
    expect(engine.commitTypedLength()).toBe(false)
  })

  it('rejects a second decimal point', () => {
    const { engine } = setup()
    engine.setTool('wall')
    engine.click({ x: 0, y: 0 })
    engine.typeLengthChar('2')
    engine.typeLengthChar('.')
    expect(engine.typeLengthChar('.')).toBe(false)
    expect(engine.getTypedLength()).toBe('2.')
  })
})

describe('magnetism toggle', () => {
  it('disables soft snapping but keeps grid snap on the legacy path', () => {
    const { engine } = setup()
    engine.setTool('wall')
    engine.setMagnetism(false)
    engine.click({ x: 0, y: 0 })
    engine.moveMouse(337, 2)

    const snap = engine.getPreview().wallSnap as WallSnapReadout | null
    expect(snap).not.toBeNull()
    expect(snap!.mode).toBe('off')
    expect(snap!.end).toEqual({ x: 340, y: 0 })
    expect(snap!.lengthLock).toBe('none')
    expect(snap!.angleLock).toBe('none')
  })

  it('disables soft snapping with grid snap fully raw when grid is off', () => {
    const { engine } = setup()
    engine.setTool('wall')
    engine.setMagnetism(false)
    engine.setGridSnap(false)
    engine.click({ x: 0, y: 0 })
    engine.moveMouse(337, 2)

    expect(engine.getPreview().wallLine!.end).toEqual({ x: 337, y: 2 })
  })
})
