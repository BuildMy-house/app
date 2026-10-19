import { describe, expect, it } from 'vitest'
import { HomeModel } from '../src/core/model'
import { HomeStore } from '../src/core/store'
import { PlanEngine } from '../src/plan/engine'

function setup() {
  const store = new HomeStore()
  const model = new HomeModel(store)
  const engine = new PlanEngine(model)
  engine.setTool('dimensionLine')
  return { store, model, engine }
}

const dims = (store: HomeStore) => store.getHome().dimensionLines

describe('dimension tool: snapping', () => {
  it('first click snaps to a nearby wall endpoint', () => {
    const { model, engine, store } = setup()
    model.addWall({ xStart: 0, yStart: 0, xEnd: 400, yEnd: 0, thickness: 10, height: 250 })
    engine.click({ x: 3, y: -2 })
    engine.click({ x: 400, y: 0 })
    expect(dims(store)[0]).toMatchObject({ xStart: 0, yStart: 0, xEnd: 400, yEnd: 0 })
  })

  it('snaps onto a wall midpoint', () => {
    const { model, engine, store } = setup()
    model.addWall({ xStart: 0, yStart: 0, xEnd: 400, yEnd: 0, thickness: 10, height: 250 })
    engine.click({ x: 0, y: 0 })
    engine.click({ x: 198, y: 3 })
    expect(dims(store)[0]).toMatchObject({ xEnd: 200, yEnd: 0 })
  })

  it('second point steps length to 10 cm and locks the axis', () => {
    const { engine, store } = setup()
    engine.setGridSnap(false)
    engine.click({ x: 1000, y: 1000 })
    engine.click({ x: 1347, y: 1004 })
    const d = dims(store)[0]!
    expect(d.yEnd).toBe(1000)
    expect(Math.round(d.xEnd - d.xStart) % 10).toBe(0)
  })

  it('Alt places the raw cursor point', () => {
    const { engine, store } = setup()
    engine.setGridSnap(false)
    engine.click({ x: 1000, y: 1000 })
    engine.click({ x: 1347, y: 1004, altOrMeta: true })
    const d = dims(store)[0]!
    expect([d.xEnd, d.yEnd]).toEqual([1347, 1004])
  })

  it('preview reports the live readout and the snapped end', () => {
    const { engine } = setup()
    engine.click({ x: 0, y: 0 })
    engine.moveMouse(303, 2)
    const p = engine.getPreview().dimensionLine!
    expect(p.length).toBe(300)
    expect(p.snap?.lengthCm).toBe(300)
    expect(p.snap?.angleLock).toBe('axis')
  })
})

describe('dimension tool: typed value, cancel, undo-point', () => {
  it('typed length + Enter places an exact dimension along the cursor direction', () => {
    const { engine, store } = setup()
    engine.click({ x: 0, y: 0 })
    engine.moveMouse(500, 3)
    expect(engine.acceptsTypedLength()).toBe(true)
    for (const ch of '237.5') expect(engine.typeLengthChar(ch)).toBe(true)
    expect(engine.getTypedLength()).toBe('237.5')
    expect(engine.commitTypedLength()).toBe(true)
    const d = dims(store)[0]!
    expect(Math.hypot(d.xEnd - d.xStart, d.yEnd - d.yStart)).toBeCloseTo(237.5, 6)
    expect(engine.getPreview().phase).toBe('idle')
    expect(store.getHome().selection).toEqual([d.id])
  })

  it('imperial typed values are inches', () => {
    const { engine, store } = setup()
    engine.setUnit('inch')
    engine.click({ x: 0, y: 0 })
    engine.moveMouse(500, 0)
    for (const ch of '100') engine.typeLengthChar(ch)
    engine.commitTypedLength()
    const d = dims(store)[0]!
    expect(d.xEnd - d.xStart).toBeCloseTo(254, 6)
  })

  it('typing is ignored before the first point is placed', () => {
    const { engine } = setup()
    expect(engine.typeLengthChar('5')).toBe(false)
  })

  it('Escape clears typed digits first, then cancels', () => {
    const { engine, store } = setup()
    engine.click({ x: 0, y: 0 })
    engine.typeLengthChar('4')
    engine.key('escape')
    expect(engine.getTypedLength()).toBeNull()
    expect(engine.getPreview().phase).toBe('drawing')
    engine.key('escape')
    expect(engine.getPreview().phase).toBe('idle')
    expect(dims(store)).toHaveLength(0)
  })

  it('Backspace eats a typed digit, then drops the first point, and never deletes the selection', () => {
    const { model, engine, store } = setup()
    const keep = model.addDimensionLine({ xStart: 0, yStart: 0, xEnd: 100, yEnd: 0, offset: 0 })
    model.setSelection([keep.id])
    engine.click({ x: 500, y: 500 })
    engine.typeLengthChar('4')
    engine.typeLengthChar('5')
    engine.key('backspace')
    expect(engine.getTypedLength()).toBe('4')
    engine.key('backspace')
    expect(engine.getTypedLength()).toBeNull()
    expect(engine.getPreview().phase).toBe('drawing')
    engine.key('backspace')
    expect(engine.getPreview().phase).toBe('idle')
    expect(dims(store)).toHaveLength(1)
  })
})

describe('dimension tool: select, hit-test and offset drag', () => {
  it('the drawn offset line is clickable, the hidden baseline is not', () => {
    const { model, engine, store } = setup()
    const d = model.addDimensionLine({ xStart: 0, yStart: 0, xEnd: 300, yEnd: 0, offset: 80 })
    engine.setTool('selection')
    engine.click({ x: 150, y: 80 })
    expect(store.getHome().selection).toEqual([d.id])
    model.setSelection([])
    engine.click({ x: 150, y: 0 })
    expect(store.getHome().selection).toEqual([])
  })

  it('a selected dimension beats the wall it overlaps', () => {
    const { model, engine, store } = setup()
    const wall = model.addWall({ xStart: 0, yStart: 0, xEnd: 300, yEnd: 0, thickness: 10, height: 250 })
    const d = model.addDimensionLine({ xStart: 0, yStart: 0, xEnd: 300, yEnd: 0, offset: 0 })
    engine.setTool('selection')
    engine.click({ x: 150, y: 0 })
    expect(store.getHome().selection).toEqual([wall.id])
    model.setSelection([d.id])
    engine.click({ x: 150, y: 0 })
    expect(store.getHome().selection).toEqual([d.id])
  })

  it('dragging a dimension re-offsets it (stepped) without moving its points', () => {
    const { model, engine, store } = setup()
    const d = model.addDimensionLine({ xStart: 0, yStart: 0, xEnd: 300, yEnd: 0, offset: 0 })
    engine.setTool('selection')
    model.setSelection([d.id])
    engine.drag({ fromX: 150, fromY: 0, toX: 170, toY: 47 })
    const after = dims(store)[0]!
    expect(after.offset).toBe(50)
    expect([after.xStart, after.xEnd]).toEqual([0, 300])
  })

  it('drag preview exposes a ghost offset until the preview ends', () => {
    const { model, engine } = setup()
    const d = model.addDimensionLine({ xStart: 0, yStart: 0, xEnd: 300, yEnd: 0, offset: 0 })
    engine.setTool('selection')
    model.setSelection([d.id])
    engine.previewDrag({ x: 150, y: 0 }, { x: 150, y: 30 })
    expect(engine.getPreview().dimensionOffsetGhost).toEqual({ id: d.id, offset: 30 })
    engine.endDragPreview()
    expect(engine.getPreview().dimensionOffsetGhost).toBeNull()
  })
})
