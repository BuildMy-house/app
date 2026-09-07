import { describe, expect, it } from 'vitest'
import { HomeStore } from '../src/core/store'
import { HomeModel } from '../src/core/model'
import { serializeHome } from '../src/core/export'
import { serializeForSave, parseHomeFile } from '../src/services/adapters/home-persistence'
import { createEmptyHome } from '../src/core/home'
import type { NormalizedHomeState } from '../src/core/home'

/**
 * Serialize → parse → compare round-trip.
 *
 * `serializeForSave` calls `serializeHome` (applies rounding per export.ts
 * contract) then `JSON.stringify` (pretty-printed).
 * `parseHomeFile` calls `JSON.parse` then `isNormalizedHome` validation.
 *
 * We compare the serialized output (which already has rounding baked in)
 * against the parsed-back state, because the input may have raw floats
 * that differ from their rounded counterparts.
 */
function roundTrip(home: NormalizedHomeState): NormalizedHomeState {
  const json = serializeForSave(home)
  return parseHomeFile(json)
}

/**
 * Deep-equality check that accounts for the 3-decimal roundHalfEven
 * rounding contract in core/export.ts. Numeric fields that go through
 * roundLen/roundAngle/roundFov are compared within 1e-3; everything else
 * must be strictly equal.
 */
function expectRoundTripEqual(original: NormalizedHomeState): void {
  const exported = serializeHome(original)
  const parsed = roundTrip(original)
  expect(parsed).toEqual(exported)
}

// ─── builders ────────────────────────────────────────────────────────

function buildMultiLevelHome(): NormalizedHomeState {
  const store = new HomeStore('UTC')
  const model = new HomeModel(store)
  const ground = model.addLevel({
    name: 'Ground Floor',
    elevation: 0,
    floorThickness: 10,
    height: 250,
    visible: true,
    viewable: true,
  })
  const upper = model.addLevel({
    name: 'Upper Floor',
    elevation: 260,
    floorThickness: 12,
    height: 240,
    visible: false,
    viewable: true,
  })

  // Wall on ground level
  model.addWall({
    xStart: 0, yStart: 0, xEnd: 400, yEnd: 0, thickness: 10,
    levelRef: ground.id,
  })
  // Wall on upper level
  model.addWall({
    xStart: 0, yStart: 0, xEnd: 300, yEnd: 200, thickness: 7,
    levelRef: upper.id,
  })
  // Furniture on ground
  model.addFurniture({
    name: 'Sofa', x: 100, y: 50, angleDeg: 0, width: 200, depth: 80,
    height: 85, elevation: 0, levelRef: ground.id,
  })
  // Furniture on upper
  model.addFurniture({
    name: 'Bed', x: 150, y: 100, angleDeg: 90, width: 200, depth: 180,
    height: 60, elevation: 0, levelRef: upper.id,
  })
  // Room on ground
  model.addRoom(
    [[0, 0], [400, 0], [400, 300], [0, 300]],
    { name: 'Living Room', levelRef: ground.id },
  )
  // Dimension line on ground
  model.addDimensionLine({
    xStart: 0, yStart: 310, xEnd: 400, yEnd: 310, offset: -15,
    levelRef: ground.id,
  })
  // Label on ground
  model.addLabel({ text: 'Ground label', x: 200, y: 150, levelRef: ground.id })
  // Label on upper
  model.addLabel({ text: 'Upper label', x: 100, y: 80, levelRef: upper.id })

  return store.getHome()
}

function buildComplexFurnitureHome(): NormalizedHomeState {
  const store = new HomeStore('UTC')
  const model = new HomeModel(store)

  // Wall with height/heightAtEnd (not default null)
  const wall = model.addWall({
    xStart: 100, yStart: 100, xEnd: 500, yEnd: 100, thickness: 7,
    height: 240, heightAtEnd: 260, arcExtent: 0.5,
    leftSideColor: 0xff0000, rightSideColor: 0x00ff00, patternId: 'hatchUp',
  })

  // Door with wallRef/wallOffset
  const door = model.addFurniture({
    name: 'Front Door', x: 300, y: 100, angleDeg: 90,
    width: 90, depth: 5, height: 210, elevation: 0,
    doorOrWindow: true, wallRef: wall.id, wallOffset: 0.5,
    catalogId: 'catalog#door#1',
  })

  // Window with wallRef/wallOffset
  model.addFurniture({
    name: 'Window', x: 200, y: 100, angleDeg: 0,
    width: 120, depth: 3, height: 80, elevation: 120,
    doorOrWindow: true, wallRef: wall.id, wallOffset: 0.25,
    catalogId: 'catalog#window#2',
  })

  // Room with full attributes
  model.addRoom(
    [[100, 100], [500, 100], [500, 400], [100, 400]],
    {
      name: 'Bedroom',
      areaVisible: true,
      floorVisible: true,
      floorColor: 0xead9b8,
      ceilingVisible: true,
    },
  )

  // Dimension line
  model.addDimensionLine({
    xStart: 100, yStart: 410, xEnd: 500, yEnd: 410, offset: -20,
    elevationStart: 0, elevationEnd: 0,
  })

  // Label
  model.addLabel({
    text: 'Kitchen Area', x: 300, y: 250, angleDeg: 45,
    elevation: 0, color: 0x0000ff,
  })

  // Furniture with pitch/roll/modelRotationDeg
  model.addFurniture({
    name: 'TV', x: 300, y: 390, angleDeg: 180,
    width: 140, depth: 10, height: 80, elevation: 120,
    pitchDeg: 15, rollDeg: -5,
    modelRotationDeg: [[10, 20, 30], [45, 60, 75]],
  })

  // Selection
  model.setSelection([wall.id, door.id])

  return store.getHome()
}

function buildEmptyHome(): NormalizedHomeState {
  return createEmptyHome('UTC')
}

function buildUnicodeHome(): NormalizedHomeState {
  const store = new HomeStore('UTC')
  const model = new HomeModel(store)

  model.addLevel({
    name: 'Étage supérieur — ن本地', elevation: 0, floorThickness: 10,
    height: 250, visible: true, viewable: true,
  })

  model.addWall({
    xStart: 0, yStart: 0, xEnd: 400, yEnd: 0, thickness: 7,
  })

  model.addRoom(
    [[0, 0], [400, 0], [400, 300], [0, 300]],
    { name: '客廳 / Living 🛋️ — Raum №1' },
  )

  model.addFurniture({
    name: 'Étagère 日本語家具', x: 100, y: 50, angleDeg: 0,
    width: 80, depth: 40, height: 180, elevation: 0,
  })

  model.addLabel({
    text: 'Привет мир — مرحبا بالعالم — 🌍', x: 200, y: 150,
  })

  model.addDimensionLine({
    xStart: 0, yStart: 310, xEnd: 400, yEnd: 310, offset: -15,
  })

  // Home name with unicode
  model.setName('Casa de Üñîçödé 🏠')

  return store.getHome()
}

function buildSpecialNumbersHome(): NormalizedHomeState {
  const store = new HomeStore('UTC')
  const model = new HomeModel(store)

  // Near-boundary angles (180 → normalizes to -180; 360 → 0; etc.)
  model.addWall({
    xStart: 0, yStart: 0, xEnd: 400, yEnd: 0, thickness: 7,
  })
  model.addFurniture({
    name: 'rotated', x: 200, y: 200, angleDeg: 180,
    width: 100, depth: 50, height: 80, elevation: 0,
  })
  model.addFurniture({
    name: 'rotated2', x: 200, y: 200, angleDeg: 360,
    width: 100, depth: 50, height: 80, elevation: 0,
  })
  // Compass with boundary northDirection
  model.setCompass({ northDirectionDeg: 180 })

  // Very small values that float near zero
  model.addFurniture({
    name: 'tiny', x: 0.001, y: -0.001, angleDeg: 0.0005,
    width: 1, depth: 1, height: 1, elevation: 0.0001,
  })

  // Large values
  model.addFurniture({
    name: 'huge', x: 99999, y: -99999, angleDeg: 359.999,
    width: 50000, depth: 50000, height: 50000, elevation: 10000,
  })

  return store.getHome()
}

// ─── round-trip tests ────────────────────────────────────────────────

describe('save-open round-trip', () => {
  it('empty home', () => {
    const home = buildEmptyHome()
    expectRoundTripEqual(home)
  })

  it('multi-level with objects on each levelRef', () => {
    const home = buildMultiLevelHome()
    expectRoundTripEqual(home)
  })

  it('complex furniture with wallRef/wallOffset, doorOrWindow, pitch/roll/modelRotationDeg', () => {
    const home = buildComplexFurnitureHome()
    expectRoundTripEqual(home)
  })

  it('unicode and special characters in names and labels', () => {
    const home = buildUnicodeHome()
    expectRoundTripEqual(home)
  })

  it('special number values (boundary angles, tiny, large)', () => {
    const home = buildSpecialNumbersHome()
    expectRoundTripEqual(home)
  })

  it('pretty-printed JSON round-trips identically (double round-trip idempotent)', () => {
    const home = buildComplexFurnitureHome()
    const json1 = serializeForSave(home)
    const parsed = parseHomeFile(json1)
    const json2 = serializeForSave(parsed)
    expect(json2).toBe(json1)
  })

  it('selected ids survive round-trip', () => {
    const store = new HomeStore('UTC')
    const model = new HomeModel(store)
    model.addWall({ xStart: 0, yStart: 0, xEnd: 100, yEnd: 0, thickness: 7 })
    model.addFurniture({
      name: 'chair', x: 0, y: 0, angleDeg: 0, width: 45, depth: 45,
      height: 90, elevation: 0,
    })
    model.setSelection(['wall-1', 'furniture-2'])
    const parsed = roundTrip(store.getHome())
    expect(parsed.selection).toEqual(['wall-1', 'furniture-2'])
  })

  it('capabilities survive round-trip', () => {
    const store = new HomeStore('UTC')
    const model = new HomeModel(store)
    model.setName('test')
    const parsed = roundTrip(store.getHome())
    expect(parsed.capabilities).toEqual({ canUndo: true, canRedo: false })
  })

  it('null/undefined optional fields serialize and parse consistently', () => {
    const store = new HomeStore('UTC')
    const model = new HomeModel(store)
    model.addWall({
      xStart: 0, yStart: 0, xEnd: 100, yEnd: 0, thickness: 7,
      height: null, heightAtEnd: null, arcExtent: null,
    })
    const parsed = roundTrip(store.getHome())
    const wall = parsed.walls[0]!
    // null values are preserved by JSON.stringify and parsed back as null
    expect(wall.height).toBeNull()
    expect(wall.heightAtEnd).toBeNull()
    expect(wall.arcExtent).toBeNull()
  })

  it('undefined optional fields become absent (undefined) after round-trip', () => {
    const store = new HomeStore('UTC')
    const model = new HomeModel(store)
    model.addWall({
      xStart: 0, yStart: 0, xEnd: 100, yEnd: 0, thickness: 7,
    })
    const parsed = roundTrip(store.getHome())
    const wall = parsed.walls[0]!
    // undefined fields are dropped by JSON.stringify and stay undefined on parse
    expect(wall.height).toBeUndefined()
    expect(wall.heightAtEnd).toBeUndefined()
    expect(wall.arcExtent).toBeUndefined()
  })

  it('floor color and ceilingVisible in rooms survive round-trip', () => {
    const store = new HomeStore('UTC')
    const model = new HomeModel(store)
    model.addRoom(
      [[0, 0], [100, 0], [100, 100], [0, 100]],
      { name: 'Test', floorColor: 0xead9b8, ceilingVisible: true },
    )
    const parsed = roundTrip(store.getHome())
    const room = parsed.rooms[0]!
    expect(room.floorColor).toBe(0xead9b8)
    expect(room.ceilingVisible).toBe(true)
    expect(room.name).toBe('Test')
  })

  it('camera state round-trips through normalization (yaw wrapping)', () => {
    const store = new HomeStore('UTC')
    const model = new HomeModel(store)
    model.moveTopCamera({ x: 50.123456, yawDeg: 190, pitchDeg: 45.5555 })
    const parsed = roundTrip(store.getHome())
    // yawDeg: 190 → normalizeAngle → -170 → roundHalfEven
    expect(parsed.cameras.top.yawDeg).toBe(-170)
    expect(parsed.cameras.top.x).toBe(50.123)
    expect(parsed.cameras.top.pitchDeg).toBe(45.556)
  })

  it('compass radians round-trip through round3', () => {
    const store = new HomeStore('UTC')
    const model = new HomeModel(store)
    model.setCompass({ latitudeRad: 0.48, longitudeRad: 1.564 })
    const parsed = roundTrip(store.getHome())
    expect(parsed.compass.latitudeRad).toBe(0.48)
    expect(parsed.compass.longitudeRad).toBe(1.564)
  })

  it('environment wallsAlpha round-trips', () => {
    const store = new HomeStore('UTC')
    const model = new HomeModel(store)
    model.setEnvironment({ wallsAlpha: 0.5 })
    const parsed = roundTrip(store.getHome())
    expect(parsed.environment.wallsAlpha).toBe(0.5)
  })
})

// ─── failure path tests ──────────────────────────────────────────────

describe('parseHomeFile error handling', () => {
  it('rejects completely invalid JSON', () => {
    expect(() => parseHomeFile('{not json!!!')).toThrow()
  })

  it('rejects empty string', () => {
    expect(() => parseHomeFile('')).toThrow()
  })

  it('rejects truncated JSON', () => {
    const full = serializeForSave(buildEmptyHome())
    // Cut off mid-string
    expect(() => parseHomeFile(full.slice(0, 50))).toThrow()
  })

  it('rejects missing required top-level keys', () => {
    expect(() => parseHomeFile('{"schemaVersion":1}')).toThrow('not a valid Homely project')
  })

  it('rejects non-array for levels', () => {
    const home = buildEmptyHome()
    const json = serializeForSave(home)
    const parsed = JSON.parse(json) as Record<string, unknown>
    parsed.levels = 'not an array'
    expect(() => parseHomeFile(JSON.stringify(parsed))).toThrow('not a valid Homely project')
  })

  it('rejects missing cameras', () => {
    const home = buildEmptyHome()
    const json = serializeForSave(home)
    const parsed = JSON.parse(json) as Record<string, unknown>
    delete parsed.cameras
    expect(() => parseHomeFile(JSON.stringify(parsed))).toThrow('not a valid Homely project')
  })

  it('rejects completely unrelated JSON object', () => {
    expect(() => parseHomeFile('{"hello":"world"}')).toThrow('not a valid Homely project')
  })

  it('rejects a plain array instead of object', () => {
    expect(() => parseHomeFile('[1,2,3]')).toThrow()
  })

  it('rejects null input', () => {
    // JSON.parse("null") returns null, which fails isNormalizedHome
    expect(() => parseHomeFile('null')).toThrow('not a valid Homely project')
  })
})
