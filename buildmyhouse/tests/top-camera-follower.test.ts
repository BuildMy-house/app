import { describe, expect, it } from 'vitest'
import { NEW_WALL_THICKNESS_CM, HomeModel } from '../src/core/model'
import { HomeStore } from '../src/core/store'
import {
  computeHomeBounds,
  wallOutlinePoints,
  type Bounds3D,
} from '../src/core/top-camera-follower'
import { PlanEngine } from '../src/plan/engine'

const DEFAULT_TOP = { x: 50, y: 1050, z: 1010, yawDeg: 180, pitchDeg: 45, fovDeg: 63 }

function expectCamera(
  store: HomeStore,
  x: number,
  y: number,
  z: number,
  precision = 6,
): void {
  const top = store.getHome().cameras.top
  expect(top.x).toBeCloseTo(x, precision)
  expect(top.y).toBeCloseTo(y, precision)
  expect(top.z).toBeCloseTo(z, precision)
}

/** Contract table driven through the real wall tool (current thickness constant). */
describe('top camera follower — create_room script via PlanEngine', () => {
  function script(): { store: HomeStore; model: HomeModel; plan: PlanEngine } {
    const store = new HomeStore()
    const model = new HomeModel(store)
    const plan = new PlanEngine(model)
    plan.setMagnetism(false)
    plan.setTool('wall')
    return { store, model, plan }
  }

  it('keeps the fresh-home default camera on an empty-home content change', () => {
    const { store, model } = script()
    model.setName('untouched')
    expectCamera(store, DEFAULT_TOP.x, DEFAULT_TOP.y, DEFAULT_TOP.z, 9)
  })

  it('reproduces the driver-observed positions for the 4-wall script', () => {
    const { store, plan } = script()

    plan.click({ x: 100, y: 100 })
    plan.click({ x: 600, y: 100 })
    plan.key('escape') // first wall commits
    expectCamera(store, 350, 1100, 1125)

    plan.click({ x: 600, y: 100 }) // snaps onto the free end
    plan.click({ x: 600, y: 400 })
    plan.key('escape')
    // Miter join pushes the outer corner out by half thickness, shifting the
    // L-shaped bounds center off-axis (contract row 3 analog at t=7.5):
    // x-center (100 .. 600+t/2), y-center ((100-t/2) .. 400).
    const half = NEW_WALL_THICKNESS_CM / 2
    expectCamera(store, (100 + 600 + half) / 2, (100 - half + 400) / 2 + 1000, 1125)

    plan.click({ x: 600, y: 400 })
    plan.click({ x: 100, y: 400 })
    plan.key('escape')

    plan.click({ x: 100, y: 400 })
    plan.click({ x: 100, y: 100, dbl: true }) // loop closes, fourth wall commits
    expectCamera(store, 350, 1250, 1125)

    const top = store.getHome().cameras.top
    expect(top.yawDeg).toBe(180)
    expect(top.pitchDeg).toBe(45)
    expect(top.fovDeg).toBe(63)
    expect(store.getHome().walls).toHaveLength(4)
  })
})

/** Exact numeric verification table from docs/behaviours/sh3d-camera-and-export.md §1
 * (driver thickness 7 — B8 owns aligning NEW_WALL_THICKNESS_CM; walls pushed directly). */
describe('top camera follower — contract verification table at driver thickness', () => {
  const T = 7
  function pushWall(
    store: HomeStore,
    id: string,
    xStart: number,
    yStart: number,
    xEnd: number,
    yEnd: number,
  ): void {
    store.apply((h) => {
      h.walls.push({ id, xStart, yStart, xEnd, yEnd, thickness: T })
    })
  }

  it('matches all four rows exactly', () => {
    const store = new HomeStore()
    expectCamera(store, 50, 1050, 1010)

    pushWall(store, 'w1', 100, 100, 600, 100)
    expectCamera(store, 350, 1100, 1125)

    pushWall(store, 'w2', 600, 100, 600, 400)
    expectCamera(store, 351.75, 1248.25, 1125)

    pushWall(store, 'w3', 600, 400, 100, 400)
    pushWall(store, 'w4', 100, 400, 100, 100)
    expectCamera(store, 350, 1250, 1125)
  })
})

describe('top camera follower — triggers and inert paths', () => {
  it('does not fight explicit camera moves (set_camera parity)', () => {
    const store = new HomeStore()
    const model = new HomeModel(store)
    model.moveTopCamera({ x: 999, y: 777 })
    const moved = store.getHome().cameras.top
    expect(moved.x).toBe(999)
    expect(moved.y).toBe(777)

    model.addWall({ xStart: 100, yStart: 100, xEnd: 600, yEnd: 100, thickness: 7.5 })
    const refollowed = store.getHome().cameras.top
    // Orbits the new center preserving the distance from the parked position
    // to the PREVIOUS bounds center (empty home default box).
    expect(refollowed.x).toBeCloseTo(350, 6)
    expect(refollowed.y).not.toBeCloseTo(1100, 3)
    const expectedDistance = Math.hypot(999 - 50, 777 - 50, 1010 - 10)
    expect(Math.hypot(refollowed.x - 350, refollowed.y - 100, refollowed.z - 125)).toBeCloseTo(
      expectedDistance,
      4,
    )
  })

  it('observer camera moves never trigger the follower', () => {
    const store = new HomeStore()
    const model = new HomeModel(store)
    model.moveObserverCamera({ x: 123, y: 77 })
    expectCamera(store, DEFAULT_TOP.x, DEFAULT_TOP.y, DEFAULT_TOP.z, 9)
  })

  it('undo steps restore followed cameras stepwise back to identity', () => {
    const store = new HomeStore()
    const model = new HomeModel(store)
    const plan = new PlanEngine(model)
    plan.setMagnetism(false)
    plan.setTool('wall')
    plan.click({ x: 100, y: 100 })
    plan.click({ x: 600, y: 100 })
    plan.key('escape')
    expectCamera(store, 350, 1100, 1125)

    expect(store.undo()).toBe(true)
    expectCamera(store, DEFAULT_TOP.x, DEFAULT_TOP.y, DEFAULT_TOP.z, 9)

    expect(store.redo()).toBe(true)
    expectCamera(store, 350, 1100, 1125)
  })

  it('resetToEmpty returns the camera to the fresh-home position', () => {
    const store = new HomeStore()
    const model = new HomeModel(store)
    model.addWallChain([
      { xStart: 100, yStart: 100, xEnd: 600, yEnd: 100 },
      { xStart: 600, yStart: 100, xEnd: 600, yEnd: 400 },
    ])
    expect(store.getHome().cameras.top.x).not.toBe(50)
    store.resetToEmpty()
    expectCamera(store, DEFAULT_TOP.x, DEFAULT_TOP.y, DEFAULT_TOP.z, 9)
  })
})

describe('home bounds computation', () => {
  const boundsCenter = (b: Bounds3D): [number, number, number] => [
    (b.minX + b.maxX) / 2,
    (b.minY + b.maxY) / 2,
    (b.minZ + b.maxZ) / 2,
  ]

  it('empty home yields the default 100x100x20 box', () => {
    const b = computeHomeBounds(new HomeStore().getHome())
    expect([b.minX, b.minY, b.minZ, b.maxX, b.maxY, b.maxZ]).toEqual([0, 0, 0, 100, 100, 20])
  })

  it('rooms contribute points with maxZ 20', () => {
    const store = new HomeStore()
    const model = new HomeModel(store)
    model.addRoom([
      [0, 0],
      [200, 0],
      [200, 100],
      [0, 100],
    ])
    const b = computeHomeBounds(store.getHome())
    expect(boundsCenter(b)).toEqual([100, 50, 10])
  })

  it('expands thin wall bounds to the minimum box symmetrically', () => {
    const store = new HomeStore()
    store.apply((h) => {
      h.walls.push({ id: 'w', xStart: 50, yStart: 50, xEnd: 60, yEnd: 50, thickness: 7.5 })
    })
    const b = computeHomeBounds(store.getHome())
    expect([b.minX, b.maxX]).toEqual([5, 105])
    expect([b.minY, b.maxY]).toEqual([0, 100])
    expect([b.minZ, b.maxZ]).toEqual([0, 250])
  })

  it('uses heightAtEnd and level elevation for wall maxZ', () => {
    const store = new HomeStore()
    const model = new HomeModel(store)
    const level = model.addLevel({
      name: 'L1',
      elevation: 100,
      floorThickness: 10,
      height: 250,
      visible: true,
      viewable: true,
    })
    model.addWall({
      xStart: 0,
      yStart: 0,
      xEnd: 100,
      yEnd: 0,
      thickness: 7.5,
      height: 200,
      heightAtEnd: 300,
      levelRef: level.id,
    })
    const b = computeHomeBounds(store.getHome())
    expect(b.maxZ).toBe(400) // level elevation 100 + heightAtEnd 300
    expect(b.minZ).toBe(0)
  })

  it('ignores invisible furniture and items on non-visible levels', () => {
    const store = new HomeStore()
    const model = new HomeModel(store)
    model.addFurniture({
      name: 'hidden',
      x: 5000,
      y: 5000,
      angleDeg: 0,
      width: 50,
      depth: 50,
      height: 50,
      elevation: 0,
      visible: false,
    })
    const level = model.addLevel({
      name: 'attic',
      elevation: 0,
      floorThickness: 0,
      height: 250,
      visible: false,
      viewable: false,
    })
    model.addFurniture({
      name: 'buried',
      x: 4000,
      y: 4000,
      angleDeg: 0,
      width: 50,
      depth: 50,
      height: 50,
      elevation: 0,
      levelRef: level.id,
    })
    expect(computeHomeBounds(store.getHome())).toEqual({
      minX: 0,
      minY: 0,
      minZ: 0,
      maxX: 100,
      maxY: 100,
      maxZ: 20,
    })
  })

  it('dimension lines contribute endpoints clamped to maxZ >= 20', () => {
    const store = new HomeStore()
    const model = new HomeModel(store)
    model.addDimensionLine({ xStart: 10, yStart: 10, xEnd: 210, yEnd: 10, offset: 0, elevationEnd: 30 })
    const b = computeHomeBounds(store.getHome())
    expect(boundsCenter(b)).toEqual([110, 10, 15])
  })
})

describe('wall thick-polygon miters', () => {
  it('extends the joined end of an L-junction to the outer corner', () => {
    const w1 = { id: 'a', xStart: 100, yStart: 100, xEnd: 600, yEnd: 100, thickness: 7 }
    const w2 = { id: 'b', xStart: 600, yStart: 100, xEnd: 600, yEnd: 400, thickness: 7 }
    const pts = wallOutlinePoints(w1, [w1, w2])
    const xs = pts.map((p) => p[0])
    const ys = pts.map((p) => p[1])
    expect(Math.min(...xs)).toBe(100) // free start cap stays flat
    expect(Math.max(...xs)).toBe(603.5) // mitered end reaches the outer corner
    expect(Math.min(...ys)).toBe(96.5)
    expect(Math.max(...ys)).toBe(103.5)
  })

  it('skips parallel head-on joins without extending caps', () => {
    const a = { id: 'a', xStart: -100, yStart: 0, xEnd: 0, yEnd: 0, thickness: 10 }
    const b = { id: 'b', xStart: 100, yStart: 0, xEnd: 0, yEnd: 0, thickness: 10 }
    // Collinear walls: side lines never intersect, caps butt flat.
    expect(wallOutlinePoints(a, [a, b]).flat()).toEqual([-100, 5, 0, 5, 0, -5, -100, -5])
    expect(wallOutlinePoints(b, [a, b]).flat()).toEqual([100, -5, 0, -5, 0, 5, 100, 5])
  })
})

describe('wall arc outlines', () => {
  it('arcExtent: 0 produces an outline identical to a straight wall', () => {
    const straight = { id: 's', xStart: 0, yStart: 0, xEnd: 100, yEnd: 0, thickness: 7 }
    const arced = { id: 'a', xStart: 0, yStart: 0, xEnd: 100, yEnd: 0, thickness: 7, arcExtent: 0 }
    expect(wallOutlinePoints(arced, [arced]).flat()).toEqual(
      wallOutlinePoints(straight, [straight]).flat(),
    )
  })

  it('a 90° arc bulges CCW by the sagitta on a wall along +x', () => {
    const wall = { id: 'a', xStart: 0, yStart: 0, xEnd: 100, yEnd: 0, thickness: 7, arcExtent: Math.PI / 2 }
    const pts = wallOutlinePoints(wall, [wall])
    expect(pts.length).toBeGreaterThan(4)
    const ys = pts.map((p) => p[1])
    const sagitta = 50 * Math.tan(Math.PI / 8)
    // CCW bulge points in -y for a +x wall: outline bottom = center.y - exteriorRadius.
    // The polyline samples a finite number of arc angles, so the sampled apex
    // undercuts the exact sagitta by less than one segment (~0.19 for this arc).
    expect(Math.min(...ys)).toBeCloseTo(-(sagitta + 3.5), 0)
  })

  it('a negative arcExtent bulges the opposite way', () => {
    const wall = { id: 'a', xStart: 0, yStart: 0, xEnd: 100, yEnd: 0, thickness: 7, arcExtent: -Math.PI / 2 }
    const pts = wallOutlinePoints(wall, [wall])
    const ys = pts.map((p) => p[1])
    const sagitta = 50 * Math.tan(Math.PI / 8)
    expect(Math.max(...ys)).toBeCloseTo(sagitta + 3.5, 0)
  })
})

describe('wall arc mitering (M53c)', () => {
  const THICKNESS = 10

  function capPoints(outline: [number, number][], atStart: boolean): [[number, number], [number, number]] {
    const i0 = atStart ? 0 : Math.floor(outline.length / 2) - 1
    const i1 = atStart ? outline.length - 1 : Math.floor(outline.length / 2)
    return [outline[i0]!, outline[i1]!]
  }

  it('straight wall meeting arc wall (CCW) shares mitered corners at joint', () => {
    const straight = { id: 's', xStart: 0, yStart: 0, xEnd: 100, yEnd: 0, thickness: THICKNESS }
    const arc = { id: 'a', xStart: 100, yStart: 0, xEnd: 200, yEnd: 0, thickness: THICKNESS, arcExtent: Math.PI / 2 }

    const sPts = wallOutlinePoints(straight, [straight, arc])
    const aPts = wallOutlinePoints(arc, [straight, arc])

    const [sEndL, sEndR] = capPoints(sPts, false)
    const [aStartExt, aStartInt] = capPoints(aPts, true)

    expect(sEndL[0]).toBeCloseTo(aStartInt[0], 6)
    expect(sEndL[1]).toBeCloseTo(aStartInt[1], 6)
    expect(sEndR[0]).toBeCloseTo(aStartExt[0], 6)
    expect(sEndR[1]).toBeCloseTo(aStartExt[1], 6)
  })

  it('straight wall meeting arc wall (CW) shares mitered corners at joint', () => {
    const straight = { id: 's', xStart: 0, yStart: 0, xEnd: 100, yEnd: 0, thickness: THICKNESS }
    const arc = { id: 'a', xStart: 100, yStart: 0, xEnd: 200, yEnd: 0, thickness: THICKNESS, arcExtent: -Math.PI / 2 }

    const sPts = wallOutlinePoints(straight, [straight, arc])
    const aPts = wallOutlinePoints(arc, [straight, arc])

    const [sEndL, sEndR] = capPoints(sPts, false)
    const [aStartExt, aStartInt] = capPoints(aPts, true)

    expect(sEndL[0]).toBeCloseTo(aStartInt[0], 6)
    expect(sEndL[1]).toBeCloseTo(aStartInt[1], 6)
    expect(sEndR[0]).toBeCloseTo(aStartExt[0], 6)
    expect(sEndR[1]).toBeCloseTo(aStartExt[1], 6)
  })

  it('arc wall meeting arc wall (both CCW) shares mitered corners at joint', () => {
    const arc1 = { id: 'a1', xStart: 0, yStart: 0, xEnd: 100, yEnd: 0, thickness: THICKNESS, arcExtent: Math.PI / 2 }
    const arc2 = { id: 'a2', xStart: 100, yStart: 0, xEnd: 200, yEnd: 0, thickness: THICKNESS, arcExtent: Math.PI / 2 }

    const a1Pts = wallOutlinePoints(arc1, [arc1, arc2])
    const a2Pts = wallOutlinePoints(arc2, [arc1, arc2])

    const [a1EndExt, a1EndInt] = capPoints(a1Pts, false)
    const [a2StartExt, a2StartInt] = capPoints(a2Pts, true)

    expect(a1EndExt[0]).toBeCloseTo(a2StartInt[0], 6)
    expect(a1EndExt[1]).toBeCloseTo(a2StartInt[1], 6)
    expect(a1EndInt[0]).toBeCloseTo(a2StartExt[0], 6)
    expect(a1EndInt[1]).toBeCloseTo(a2StartExt[1], 6)
  })

  it('arc wall meeting straight wall in L-junction shares mitered corners', () => {
    const arc = { id: 'a', xStart: 0, yStart: 0, xEnd: 100, yEnd: 0, thickness: THICKNESS, arcExtent: Math.PI / 2 }
    const straight = { id: 's', xStart: 100, yStart: 0, xEnd: 100, yEnd: 100, thickness: THICKNESS }

    const aPts = wallOutlinePoints(arc, [arc, straight])
    const sPts = wallOutlinePoints(straight, [arc, straight])

    const [aEndExt, aEndInt] = capPoints(aPts, false)
    const [sStartL, sStartR] = capPoints(sPts, true)

    expect(aEndExt[0]).toBeCloseTo(sStartR[0], 6)
    expect(aEndExt[1]).toBeCloseTo(sStartR[1], 6)
    expect(aEndInt[0]).toBeCloseTo(sStartL[0], 6)
    expect(aEndInt[1]).toBeCloseTo(sStartL[1], 6)
  })
})
