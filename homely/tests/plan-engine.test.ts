import { describe, expect, it } from 'vitest'
import { HomeModel, NEW_WALL_THICKNESS_CM } from '../src/core/model'
import { HomeStore } from '../src/core/store'
import {
  PlanEngine,
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
