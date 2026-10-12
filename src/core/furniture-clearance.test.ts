import { describe, expect, it } from 'vitest'
import { furnitureOverlapsWalls } from '../plan/furniture-snap'
import { FurnitureTooLargeError } from './furniture-clearance'
import { ClipboardManager } from '../plan/clipboard'
import type { Furniture, NormalizedHomeState } from './home'
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

describe('store invariant: furniture too large for its room is rejected, never relocated', () => {
  /** 400x400 room (walls on its edges, 10 cm thick => 390 cm clear) with a Room polygon. */
  function roomSetup() {
    const s = setup()
    s.model.addRoom([[0, 0], [400, 0], [400, 400], [0, 400]], { name: 'Living' })
    return s
  }

  /** Everything observable that a rejected edit must leave untouched. */
  function snapshot(store: HomeStore) {
    return { home: JSON.stringify(store.getHome()), canUndo: store.canUndo(), canRedo: store.canRedo(), dirty: store.isDirty() }
  }

  it('addFurniture bigger than the room throws a clear error and changes nothing', () => {
    const { store, model } = roomSetup()
    const before = snapshot(store)
    const attempt = () => model.addFurniture(piece({ name: 'Giant sofa', width: 500, depth: 120 }))
    expect(attempt).toThrow(FurnitureTooLargeError)
    expect(attempt).toThrow(/"Giant sofa" \(500 x 120 cm\) is too large for room "Living" \(about 400 x 400 cm\)/)
    expect(snapshot(store)).toEqual(before)
  })

  it('carries structured details about the piece and the room', () => {
    const { model } = roomSetup()
    try {
      model.addFurniture(piece({ name: 'Slab', width: 600, depth: 50, angleDeg: 10 }))
      expect.unreachable()
    } catch (err) {
      expect(err).toBeInstanceOf(FurnitureTooLargeError)
      const e = err as FurnitureTooLargeError
      expect([e.furnitureName, e.widthCm, e.depthCm, e.angleDeg, e.roomName, e.roomWidthCm, e.roomDepthCm]).toEqual(['Slab', 600, 50, 10, 'Living', 400, 400])
    }
  })

  it('a piece that exactly fills the clear space is accepted and sits flush', () => {
    const { store, model } = roomSetup()
    const f = model.addFurniture(piece({ width: 390, depth: 60, x: 120, y: 200 }))
    const placed = store.peek().furniture.find((i) => i.id === f.id)!
    expect(placed.x).toBeCloseTo(200, 6)
    expect(overlapsWall(store, f.id)).toBe(false)
    expect(() => model.addFurniture(piece({ width: 390.5, depth: 60 }))).toThrow(FurnitureTooLargeError)
  })

  it('resizing a placed piece past the room (properties panel W/D) is rejected and the old size stays', () => {
    const { store, model } = roomSetup()
    const f = model.addFurniture(piece({ x: 200, y: 200 }))
    const before = snapshot(store)
    expect(() => model.updateFurniture(f.id, { width: 450 })).toThrow(FurnitureTooLargeError)
    expect(() => model.updateFurniture(f.id, { depth: 450 })).toThrow(FurnitureTooLargeError)
    expect(snapshot(store)).toEqual(before)
    expect(() => model.updateFurniture(f.id, { width: 380 })).not.toThrow()
  })

  it('rotating a long piece so it no longer fits the room is rejected (angle input, rotate handle)', () => {
    const store = new HomeStore()
    const model = new HomeModel(store)
    for (const [xs, ys, xe, ye] of [[0, 0, 400, 0], [400, 0, 400, 200], [400, 200, 0, 200], [0, 200, 0, 0]] as const) {
      model.addWall({ xStart: xs, yStart: ys, xEnd: xe, yEnd: ye, thickness: 10 })
    }
    model.addRoom([[0, 0], [400, 0], [400, 200], [0, 200]], { name: 'Corridor' })
    const f = model.addFurniture(piece({ name: 'Shelf', width: 380, depth: 40, x: 200, y: 100 }))
    const before = snapshot(store)
    expect(() => model.updateFurniture(f.id, { angleDeg: 90 })).toThrow(/"Shelf" \(380 x 40 cm\) is too large for room "Corridor" \(about 400 x 200 cm\)/)
    expect(snapshot(store)).toEqual(before)
    expect(() => model.updateFurniture(f.id, { angleDeg: 10 })).not.toThrow()
  })

  it('moving a fitting piece into a wall still slides it flush inside the room', () => {
    const { store, model } = roomSetup()
    const f = model.addFurniture(piece({ x: 200, y: 200 }))
    model.updateFurniture(f.id, { x: 5, y: 5 })
    const item = store.peek().furniture.find((i) => i.id === f.id)!
    expect(item.x).toBeCloseTo(5 + 60, 6)
    expect(item.y).toBeCloseTo(5 + 30, 6)
  })

  it('a piece dragged out of the room keeps the existing push-out (it is outside every room)', () => {
    const { store, model } = roomSetup()
    const f = model.addFurniture(piece({ x: 200, y: 200 }))
    model.updateFurniture(f.id, { x: 700, y: 200 })
    expect(store.peek().furniture.find((i) => i.id === f.id)!.x).toBe(700)
  })

  it('handles non-rectangular rooms: an L-shape holds a piece in its wide arm, not in its narrow one', () => {
    const store = new HomeStore()
    const model = new HomeModel(store)
    // L: 400x100 bar along the top, 100x300 bar down the left (walls on the outline).
    const outline: Array<[number, number]> = [[0, 0], [400, 0], [400, 100], [100, 100], [100, 400], [0, 400]]
    outline.forEach(([x, y], i) => {
      const [nx, ny] = outline[(i + 1) % outline.length]!
      model.addWall({ xStart: x, yStart: y, xEnd: nx, yEnd: ny, thickness: 10 })
    })
    model.addRoom(outline, { name: 'L-room' })
    const fits = model.addFurniture(piece({ name: 'Bench', width: 250, depth: 60, x: 250, y: 50 }))
    expect(store.peek().furniture.find((i) => i.id === fits.id)!.x).toBeCloseTo(250, 6)
    // A 200x200 block fits neither the 90 cm arm nor the 90 cm bar.
    expect(() => model.addFurniture(piece({ name: 'Wardrobe', width: 200, depth: 200, x: 50, y: 300 }))).toThrow(
      /"Wardrobe" \(200 x 200 cm\) is too large for room "L-room" \(about 400 x 400 cm\)/,
    )
  })

  it('round rooms: a circle of two arc walls holds a square that fits its inscribed circle and rejects a bigger one', () => {
    const store = new HomeStore()
    const model = new HomeModel(store)
    // Two half-turn arcs making a circle of centreline radius 150, walls 10 cm: 145 cm clear radius.
    model.addWall({ xStart: 0, yStart: 150, xEnd: 300, yEnd: 150, thickness: 10, arcExtent: Math.PI })
    model.addWall({ xStart: 300, yStart: 150, xEnd: 0, yEnd: 150, thickness: 10, arcExtent: Math.PI })
    const ring: Array<[number, number]> = Array.from({ length: 64 }, (_, i) => [150 + 150 * Math.cos((i * Math.PI) / 32), 150 + 150 * Math.sin((i * Math.PI) / 32)])
    model.addRoom(ring, { name: 'Rotunda' })
    // Largest square in a 145 cm circle has side 145 * sqrt(2) = 205.06.
    const fits = model.addFurniture(piece({ name: 'Rug', width: 205, depth: 205, x: 160, y: 140 }))
    const placed = store.peek().furniture.find((i) => i.id === fits.id)!
    expect(Math.hypot(placed.x - 150, placed.y - 150)).toBeLessThan(0.5)
    const before = JSON.stringify(store.getHome())
    expect(() => model.addFurniture(piece({ name: 'Rug', width: 207, depth: 207, x: 150, y: 150 }))).toThrow(
      /"Rug" \(207 x 207 cm\) is too large for room "Rotunda" \(about 300 x 300 cm\)/,
    )
    expect(JSON.stringify(store.getHome())).toBe(before)
  })

  it('a wall edit that shrinks the room below an existing piece is rejected (no ejection)', () => {
    const { store, model } = roomSetup()
    const f = model.addFurniture(piece({ name: 'Sofa', width: 300, depth: 80, x: 200, y: 200 }))
    const east = store.peek().walls[1]!
    expect(() => model.updateWall(east.id, { xStart: 250, xEnd: 250 })).toThrow(/"Sofa" \(300 x 80 cm\) is too large for room "Living"/)
    model.setSelection([east.id])
    const selected = snapshot(store)
    expect(() => model.moveSelection(-150, 0)).toThrow(FurnitureTooLargeError)
    expect(snapshot(store)).toEqual(selected)
    expect(store.peek().furniture.find((i) => i.id === f.id)!.x).toBe(200)
  })

  it('a wall drawn through a room is rejected when neither side can hold the piece, accepted (piece moves aside) when one can', () => {
    const { store, model } = roomSetup()
    const sofa = model.addFurniture(piece({ name: 'Sofa', width: 300, depth: 80, x: 200, y: 200 }))
    const before = snapshot(store)
    // A divider at x = 200 leaves two 190 cm halves: a 300 cm sofa fits neither.
    expect(() => model.addWall({ xStart: 200, yStart: 0, xEnd: 200, yEnd: 400, thickness: 20 })).toThrow(FurnitureTooLargeError)
    expect(snapshot(store)).toEqual(before)
    // A divider close to the west wall leaves a 285 cm side: a 250 cm piece moves there.
    model.updateFurniture(sofa.id, { width: 250 })
    model.addWall({ xStart: 100, yStart: 0, xEnd: 100, yEnd: 400, thickness: 20 })
    const moved = store.peek().furniture.find((i) => i.id === sofa.id)!
    expect(moved.x - 125).toBeGreaterThanOrEqual(110 - 1e-6)
    expect(overlapsWall(store, sofa.id)).toBe(false)
  })

  it('a loaded file that is already oversize is restored verbatim and unrelated wall edits leave it alone', () => {
    const { store, model } = roomSetup()
    const f = model.addFurniture(piece({ x: 200, y: 200 }))
    const home = store.getHome()
    home.furniture[0]!.width = 900 // a saved file whose piece never fitted
    store.loadHome(home)
    expect(store.peek().furniture[0]!.width).toBe(900)
    model.updateWall(store.peek().walls[0]!.id, { thickness: 12 })
    model.addWall({ xStart: 1000, yStart: 0, xEnd: 1100, yEnd: 0, thickness: 10 })
    expect(store.peek().furniture.find((i) => i.id === f.id)!.width).toBe(900)
  })

  it('undo/redo of an accepted edit are untouched by rejections in between', () => {
    const { store, model } = roomSetup()
    const f = model.addFurniture(piece())
    model.updateFurniture(f.id, { x: 150 })
    expect(() => model.updateFurniture(f.id, { width: 800 })).toThrow(FurnitureTooLargeError)
    expect(store.undo()).toBe(true)
    expect(store.peek().furniture[0]!.x).toBe(200)
    expect(store.redo()).toBe(true)
    expect(store.peek().furniture[0]!.x).toBe(150)
  })

  it('atomically rolls back a multi-step batch that is rejected halfway', () => {
    const { store, model } = roomSetup()
    const before = snapshot(store)
    expect(() => store.atomically(() => {
      store.beginCompoundEdit()
      model.addFurniture(piece({ name: 'Chair', width: 50, depth: 50 }))
      model.addFurniture(piece({ name: 'Giant', width: 900, depth: 50 }))
      store.endCompoundEdit()
    })).toThrow(FurnitureTooLargeError)
    expect(snapshot(store)).toEqual(before)
    // The compound edit is closed again: the next apply is a normal undo step.
    model.addFurniture(piece({ name: 'Stool', width: 40, depth: 40 }))
    expect(store.canUndo()).toBe(true)
  })
})

describe('fixFurnitureClearance (legacy loads)', () => {
  const wall = (id: string, xs: number, ys: number, xe: number, ye: number) => ({
    id, xStart: xs, yStart: ys, xEnd: xe, yEnd: ye, thickness: 10, levelRef: null,
  })
  function legacyHome() {
    const store = new HomeStore()
    const home = structuredClone(store.peek()) as NormalizedHomeState
    home.walls = [wall('w1', 0, 0, 400, 0), wall('w2', 400, 0, 400, 400), wall('w3', 400, 400, 0, 400), wall('w4', 0, 400, 0, 0)]
    home.rooms = [{ id: 'r1', points: [[5, 5], [395, 5], [395, 395], [5, 395]], levelRef: null }]
    home.furniture = [
      { id: 'f1', name: 'Shelf', x: 200, y: 0, angleDeg: 0, width: 120, depth: 60, height: 80, elevation: 0 },
      { id: 'f2', name: 'Fine', x: 200, y: 200, angleDeg: 0, width: 50, depth: 50, height: 80, elevation: 0 },
    ]
    store.loadHome(home)
    return store
  }

  it('moves overlapping pieces flush as ONE undo step and leaves others alone', () => {
    const store = legacyHome()
    const fix = store.fixFurnitureClearance()
    expect(fix.moves.map((m) => m.furnitureId)).toEqual(['f1'])
    expect(fix.unfixable).toEqual([])
    expect(store.peek().furniture.find((f) => f.id === 'f1')!.y).toBe(35)
    expect(store.peek().furniture.find((f) => f.id === 'f2')!.y).toBe(200)
    expect(store.fixFurnitureClearance().moves).toEqual([])
    store.undo()
    expect(store.peek().furniture.find((f) => f.id === 'f1')!.y).toBe(0)
    expect(store.canUndo()).toBe(false)
  })

  it('reports an oversize piece as unfixable without throwing or moving it', () => {
    const store = legacyHome()
    const home = structuredClone(store.peek()) as NormalizedHomeState
    home.furniture.push({ id: 'big', name: 'Huge', x: 200, y: 200, angleDeg: 0, width: 900, depth: 900, height: 80, elevation: 0 })
    store.loadHome(home)
    const fix = store.fixFurnitureClearance()
    expect(fix.unfixable.map((u) => u.furnitureId)).toEqual(['big'])
    expect(fix.unfixable[0]!.message).toMatch(/Huge/)
    expect(store.peek().furniture.find((f) => f.id === 'big')!.x).toBe(200)
    expect(store.peek().furniture.find((f) => f.id === 'f1')!.y).toBe(35)
  })
})
