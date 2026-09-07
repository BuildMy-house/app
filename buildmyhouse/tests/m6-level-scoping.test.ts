import { describe, expect, it } from 'vitest'
import { HomeModel } from '../src/core/model'
import { HomeStore } from '../src/core/store'
import { PlanEngine } from '../src/plan/engine'
import { fitToBounds } from '../src/plan/renderer'
import { HomelyCommandHandler } from '../src/automation/homely-handler'

function setup() {
  const store = new HomeStore()
  const model = new HomeModel(store)
  const engine = new PlanEngine(model)
  return { store, model, engine }
}

describe('level scoping — engine stamps levelRef', () => {
  it('walls created with active level get that levelRef', () => {
    const { model, engine } = setup()
    const level = model.addLevel({ name: 'Floor 1', elevation: 0, floorThickness: 20, height: 250, visible: true, viewable: true })
    engine.setActiveLevel(level.id)
    engine.setTool('wall')
    engine.click({ x: 0, y: 0 })
    engine.click({ x: 100, y: 0 })
    engine.key('escape')
    const home = model.getStore().getHome()
    expect(home.walls).toHaveLength(1)
    expect(home.walls[0]!.levelRef).toBe(level.id)
  })

  it('walls created with no active level have no levelRef (omitted, not null — preserves the SH3D export golden contract)', () => {
    const { model, engine } = setup()
    engine.setTool('wall')
    engine.click({ x: 0, y: 0 })
    engine.click({ x: 100, y: 0 })
    engine.key('escape')
    const home = model.getStore().getHome()
    expect(home.walls).toHaveLength(1)
    expect(home.walls[0]!.levelRef).toBeUndefined()
  })

  it('rooms created with active level get that levelRef', () => {
    const { model, engine } = setup()
    const level = model.addLevel({ name: 'Floor 2', elevation: 250, floorThickness: 20, height: 250, visible: true, viewable: true })
    engine.setActiveLevel(level.id)
    engine.setTool('room')
    engine.click({ x: 0, y: 0 })
    engine.click({ x: 100, y: 0 })
    engine.click({ x: 100, y: 100 })
    engine.click({ x: 0, y: 100 })
    engine.click({ x: 0, y: 0, dbl: true })
    const home = model.getStore().getHome()
    expect(home.rooms).toHaveLength(1)
    expect(home.rooms[0]!.levelRef).toBe(level.id)
  })

  it('dimension lines created with active level get that levelRef', () => {
    const { model, engine } = setup()
    const level = model.addLevel({ name: 'Mezzanine', elevation: 125, floorThickness: 10, height: 200, visible: true, viewable: true })
    engine.setActiveLevel(level.id)
    engine.setTool('dimensionLine')
    engine.click({ x: 0, y: 0 })
    engine.click({ x: 200, y: 0 })
    const home = model.getStore().getHome()
    expect(home.dimensionLines).toHaveLength(1)
    expect(home.dimensionLines[0]!.levelRef).toBe(level.id)
  })

  it('labels created with active level get that levelRef', () => {
    const { model, engine } = setup()
    const level = model.addLevel({ name: 'Attic', elevation: 500, floorThickness: 15, height: 180, visible: true, viewable: true })
    engine.setActiveLevel(level.id)
    engine.setTool('label')
    engine.click({ x: 50, y: 50 })
    const home = model.getStore().getHome()
    expect(home.labels).toHaveLength(1)
    expect(home.labels[0]!.levelRef).toBe(level.id)
  })
})

describe('level scoping — switching isolates objects', () => {
  it('drawing on level 2 does not affect level 1 wall count', () => {
    const { model, engine } = setup()
    const level1 = model.addLevel({ name: 'Ground', elevation: 0, floorThickness: 20, height: 250, visible: true, viewable: true })
    const level2 = model.addLevel({ name: 'Upper', elevation: 250, floorThickness: 20, height: 250, visible: true, viewable: true })

    // Draw walls on level 1
    engine.setActiveLevel(level1.id)
    engine.setTool('wall')
    engine.click({ x: 0, y: 0 })
    engine.click({ x: 100, y: 0 })
    engine.key('escape')
    engine.click({ x: 100, y: 100 })
    engine.click({ x: 200, y: 100 })
    engine.key('escape')

    // Draw a wall on level 2
    engine.setActiveLevel(level2.id)
    engine.setTool('wall')
    engine.click({ x: 0, y: 200 })
    engine.click({ x: 100, y: 200 })
    engine.key('escape')

    const home = model.getStore().getHome()
    const level1Walls = home.walls.filter((w) => w.levelRef === level1.id)
    const level2Walls = home.walls.filter((w) => w.levelRef === level2.id)

    expect(level1Walls).toHaveLength(2)
    expect(level2Walls).toHaveLength(1)
    expect(home.walls).toHaveLength(3)
  })

  it('fitToBounds filters by active level', () => {
    const { model } = setup()
    const level1 = model.addLevel({ name: 'G', elevation: 0, floorThickness: 20, height: 250, visible: true, viewable: true })
    const level2 = model.addLevel({ name: 'U', elevation: 250, floorThickness: 20, height: 250, visible: true, viewable: true })

    model.addWall({ xStart: 0, yStart: 0, xEnd: 100, yEnd: 0, thickness: 10, height: 250, patternId: 'solid', levelRef: level1.id })
    model.addWall({ xStart: 500, yStart: 500, xEnd: 600, yEnd: 500, thickness: 10, height: 250, patternId: 'solid', levelRef: level2.id })

    const home = model.getStore().getHome()
    const allView = fitToBounds(home, 800, 600, 40, null)
    const l1View = fitToBounds(home, 800, 600, 40, level1.id)
    const l2View = fitToBounds(home, 800, 600, 40, level2.id)

    // All view should encompass both walls
    expect(allView.offsetX).not.toBe(l1View.offsetX)
    expect(l1View.offsetX).not.toBe(l2View.offsetX)
  })
})

describe('level scoping — hitTest filtering', () => {
  it('hitTest ignores walls not on the active level', () => {
    const { model, engine } = setup()
    const level1 = model.addLevel({ name: 'G', elevation: 0, floorThickness: 20, height: 250, visible: true, viewable: true })
    const level2 = model.addLevel({ name: 'U', elevation: 250, floorThickness: 20, height: 250, visible: true, viewable: true })

    model.addWall({ xStart: 0, yStart: 0, xEnd: 100, yEnd: 0, thickness: 10, height: 250, patternId: 'solid', levelRef: level1.id })
    model.addWall({ xStart: 0, yStart: 100, xEnd: 100, yEnd: 100, thickness: 10, height: 250, patternId: 'solid', levelRef: level2.id })

    // Switch to level 2 — should only hit level 2 wall
    engine.setActiveLevel(level2.id)
    engine.setTool('selection')
    const hitAtY0 = engine.hitTestPoint({ x: 50, y: 0 })
    const hitAtY100 = engine.hitTestPoint({ x: 50, y: 100 })
    expect(hitAtY0).toBeNull()
    expect(hitAtY100).not.toBeNull()
    expect(hitAtY100!.kind).toBe('wall-body')
  })

  it('hitTest hits all walls when no level is active', () => {
    const { model, engine } = setup()
    const level1 = model.addLevel({ name: 'G', elevation: 0, floorThickness: 20, height: 250, visible: true, viewable: true })

    model.addWall({ xStart: 0, yStart: 0, xEnd: 100, yEnd: 0, thickness: 10, height: 250, patternId: 'solid', levelRef: level1.id })
    model.addWall({ xStart: 0, yStart: 100, xEnd: 100, yEnd: 100, thickness: 10, height: 250, patternId: 'solid', levelRef: null })

    engine.setActiveLevel(null)
    engine.setTool('selection')
    expect(engine.hitTestPoint({ x: 50, y: 0 })).not.toBeNull()
    expect(engine.hitTestPoint({ x: 50, y: 100 })).not.toBeNull()
  })
})

describe('set_active_level command', () => {
  function handlerWithEngine() {
    const store = new HomeStore()
    const model = new HomeModel(store)
    const engine = new PlanEngine(model)
    const handler = new HomelyCommandHandler(store, { planEngine: engine })
    return { store, model, engine, handler }
  }

  it('switches active level and stamps levelRef on created walls', () => {
    const { model, handler } = handlerWithEngine()
    const level = model.addLevel({ name: 'Floor 1', elevation: 0, floorThickness: 20, height: 250, visible: true, viewable: true })

    const res = handler.execute('set_active_level', { levelId: level.id })
    expect(res).toEqual({ ok: true, data: { levelId: level.id } })

    handler.execute('select_tool', { tool: 'wall' })
    handler.execute('click', { x: 0, y: 0 })
    handler.execute('click', { x: 100, y: 0 })
    handler.execute('key', { key: 'escape' })

    const home = model.getStore().getHome()
    expect(home.walls).toHaveLength(1)
    expect(home.walls[0]!.levelRef).toBe(level.id)
  })

  it('sets levelId to null to show all levels', () => {
    const { handler } = handlerWithEngine()
    const res = handler.execute('set_active_level', { levelId: null })
    expect(res).toEqual({ ok: true, data: { levelId: null } })
  })

  it('rejects unknown level ids', () => {
    const { handler } = handlerWithEngine()
    const res = handler.execute('set_active_level', { levelId: 'nonexistent-id' })
    expect(res.ok).toBe(false)
    if (!res.ok) {
      expect(res.code).toBe('INVALID_PARAMS')
      expect(res.error).toContain('nonexistent-id')
    }
  })
})
