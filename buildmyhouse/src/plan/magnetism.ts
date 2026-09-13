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
}

export function wallPointMagnetism(
  start: Point,
  point: Point,
  walls: Array<WallEndpointLike>,
  options: WallPointMagnetismOptions,
): Point {
  const base = options.enabled
    ? pointWithAngleMagnetism(start, point, options.maxDelta)
    : { x: point.x, y: point.y }

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
