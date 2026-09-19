// @vitest-environment jsdom
import { describe, expect, it, afterEach } from 'vitest'
import { HomeModel } from '../src/core/model'
import { HomeStore } from '../src/core/store'
import { PlanEngine } from '../src/plan/engine'

// Selection-tool click inside a closed (not-yet-a-room) wall loop must offer
// the same AutoFloorDialog confirm flow as wall finalization; empty-space
// clicks keep clearing selection; hits on existing entities are unaffected.

function setup() {
  const store = new HomeStore()
  const model = new HomeModel(store)
  const engine = new PlanEngine(model)
  return { store, model, engine }
}

function addRectWalls(model: HomeModel): void {
  model.addWall({ xStart: 0, yStart: 0, xEnd: 100, yEnd: 0, thickness: 7 })
  model.addWall({ xStart: 100, yStart: 0, xEnd: 100, yEnd: 100, thickness: 7 })
  model.addWall({ xStart: 100, yStart: 100, xEnd: 0, yEnd: 100, thickness: 7 })
  model.addWall({ xStart: 0, yStart: 100, xEnd: 0, yEnd: 0, thickness: 7 })
}

// The engine defers opening the dialog (~250ms) so an in-flight
// click+dblclick gesture completes before the dialog exists on screen.
const flushAutoFloorOpen = (): Promise<void> => new Promise((r) => setTimeout(r, 300))

describe('selection tool: click inside enclosure offers make-room dialog', () => {
  // jsdom DOM is shared across tests in this file — close any dialog a
  // previous test left open via its Escape handler.
  afterEach(() => {
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
  })

  it('click inside a closed wall loop opens the dialog; Create makes a room', async () => {
    const { store, model, engine } = setup()
    addRectWalls(model)
    engine.setTool('selection')

    engine.click({ x: 50, y: 50 })
    await flushAutoFloorOpen()

    // No silent creation — the confirm dialog must be up and no room yet.
    expect(document.querySelector('.auto-floor-dialog')).not.toBeNull()
    expect(store.getHome().rooms).toHaveLength(0)

    // Confirm → room created from the loop vertices.
    const confirm = document.querySelector<HTMLButtonElement>('.auto-floor-confirm')
    expect(confirm).not.toBeNull()
    confirm!.click()

    const rooms = store.getHome().rooms
    expect(rooms).toHaveLength(1)
    const xs = rooms[0]!.points.map((p) => p[0]).sort((a, b) => a - b)
    const ys = rooms[0]!.points.map((p) => p[1]).sort((a, b) => a - b)
    expect(xs[0]).toBeCloseTo(0, 5)
    expect(xs[3]).toBeCloseTo(100, 5)
    expect(ys[0]).toBeCloseTo(0, 5)
    expect(ys[3]).toBeCloseTo(100, 5)
  })

  it('dialog click leaves the current selection untouched (no clear)', async () => {
    const { store, model, engine } = setup()
    addRectWalls(model)
    const wallId = store.getHome().walls[0]!.id
    model.setSelection([wallId])
    engine.setTool('selection')

    engine.click({ x: 50, y: 50 })
    await flushAutoFloorOpen()

    expect(document.querySelector('.auto-floor-dialog')).not.toBeNull()
    expect(store.getHome().selection).toEqual([wallId])
  })

  it('click in genuinely empty space still clears selection', () => {
    const { store, model, engine } = setup()
    const wall = model.addWall({ xStart: 0, yStart: 0, xEnd: 100, yEnd: 0, thickness: 7 })
    model.setSelection([wall.id])
    engine.setTool('selection')

    engine.click({ x: 5000, y: 5000 })

    expect(document.querySelector('.auto-floor-dialog')).toBeNull()
    expect(store.getHome().selection).toEqual([])
  })

  it('click hitting an existing room selects it, no dialog', () => {
    const { store, model, engine } = setup()
    const room = model.addRoom([[0, 0], [100, 0], [100, 100], [0, 100]])
    engine.setTool('selection')

    engine.click({ x: 50, y: 50 })

    expect(document.querySelector('.auto-floor-dialog')).toBeNull()
    expect(store.getHome().selection).toEqual([room.id])
  })
})
