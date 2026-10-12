import { describe, expect, it } from 'vitest'
import {
  lockPointToAngleStep,
  lockVectorToAngleStep,
  pointWithAngleMagnetism,
  softAxisSnapVector,
  wallPointMagnetism,
} from './magnetism'

const STEP = Math.PI / 12

describe('lockPointToAngleStep', () => {
  it('locks exactly on the 0/90/180/270 axes (no float residue)', () => {
    const start = { x: 100, y: 100 }
    // near-horizontal (dx 1000, dy 30; length 1000.45 → 1000)
    expect(lockPointToAngleStep(start, { x: 1100, y: 130 }, STEP, 1)).toEqual({ x: 1100, y: 100 })
    // near-vertical (like a near-90 click)
    expect(lockPointToAngleStep(start, { x: 130, y: 1100 }, STEP, 1)).toEqual({ x: 100, y: 1100 })
    // near-180
    expect(lockPointToAngleStep(start, { x: -900, y: 70 }, STEP, 1)).toEqual({ x: -900, y: 100 })
    // near-270
    expect(lockPointToAngleStep(start, { x: 70, y: -900 }, STEP, 1)).toEqual({ x: 100, y: -900 })
  })

  it('locks (1000, 30) exactly onto the horizontal ray', () => {
    const result = lockPointToAngleStep({ x: 0, y: 0 }, { x: 1000, y: 30 }, STEP, 1)
    expect(result.y).toBe(0)
    expect(result.x).toBeGreaterThan(900)
  })

  it('locks intermediate steps: 15/30/45/75 degrees', () => {
    const start = { x: 0, y: 0 }
    const cases: Array<[number, number, number]> = [
      [15, 0.9659258262890683, 0.25881904510252074],
      [30, 0.8660254037844387, 0.5],
      [45, 0.7071067811865476, 0.7071067811865476],
      [75, 0.25881904510252074, 0.9659258262890683],
    ]
    for (const [deg, cos, sin] of cases) {
      const rad = (deg * Math.PI) / 180
      // a 40° input lands on the 45° ray; others land on their own step
      const inputRad = deg === 45 ? (40 * Math.PI) / 180 : rad
      const radius = 200
      const point = { x: radius * Math.cos(inputRad), y: radius * Math.sin(inputRad) }
      const result = lockPointToAngleStep(start, point, STEP, 1)
      expect(result.x).toBeCloseTo(200 * cos, 9)
      expect(result.y).toBeCloseTo(200 * sin, 9)
    }
  })

  it('a 40° input lands on the 45° ray', () => {
    const radius = 200
    const point = { x: radius * Math.cos((40 * Math.PI) / 180), y: radius * Math.sin((40 * Math.PI) / 180) }
    const result = lockPointToAngleStep({ x: 0, y: 0 }, point, STEP, 1)
    const angle = Math.atan2(result.y, result.x)
    expect(angle).toBeCloseTo(Math.PI / 4, 9)
  })

  it('magnetizes the locked length with getMagnetizedLength (maxDelta 1 → whole units)', () => {
    const point = { x: 104.4, y: 0.5 }
    const result = lockPointToAngleStep({ x: 0, y: 0 }, point, STEP, 1)
    expect(result.x).toBe(104)
    expect(result.y).toBe(0)
  })

  it('returns a copy of start for zero-length input', () => {
    const start = { x: 5, y: 7 }
    const result = lockPointToAngleStep(start, { x: 5, y: 7 }, STEP, 1)
    expect(result).toEqual({ x: 5, y: 7 })
    expect(result).not.toBe(start)
  })
})

describe('lockVectorToAngleStep', () => {
  it('locks a translation onto the axes, preserving length', () => {
    const result = lockVectorToAngleStep(300, 30) // 5.7° → 0°
    expect(result.y).toBe(0)
    expect(result.x).toBeCloseTo(Math.hypot(300, 30), 9)
    const vertical = lockVectorToAngleStep(30, 300) // 84.3° → 90°
    expect(vertical.x).toBe(0)
    expect(vertical.y).toBeCloseTo(Math.hypot(30, 300), 9)
  })

  it('locks diagonal translations onto the nearest 15° step without length magnetization', () => {
    const result = lockVectorToAngleStep(100, 100) // already 45°; length √2·100 preserved
    expect(result.x).toBeCloseTo(100, 9)
    expect(result.y).toBeCloseTo(100, 9)
    expect(Math.hypot(result.x, result.y)).toBeCloseTo(Math.hypot(100, 100), 9)
    const locked = lockVectorToAngleStep(Math.cos((40 * Math.PI) / 180) * 300, Math.sin((40 * Math.PI) / 180) * 300)
    expect(Math.hypot(locked.x, locked.y)).toBeCloseTo(300, 9)
    expect(Math.atan2(locked.y, locked.x)).toBeCloseTo(Math.PI / 4, 9)
  })

  it('keeps the zero vector at zero', () => {
    expect(lockVectorToAngleStep(0, 0)).toEqual({ x: 0, y: 0 })
  })
})

describe('softAxisSnapVector', () => {
  it('zeroes the off-axis component within ~3° of horizontal', () => {
    expect(softAxisSnapVector(300, 4)).toEqual({ x: 300, y: 0 })
    expect(softAxisSnapVector(-300, 4)).toEqual({ x: -300, y: 0 })
  })

  it('zeroes the off-axis component within ~3° of vertical', () => {
    expect(softAxisSnapVector(4, 300)).toEqual({ x: 0, y: 300 })
    expect(softAxisSnapVector(4, -300)).toEqual({ x: 0, y: -300 })
  })

  it('leaves vectors outside tolerance unchanged', () => {
    expect(softAxisSnapVector(300, 40)).toEqual({ x: 300, y: 40 })
    expect(softAxisSnapVector(40, 300)).toEqual({ x: 40, y: 300 })
  })

  it('supports a custom tolerance and the zero vector', () => {
    expect(softAxisSnapVector(300, 40, (10 * Math.PI) / 180)).toEqual({ x: 300, y: 0 })
    expect(softAxisSnapVector(0, 0)).toEqual({ x: 0, y: 0 })
  })
})

describe('wallPointMagnetism modes', () => {
  it('hard mode: the locked angle wins over per-axis endpoint snapping (length still magnetizes)', () => {
    const start = { x: 0, y: 0 }
    const point = { x: 600, y: 30 } // 2.86° → locks to 0°, length 600.75 → 601
    const walls = [{ xStart: 599, yStart: 0, xEnd: 599, yEnd: 100 }]
    const hard = wallPointMagnetism(start, point, walls, {
      enabled: true,
      mode: 'hard',
      maxDelta: 1,
      endpointMargin: 8,
    })
    expect(hard.x).toBe(601)
    expect(hard.y).toBe(0)
  })

  it('soft mode (default when enabled) still lets endpoints snap per-axis', () => {
    const start = { x: 0, y: 0 }
    const point = { x: 600, y: 30 }
    const walls = [{ xStart: 599, yStart: 0, xEnd: 599, yEnd: 100 }]
    const soft = wallPointMagnetism(start, point, walls, {
      enabled: true,
      maxDelta: 1,
      endpointMargin: 8,
    })
    expect(soft.x).toBe(599)
    expect(soft.y).toBe(0)
  })

  it('off mode: raw point, but endpoint snapping still applies when walls are given', () => {
    const start = { x: 0, y: 0 }
    const point = { x: 600, y: 30 }
    const walls = [{ xStart: 599, yStart: 0, xEnd: 599, yEnd: 100 }]
    const off = wallPointMagnetism(start, point, walls, {
      enabled: false,
      maxDelta: 1,
      endpointMargin: 8,
    })
    expect(off).toEqual({ x: 599, y: 30 })
  })

  it('off mode with no walls returns the raw point (Alt bypass contract)', () => {
    const result = wallPointMagnetism(
      { x: 0, y: 0 },
      { x: 600, y: 30 },
      [],
      { enabled: false, maxDelta: 1, endpointMargin: 8 },
    )
    expect(result).toEqual({ x: 600, y: 30 })
  })

  it('does not change the existing soft helper behaviour', () => {
    // sanity anchor: pointWithAngleMagnetism untouched by this ticket
    const soft = pointWithAngleMagnetism({ x: 0, y: 0 }, { x: 1000, y: 0 }, 1)
    expect(soft).toEqual({ x: 1000, y: 0 })
  })
})
