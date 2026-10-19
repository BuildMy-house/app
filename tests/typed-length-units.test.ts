import { describe, expect, it } from 'vitest'
import { HomeModel } from '../src/core/model'
import { HomeStore } from '../src/core/store'
import { PlanEngine } from '../src/plan/engine'
import { typedLengthToCm } from '../src/plan/snap-math'

function setup(tool: 'wall' | 'dimensionLine', unit: 'cm' | 'inch') {
  const store = new HomeStore()
  const model = new HomeModel(store)
  const engine = new PlanEngine(model)
  engine.setTool(tool)
  engine.setUnit(unit)
  engine.click({ x: 0, y: 0 })
  engine.moveMouse(500, 0)
  return { store, engine }
}

const type = (engine: PlanEngine, text: string) => {
  for (const ch of text) engine.typeLengthChar(ch)
}

describe('typedLengthToCm', () => {
  it('metric is identity, imperial scales inches by 2.54', () => {
    expect(typedLengthToCm('250', 'cm')).toBe(250)
    expect(typedLengthToCm('100', 'inch')).toBeCloseTo(254, 9)
  })

  it('rejects empty, unparsable and non-positive input', () => {
    for (const unit of ['cm', 'inch'] as const) {
      expect(typedLengthToCm(null, unit)).toBeNull()
      expect(typedLengthToCm('', unit)).toBeNull()
      expect(typedLengthToCm('abc', unit)).toBeNull()
      expect(typedLengthToCm('0', unit)).toBeNull()
      expect(typedLengthToCm('-5', unit)).toBeNull()
    }
  })
})

describe('typed length: wall tool preview and commit agree per unit', () => {
  it('metric: typed value is centimetres in the live preview and the commit', () => {
    const { engine, store } = setup('wall', 'cm')
    type(engine, '237')
    expect(engine.getPreview().wallLine!.length).toBeCloseTo(237, 6)
    engine.commitTypedLength()
    const w = store.getHome().walls[0]!
    expect(Math.hypot(w.xEnd - w.xStart, w.yEnd - w.yStart)).toBeCloseTo(237, 6)
  })

  it('imperial: typed value is inches in the live preview and the commit', () => {
    const { engine, store } = setup('wall', 'inch')
    type(engine, '100')
    expect(engine.getPreview().wallLine!.length).toBeCloseTo(254, 6)
    engine.commitTypedLength()
    const w = store.getHome().walls[0]!
    expect(Math.hypot(w.xEnd - w.xStart, w.yEnd - w.yStart)).toBeCloseTo(254, 6)
  })
})

describe('typed length: dimension tool preview and commit agree per unit', () => {
  it('metric: typed value is centimetres', () => {
    const { engine, store } = setup('dimensionLine', 'cm')
    type(engine, '237')
    expect(engine.getPreview().dimensionLine!.length).toBeCloseTo(237, 6)
    engine.commitTypedLength()
    engine.commitTypedLength()
    const d = store.getHome().dimensionLines[0]!
    expect(Math.hypot(d.xEnd - d.xStart, d.yEnd - d.yStart)).toBeCloseTo(237, 6)
  })

  it('imperial: typed value is inches', () => {
    const { engine, store } = setup('dimensionLine', 'inch')
    type(engine, '100')
    expect(engine.getPreview().dimensionLine!.length).toBeCloseTo(254, 6)
    engine.commitTypedLength()
    engine.commitTypedLength()
    const d = store.getHome().dimensionLines[0]!
    expect(Math.hypot(d.xEnd - d.xStart, d.yEnd - d.yStart)).toBeCloseTo(254, 6)
  })
})
