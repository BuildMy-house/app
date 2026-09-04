import { describe, expect, it } from 'vitest'
import { HomeModel } from '../src/core/model'
import { HomeStore } from '../src/core/store'
import { PlanEngine } from '../src/plan/engine'

function setup() {
  const store = new HomeStore()
  const model = new HomeModel(store)
  const engine = new PlanEngine(model)
  const click = (x: number, y: number, dbl = false) =>
    engine.click({ x, y, dbl })
  return { store, model, engine, click }
}

describe('Roof model CRUD', () => {
  it('addRoof creates a roof with generated id and stores it', () => {
    const { model, store } = setup()
    const roof = model.addRoof([[0, 0], [100, 0], [50, 80]])
    expect(roof.id).toMatch(/^roof-/)
    expect(roof.points).toEqual([[0, 0], [100, 0], [50, 80]])
    expect(store.getHome().roofs).toHaveLength(1)
    expect(store.getHome().roofs[0]!.id).toBe(roof.id)
  })

  it('addRoof with options merges levelRef and name', () => {
    const { model, store } = setup()
    const roof = model.addRoof([[0, 0], [100, 0], [50, 80]], {
      levelRef: 'level-1',
      name: 'Main Roof',
    })
    expect(roof.levelRef).toBe('level-1')
    expect(roof.name).toBe('Main Roof')
    expect(store.getHome().roofs[0]!.levelRef).toBe('level-1')
  })

  it('updateRoof patches fields immutably', () => {
    const { model, store } = setup()
    const roof = model.addRoof([[0, 0], [100, 0], [50, 80]])
    model.updateRoof(roof.id, { name: 'Roof A', color: 0xff0000 })
    const updated = store.getHome().roofs.find((r) => r.id === roof.id)!
    expect(updated.name).toBe('Roof A')
    expect(updated.color).toBe(0xff0000)
    expect(updated.points).toEqual([[0, 0], [100, 0], [50, 80]])
  })

  it('removeRoof deletes the roof', () => {
    const { model, store } = setup()
    const roof = model.addRoof([[0, 0], [100, 0], [50, 80]])
    model.removeRoof(roof.id)
    expect(store.getHome().roofs).toHaveLength(0)
  })

  it('addRoof creates a single undo step', () => {
    const { model, store } = setup()
    model.getStore().beginCompoundEdit()
    model.addRoof([[0, 0], [100, 0], [50, 80]])
    model.getStore().endCompoundEdit()
    expect(store.getHome().roofs).toHaveLength(1)
    store.undo()
    expect(store.getHome().roofs).toHaveLength(0)
  })

  it('moveSelection translates roof points', () => {
    const { model, store } = setup()
    const roof = model.addRoof([[0, 0], [100, 0], [50, 80]])
    model.setSelection([roof.id])
    model.moveSelection(20, 30)
    const moved = store.getHome().roofs.find((r) => r.id === roof.id)!
    expect(moved.points).toEqual([[20, 30], [120, 30], [70, 110]])
  })
})

describe('Roof tool — PlanEngine', () => {
  it('setTool("roof") sets active tool', () => {
    const { engine } = setup()
    engine.setTool('roof')
    expect(engine.getTool()).toBe('roof')
  })

  it('single click with roof tool creates a triangular roof', () => {
    const { engine, click, store } = setup()
    engine.setTool('roof')
    click(200, 300)
    const roofs = store.getHome().roofs
    expect(roofs).toHaveLength(1)
    expect(roofs[0]!.points).toHaveLength(3)
    expect(store.getHome().selection).toEqual([roofs[0]!.id])
  })

  it('double-click with roof tool inside wall loop creates roof from wall footprint', () => {
    const { engine, click, store } = setup()
    engine.setTool('wall')
    // Draw a rectangular wall enclosure: (0,0)→(200,0)→(200,150)→(0,150)→(0,0)
    click(0, 0)
    click(200, 0)
    click(200, 150)
    click(0, 150)
    click(0, 0)
    engine.key('escape')
    expect(store.getHome().walls).toHaveLength(4)

    // Switch to roof tool and double-click inside
    engine.setTool('roof')
    click(100, 75, true)
    const roofs = store.getHome().roofs
    expect(roofs).toHaveLength(1)
    // Should have the wall loop points (4 vertices for a rectangle)
    expect(roofs[0]!.points.length).toBeGreaterThanOrEqual(3)
  })

  it('roof is undoable via single compound edit', () => {
    const { engine, click, store } = setup()
    engine.setTool('roof')
    click(0, 0)
    expect(store.getHome().roofs).toHaveLength(1)
    store.undo()
    expect(store.getHome().roofs).toHaveLength(0)
  })

  it('escape with roof tool switches to selection', () => {
    const { engine } = setup()
    engine.setTool('roof')
    engine.key('escape')
    expect(engine.getTool()).toBe('selection')
  })
})
