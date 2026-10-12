import type { Point } from './geometry'

const ANGLE_STEP = Math.PI / 12

export function getMagnetizedLength(length: number, maxDelta: number): number {
  const doubleDelta = maxDelta * 2
  let precision: number
  if (doubleDelta > 100) precision = 100
  else if (doubleDelta > 10) precision = 10
  else if (doubleDelta > 5) precision = 5
  else if (doubleDelta > 1) precision = 1
  else if (doubleDelta > 0.5) precision = 0.5
  else if (doubleDelta > 0.1) precision = 0.1
  else precision = 0.01
  return Math.round(length / precision) * precision
}

export function pointWithAngleMagnetism(
  start: Point,
  point: Point,
  maxDelta: number,
): Point {
  const dx = point.x - start.x
  const dy = point.y - start.y
  if (point.x === start.x) {
    return { x: start.x, y: start.y + getMagnetizedLength(Math.abs(dy), maxDelta) * Math.sign(dy || 1) }
  }
  if (point.y === start.y) {
    return { x: start.x + getMagnetizedLength(Math.abs(dx), maxDelta) * Math.sign(dx), y: start.y }
  }

  const angle = Math.atan2(dy, dx)
  const radius = Math.hypot(dx, dy)
  const lowerStep = Math.floor(angle / ANGLE_STEP) * ANGLE_STEP
  const upperStep = lowerStep + ANGLE_STEP

  const lowerPoint: Point = {
    x: start.x + radius * Math.cos(lowerStep),
    y: start.y + radius * Math.sin(lowerStep),
  }
  const upperPoint: Point = {
    x: start.x + radius * Math.cos(upperStep),
    y: start.y + radius * Math.sin(upperStep),
  }

  const chosen =
    Math.hypot(point.x - lowerPoint.x, point.y - lowerPoint.y) <=
    Math.hypot(point.x - upperPoint.x, point.y - upperPoint.y)
      ? lowerStep
      : upperStep

  const magnetizedRadius = getMagnetizedLength(radius, maxDelta)
  return {
    x: start.x + magnetizedRadius * Math.cos(chosen),
    y: start.y + magnetizedRadius * Math.sin(chosen),
  }
}

/**
 * Hard-lock `point` onto the nearest multiple of `stepRad` of the direction
 * ray from `start` (15° by default), keeping the ray's length but rounding it
 * with {@link getMagnetizedLength}. Unlike {@link pointWithAngleMagnetism}
 * (soft: only snaps when close), this ALWAYS locks the direction. Axis-aligned
 * results (0/90/180/270°) are computed exactly — no cos/sin float residue.
 * Zero-length input returns a copy of `start`.
 */
export function lockPointToAngleStep(
  start: Point,
  point: Point,
  stepRad: number = ANGLE_STEP,
  maxDelta: number,
): Point {
  const offset = stepLockedOffset(
    point.x - start.x,
    point.y - start.y,
    stepRad,
    (radius) => getMagnetizedLength(radius, maxDelta),
  )
  return { x: start.x + offset.x, y: start.y + offset.y }
}

/**
 * Hard-lock a translation vector's direction onto the nearest multiple of
 * `stepRad` (15° by default), preserving its length (no length magnetization).
 * Exact on the axes; the zero vector stays zero.
 */
export function lockVectorToAngleStep(dx: number, dy: number, stepRad: number = ANGLE_STEP): Point {
  return stepLockedOffset(dx, dy, stepRad, (radius) => radius)
}

/**
 * Soft axis snap for a translation vector: if its direction is within
 * `toleranceRad` (~3° by default) of horizontal or vertical, the off-axis
 * component is zeroed; otherwise the vector is returned unchanged.
 */
export function softAxisSnapVector(dx: number, dy: number, toleranceRad: number = Math.PI / 36): Point {
  if (dx === 0 && dy === 0) return { x: 0, y: 0 }
  const angle = Math.atan2(dy, dx)
  const toleranceSin = Math.sin(toleranceRad)
  if (Math.abs(Math.sin(angle)) <= toleranceSin) return { x: dx, y: 0 }
  if (Math.abs(Math.cos(angle)) <= toleranceSin) return { x: 0, y: dy }
  return { x: dx, y: dy }
}

/**
 * Shared direction locker: maps (dx, dy) onto the nearest `stepRad` multiple
 * with the radius passed through `transformRadius`, exact on the axes.
 */
function stepLockedOffset(
  dx: number,
  dy: number,
  stepRad: number,
  transformRadius: (radius: number) => number,
): Point {
  if (dx === 0 && dy === 0) return { x: 0, y: 0 }
  const angle = Math.atan2(dy, dx)
  const snappedAngle = Math.round(angle / stepRad) * stepRad
  const radius = transformRadius(Math.hypot(dx, dy))
  const halfPi = Math.PI / 2
  const axisQuarter = Math.round(snappedAngle / halfPi)
  if (Math.abs(snappedAngle - axisQuarter * halfPi) < 1e-9) {
    const q = ((axisQuarter % 4) + 4) % 4
    return q === 0
      ? { x: radius, y: 0 }
      : q === 1
        ? { x: 0, y: radius }
        : q === 2
          ? { x: -radius, y: 0 }
          : { x: 0, y: -radius }
  }
  return { x: radius * Math.cos(snappedAngle), y: radius * Math.sin(snappedAngle) }
}

export interface WallEndpointLike {
  xStart: number
  yStart: number
  xEnd: number
  yEnd: number
}

export interface WallPointMagnetismOptions {
  enabled: boolean
  maxDelta: number
  endpointMargin: number
  /**
   * Snap mode: 'soft' = today's 15° snap when close, 'hard' = always lock the
   * direction to the 15° grid, 'off' = no angle snapping. Defaults to
   * 'soft' when `enabled` and 'off' when not.
   */
  mode?: 'soft' | 'hard' | 'off'
}

export function wallPointMagnetism(
  start: Point,
  point: Point,
  walls: Array<WallEndpointLike>,
  options: WallPointMagnetismOptions,
): Point {
  const mode = options.mode ?? (options.enabled ? 'soft' : 'off')
  const base = mode === 'soft'
    ? pointWithAngleMagnetism(start, point, options.maxDelta)
    : mode === 'hard'
      ? // Hard mode: the locked angle is the contract — length still magnetizes.
        lockPointToAngleStep(start, point, ANGLE_STEP, options.maxDelta)
      : { x: point.x, y: point.y }

  // Per-axis endpoint snapping would break the locked angle in hard mode,
  // so it is skipped there entirely (angle wins over endpoints).
  if (mode === 'hard') return base

  let snappedX: number | null = null
  let bestDistX = options.endpointMargin
  let snappedY: number | null = null
  let bestDistY = options.endpointMargin

  for (const wall of walls) {
    for (const endpoint of [
      { x: wall.xStart, y: wall.yStart },
      { x: wall.xEnd, y: wall.yEnd },
    ]) {
      const distX = Math.abs(endpoint.x - base.x)
      if (distX <= bestDistX) {
        bestDistX = distX
        snappedX = endpoint.x
      }
      const distY = Math.abs(endpoint.y - base.y)
      if (distY <= bestDistY) {
        bestDistY = distY
        snappedY = endpoint.y
      }
    }
  }

  return {
    x: snappedX ?? base.x,
    y: snappedY ?? base.y,
  }
}
