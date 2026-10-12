import { describe, expect, it } from 'vitest'
import { furnitureOverlapsWalls } from '../plan/furniture-snap'
import { ClipboardManager } from '../plan/clipboard'
import type { Furniture } from './home'
import { HomeModel } from './model'
import { HomeStore } from './store'

function setup() {
  const store = new HomeStore()
  const model = new HomeModel(store)
  // 400x400 room, 10 cm walls, ground floor.
  for (const [xs, ys, xe, ye] of [[0, 0, 400, 0], [400, 0, 400, 400], [400, 400, 0, 400], [0, 400, 0, 0]] as const) {
    model.addWall({ xStart: xs, yStart: ys, xEnd: xe, yEnd: ye, thickness: 10 })
  }
  return { store, model }
}

const piece = (over: Partial<Omit<Furniture, 'id'>> = {}): Omit<Furniture, 'id'> => ({
  name: 'Sofa', x: 200, y: 200, angleDeg: 0, width: 120, depth: 60, height: 80, elevation: 0, ...over,
})

function overlapsWall(store: HomeStore, id: string): boolean {
  const home = store.peek()
  const f = home.furniture.find((item) => item.id === id)!
  const walls = home.walls.filter((w) => (w.levelRef ?? null) === (f.levelRef ?? null))
  return furnitureOverlapsWalls({ x: f.x, y: f.y }, walls, f.width, f.depth, f.angleDeg)
}

describe('store invariant: furniture never overlaps a wall', () => {
  it('addFurniture (catalog placement, MCP add_furniture) is pushed out of a wall', () => {
    const { store, model } = setup()
    const f = model.addFurniture(piece({ x: 200, y: 0 }))
    expect(overlapsWall(store, f.id)).toBe(false)
    expect(store.peek().furniture[0]!.y).toBe(5 + 30)
  })

  it('updateFurniture x/y (drag, gizmo translate, properties panel, MCP modify_selected) is clamped', () => {
    const { store, model } = setup()
    const f = model.addFurniture(piece())
    model.updateFurniture(f.id, { x: 2 })
    model.updateFurniture(f.id, { y: 399 })
    expect(overlapsWall(store, f.id)).toBe(false)
    model.updateFurniture(f.id, { x: 1000, y: 1000 })
    expect(overlapsWall(store, f.id)).toBe(false)
  })

  it('updateFurniture angle (rotate handle, gizmo rotate, angle input) is clamped', () => {
    const { store, model } = setup()
    const f = model.addFurniture(piece({ x: 200, y: 36, width: 150, depth: 60 }))
    for (const angleDeg of [90, 45, 135, 10, 180]) {
      model.updateFurniture(f.id, { angleDeg })
      expect(overlapsWall(store, f.id), `angle ${angleDeg}`).toBe(false)
    }
  })

  it('updateFurniture width/depth growth (properties panel) is clamped', () => {
    const { store, model } = setup()
    const f = model.addFurniture(piece({ x: 200, y: 36 }))
    model.updateFurniture(f.id, { width: 300 })
    model.updateFurniture(f.id, { depth: 200 })
    expect(overlapsWall(store, f.id)).toBe(false)
  })

  it('moveSelection (arrow-key nudge) is clamped', () => {
    const { store, model } = setup()
    const f = model.addFurniture(piece({ x: 70, y: 200 }))
    model.setSelection([f.id])
    model.moveSelection(-100, 0)
    expect(overlapsWall(store, f.id)).toBe(false)
  })

  it('paste and duplicate cannot land inside a wall', () => {
    const { store, model } = setup()
    const clipboard = new ClipboardManager(store, model)
    const f = model.addFurniture(piece({ x: 340, y: 200 }))
    model.setSelection([f.id])
    clipboard.copy()
    const pasted = clipboard.paste()
    const duplicated = clipboard.duplicate()
    for (const id of [...pasted, ...duplicated]) expect(overlapsWall(store, id)).toBe(false)
  })

  it('adding, resizing or moving a wall into existing furniture pushes the furniture out', () => {
    const { store, model } = setup()
    const f = model.addFurniture(piece())
    model.addWall({ xStart: 100, yStart: 200, xEnd: 300, yEnd: 200, thickness: 10 })
    expect(overlapsWall(store, f.id)).toBe(false)

    const wall = store.peek().walls[0]!
    model.updateWall(wall.id, { yStart: 190, yEnd: 190, thickness: 40 })
    expect(overlapsWall(store, f.id)).toBe(false)

    model.setWallEndpoint(wall.id, 'end', 200, 210)
    expect(overlapsWall(store, f.id)).toBe(false)

    model.updateWall(store.peek().walls[1]!.id, { thickness: 300 })
    expect(overlapsWall(store, f.id)).toBe(false)
  })

  it('a wall attached piece sits on the wall face, not its centerline', () => {
    const { store, model } = setup()
    const f = model.addFurniture(piece({ x: 200, y: 36, wallRef: store.peek().walls[0]!.id, wallOffset: 200 }))
    model.updateFurniture(f.id, { x: 250, y: 20 })
    expect(overlapsWall(store, f.id)).toBe(false)
    expect(store.peek().furniture[0]!.y).toBeCloseTo(35, 6)
  })

  it('only same-level walls constrain a piece', () => {
    const { store, model } = setup()
    const level = model.addLevel({ name: 'First floor', elevation: 270, floorThickness: 12, height: 250 } as Parameters<HomeModel['addLevel']>[0])
    const upstairs = model.addFurniture(piece({ x: 200, y: 0, levelRef: level.id }))
    expect(store.peek().furniture.find((i) => i.id === upstairs.id)!.y).toBe(0)
    model.addWall({ xStart: 0, yStart: 0, xEnd: 400, yEnd: 0, thickness: 10, levelRef: level.id })
    expect(overlapsWall(store, upstairs.id)).toBe(false)
    expect(store.peek().furniture.find((i) => i.id === upstairs.id)!.y).toBe(35)
  })

  it('doors and windows are exempt: they sit in their wall', () => {
    const { store, model } = setup()
    const door = model.addFurniture(piece({ name: 'Door', x: 200, y: 0, width: 90, depth: 10, height: 210, doorOrWindow: true, wallRef: store.peek().walls[0]!.id }))
    const window = model.addFurniture(piece({ name: 'Window', x: 400, y: 100, width: 90, depth: 10, height: 100, elevation: 90, doorOrWindow: true }))
    model.addWall({ xStart: 200, yStart: -50, xEnd: 200, yEnd: 50, thickness: 10 })
    for (const [id, x, y] of [[door.id, 200, 0], [window.id, 400, 100]] as const) {
      const item = store.peek().furniture.find((i) => i.id === id)!
      expect([item.x, item.y], item.name).toEqual([x, y])
    }
    expect(overlapsWall(store, door.id)).toBe(true)
  })

  it('loadHome restores a saved file verbatim, and unrelated edits do not move legacy overlaps', () => {
    const { store, model } = setup()
    const f = model.addFurniture(piece())
    const home = store.getHome()
    home.furniture[0]!.y = 0 // a saved file that already clips a wall
    store.loadHome(home)
    expect(overlapsWall(store, f.id)).toBe(true)
    model.setName('Renamed')
    model.addLabel({ text: 'hi', x: 1, y: 1 })
    expect(store.peek().furniture[0]!.y).toBe(0)
    // Touching the piece itself brings it into compliance.
    model.updateFurniture(f.id, { x: 210 })
    expect(overlapsWall(store, f.id)).toBe(false)
  })

  it('undo restores the pre-push state and redo re-applies the clamp', () => {
    const { store, model } = setup()
    const f = model.addFurniture(piece())
    model.updateFurniture(f.id, { y: 0 })
    const pushed = store.peek().furniture[0]!.y
    expect(pushed).toBe(35)
    store.undo()
    expect(store.peek().furniture[0]!.y).toBe(200)
    store.redo()
    expect(store.peek().furniture[0]!.y).toBe(pushed)
  })
})
