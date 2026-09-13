import Ajv2020 from 'ajv/dist/2020'
import { describe, expect, it } from 'vitest'
import schemaJson from '../../docs/schema/home-project.schema.json'
import createRoomGolden from '../../equivalence/scenarios/slice/goldens/create_room.expected-state.json'
import type { LensName, NormalizedHomeState } from '../src/core/home'
import { normalizeAngle, roundHalfEven, serializeHome } from '../src/core/export'
import { createEmptyHome } from '../src/core/home'
import { HomeModel } from '../src/core/model'
import { HomeStore } from '../src/core/store'

const ajv = new Ajv2020({ strict: false, allErrors: true })
const validate = ajv.compile(schemaJson)

function assertValid(state: unknown): void {
  const ok = validate(state)
  if (!ok) throw new Error(ajv.errorsText(validate.errors))
  expect(ok).toBe(true)
}

function expectInvalid(state: unknown, fragment: string): void {
  const ok = validate(state)
  expect(ok).toBe(false)
  expect(ajv.errorsText(validate.errors)).toContain(fragment)
}

describe('roundHalfEven', () => {
  it('rounds to 3 decimals with ties-to-even', () => {
    expect(roundHalfEven(1.2345)).toBeCloseTo(1.234, 10)
    expect(roundHalfEven(1.2335)).toBeCloseTo(1.234, 10)
    expect(roundHalfEven(2.5)).toBe(2.5) // exact at 3dp already
    expect(roundHalfEven(0.123456)).toBeCloseTo(0.123, 10)
    expect(roundHalfEven(0.12355)).toBeCloseTo(0.124, 10)
  })

  it('handles negatives symmetrically', () => {
    expect(roundHalfEven(-1.2345)).toBeCloseTo(-1.234, 10)
    expect(roundHalfEven(-1.2355)).toBeCloseTo(-1.236, 10)
  })

  it('resolves binary-float near-ties as exact decimal ties', () => {
    // 8.1855 * 1000 === 8185.499999... in doubles; decimal half-even says 8186.
    expect(roundHalfEven(8.1855)).toBe(8.186)
    expect(roundHalfEven(-8.1865)).toBe(-8.186)
    expect(roundHalfEven(2.5005)).toBe(2.5) // 2500.5 → even 2500
    expect(roundHalfEven(2.5015)).toBe(2.502) // 2501.5 → even 2502
  })
})

describe('normalizeAngle', () => {
  it('maps into [-180, 180) so yaw pi exports as -180 (driver golden)', () => {
    expect(normalizeAngle(180)).toBe(-180)
    expect(normalizeAngle(-180)).toBe(-180)
    expect(normalizeAngle(185)).toBe(-175)
    expect(normalizeAngle(-185)).toBe(175)
    expect(normalizeAngle(540)).toBe(-180)
    expect(normalizeAngle(0)).toBe(0)
    expect(normalizeAngle(315)).toBe(-45)
    // values strictly inside the range pass through (modulo float noise is
    // cleaned up by the round3 that always follows)
    expect(normalizeAngle(179.9)).toBeCloseTo(179.9, 10)
    expect(normalizeAngle(-179.9)).toBeCloseTo(-179.9, 10)
    expect(normalizeAngle(45.5)).toBe(45.5)
  })
})

describe('serializeHome determinism', () => {
  it('empty home exports SH3D golden defaults (Thimphu zone, ids, wallsAlpha 0)', () => {
    const home = createEmptyHome('Asia/Thimphu')
    const out = serializeHome(home)
    // yaw 180 (pi) wraps to -180 on the wire — driver toDeg() parity
    expect(out.cameras.top).toEqual({
      id: 'camera-top-1',
      x: 50,
      y: 1050,
      z: 1010,
      yawDeg: -180,
      pitchDeg: 45,
      fovDeg: 63,
      lens: 'PINHOLE',
    })
    expect(out.cameras.observer).toEqual({
      id: 'camera-observer-1',
      x: 50,
      y: 50,
      z: 170,
      yawDeg: -45,
      pitchDeg: 11.25,
      fovDeg: 63,
      lens: 'PINHOLE',
      fixedSize: false,
    })
    expect(out.compass).toEqual({
      x: -100,
      y: 50,
      diameter: 100,
      northDirectionDeg: 0,
      latitudeRad: 0.48, // round3(toRadians(27.4833333f)) — golden
      longitudeRad: 1.564, // round3(toRadians(89.6f)) — golden
      visible: true,
    })
    expect(out.environment.wallsAlpha).toBe(0)
    expect(out.walls).toEqual([])
    expect(out.selection).toEqual([])
    expect(out.capabilities).toEqual({ canUndo: false, canRedo: false })
  })

  it('two serializations of equivalent state are byte-identical', () => {
    const build = (): { store: HomeStore; model: HomeModel } => {
      const store = new HomeStore()
      const model = new HomeModel(store)
      model.addWall({ xStart: 10.0000004, yStart: 0, xEnd: 400.987654321, yEnd: 0, thickness: 10.5 })
      model.addFurniture({
        name: 'chair',
        x: 33.3333333,
        y: -12.7,
        angleDeg: 185,
        width: 45,
        depth: 45,
        height: 90,
        elevation: 0,
      })
      return { store, model }
    }
    const a = serializeHome(build().store.getHome())
    const b = serializeHome(build().store.getHome())
    expect(JSON.stringify(a)).toBe(JSON.stringify(b))
    // rounding actually applied
    const wall = a.walls[0]
    expect(wall?.xEnd).toBe(400.988)
    const furniture = a.furniture[0]
    expect(furniture?.angleDeg).toBeCloseTo(-175, 6)
  })

  it('rounds furniture length fields (width/depth/height) half-even to 3 decimals', () => {
    const store = new HomeStore()
    const model = new HomeModel(store)
    model.addFurniture({
      name: 'odd-chair',
      x: 0,
      y: 0,
      angleDeg: 0,
      width: 50.12345,
      depth: 20.9876,
      height: 90.12951,
      elevation: 2.50004,
    })
    const f = serializeHome(store.getHome()).furniture[0]
    expect(f?.width).toBe(50.123)
    expect(f?.depth).toBe(20.988)
    expect(f?.height).toBe(90.13)
    expect(f?.elevation).toBe(2.5)
  })

  it('normalizes furniture pitch/roll and modelRotationDeg like all degree angles', () => {
    const store = new HomeStore()
    const model = new HomeModel(store)
    model.addFurniture({
      name: 'tilted',
      x: 0,
      y: 0,
      angleDeg: 0,
      width: 10,
      depth: 10,
      height: 10,
      elevation: 0,
      pitchDeg: 185,
      rollDeg: -180,
      modelRotationDeg: [[540, -90, 315]],
    })
    const f = serializeHome(store.getHome()).furniture[0]
    expect(f?.pitchDeg).toBe(-175)
    expect(f?.rollDeg).toBe(-180)
    expect(f?.modelRotationDeg).toEqual([[-180, -90, -45]])
  })

  it('does not mutate the input state', () => {
    const store = new HomeStore()
    const model = new HomeModel(store)
    const raw = model.addWall({ xStart: 0.123456789, yStart: 0, xEnd: 100, yEnd: 0, thickness: 7 })
    const home = store.getHome()
    serializeHome(home)
    expect(home.walls[0]?.xStart).toBe(raw.xStart)
  })

  it('leaves arcExtent untouched but exports compass radians round3', () => {
    const store = new HomeStore('UTC')
    const model = new HomeModel(store)
    model.addWall({ ...{ xStart: 0, yStart: 0, xEnd: 400, yEnd: 0, thickness: 10 }, arcExtent: Math.PI / 3 })
    model.setCompass({ latitudeRad: Math.PI / 4, longitudeRad: 0.123456789 })
    const out = serializeHome(store.getHome())
    expect(out.walls[0]?.arcExtent).toBe(Math.PI / 3)
    expect(out.compass.latitudeRad).toBe(0.785)
    expect(out.compass.longitudeRad).toBe(0.123)
  })

  it('exports fovDeg with plain round3 without angle wrapping', () => {
    const store = new HomeStore()
    const model = new HomeModel(store)
    model.moveTopCamera({ fovDeg: 62.98765 })
    const out = serializeHome(store.getHome())
    expect(out.cameras.top.fovDeg).toBe(62.988)
  })
})

describe('schema validation via ajv (draft 2020-12)', () => {
  it('empty home validates', () => {
    assertValid(serializeHome(createEmptyHome()))
  })

  it('fully populated home validates against every item schema', () => {
    const store = new HomeStore()
    const model = new HomeModel(store)
    const level = model.addLevel({
      name: 'Ground',
      elevation: 0,
      floorThickness: 12.5,
      height: 250,
      visible: true,
      viewable: true,
    })
    const upstairs = model.addLevel({
      name: 'Up',
      elevation: 262.5,
      floorThickness: 10,
      height: 250,
      visible: false,
      viewable: true,
    })
    const wall = model.addWall({
      xStart: 0,
      yStart: 0,
      xEnd: 400,
      yEnd: 300,
      thickness: 10.25,
      arcExtent: null,
      height: 250,
      heightAtEnd: 260,
      levelRef: level.id,
      leftSideColor: 0xff0000,
      rightSideColor: null,
      patternId: 'hatched',
    })
    const room = model.addRoom(
      [
        [0, 0],
        [400, 0],
        [400, 300],
        [0, 300],
      ],
      { name: 'Living', areaVisible: true, floorVisible: true, floorColor: 0xead9b8, ceilingVisible: false, levelRef: level.id },
    )
    const furniture = model.addFurniture({
      name: 'sofa',
      catalogId: 'catalog#sofa#42',
      x: 120.5,
      y: 60.25,
      elevation: 3,
      angleDeg: 270,
      pitchDeg: 15,
      rollDeg: -15,
      width: 200,
      depth: 90,
      height: 85,
      color: 0x336699,
      visible: true,
      movable: false,
      doorOrWindow: false,
      modelRotationDeg: [[10, 20, 30]],
      levelRef: level.id,
    })
    const dimension = model.addDimensionLine({
      xStart: 0,
      yStart: 310,
      xEnd: 400,
      yEnd: 310,
      offset: -15.5,
      elevationStart: 0,
      elevationEnd: 0,
      levelRef: level.id,
    })
    const label = model.addLabel({ text: 'Front door', x: 50, y: -20, angleDeg: 90, elevation: 210, color: null, levelRef: level.id })
    model.setSelection([wall.id, room.id, furniture.id, dimension.id, label.id])
    model.setActiveTool('selection')
    model.moveTopCamera({ x: 100.125, yawDeg: 190 })
    model.moveObserverCamera({ fixedSize: true })
    model.setCompass({ northDirectionDeg: 12.5, diameter: 99.9, visible: false })
    model.setEnvironment({ skyColor: null, wallsAlpha: 0.5 })
    model.updateWall(wall.id, {})
    void upstairs

    const exported = serializeHome(store.getHome())
    assertValid(exported)
    // spot-check transforms survived
    expect(exported.cameras.top.yawDeg).toBe(-170)
    expect(exported.walls[0]?.thickness).toBe(10.25)
  })

  it('rejects invalid fixtures (guards against validator false-positives)', () => {
    const empty = createEmptyHome()
    const badVersion = { ...empty, schemaVersion: 2 }
    expectInvalid(badVersion, 'schemaVersion')

    const badWall = structuredClone(empty)
    badWall.walls.push({
      id: 'w',
      xStart: 0,
      yStart: 0,
      xEnd: 100,
      yEnd: 0,
      thickness: 0,
    })
    expectInvalid(badWall, 'thickness')

    const badRoom = structuredClone(empty)
    badRoom.rooms.push({ id: 'r', points: [[0, 0], [1, 1]] })
    expectInvalid(badRoom, 'points')

    const badLens = structuredClone(empty)
    badLens.cameras.top.lens = 'GOPRO' as LensName
    expectInvalid(badLens, 'lens')

    const badAlpha = structuredClone(empty)
    badAlpha.environment.wallsAlpha = 2
    expectInvalid(badAlpha, 'wallsAlpha')
  })
})

describe('driver golden parity (create_room.expected-state.json)', () => {
  // Read-only reference generated by the real Java driver — never modified.
  const golden = createRoomGolden as unknown as {
    cameras: NormalizedHomeState['cameras']
    compass: NormalizedHomeState['compass']
    environment: NormalizedHomeState['environment']
    walls: Array<Record<string, unknown>>
    selection: string[]
    activeTool: string
  }

  function replayCreateRoom(): HomeStore {
    const store = new HomeStore('Asia/Thimphu') // build machine zone per contract §3
    const model = new HomeModel(store)
    model.setActiveTool('wall')
    model.addWallChain([
      { xStart: 100, yStart: 100, xEnd: 600, yEnd: 100 },
      { xStart: 600, yStart: 100, xEnd: 600, yEnd: 400 },
      { xStart: 600, yStart: 400, xEnd: 100, yEnd: 400 },
      { xStart: 100, yStart: 400, xEnd: 100, yEnd: 100 },
    ])
    return store
  }

  it('wall chain exports thickness 7, patternId hatchUp, height 250 like the driver', () => {
    const out = serializeHome(replayCreateRoom().getHome())
    expect(out.walls).toHaveLength(golden.walls.length)
    for (const [exported, expected] of zip(out.walls, golden.walls)) {
      for (const key of [
        'xStart',
        'yStart',
        'xEnd',
        'yEnd',
        'thickness',
        'height',
        'patternId',
      ] as const) {
        expect(exported[key]).toBe(expected[key])
      }
    }
  })

  it('cameras, compass and environment match the golden exactly', () => {
    const out = serializeHome(replayCreateRoom().getHome())
    expect(out.cameras.top).toEqual(golden.cameras.top)
    expect(out.cameras.observer).toEqual(golden.cameras.observer)
    expect(out.compass).toEqual(golden.compass)
    expect(out.environment).toEqual(golden.environment)
    expect(out.selection).toEqual(golden.selection)
    expect(out.activeTool).toBe(golden.activeTool)
    expect(out.capabilities.canUndo).toBe(true)
  })

  function zip<A, B>(a: A[], b: B[]): Array<[A, B]> {
    return a.map((item, i) => [item, b[i]] as [A, B])
  }
})
