import { describe, expect, it } from 'vitest'
import { HomeModel, NEW_WALL_THICKNESS_CM } from '../src/core/model'
import { HomeStore } from '../src/core/store'
import {
  PlanEngine,
  furnitureRotationHandlePos,
  wallArcHandlePos,
  type ClickInput,
  type DragInput,
  type HitResult,
} from '../src/plan/engine'
import {
  getMagnetizedLength,
  pointWithAngleMagnetism,
  wallPointMagnetism,
} from '../src/plan/magnetism'

function setup() {
  const store = new HomeStore()
  const model = new HomeModel(store)
  const engine = new PlanEngine(model)
  const click = (x: number, y: number, rest: Omit<ClickInput, 'x' | 'y'> = {}) =>
    engine.click({ x, y, ...rest })
  const drag = (fromX: number, fromY: number, toX: number, toY: number, rest: Partial<DragInput> = {}) =>
    engine.drag({ fromX, fromY, toX, toY, ...rest })
  return { store, model, engine, click, drag }
}

const WALL_ENDPOINT_MARGIN = 4

/** Serialized wall graph modulo ids: sorted [x1,y1,x2,y2] tuples. */
function wallGraph(store: HomeStore): Array<[number, number, number, number]> {
  return store
    .getHome()
    .walls.map((w) => {
      const a: [number, number] = [w.xStart, w.yStart]
      const b: [number, number] = [w.xEnd, w.yEnd]
      // Canonical endpoint order per wall...
      const ordered =
        a[0]! > b[0]! || (a[0] === b[0] && a[1]! > b[1]!) ? ([b, a] as const) : ([a, b] as const)
      return [...ordered[0], ...ordered[1]] as [number, number, number, number]
    })
    .sort(
      (t1, t2) =>
        t1[0]! - t2[0]! || t1[1]! - t2[1]! || t1[2]! - t2[2]! || t1[3]! - t2[3]!,
    )
}

describe('wall tool state machine', () => {
  it('chains clicked segments and commits them as ONE undo step on escape', () => {
    const { engine, click, store } = setup()
    engine.setTool('wall')
    click(0, 0)
    expect(engine.getPreview().phase).toBe('drawing')
    click(100, 0)
    // SH3D WallDrawingState: each wall enters the home AT ITS CLICK
    // (the top camera moves on the second click — first wall committed).
    expect(store.getHome().walls).toHaveLength(1)
    click(100, 80)
    expect(store.getHome().walls).toHaveLength(2)
    expect(engine.getPreview().pendingWalls).toHaveLength(0)

    engine.key('escape')
    expect(engine.getPreview()).toMatchObject({ phase: 'idle', pendingWalls: [], chainStart: null })
    const home = store.getHome()
    expect(home.walls).toHaveLength(2)
    expect(wallGraph(store)).toEqual([
      [0, 0, 100, 0],
      [100, 0, 100, 80],
    ])
    expect(home.selection).toHaveLength(2)
    // Single compound undo op for the whole chain session.
    expect(store.undo()).toBe(true)
    expect(store.getHome().walls).toHaveLength(0)
    expect(store.canUndo()).toBe(false)
  })

  it('double-click closes the cycle, joins exactly, and adds NO room (SH3D parity)', () => {
    const { engine, click, store } = setup()
    engine.setTool('wall')
    engine.setMagnetism(false)
    click(0, 0)
    click(100, 0)
    click(50, -80)
    click(0.5, 0.5, { dbl: true })

    const home = store.getHome()
    expect(home.walls).toHaveLength(3)
    // Final segment joined EXACTLY onto the free chain-start endpoint.
    const last = home.walls[2]!
    expect([last.xStart, last.yStart]).toEqual([50, -80])
    expect([last.xEnd, last.yEnd]).toEqual([0, 0])
    // SH3D validateDrawnWalls never creates rooms on loop close.
    expect(home.rooms).toHaveLength(0)
    expect(home.selection).toHaveLength(3)
    expect(store.undo()).toBe(true)
    expect(store.getHome().walls).toHaveLength(0)
    expect(store.getHome().rooms).toHaveLength(0)
  })

  it('a later chain starts exactly at a free endpoint of a committed wall', () => {
    const { engine, click } = setup()
    engine.setTool('wall')
    engine.setMagnetism(false)
    click(0, 0)
    click(100, 0)
    engine.key('escape')

    click(102, 0) // within PIXEL_MARGIN of the free end (100,0)
    expect(engine.getPreview().chainStart).toEqual({ x: 100, y: 0 })
  })

  it('escape with an empty chain returns to the selection tool', () => {
    const { engine, click } = setup()
    engine.setTool('wall')
    engine.key('escape')
    expect(engine.getTool()).toBe('selection')

    engine.setTool('wall')
    click(10, 10)
    engine.key('escape') // commits nothing (no segments), stays in wall tool
    expect(engine.getTool()).toBe('wall')
    expect(engine.getPreview().phase).toBe('idle')
  })

  it('delete key removes the selection without switching off the wall tool', () => {
    const { engine, click, store } = setup()
    engine.setTool('wall')
    engine.setMagnetism(false)
    click(0, 0)
    click(100, 0)
    click(100, 80)
    click(0.5, 0.5, { dbl: true })

    expect(store.getHome().walls).toHaveLength(3)
    expect(engine.getTool()).toBe('wall')
    expect(store.getHome().selection).toHaveLength(3)

    engine.key('delete')
    expect(store.getHome().walls).toHaveLength(0)
    expect(store.getHome().selection).toEqual([])
    expect(engine.getTool()).toBe('wall') // tool is unaffected by delete
    expect(store.undo()).toBe(true)
    expect(store.getHome().walls).toHaveLength(3)
  })

  it('switching tools mid-chain commits the drawn walls first', () => {
    const { engine, click, store } = setup()
    engine.setTool('wall')
    click(0, 0)
    click(80, 0)
    engine.setTool('selection')
    expect(store.getHome().walls).toHaveLength(1)
    expect(engine.getPreview().phase).toBe('idle')
  })
})

describe('magnetism', () => {
  it('snaps lengths to the SH3D precision ladder', () => {
    expect(getMagnetizedLength(52.6, 5)).toBe(55)
    expect(getMagnetizedLength(103.005, 1)).toBe(103)
    expect(getMagnetizedLength(7.04, 0.1)).toBe(7)
  })

  it('snaps direction to the nearest 15° ray and magnetizes the radius', () => {
    expect(pointWithAngleMagnetism({ x: 0, y: 0 }, { x: 103, y: 1 }, 1)).toEqual({ x: 103, y: 0 })
    const diag = pointWithAngleMagnetism({ x: 0, y: 0 }, { x: 70.8, y: 70.8 }, 1)
    expect(diag.x).toBeCloseTo(100 * Math.cos(Math.PI / 4), 6)
    expect(diag.y).toBeCloseTo(100 * Math.sin(Math.PI / 4), 6)
  })

  it('per-axis snaps x and y independently toward wall endpoints', () => {
    const walls = [
      { id: 'w', xStart: 0, yStart: 0, xEnd: 100, yEnd: 0 },
    ]
    // x within 4 of endpoint x=100, y within 4 of endpoint y=0 → both snap.
    expect(
      wallPointMagnetism({ x: 500, y: 500 }, { x: 101, y: 3 }, walls, {
        enabled: false,
        maxDelta: 1,
        endpointMargin: WALL_ENDPOINT_MARGIN,
      }),
    ).toEqual({ x: 100, y: 0 })
    // Beyond the margin nothing moves.
    expect(
      wallPointMagnetism({ x: 500, y: 500 }, { x: 105, y: 9 }, walls, {
        enabled: false,
        maxDelta: 1,
        endpointMargin: WALL_ENDPOINT_MARGIN,
      }),
    ).toEqual({ x: 105, y: 9 })
  })

  it('engine resolves segment ends through the magnetizer when enabled', () => {
    const { engine, click, store } = setup()
    engine.setTool('wall')
    engine.setMagnetism(true)
    click(0, 0)
    click(103, 1)
    engine.key('escape')
    expect(wallGraph(store)).toEqual([[0, 0, 103, 0]])
  })

  it('set_magnetism toggles the flag used by segment resolution', () => {
    const { engine } = setup()
    expect(engine.isMagnetismEnabled()).toBe(true)
    engine.setMagnetism(false)
    expect(engine.isMagnetismEnabled()).toBe(false)
  })
})

describe('selection interactions', () => {
  function twoWalls() {
    const s = setup()
    s.engine.setTool('wall')
    s.engine.setMagnetism(false)
    s.click(0, 0)
    s.click(100, 0)
    s.engine.key('escape')
    s.click(0, 40)
    s.click(100, 40)
    s.engine.key('escape')
    s.engine.setTool('selection')
    return s
  }

  it('click selects a wall, shift-click adds, empty click clears', () => {
    const { click, store } = twoWalls()
    click(50, 0) // midpoint of first wall
    expect(store.getHome().selection).toHaveLength(1)
    const first = store.getHome().selection[0]!

    click(50, 40, { shift: true })
    expect(store.getHome().selection).toHaveLength(2)

    click(500, 500)
    expect(store.getHome().selection).toEqual([])

    click(50, 0)
    click(50, 0, { shift: true })
    expect(store.getHome().selection).toEqual([])
    void first
  })

  it('drag-move translates the hit wall in ONE undo step', () => {
    const { drag, store } = twoWalls()
    const before = wallGraph(store)
    drag(50, 0, 60, 20)
    const after = store.getHome().walls
    expect(after).toHaveLength(2)
    const moved = after.find((w) => Math.abs(w.yStart - 20) < 1e-9)!
    expect([moved.xStart, moved.yStart, moved.xEnd, moved.yEnd]).toEqual([10, 20, 110, 20])
    expect(store.undo()).toBe(true)
    expect(wallGraph(store)).toEqual(before)
  })

  it('drag over empty space rectangle-selects walls by endpoints/midpoint', () => {
    const { drag, store } = twoWalls()
    drag(-10, -10, 120, 10)
    expect(store.getHome().selection).toHaveLength(1)
    drag(-10, -10, 120, 50)
    expect(store.getHome().selection).toHaveLength(2)
  })

  it('delete key removes the selection in one undoable op', () => {
    const s = twoWalls()
    const { click, store, engine } = s
    click(50, 0)
    engine.key('delete')
    expect(store.getHome().walls).toHaveLength(1)
    expect(store.getHome().selection).toEqual([])
    expect(store.undo()).toBe(true)
    expect(store.getHome().walls).toHaveLength(2)
  })

  it('arrow keys nudge selection by 1 cm', () => {
    const s = twoWalls()
    const { click, store, engine } = s
    click(50, 0)
    const id = store.getHome().selection[0]!
    const w = () => store.getHome().walls.find((w) => w.id === id)!
    expect(w().xStart).toBe(0)
    engine.key('arrow-right')
    expect(w().xStart).toBe(1)
    engine.key('arrow-left')
    expect(w().xStart).toBe(0)
    engine.key('arrow-down')
    expect(w().yStart).toBe(1)
    engine.key('arrow-up')
    expect(w().yStart).toBe(0)
  })

  it('arrow keys with shift nudge by 10 cm', () => {
    const s = twoWalls()
    const { click, store, engine } = s
    click(50, 0)
    const id = store.getHome().selection[0]!
    const w = () => store.getHome().walls.find((w) => w.id === id)!
    engine.key('arrow-right', true)
    expect(w().xStart).toBe(10)
    engine.key('arrow-left', true)
    expect(w().xStart).toBe(0)
    engine.key('arrow-down', true)
    expect(w().yStart).toBe(10)
    engine.key('arrow-up', true)
    expect(w().yStart).toBe(0)
  })

  it('arrow key nudge is a no-op on empty selection', () => {
    const s = twoWalls()
    const { click, store, engine } = s
    click(500, 500)
    const before = store.getHome().walls.map((w) => [w.xStart, w.yStart, w.xEnd, w.yEnd])
    engine.key('arrow-right')
    expect(store.getHome().walls.map((w) => [w.xStart, w.yStart, w.xEnd, w.yEnd])).toEqual(before)
  })

  it('arrow key nudge is undoable in one step per keypress', () => {
    const s = twoWalls()
    const { click, store, engine } = s
    click(50, 0)
    const id = store.getHome().selection[0]!
    const w = () => store.getHome().walls.find((w) => w.id === id)!
    engine.key('arrow-right')
    expect(w().xStart).toBe(1)
    engine.key('arrow-down')
    expect(w().yStart).toBe(1)
    expect(store.undo()).toBe(true)
    expect(w().yStart).toBe(0)
    expect(store.undo()).toBe(true)
    expect(w().xStart).toBe(0)
  })

  it('new walls use the driver defaults: thickness 7, height 250, pattern hatchUp', () => {
    const s = setup()
    s.engine.setTool('wall')
    s.click(0, 0)
    s.click(100, 0)
    s.engine.key('escape')
    const wall = s.store.getHome().walls[0]!
    expect(wall.thickness).toBe(NEW_WALL_THICKNESS_CM)
    expect(NEW_WALL_THICKNESS_CM).toBe(7) // driver forces prefs thickness=7f
    expect(wall.height).toBe(250)
    expect(wall.patternId).toBe('hatchUp')
  })
})

describe('equivalence-style script (mirrors scenarios/walls/create_room.yaml)', () => {
  it('same click script yields the expected wall graph modulo ids', () => {
    const { engine, click, store } = setup()
    engine.setTool('wall')
    engine.setMagnetism(false)

    const script: Array<[number, number]> = [
      [0, 0],
      [400, 0],
      [400, 300],
      [0, 300],
    ]
    for (const [x, y] of script) click(x, y)
    click(0, 0, { dbl: true })

    expect(wallGraph(store)).toEqual([
      [0, 0, 0, 300],
      [0, 0, 400, 0],
      [0, 300, 400, 300],
      [400, 0, 400, 300],
    ])
    const home = store.getHome()
    expect(home.rooms).toHaveLength(0) // SH3D parity: no auto-room on loop close
    expect(home.selection).toHaveLength(4)

    // Whole room creation is one compound undo step.
    store.undo()
    expect(store.getHome().walls).toHaveLength(0)
    expect(store.getHome().rooms).toHaveLength(0)
  })
})

describe('wall vertex interaction', () => {
  function makeWallRoom() {
    const s = setup()
    s.engine.setTool('wall')
    s.engine.setMagnetism(false)
    s.click(0, 0)
    s.click(100, 0)
    s.click(100, 80)
    s.engine.key('escape')
    s.engine.setTool('selection')
    return s
  }

  it('hitTest near wall endpoint returns wall-endpoint HitResult', () => {
    const { engine, store } = makeWallRoom()
    const home = store.getHome()
    const wall = home.walls[0]!
    const hit = engine.hitTestPoint({ x: wall.xStart, y: wall.yStart })
    expect(hit).not.toBeNull()
    expect(hit!.kind).toBe('wall-endpoint')
    expect((hit as Extract<HitResult, { kind: 'wall-endpoint' }>).wallId).toBe(wall.id)
    expect((hit as Extract<HitResult, { kind: 'wall-endpoint' }>).endpoint).toBe('start')
  })

  it('hitTest on wall body returns wall-body HitResult', () => {
    const { engine, store } = makeWallRoom()
    const home = store.getHome()
    const wall = home.walls[0]!
    const midX = (wall.xStart + wall.xEnd) / 2
    const midY = (wall.yStart + wall.yEnd) / 2
    const hit = engine.hitTestPoint({ x: midX, y: midY })
    expect(hit).not.toBeNull()
    expect(hit!.kind).toBe('wall-body')
  })

  it('setWallEndpoint moves just that endpoint', () => {
    const { model, store } = makeWallRoom()
    const wall = store.getHome().walls[0]!
    model.setWallEndpoint(wall.id, 'end', 200, 50)
    const updated = store.getHome().walls.find((w) => w.id === wall.id)!
    expect(updated.xEnd).toBe(200)
    expect(updated.yEnd).toBe(50)
    expect(updated.xStart).toBe(wall.xStart)
    expect(updated.yStart).toBe(wall.yStart)
  })

  it('drag on endpoint moves connected walls sharing that endpoint', () => {
    const s = makeWallRoom()
    const { click, store, drag } = s
    // Wall 0: (0,0)-(100,0), Wall 1: (100,0)-(100,80)
    // They share endpoint at (100,0)
    const wall0 = store.getHome().walls[0]!
    const wall1 = store.getHome().walls[1]!
    expect(wall0.xEnd).toBe(100)
    expect(wall0.yEnd).toBe(0)
    expect(wall1.xStart).toBe(100)
    expect(wall1.yStart).toBe(0)

    // Click to select wall 0, then drag its endpoint at (100,0)
    click(50, 0)
    drag(100, 0, 120, 0)

    const after0 = store.getHome().walls.find((w) => w.id === wall0.id)!
    const after1 = store.getHome().walls.find((w) => w.id === wall1.id)!
    expect(after0.xEnd).toBe(120)
    expect(after0.yEnd).toBe(0)
    expect(after1.xStart).toBe(120)
    expect(after1.yStart).toBe(0)
  })
})

describe('room vertex interaction', () => {
  function makeRoom() {
    const s = setup()
    s.engine.setTool('room')
    s.engine.setMagnetism(false)
    s.click(0, 0)
    s.click(200, 0)
    s.click(200, 150)
    s.click(0, 150)
    s.click(50, 75, { dbl: true })
    s.engine.setTool('selection')
    return s
  }

  it('hitTest near a room vertex returns the room-vertex HitResult', () => {
    const { engine, store } = makeRoom()
    const room = store.getHome().rooms[0]!
    const hit = engine.hitTestPoint({ x: room.points[1]![0] + 3, y: room.points[1]![1] + 3 })
    expect(hit).not.toBeNull()
    expect(hit!.kind).toBe('room-vertex')
    expect((hit as Extract<HitResult, { kind: 'room-vertex' }>).roomId).toBe(room.id)
    expect((hit as Extract<HitResult, { kind: 'room-vertex' }>).vertexIndex).toBe(1)
  })

  it('drag on a room vertex moves only that one point, leaving others unchanged', () => {
    const { drag, store } = makeRoom()
    const room = store.getHome().rooms[0]!
    drag(room.points[1]![0], room.points[1]![1], room.points[1]![0] + 40, room.points[1]![1] + 25)
    const updated = store.getHome().rooms[0]!
    expect(updated.points[1]).toEqual([240, 25])
    expect(updated.points[0]).toEqual([0, 0])
    expect(updated.points[2]).toEqual([200, 150])
    expect(updated.points[3]).toEqual([0, 150])
  })

  it('the whole room-vertex drag is ONE undo step', () => {
    const { drag, store } = makeRoom()
    const room = store.getHome().rooms[0]!
    const original = room.points
    drag(
      room.points[2]![0],
      room.points[2]![1],
      room.points[2]![0] + 30,
      room.points[2]![1] - 10,
    )
    expect(store.getHome().rooms[0]!.points[2]).toEqual([230, 140])
    expect(store.undo()).toBe(true)
    expect(store.getHome().rooms[0]!.points).toEqual(original)
  })
})

describe('room tool state machine', () => {
  it('clicks a 4-vertex polygon and double-click closes it into a Room', () => {
    const { engine, click, store } = setup()
    engine.setTool('room')
    engine.setMagnetism(false)
    click(0, 0)
    expect(engine.getPreview().phase).toBe('drawing')
    click(200, 0)
    click(200, 150)
    click(0, 150)
    click(50, 75, { dbl: true })

    const home = store.getHome()
    expect(home.rooms).toHaveLength(1)
    const room = home.rooms[0]!
    expect(room.points).toEqual([
      [0, 0],
      [200, 0],
      [200, 150],
      [0, 150],
    ])
    expect(engine.getPreview().phase).toBe('idle')
    expect(home.selection).toEqual([room.id])
  })

  it('click-near-start closes the polygon without adding a closing vertex', () => {
    const { engine, click, store } = setup()
    engine.setTool('room')
    engine.setMagnetism(false)
    click(0, 0)
    click(100, 0)
    click(100, 80)
    click(0, 80)
    click(1, 1) // within ENDPOINT_HIT_RADIUS (10) of the start (0,0)

    const home = store.getHome()
    expect(home.rooms).toHaveLength(1)
    expect(home.rooms[0]!.points).toEqual([
      [0, 0],
      [100, 0],
      [100, 80],
      [0, 80],
    ])
    expect(engine.getPreview().phase).toBe('idle')
  })

  it('escape cancels the in-progress polygon and creates no room', () => {
    const { engine, click, store } = setup()
    engine.setTool('room')
    click(0, 0)
    click(100, 0)
    click(100, 80)
    expect(engine.getPreview().phase).toBe('drawing')
    expect(engine.getPreview().roomPoints).toHaveLength(3)

    engine.key('escape')
    expect(engine.getPreview().phase).toBe('idle')
    expect(engine.getPreview().roomPoints).toHaveLength(0)
    expect(store.getHome().rooms).toHaveLength(0)
  })

  it('undo removes the created room in one step', () => {
    const { engine, click, store } = setup()
    engine.setTool('room')
    engine.setMagnetism(false)
    click(0, 0)
    click(100, 0)
    click(100, 80)
    click(0, 80)
    click(1, 1) // close near start

    expect(store.getHome().rooms).toHaveLength(1)
    expect(store.canUndo()).toBe(true)
    store.undo()
    expect(store.getHome().rooms).toHaveLength(0)
    expect(store.canUndo()).toBe(false)
  })

  it('double-click immediately after starting (1 vertex) creates no room', () => {
    const { engine, click, store } = setup()
    engine.setTool('room')
    click(0, 0)
    click(50, 50, { dbl: true })

    expect(store.getHome().rooms).toHaveLength(0)
    // Points are at different positions → not trivial → closeRoom with < 3 points → idle
    expect(engine.getPreview().phase).toBe('idle')
  })

  it('switching tools mid-drawing cancels the in-progress polygon', () => {
    const { engine, click, store } = setup()
    engine.setTool('room')
    click(0, 0)
    click(100, 0)
    click(100, 80)
    expect(engine.getPreview().phase).toBe('drawing')
    engine.setTool('selection')
    expect(engine.getPreview().phase).toBe('idle')
    expect(store.getHome().rooms).toHaveLength(0)
  })

  it('a 3-vertex triangle closes correctly via double-click', () => {
    const { engine, click, store } = setup()
    engine.setTool('room')
    engine.setMagnetism(false)
    click(0, 0)
    click(100, 0)
    click(50, 80)
    click(50, 40, { dbl: true })

    const home = store.getHome()
    expect(home.rooms).toHaveLength(1)
    expect(home.rooms[0]!.points).toEqual([
      [0, 0],
      [100, 0],
      [50, 80],
    ])
  })

  it('double-click inside a 4-wall enclosure auto-creates a room in one undo step', () => {
    const { engine, click, store } = setup()
    // Draw 4 walls forming a closed rectangle
    engine.setTool('wall')
    engine.setMagnetism(false)
    click(0, 0)
    click(400, 0)
    click(400, 300)
    click(0, 300)
    click(0, 0, { dbl: true })
    expect(store.getHome().walls).toHaveLength(4)

    // Switch to room tool and double-click inside the rectangle
    engine.setTool('room')
    click(200, 150, { dbl: true })

    const home = store.getHome()
    expect(home.rooms).toHaveLength(1)
    const room = home.rooms[0]!
    expect(room.points.length).toBeGreaterThanOrEqual(3)
    // The room should cover the interior of the 4-wall rectangle.
    // Verify undo removes it in one step.
    expect(store.canUndo()).toBe(true)
    store.undo()
    expect(store.getHome().rooms).toHaveLength(0)
    // Walls remain untouched.
    expect(store.getHome().walls).toHaveLength(4)
  })

  it('double-click in open space (no enclosure) starts manual room drawing', () => {
    const { engine, click, store } = setup()
    engine.setTool('room')
    // Double-click in empty space — no walls, no enclosure
    click(100, 100, { dbl: true })

    // Should fall back to manual drawing (starts with 1 vertex)
    expect(engine.getPreview().phase).toBe('drawing')
    expect(engine.getPreview().roomPoints).toHaveLength(1)
    expect(store.getHome().rooms).toHaveLength(0)
  })
})

describe('dimension-line tool state machine', () => {
  it('two clicks place a dimension line with the correct endpoints and length', () => {
    const { engine, click, store } = setup()
    engine.setTool('dimensionLine')
    engine.setMagnetism(false)
    click(0, 0)
    expect(engine.getPreview().phase).toBe('drawing')
    click(300, 0)

    const home = store.getHome()
    expect(home.dimensionLines).toHaveLength(1)
    const dim = home.dimensionLines[0]!
    expect([dim.xStart, dim.yStart, dim.xEnd, dim.yEnd]).toEqual([0, 0, 300, 0])
    expect(engine.getPreview().phase).toBe('idle')
    expect(home.selection).toEqual([dim.id])
  })

  it('escape cancels an in-progress dimension line and creates none', () => {
    const { engine, click, store } = setup()
    engine.setTool('dimensionLine')
    click(0, 0)
    expect(engine.getPreview().phase).toBe('drawing')

    engine.key('escape')
    expect(engine.getPreview().phase).toBe('idle')
    expect(store.getHome().dimensionLines).toHaveLength(0)
  })

  it('undo removes the created dimension line in one step (create+select compounded)', () => {
    const { engine, click, store } = setup()
    engine.setTool('dimensionLine')
    engine.setMagnetism(false)
    click(0, 0)
    click(150, 0)

    expect(store.getHome().dimensionLines).toHaveLength(1)
    expect(store.canUndo()).toBe(true)
    store.undo()
    expect(store.getHome().dimensionLines).toHaveLength(0)
    expect(store.canUndo()).toBe(false)
  })

  it('clicking the same point twice creates no zero-length dimension line', () => {
    const { engine, click, store } = setup()
    engine.setTool('dimensionLine')
    click(10, 10)
    click(10, 10)
    expect(store.getHome().dimensionLines).toHaveLength(0)
    expect(engine.getPreview().phase).toBe('idle')
  })

  it('re-arms after placing one, ready to draw another', () => {
    const { engine, click, store } = setup()
    engine.setTool('dimensionLine')
    engine.setMagnetism(false)
    click(0, 0)
    click(100, 0)
    click(0, 50)
    click(0, 200)

    expect(store.getHome().dimensionLines).toHaveLength(2)
  })
})

describe('label tool state machine', () => {
  it('one click places a label at that point with placeholder text', () => {
    const { engine, click, store } = setup()
    engine.setTool('label')
    click(40, 60)

    const home = store.getHome()
    expect(home.labels).toHaveLength(1)
    const label = home.labels[0]!
    expect(label.x).toBe(40)
    expect(label.y).toBe(60)
    expect(typeof label.text).toBe('string')
    expect(label.text.length).toBeGreaterThan(0)
    expect(home.selection).toEqual([label.id])
  })

  it('undo removes the created label in one step (create+select compounded)', () => {
    const { engine, click, store } = setup()
    engine.setTool('label')
    click(5, 5)

    expect(store.getHome().labels).toHaveLength(1)
    expect(store.canUndo()).toBe(true)
    store.undo()
    expect(store.getHome().labels).toHaveLength(0)
    expect(store.canUndo()).toBe(false)
  })

  it('each click places a new, independent label', () => {
    const { engine, click, store } = setup()
    engine.setTool('label')
    click(0, 0)
    click(100, 100)
    expect(store.getHome().labels).toHaveLength(2)
  })
})

describe('furniture rotation handle', () => {
  function makeFurniture() {
    const store = new HomeStore()
    const model = new HomeModel(store)
    const engine = new PlanEngine(model)
    engine.setTool('selection')
    const f = model.addFurniture({
      name: 'Sofa',
      x: 100,
      y: 200,
      width: 120,
      depth: 80,
      height: 80,
      elevation: 0,
      angleDeg: 0,
    })
    model.setSelection([f.id])
    const click = (x: number, y: number, rest: Omit<ClickInput, 'x' | 'y'> = {}) =>
      engine.click({ x, y, ...rest })
    const drag = (fromX: number, fromY: number, toX: number, toY: number, rest: Partial<DragInput> = {}) =>
      engine.drag({ fromX, fromY, toX, toY, ...rest })
    return { store, model, engine, click, drag, furniture: f }
  }

  it('hitTest near the handle returns furniture-rotate', () => {
    const { engine, furniture } = makeFurniture()
    const hp = furnitureRotationHandlePos(furniture)
    const hit = engine.hitTestPoint(hp)
    expect(hit).not.toBeNull()
    expect(hit!.kind).toBe('furniture-rotate')
    expect((hit as Extract<HitResult, { kind: 'furniture-rotate' }>).id).toBe(furniture.id)
  })

  it('dragging the handle east of center sets angleDeg to 90', () => {
    const { drag, store, furniture } = makeFurniture()
    const hp = furnitureRotationHandlePos(furniture)
    drag(hp.x, hp.y, furniture.x + 100, furniture.y)
    expect(store.getHome().furniture[0]!.angleDeg).toBe(90)
  })

  it('dragging the handle south of center sets angleDeg to 0', () => {
    const { drag, store, furniture } = makeFurniture()
    const hp = furnitureRotationHandlePos(furniture)
    drag(hp.x, hp.y, furniture.x, furniture.y - 100)
    expect(store.getHome().furniture[0]!.angleDeg).toBe(0)
  })

  it('the whole rotation drag is ONE undo step', () => {
    const { drag, store, furniture } = makeFurniture()
    const originalAngle = store.getHome().furniture[0]!.angleDeg
    const hp = furnitureRotationHandlePos(furniture)
    drag(hp.x, hp.y, furniture.x + 100, furniture.y)
    expect(store.getHome().furniture[0]!.angleDeg).toBe(90)
    expect(store.undo()).toBe(true)
    expect(store.getHome().furniture[0]!.angleDeg).toBe(originalAngle)
  })
})

describe('wall round-wall (arc) handle', () => {
  function makeWall() {
    const store = new HomeStore()
    const model = new HomeModel(store)
    const engine = new PlanEngine(model)
    engine.setTool('selection')
    const wall = model.addWall({
      xStart: 0,
      yStart: 0,
      xEnd: 100,
      yEnd: 0,
      thickness: NEW_WALL_THICKNESS_CM,
    })
    model.setSelection([wall.id])
    const click = (x: number, y: number, rest: Omit<ClickInput, 'x' | 'y'> = {}) =>
      engine.click({ x, y, ...rest })
    const drag = (fromX: number, fromY: number, toX: number, toY: number, rest: Partial<DragInput> = {}) =>
      engine.drag({ fromX, fromY, toX, toY, ...rest })
    return { store, model, engine, click, drag, wall }
  }

  it('hitTest near the midpoint of a selected wall returns wall-arc', () => {
    const { engine, store } = makeWall()
    const wall = store.getHome().walls[0]!
    expect(wall.arcExtent).toBeUndefined()
    const hp = wallArcHandlePos(wall)
    expect(hp.x).toBeCloseTo(50, 6)
    expect(hp.y).toBeCloseTo(0, 6)
    const hit = engine.hitTestPoint(hp)
    expect(hit).not.toBeNull()
    expect(hit!.kind).toBe('wall-arc')
    expect((hit as Extract<HitResult, { kind: 'wall-arc' }>).id).toBe(wall.id)
  })

  it('dragging the handle perpendicular sets a semicircular arcExtent', () => {
    const { drag, store } = makeWall()
    const wall = store.getHome().walls[0]!
    const hp = wallArcHandlePos(wall)
    // Perpendicular offset 50 on a 100-long chord => sagitta 50 => θ = 4·atan(2·50/100) = π.
    drag(hp.x, hp.y, 50, -50)
    expect(store.getHome().walls[0]!.arcExtent).toBeCloseTo(Math.PI, 6)
  })

  it('the whole arc drag is ONE undo step', () => {
    const { drag, store } = makeWall()
    const wall = store.getHome().walls[0]!
    const hp = wallArcHandlePos(wall)
    drag(hp.x, hp.y, 50, -50)
    expect(store.getHome().walls[0]!.arcExtent).toBeCloseTo(Math.PI, 6)
    expect(store.undo()).toBe(true)
    expect(store.getHome().walls[0]!.arcExtent).toBeUndefined()
  })
})

describe('furniture drag wall-snap', () => {
  function setupFurnitureWithWall() {
    const store = new HomeStore()
    const model = new HomeModel(store)
    const engine = new PlanEngine(model)
    engine.setTool('selection')

    model.addWall({
      xStart: 0,
      yStart: 0,
      xEnd: 500,
      yEnd: 0,
      thickness: NEW_WALL_THICKNESS_CM,
      height: 250,
    })

    const f = model.addFurniture({
      name: 'Chair',
      x: 200,
      y: 100,
      width: 60,
      depth: 60,
      height: 80,
      elevation: 0,
      angleDeg: 0,
    })

    const drag = (fromX: number, fromY: number, toX: number, toY: number) =>
      engine.drag({ fromX, fromY, toX, toY })
    return { store, model, engine, drag, furniture: f }
  }

  it('dragging near a wall snaps furniture flush against it', () => {
    const { drag, store, furniture } = setupFurnitureWithWall()
    const origX = furniture.x
    const origY = furniture.y

    drag(origX, origY, origX, 20)

    const placed = store.getHome().furniture[0]!
    expect(placed.y).toBeCloseTo(30, 0)
    expect(placed.angleDeg).toBe(0)
  })

  it('dragging far from any wall applies raw delta unchanged', () => {
    const { drag, store, furniture } = setupFurnitureWithWall()
    const origX = furniture.x
    const origY = furniture.y

    drag(origX, origY, origX + 100, origY + 300)

    const placed = store.getHome().furniture[0]!
    expect(placed.x).toBeCloseTo(origX + 100)
    expect(placed.y).toBeCloseTo(origY + 300)
    expect(placed.angleDeg).toBe(0)
  })

  it('drag-snap is ONE undo step', () => {
    const { drag, store, furniture } = setupFurnitureWithWall()
    const origX = furniture.x
    const origY = furniture.y

    drag(origX, origY, origX, 20)

    expect(store.getHome().furniture[0]!.y).toBeCloseTo(30, 0)
    expect(store.undo()).toBe(true)
    const reverted = store.getHome().furniture[0]!
    expect(reverted.x).toBe(origX)
    expect(reverted.y).toBe(origY)
  })

  it('magnetism disabled prevents snap even near a wall', () => {
    const { engine, drag, store, furniture } = setupFurnitureWithWall()
    engine.setMagnetism(false)
    const origX = furniture.x
    const origY = furniture.y

    drag(origX, origY, origX, 20)

    const placed = store.getHome().furniture[0]!
    expect(placed.y).toBeCloseTo(20, 0)
    expect(placed.angleDeg).toBe(0)
  })
})

describe('wall endpoint drag magnetism', () => {
  function makeTwoParallelWalls() {
    const s = setup()
    s.engine.setTool('wall')
    s.engine.setMagnetism(false)
    s.click(0, 0)
    s.click(100, 0)
    s.engine.key('escape')
    s.click(0, 40)
    s.click(100, 40)
    s.engine.key('escape')
    s.engine.setTool('selection')
    return s
  }

  it('snaps a dragged wall endpoint onto another wall endpoint', () => {
    const s = makeTwoParallelWalls()
    s.engine.setMagnetism(true)
    const { drag, store } = s
    // Wall A: (0,0)-(100,0), wall B: (0,40)-(100,40). Drag A's end near B's start.
    drag(100, 0, 1, 38)
    const a = store.getHome().walls.find((w) => w.xStart === 0 && w.yStart === 0)!
    const b = store.getHome().walls.find((w) => w.xStart === 0 && w.yStart === 40)!
    expect([a.xEnd, a.yEnd]).toEqual([0, 40])
    expect([b.xStart, b.yStart]).toEqual([0, 40])
  })

  it('magnetism off keeps the raw delta even near another endpoint', () => {
    const s = makeTwoParallelWalls()
    const { drag, store } = s
    drag(100, 0, 1, 38)
    const a = store.getHome().walls.find((w) => w.xStart === 0 && w.yStart === 0)!
    expect([a.xEnd, a.yEnd]).toEqual([1, 38])
  })

  it('magnetized drag of a shared join is ONE undo step for every connected wall', () => {
    const s = setup()
    s.engine.setTool('wall')
    s.engine.setMagnetism(false)
    s.click(0, 0)
    s.click(100, 0)
    s.click(100, 80)
    s.engine.key('escape')
    s.engine.setTool('selection')
    s.engine.setMagnetism(true)
    const { drag, store } = s
    const before = wallGraph(store)
    // Two walls joined at (100,0). Magnetized drag moves the whole join.
    drag(100, 0, 140, 10)
    const w0 = store.getHome().walls[0]!
    const w1 = store.getHome().walls[1]!
    // Both walls still share one point, on the 15° ray from the hit wall's
    // opposite anchor (x≈140, y small) — independent of which wall was hit.
    expect([w0.xEnd, w0.yEnd]).toEqual([w1.xStart, w1.yStart])
    expect(Math.abs(w0.xEnd - 140)).toBeLessThan(1)
    expect(Math.abs(w0.yEnd)).toBeLessThan(10)
    // Exactly one undo reverts the drag; the next reverts the wall creation.
    expect(store.undo()).toBe(true)
    expect(wallGraph(store)).toEqual(before)
    expect(store.undo()).toBe(true)
    expect(store.getHome().walls).toHaveLength(0)
    expect(store.canUndo()).toBe(false)
  })
})

describe('room vertex drag magnetism', () => {
  it('snaps a dragged room corner onto a nearby wall endpoint', () => {
    const s = setup()
    s.engine.setTool('wall')
    s.engine.setMagnetism(false)
    s.click(200, 0)
    s.click(200, 150)
    s.engine.key('escape')
    s.engine.setTool('room')
    s.engine.setMagnetism(false)
    s.click(0, 0)
    s.click(50, 0)
    s.click(50, 50)
    s.click(0, 50)
    s.click(25, 25, { dbl: true })
    s.engine.setTool('selection')
    s.engine.setMagnetism(true)
    const { drag, store } = s
    // Point[1]=(50,0) dragged within PIXEL_MARGIN of wall start (200,0).
    drag(50, 0, 197, 0)
    expect(store.getHome().rooms[0]!.points[1]).toEqual([200, 0])
  })

  it('snaps a dragged room corner onto another room vertex', () => {
    const s = setup()
    s.engine.setTool('room')
    s.engine.setMagnetism(false)
    s.click(0, 0)
    s.click(200, 0)
    s.click(200, 150)
    s.click(0, 150)
    s.click(50, 75, { dbl: true })
    s.engine.setTool('selection')
    s.engine.setMagnetism(true)
    const { drag, store } = s
    // Point[2]=(200,150) dragged within PIXEL_MARGIN of point[1]=(200,0).
    drag(200, 150, 198, -2)
    expect(store.getHome().rooms[0]!.points[2]).toEqual([200, 0])
  })

  it('away from any corner, falls back to 15° angle magnetism from the previous vertex', () => {
    const s = setup()
    s.engine.setTool('room')
    s.engine.setMagnetism(false)
    s.click(0, 0)
    s.click(200, 0)
    s.click(200, 150)
    s.click(0, 150)
    s.click(50, 75, { dbl: true })
    s.engine.setTool('selection')
    s.engine.setMagnetism(true)
    const { drag, store } = s
    // Point[1]=(200,0) dragged to (240,25): ~6° off the 0° ray from (0,0).
    drag(200, 0, 240, 25)
    expect(store.getHome().rooms[0]!.points[1]).toEqual([241, 0])
  })
})

describe('marquee selection', () => {
  it('selects walls, rooms, furniture inside the rectangle', () => {
    const s = setup()
    const { model, store, drag, click } = s
    // Add walls
    const w1 = model.addWall({ xStart: 0, yStart: 0, xEnd: 100, yEnd: 0, thickness: 10, height: 250 })
    const w2 = model.addWall({ xStart: 200, yStart: 200, xEnd: 300, yEnd: 200, thickness: 10, height: 250 })
    // Add a room
    const r1 = model.addRoom([[50, 50], [150, 50], [150, 150], [50, 150]])
    // Add furniture
    const f1 = model.addFurniture({ name: 'chair', x: 75, y: 75, width: 40, depth: 40, height: 80, elevation: 0, angleDeg: 0 })
    // w2 is outside the marquee rectangle
    drag(-10, -10, 160, 160)
    // Click to end marquee drag and apply selection
    click(500, 500)
    const sel = new Set(store.getHome().selection)
    expect(sel.has(w1.id)).toBe(true)
    expect(sel.has(r1.id)).toBe(true)
    expect(sel.has(f1.id)).toBe(true)
    expect(sel.has(w2.id)).toBe(false)
  })

  it('clears selection when marquee covers nothing', () => {
    const s = setup()
    const { model, store, drag, click } = s
    const w1 = model.addWall({ xStart: 0, yStart: 0, xEnd: 100, yEnd: 0, thickness: 10, height: 250 })
    model.setSelection([w1.id])
    expect(store.getHome().selection).toContain(w1.id)
    // Marquee in empty area
    drag(500, 500, 600, 600)
    // Click to end marquee drag and apply selection (empty marquee clears selection)
    click(500, 500)
    expect(store.getHome().selection).toEqual([])
  })

  it('union with existing selection when shift is held', () => {
    const s = setup()
    const { model, store, drag, click } = s
    const w1 = model.addWall({ xStart: 0, yStart: 0, xEnd: 50, yEnd: 0, thickness: 10, height: 250 })
    const w2 = model.addWall({ xStart: 200, yStart: 200, xEnd: 300, yEnd: 200, thickness: 10, height: 250 })
    model.setSelection([w1.id])
    // Marquee covers only w2 area
    drag(190, 190, 310, 210, { shift: true })
    // Click to end marquee drag and apply selection
    click(500, 500)
    const sel = new Set(store.getHome().selection)
    expect(sel.has(w1.id)).toBe(true)
    expect(sel.has(w2.id)).toBe(true)
  })

  it('reports marquee bounds in preview during drag', () => {
    const s = setup()
    const { model, drag, engine } = s
    model.addWall({ xStart: 0, yStart: 0, xEnd: 100, yEnd: 0, thickness: 10, height: 250 })
    drag(-10, -10, 110, 10)
    const preview = engine.getPreview()
    expect(preview.marquee).not.toBeNull()
    expect(preview.marquee!.from).toEqual({ x: -10, y: -10 })
    expect(preview.marquee!.to).toEqual({ x: 110, y: 10 })
  })

  it('clears marquee on next click', () => {
    const s = setup()
    const { model, drag, engine, click } = s
    model.addWall({ xStart: 0, yStart: 0, xEnd: 100, yEnd: 0, thickness: 10, height: 250 })
    drag(-10, -10, 110, 10)
    expect(engine.getPreview().marquee).not.toBeNull()
    click(500, 500)
    expect(engine.getPreview().marquee).toBeNull()
  })

  it('selects dimension lines inside the marquee', () => {
    const s = setup()
    const { model, store, drag, click } = s
    engine_setTool(s, 'dimensionLine')
    const d1 = model.addDimensionLine({ xStart: 10, yStart: 10, xEnd: 90, yEnd: 10, offset: 0 })
    const d2 = model.addDimensionLine({ xStart: 200, yStart: 200, xEnd: 300, yEnd: 200, offset: 0 })
    engine_setTool(s, 'selection')
    drag(0, 0, 100, 20)
    click(500, 500)
    const sel = new Set(store.getHome().selection)
    expect(sel.has(d1.id)).toBe(true)
    expect(sel.has(d2.id)).toBe(false)
  })

  it('selects labels inside the marquee', () => {
    const s = setup()
    const { model, store, drag, click } = s
    engine_setTool(s, 'label')
    const l1 = model.addLabel({ x: 50, y: 50, text: 'Kitchen' })
    const l2 = model.addLabel({ x: 250, y: 250, text: 'Garage' })
    engine_setTool(s, 'selection')
    drag(0, 0, 100, 100)
    click(500, 500)
    const sel = new Set(store.getHome().selection)
    expect(sel.has(l1.id)).toBe(true)
    expect(sel.has(l2.id)).toBe(false)
  })

  it('marquee drag over multiple items selects all; empty marquee clears unless shift', () => {
    const s = setup()
    const { model, store, drag, click } = s
    const w1 = model.addWall({ xStart: 0, yStart: 0, xEnd: 100, yEnd: 0, thickness: 10, height: 250 })
    const w2 = model.addWall({ xStart: 50, yStart: 50, xEnd: 150, yEnd: 50, thickness: 10, height: 250 })
    const r1 = model.addRoom([[25, 25], [75, 25], [75, 75], [25, 75]])
    const f1 = model.addFurniture({ name: 'table', x: 50, y: 50, width: 40, depth: 40, height: 80, elevation: 0, angleDeg: 0 })
    const d1 = model.addDimensionLine({ xStart: 10, yStart: 10, xEnd: 90, yEnd: 10, offset: 0 })
    const l1 = model.addLabel({ x: 30, y: 30, text: 'Test' })

    // Marquee covering all items
    drag(-10, -10, 200, 200)
    click(500, 500)
    const sel = new Set(store.getHome().selection)
    expect(sel.has(w1.id)).toBe(true)
    expect(sel.has(w2.id)).toBe(true)
    expect(sel.has(r1.id)).toBe(true)
    expect(sel.has(f1.id)).toBe(true)
    expect(sel.has(d1.id)).toBe(true)
    expect(sel.has(l1.id)).toBe(true)

    // Empty marquee without shift clears selection
    drag(500, 500, 600, 600)
    click(500, 500)
    expect(store.getHome().selection).toEqual([])

    // Re-select w1
    model.setSelection([w1.id])
    expect(store.getHome().selection).toContain(w1.id)

    // Empty marquee with shift held is a no-op union (keeps existing selection)
    drag(500, 500, 600, 600, { shift: true })
    click(500, 500)
    expect(store.getHome().selection).toContain(w1.id)
  })
})

function engine_setTool(s: ReturnType<typeof setup>, tool: 'selection' | 'wall' | 'room' | 'dimensionLine' | 'label' | 'panning'): void {
  s.engine.setTool(tool)
}
