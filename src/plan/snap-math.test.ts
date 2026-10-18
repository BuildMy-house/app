import { describe, expect, it } from 'vitest'
import {
  lengthSnapConfig,
  resolveSnapMode,
  snapAngle,
  snapLength,
  snapWallSegment,
} from './snap-math'

const CM = lengthSnapConfig('cm')
const INCH = lengthSnapConfig('inch')

describe('lengthSnapConfig', () => {
  it('returns centimetre steps (10 / 100 / 1 cm)', () => {
    expect(lengthSnapConfig('cm')).toEqual({ stepCm: 10, majorCm: 100, fineStepCm: 1 })
  })

  it('returns inch steps (4 in / 1 ft / 1 in in cm)', () => {
    expect(lengthSnapConfig('inch')).toEqual({ stepCm: 10.16, majorCm: 30.48, fineStepCm: 2.54 })
  })
})

describe('snapLength', () => {
  it('rounds to the nearest step', () => {
    expect(snapLength(134, CM)).toEqual({ lengthCm: 130, lock: 'step' })
    expect(snapLength(136, CM)).toEqual({ lengthCm: 140, lock: 'step' })
    expect(snapLength(113, CM)).toEqual({ lengthCm: 110, lock: 'step' })
  })

  it('captures the nearest major within 0.8 * step', () => {
    expect(snapLength(96, CM)).toEqual({ lengthCm: 100, lock: 'major' })
    expect(snapLength(108, CM)).toEqual({ lengthCm: 100, lock: 'major' })
  })

  it('holds a major it was already on through the release band (1.2 * step)', () => {
    expect(snapLength(110, CM, { wasAtMajor: true })).toEqual({ lengthCm: 100, lock: 'major' })
    expect(snapLength(110, CM)).toEqual({ lengthCm: 110, lock: 'step' })
  })

  it('uses the fine step without major stickiness', () => {
    expect(snapLength(134, CM, { fine: true })).toEqual({ lengthCm: 134, lock: 'fine' })
    expect(snapLength(96, CM, { fine: true })).toEqual({ lengthCm: 96, lock: 'fine' })
  })

  it('never returns a negative length and maps zero to zero', () => {
    expect(snapLength(0, CM).lengthCm).toBe(0)
    expect(snapLength(-5, CM).lengthCm).toBe(0)
  })

  it('snaps in inches (4 in steps, 1 ft major, 1 in fine)', () => {
    const step = snapLength(41, INCH)
    expect(step.lock).toBe('step')
    expect(step.lengthCm).toBeCloseTo(40.64, 9)

    const major = snapLength(30, INCH)
    expect(major.lock).toBe('major')
    expect(major.lengthCm).toBeCloseTo(30.48, 9)

    const fine = snapLength(5, INCH, { fine: true })
    expect(fine.lock).toBe('fine')
    expect(fine.lengthCm).toBeCloseTo(5.08, 9)
  })
})

describe('snapAngle soft', () => {
  it('captures plain steps within ±3°', () => {
    expect(snapAngle(12, 'soft')).toEqual({ angleDeg: 15, lock: 'step' })
    expect(snapAngle(18, 'soft')).toEqual({ angleDeg: 15, lock: 'step' })
    expect(snapAngle(20, 'soft')).toEqual({ angleDeg: 20, lock: 'none' })
  })

  it('captures diagonals within ±6°', () => {
    expect(snapAngle(48, 'soft')).toEqual({ angleDeg: 45, lock: 'diagonal' })
    expect(snapAngle(39, 'soft')).toEqual({ angleDeg: 45, lock: 'diagonal' })
    expect(snapAngle(37, 'soft')).toEqual({ angleDeg: 37, lock: 'none' })
  })

  it('captures axes within ±8°', () => {
    expect(snapAngle(5, 'soft')).toEqual({ angleDeg: 0, lock: 'axis' })
    expect(snapAngle(85, 'soft')).toEqual({ angleDeg: 90, lock: 'axis' })
    expect(snapAngle(9, 'soft')).toEqual({ angleDeg: 9, lock: 'none' })
  })

  it('returns exact axis multiples without float residue', () => {
    expect(snapAngle(91, 'soft').angleDeg).toBe(90)
    expect(snapAngle(179, 'soft').angleDeg).toBe(180)
    expect(snapAngle(-89, 'soft').angleDeg).toBe(-90)
  })

  it('extends the lock for the candidate it was locked to (hysteresis)', () => {
    expect(snapAngle(52, 'soft')).toEqual({ angleDeg: 52, lock: 'none' })
    expect(snapAngle(52, 'soft', { wasLockedDeg: 45 })).toEqual({ angleDeg: 45, lock: 'diagonal' })
  })

  it('snaps relative to extra bases, preferring the stronger lock on ties', () => {
    const result = snapAngle(121, 'soft', { baseDegs: [0, 30] })
    expect(result.angleDeg).toBe(120)
    expect(result.lock).toBe('axis')
  })
})

describe('snapAngle hard', () => {
  it('always locks to the nearest 15° multiple', () => {
    expect(snapAngle(20, 'hard')).toEqual({ angleDeg: 15, lock: 'step' })
    expect(snapAngle(71, 'hard')).toEqual({ angleDeg: 75, lock: 'step' })
  })

  it('lets axis/diagonal targets capture within ±10° before plain steps', () => {
    expect(snapAngle(38, 'hard')).toEqual({ angleDeg: 45, lock: 'diagonal' })
    expect(snapAngle(53, 'hard')).toEqual({ angleDeg: 45, lock: 'diagonal' })
    expect(snapAngle(100, 'hard')).toEqual({ angleDeg: 90, lock: 'axis' })
  })
})

describe('resolveSnapMode', () => {
  it('follows the alt/shift/enabled truth table', () => {
    expect(resolveSnapMode({ shift: false, alt: false }, true)).toBe('soft')
    expect(resolveSnapMode({ shift: false, alt: false }, false)).toBe('off')
    expect(resolveSnapMode({ shift: true, alt: false }, true)).toBe('hard')
    expect(resolveSnapMode({ shift: true, alt: false }, false)).toBe('hard')
    expect(resolveSnapMode({ shift: false, alt: true }, true)).toBe('off')
    expect(resolveSnapMode({ shift: true, alt: true }, true)).toBe('off')
  })
})

describe('snapWallSegment', () => {
  const start = { x: 0, y: 0 }

  it('soft: snaps angle and length together', () => {
    const result = snapWallSegment({ start, cursor: { x: 121, y: 1 }, unit: 'cm', mode: 'soft' })
    expect(result.angleLock).toBe('axis')
    expect(result.lengthLock).toBe('step')
    expect(result.lengthCm).toBe(120)
    expect(result.end).toEqual({ x: 120, y: 0 })
    expect(result.state).toEqual({ lengthMajor: false, angleLockedDeg: 0 })
  })

  it('hard (Shift): locks the angle to a diagonal and the length to a major', () => {
    const radius = 100
    const cursor = {
      x: radius * Math.cos((38 * Math.PI) / 180),
      y: radius * Math.sin((38 * Math.PI) / 180),
    }
    const result = snapWallSegment({ start, cursor, unit: 'cm', mode: 'hard' })
    expect(result.angleLock).toBe('diagonal')
    expect(result.angleDeg).toBe(45)
    expect(result.lengthLock).toBe('major')
    expect(result.end.x).toBeCloseTo(100 * Math.cos(Math.PI / 4), 9)
    expect(result.end.y).toBeCloseTo(100 * Math.sin(Math.PI / 4), 9)
  })

  it('off (Alt): returns the raw cursor with no locks', () => {
    const result = snapWallSegment({ start, cursor: { x: 121, y: 3 }, unit: 'cm', mode: 'off' })
    expect(result.end).toEqual({ x: 121, y: 3 })
    expect(result.lengthLock).toBe('none')
    expect(result.angleLock).toBe('none')
  })

  it('typed length overrides snapping but keeps the snapped angle', () => {
    const radius = 100
    const cursor = {
      x: radius * Math.cos((41 * Math.PI) / 180),
      y: radius * Math.sin((41 * Math.PI) / 180),
    }
    const result = snapWallSegment({ start, cursor, unit: 'cm', mode: 'soft', typedLengthCm: 250 })
    expect(result.lengthCm).toBe(250)
    expect(result.lengthLock).toBe('none')
    expect(result.angleLock).toBe('diagonal')
    expect(result.end.x).toBeCloseTo(250 * Math.cos(Math.PI / 4), 9)
    expect(result.end.y).toBeCloseTo(250 * Math.sin(Math.PI / 4), 9)
  })

  it('typed length applies exactly even in off mode, along the raw direction', () => {
    const result = snapWallSegment({
      start,
      cursor: { x: 3, y: 4 },
      unit: 'cm',
      mode: 'off',
      typedLengthCm: 500,
    })
    expect(result.lengthCm).toBe(500)
    expect(result.end.x).toBeCloseTo(500 * (3 / 5), 9)
    expect(result.end.y).toBeCloseTo(500 * (4 / 5), 9)
  })

  it('zero-length cursor returns start with zero length', () => {
    const result = snapWallSegment({ start: { x: 5, y: 7 }, cursor: { x: 5, y: 7 }, unit: 'cm', mode: 'soft' })
    expect(result.end).toEqual({ x: 5, y: 7 })
    expect(result.lengthCm).toBe(0)
    expect(result.angleLock).toBe('none')
    expect(result.lengthLock).toBe('none')
  })

  it('carries lock state across calls (hysteresis)', () => {
    const cursor = {
      x: 100 * Math.cos((52 * Math.PI) / 180),
      y: 100 * Math.sin((52 * Math.PI) / 180),
    }
    const first = snapWallSegment({ start, cursor, unit: 'cm', mode: 'soft' })
    expect(first.angleLock).toBe('none')
    expect(first.state.angleLockedDeg).toBeNull()

    const second = snapWallSegment({
      start,
      cursor,
      unit: 'cm',
      mode: 'soft',
      prev: { lengthMajor: false, angleLockedDeg: 45 },
    })
    expect(second.angleLock).toBe('diagonal')
    expect(second.angleDeg).toBe(45)
    expect(second.state.angleLockedDeg).toBe(45)
  })
})
